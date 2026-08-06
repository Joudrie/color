# Build prompt — photo → coloring book app

Copy everything in the fenced block below into Claude Code (or Cursor / Lovable / v0)
as your first message. Notes on adjusting it, and the reasoning behind the tricky
parts, are at the bottom.

Step 1 of this prompt is implemented in this repo — see `README.md`. The architecture
below is the corrected one, rewritten after the first version was built and failed.

---

```
Build a web app called Colorbook that turns a user's photo into a coloring page they
can fill in with a paint-bucket tool. Mobile-first, works in a phone browser, no
login, no backend — everything runs on-device.

## User flow

1. Upload or take a photo.
2. It converts to clean black line art on white. A "Detail" slider (Simple →
   Detailed) re-renders the page as they drag it.
3. Tap "Color it" → the line art becomes a colorable canvas.
4. Tap a palette color, tap a region, it fills instantly with flat color.
5. Undo, redo, reset, save PNG.

## Architecture — read this section twice, it is the whole product

**Derive the lines from the regions, not the regions from the lines.**

The obvious approach is edge detection (Canny/DoG) followed by flood fill. It does
not work, and it is worth understanding why before you write any code. Edge
detection on a photo produces *open contours* — a dog's outline comes out as a
dashed line with gaps in it. A coloring page needs *closed shapes*. No amount of
gap-sealing fixes this reliably: the fill escapes through the first gap and floods
the page. That is the #1 complaint about every app in this category.

So invert it. Segment the image into regions first; the lines are just where two
regions meet. Every enclosed area is then closed **by construction** and a fill has
nowhere to escape to. Leaks become structurally impossible rather than something you
mitigate.

**Pipeline (runs in a Web Worker):**

1. Decode with `createImageBitmap(file, { imageOrientation: 'from-image' })`. Do not
   skip this — phone photos carry EXIF rotation and will render sideways otherwise.
2. Downscale so the long edge is 1400px. All processing happens at this resolution;
   display is separate.
3. Smooth with 2 passes of a 3×3 median filter, **on all three colour channels**.
   Segmentation is a colour decision, so texture has to come out of colour, not
   luma. (Use the 19-comparison median-of-9 sorting network, not a per-pixel sort —
   at 1.5M pixels a generic sort is seconds of work.)
4. Convert to CIELAB, and **scale L down to ~0.4 before any distance is
   measured**. This is the single most important number in the app. Lighting,
   shadow and wrinkles are almost entirely lightness variation, while "this is
   still the same blue shirt" across a highlight is an a/b fact. At full L weight
   every lit surface bands into contour lines and every face grows wrinkles.
5. Also compute a Sobel gradient magnitude over *true, unweighted* luma. Keep it —
   steps 8 and 9 need it to tell a real edge from a shading ramp.
6. Quantise colour with k-means in the weighted Lab (k-means++ init). Run the
   iterations on a ~20k-pixel subsample, then assign all pixels to the resulting
   centroids — full k-means over every pixel is pointlessly slow for identical
   output. Deliberately over-segment here; step 9 merges back.
7. Majority (mode) filter over the cluster-index image: one 3×3 pass then two 5×5
   passes. This dissolves speckle and rounds off jagged cluster boundaries.
   Smoothness has to happen here, because merging only ever *removes* borders — it
   never creates a rough new one — so a smooth index map yields smooth lines all
   the way through.
8. Connected-component labeling of *equal-valued* runs (two-pass union-find,
   4-connectivity). Output `Int32Array regionMap` plus per-region pixel count,
   bounding box, and mean colour.
9. Merge, in this order: small → similar → small again.
   - **Small:** absorb regions below a minimum size into whichever neighbour shares
     the longest border. Track adjacency only for the small regions so bookkeeping
     scales with the noise, not the image. **Spare any small region that is either
     chromatically distinct from that neighbour or ringed by a strong gradient** —
     this exception is the only thing keeping eyes, nostrils and lips alive, and a
     face without them reads as a blank mask.
   - **Similar:** merge adjacent regions whose mean colours are close *and* whose
     shared border is not a real edge. Both a shirt's lighting band and an eye look
     like a colour change to a clustering algorithm; the difference is that one
     border is a gradual ramp and the other is a step. Allow only one merge per
     region per pass so a gradient can't chain-collapse in one go, and repeat ~4
     passes.
10. Lines = every pixel with a 4-neighbour in a different region. Optionally dilate
    by 1 for ink weight at low detail levels.

**Make the edge threshold a percentile of the photo's own gradient distribution,
not an absolute number.** A textured photo (fur, foliage) has strong gradients
everywhere, so "this is a real edge" has to mean "strong relative to *this* image".
An absolute threshold protects every fur strand in one photo and nothing at all in
another — when I tried one, the same value gave 487 regions on a dog and 28 on a
portrait.

**The Detail slider** drives the cluster count, the minimum region size, and the two
merge thresholds together. That is the only thing "detail" means on a coloring page
— how many shapes it has. Use ~5 discrete levels and **cache each level's
segmentation**; revisiting a level is then instant and the slider feels live without
any separate preview path.

    level 0: k=10, minFrac=0.0022,  colorThreshold=15, preserve=17, edgePct=0.985
    level 2: k=18, minFrac=0.0008,  colorThreshold=11, preserve=15, edgePct=0.975
    level 4: k=30, minFrac=0.00025, colorThreshold=7,  preserve=12, edgePct=0.965

**Tap handling:** `regionMap[y * width + x]` → a region id. That is the whole
operation. No traversal.

**Document model — this is not the canvas.** The user's artwork is exactly:

    Map<regionId, colorIndex>

That is the entire saved state. It is a few hundred bytes, not a bitmap. Therefore:
- Undo/redo is a stack of `{regionId, from, to}`. Never snapshot the canvas — at
  1400px a single RGBA snapshot is ~7.8MB and a 20-step undo stack will crash mobile
  Safari.
- Reset is `map.clear()`.
- Save/resume across reloads is JSON in localStorage, for free.
- "Fill with the photo's real colours" is one pass over the per-region mean colours
  you already computed in step 7.

**Rendering:** three stacked layers — white base, fill layer, black line layer on
top (so lines always stay crisp over color). On a fill, repaint only the filled
region's bounding box, not the whole canvas.

## How to verify your own work

You cannot see the output, so build the instruments:

- A "debug" toggle that renders the region map in false colour (deterministic hue
  per region id). Correct output looks like a stained-glass window: every shape its
  own hue, adjacent shapes clearly different. A leak looks like one hue spanning
  things a human would call separate.
- Log after every segmentation: total regions, interior regions (not touching the
  image edge), largest region as a share of the image, ink share, and elapsed ms.
- Sanity targets on a normal photo at mid detail: **30–150 regions**, at least half
  of them interior, ink share 4–9%, segmentation under ~1.3s. Under 20 regions means
  the image had nothing to segment; several hundred means a merge step isn't firing.
- Log the resolved edge threshold too. If it looks nothing like the gradient scale
  of the image, the percentile lookup is wrong and every other number will mislead.
- Measure the largest region **including** the background. Measuring only interior
  regions hides the worst failure mode, where everything collapses into a single
  border-touching blob and the interior count is zero.
- Test with a portrait, a pet, a landscape, and a deliberately dark/low-contrast
  photo. Expect the dark one to look like a topographic map — see Known limits.

## Known limits — do not treat these as bugs

- Photos that are mostly smooth gradients (night skies, fog, sunsets) segment into
  concentric contour bands. It is a valid coloring page and a bad one. Detect it
  (very few interior regions, or regions that are long and thin) and tell the user
  the photo won't trace well rather than shipping them a contour map.
- Thin lighting ribbons survive along arms, shoulders and other rounded surfaces.
  Do **not** try to remove them with a thinness (isoperimetric) test — a smiling or
  squinting eye is a crescent, so every threshold that catches a shading ribbon also
  deletes the eyes. Losing a feature to remove an artefact is a bad trade.
- Heavily textured subjects (a wrinkled pug, curly fur, foliage) segment into
  pleasant abstract shapes but do not resolve individual features. The wrinkles are
  genuine strong edges, so they are correctly kept — there is just no signal that
  says an eye matters more than a fold.
- Faces come out clean and recognisable, but flat: no shading, and the jawline is
  often implied rather than drawn. That is the correct look for a coloring page.

## Stack

- Vite + React + TypeScript, Tailwind for styling.
- Plain Canvas 2D + typed arrays. Hand-write the convolutions, the morphology, the
  labeling and the merge — no image-processing dependencies (OpenCV.js is an 8MB
  wasm blob for a handful of functions).
- Heavy pipeline in a Web Worker; transfer buffers, don't copy them. Show a progress
  state — the initial load takes ~0.5–2s and that is fine if it's honest.
- UI nearly empty. The artwork is the interface.

## Acceptance checklist

Each item is testable — verify before telling me a step is done.

- [ ] A photo taken in portrait orientation on a phone displays right-side up.
- [ ] In debug view, no region spans two shapes a human would call separate.
- [ ] A normal photo yields 30–150 regions with a majority interior.
- [ ] Tap-to-painted is under 50ms on a 1400px image.
- [ ] 50 fills then 50 undos leaves memory flat (no canvas snapshots on the stack).
- [ ] Moving the Detail slider back to a previous level renders instantly (cached).
- [ ] Pinch-zoom to 4×, pan, then tap — the correct region fills. Screen→image
      coordinate mapping must invert the full pan/zoom transform; getting this wrong
      is the most common bug in this kind of app and it only shows up when zoomed.
- [ ] One finger on the canvas paints; two fingers pan/zoom; the page itself never
      scrolls while a finger is on the canvas.
- [ ] Reload the page mid-coloring and the work is still there.

## Build order

Stop after each step so I can look at it.

1. Upload → line art on screen + working Detail slider + debug region-map toggle.
2. Tap-to-fill with a fixed palette.
3. Undo/redo, reset, save PNG, pinch-zoom, localStorage persistence.

Use a palette of ~24 colors: light and dark versions of each hue, four skin tones,
and warm neutrals. Avoid fully saturated primaries — they look cheap next to black
line art.

Start with step 1.
```

---

## What changed and why

Three defects, found in two rounds of review and one round of actually building it.

**1. Canvas snapshots for undo (caught by review).** "Undo is just swapping the fill
layer" means storing a full bitmap per step — ~7.8MB each at 1400px, so twenty steps
is 156MB and a crash on mobile Safari. Fixing it revealed the better design: because
fills are region-based, the document is just `Map<regionId, color>`. Undo becomes
trivial, and save/resume and instant reset fall out for free.

**2. "Precomputed regions cannot leak" was an overclaim (caught by review).**
Precomputing doesn't stop leaks — if a gap connects two areas they become one region
and the tap still fills both. It makes leaks deterministic and detectable rather than
absent.

**3. The whole edge-detection architecture was wrong (caught by building it).** This
is the one that mattered. The first version ran DoG edge detection, sealed gaps with
morphological closing, then labeled the fillable areas. On a real photo of a dog it
produced *one region* — the outline had gaps, so the dog's interior and the
background were the same connected area. The line art looked like a pleasant pencil
sketch and was completely unfillable.

The leak check missed it, too, because it only measured the largest *interior*
region — and there were none, so it reported 0% and declared success. Measuring the
largest region including the background would have caught it immediately.

The fix was to invert the pipeline: segment regions from colour first, then draw
lines where regions meet. Same photo, same slider, now 70 regions with 60 interior
and a closed silhouette. Closure stops being something you fight for and becomes a
property of the construction.

The lesson worth keeping: the debug region-map view and the logged region counts are
what turned a plausible-looking failure into an obvious one in a single run. Build
the instruments first.

## Tweaking it

**Want a real iPhone app instead of a web app?** Replace the Stack section with Expo
+ React Native + `react-native-skia`. Everything else stays identical. Web-first is
still the faster path to knowing whether the idea feels good, and it wraps to native
later with Capacitor.

**Want cleaner, more deliberate shapes?** Simplify each region boundary with
Douglas–Peucker before drawing it, and render as smoothed paths rather than pixel
borders. This is the single biggest available quality win — it turns the slightly
wobbly contour look into something that reads as drawn.

**Optional additions, once the core works**

- Long-press a region to sample that spot's color from the original photo.
- Print-friendly PDF of the blank line art. Parents and teachers want paper, and no
  competitor does this well.
- Share as a before/after: original photo beside the finished coloring.
