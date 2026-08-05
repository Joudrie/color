# Build prompt — photo → coloring book app

Copy everything in the fenced block below into Claude Code (or Cursor / Lovable / v0)
as your first message. Notes on adjusting it, and the reasoning behind the tricky
parts, are at the bottom.

---

```
Build a web app called Colorbook that turns a user's photo into a coloring page they
can fill in with a paint-bucket tool. Mobile-first, works in a phone browser, no
login, no backend — everything runs on-device.

## User flow

1. Upload or take a photo.
2. It converts to clean black line art on white. A "Detail" slider (Simple →
   Detailed) re-renders the line art as they drag it.
3. Tap "Color it" → the line art becomes a colorable canvas.
4. Tap a palette color, tap a region, it fills instantly with flat color.
5. Undo, redo, reset, save PNG.

## Architecture — read this section twice, it is the whole product

Never run a pixel flood fill at tap time. Edge-detected lines have single-pixel gaps
and soft anti-aliased edges, so a tap-time flood escapes the shape and floods half
the image. That is the #1 complaint about every app in this category.

Instead, segment the image into regions once, up front, and make a tap a lookup.

**Pipeline (runs in a Web Worker):**

1. Generate line art (algorithm below).
2. Binarize hard — every pixel is LINE or FILLABLE. No gray, no alpha, no
   in-between. Everything downstream depends on this being strictly binary.
3. Seal gaps: morphological close on the LINE layer (dilate radius 2, then erode
   radius 2). This joins hairline breaks before segmentation, which is what actually
   prevents leaks.
4. Connected-component labeling (two-pass with union-find, 4-connectivity) over the
   FILLABLE pixels. Output an `Int32Array regionMap` of width*height holding a
   region id per pixel, plus for each region: pixel count and bounding box. The
   bounding boxes matter — see rendering.
5. Absorb specks: any region smaller than 0.01% of image area becomes LINE. Do not
   try to merge it into a neighbor; specks are line noise, and absorbing is simpler
   and looks better. Re-label after absorbing.
6. Leak check: if any single region other than the outer background covers more than
   35% of fillable area, the line art has a hole. Automatically re-run from step 3
   with close radius 3, then 4. If it still fails, keep the best result and continue
   — do not block the user.

**Tap handling:** `regionMap[y * width + x]` → a region id. That is the whole
operation. No traversal.

**Document model — this is not the canvas.** The user's artwork is exactly:

    Map<regionId, colorIndex>

That is the entire saved state. It is a few hundred bytes, not a bitmap. Therefore:
- Undo/redo is a stack of `{regionId, from, to}`. Never snapshot the canvas — at
  1400px a single RGBA snapshot is ~7.8MB and a 20-step undo stack will crash mobile
  Safari.
- Reset is `map.clear()`.
- Save/resume progress across reloads is JSON in localStorage, for free.

**Rendering:** three stacked layers — white base, fill layer, black line layer on
top (so lines always stay crisp over color). On a fill, repaint only the filled
region's bounding box, not the whole canvas. Full repaint only on load and undo-all.

## Line art algorithm

Aim for FEW, THICK, CLOSED lines — a coloring page, not a photocopy. When in doubt,
throw detail away. A simple page that colors nicely beats a detailed one that
doesn't.

1. Decode with `createImageBitmap(file, { imageOrientation: 'from-image' })`. Do not
   skip this — phone photos carry EXIF rotation and will render sideways otherwise.
2. Downscale so the long edge is 1400px. All processing happens at this resolution;
   display is separate.
3. Edge-preserving smooth to kill texture — skin pores, grass, and fabric weave must
   not become lines. Use 2–3 passes of a 3×3 median filter (fast, hand-writable). A
   true bilateral filter is better but too slow in JS at this size; don't bother.
4. Grayscale (luma: 0.299R + 0.587G + 0.114B).
5. Difference of Gaussians. Blur at σ and at 1.6σ using a **separable** kernel (two
   1-D passes, not a 2-D convolution — 2-D is ~10× slower for identical output).
   Then `dog = blurA - 0.985 * blurB`.
   Starting values: σ ranges 1.0 (detailed) to 3.0 (simple); threshold ε around 0.5
   on a 0–255 scale. Skip the XDoG tanh soft-thresholding curve — we binarize
   anyway, so hard-threshold the DoG directly.
6. Despeckle the LINE layer: drop line blobs under 0.005% of image area.
7. Dilate surviving lines to 2–3px so they read as ink.

**Making the slider actually live:** steps 1–4 run once on upload. Precompute the
DoG at four fixed σ values (1.0 / 1.7 / 2.4 / 3.0) during that initial pass and keep
all four. The slider then picks the nearest σ level and varies ε continuously —
re-thresholding is a single cheap pass, so the preview updates every frame while
dragging. Only re-run sealing and labeling (steps 3–6 of the pipeline) on slider
release, not during the drag.

## How to verify your own work

You cannot see the output, so build the instruments:

- A "debug" toggle that renders the region map in false color (deterministic hue per
  region id). This makes leaks visible instantly — a leak looks like one color
  spanning things that should be separate.
- Log after labeling: region count, largest-region share of fillable area, and how
  many close-radius retries were needed.
- Sanity targets on a normal portrait photo at mid-detail: roughly 150–2000 regions,
  largest non-background region under 35%. Ten regions means the line art collapsed;
  50,000 means it's confetti. Either way the pipeline is wrong, not the photo.
- Test with a portrait, a landscape, a pet, and a deliberately dark/low-contrast
  photo. The dark one is the failure case — if it produces under 20 regions, show
  the user "this photo didn't have enough contrast, try another" rather than a blank
  page.

## Stack

- Vite + React + TypeScript, Tailwind for styling.
- Plain Canvas 2D + typed arrays. Hand-write the convolutions, the morphology, and
  the labeling pass — no image-processing dependencies (OpenCV.js is an 8MB wasm
  blob for four functions we need).
- Heavy pipeline in a Web Worker; transfer buffers, don't copy them. Show a progress
  state — the initial pass will take 1–3 seconds and that is fine if it's honest.
- UI nearly empty. The artwork is the interface.

## Acceptance checklist

Each item is testable — verify before telling me a step is done.

- [ ] A photo taken in portrait orientation on a phone displays right-side up.
- [ ] In debug view, no region spans two shapes a human would call separate.
- [ ] Tap-to-painted is under 50ms on a 1400px image.
- [ ] 50 fills then 50 undos leaves memory flat (no canvas snapshots on the stack).
- [ ] Dragging the Detail slider updates the preview without a visible hitch.
- [ ] Pinch-zoom to 4×, pan, then tap — the correct region fills. Screen→image
      coordinate mapping must invert the full pan/zoom transform; getting this wrong
      is the most common bug in this kind of app and it only shows up when zoomed.
- [ ] One finger on the canvas paints; two fingers pan/zoom; the page itself never
      scrolls while a finger is on the canvas.
- [ ] Reload the page mid-coloring and the work is still there.

## Build order

Stop after each step so I can look at it.

1. Upload → line art on screen + working Detail slider + debug region-map toggle.
2. Region map + tap-to-fill with a fixed palette.
3. Undo/redo, reset, save PNG, pinch-zoom, localStorage persistence.

Use a palette of ~24 colors: light and dark versions of each hue, four skin tones,
and warm neutrals. Avoid fully saturated primaries — they look cheap next to black
line art.

Start with step 1.
```

---

## What changed and why

The first draft of this prompt had two bugs that would have shipped:

**Canvas snapshots for undo.** "Undo is just swapping the fill layer" means storing a
full bitmap per step — ~7.8MB each at 1400px. Twenty steps is 156MB and a crash on
mobile Safari. Fixing it revealed the better design: because fills are region-based,
the document is just `Map<regionId, color>`. That makes undo trivial, and it makes
save/resume and instant reset fall out for free.

**"Cannot leak" was an overclaim.** Precomputing regions doesn't stop leaks — if a
gap connects two areas, they become one region and the tap still fills both. It makes
leaks *deterministic and detectable* instead of random. That's actually the stronger
property, because you can catch a bad segmentation automatically and re-seal harder
before the user ever sees it. Hence the leak check in step 6.

The rest: EXIF orientation (a guaranteed sideways-photo bug), concrete DoG constants
so the agent isn't guessing at an algorithm it can't visually check, a slider design
that's affordable to run live, the debug region-map view, and a testable checklist in
place of vague quality goals.

## Tweaking it

**Want a real iPhone app instead of a web app?** Replace the Stack section with Expo
+ React Native + `react-native-skia`. Everything else stays identical. Web-first is
still the faster path to knowing whether the idea feels good, and it wraps to native
later with Capacitor.

**Want it hand-drawn rather than machine-traced?** Add: "After generating line art,
redraw each contour as a slightly wobbling variable-width stroke so it reads as
pen-on-paper rather than a filter."

**Optional additions, once the core works**

- "Fill with the photo's real colors" — average the original photo's pixels within
  each region and assign. One pass, nearly free given the architecture, and it
  rescues the moment where someone gives up on a hard page.
- Long-press a region to sample that spot's color from the original photo.
- Print-friendly PDF of the blank line art. Parents and teachers want paper, and no
  competitor does this well.
- Share as a before/after: original photo beside the finished coloring.
