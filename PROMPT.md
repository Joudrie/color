# Build prompt — photo → coloring book app

Copy everything in the fenced block below into Claude Code (or Cursor / Lovable / v0)
as your first message. Notes on how to adjust it are at the bottom.

---

```
Build a web app called Colorbook that turns a user's photo into a coloring page
they can fill in with a paint-bucket tool. Mobile-first, works in a phone browser,
no login, no backend — everything runs on-device in the browser.

## The user flow

1. Upload / take a photo.
2. It converts to clean black line art on white. Show a "Detail" slider
   (Simple → Detailed) they can drag to re-render live.
3. Tap "Color it" → the line art becomes a colorable canvas.
4. Tap a palette color, tap any region, it fills instantly with a flat color.
5. Undo, redo, reset, and a "Save image" button that downloads the PNG.

## The one thing that makes or breaks this app

Every competitor gets this wrong, so read carefully.

If you run edge detection and then run a pixel-level flood fill on the result at
tap time, the app WILL feel broken: edge-detected lines have single-pixel gaps and
anti-aliased soft edges, so fills leak out of the shape and flood half the picture.
That is the #1 complaint about every app in this category.

Do it this way instead — **precompute a region map before the user ever taps:**

1. Generate the line art (algorithm below).
2. Binarize it hard: every pixel is either LINE or FILLABLE. No gray, no alpha.
3. Morphologically close the line layer (dilate then erode) so hairline gaps in the
   strokes seal shut BEFORE segmentation.
4. Run connected-component labeling over the FILLABLE pixels once, up front. Store
   the result as an Int32Array `regionMap` the same size as the canvas, where each
   entry is a region id.
5. Discard/merge regions smaller than ~150px into their largest neighbor, so the
   user never taps a speck that fills nothing.
6. On tap: look up `regionMap[y * width + x]`, then paint every pixel with that id.
   O(1) lookup, no traversal, cannot leak, feels instant even on a big image.

Render as three stacked layers: white background, the user's fill layer, and the
black line layer composited on top. That way lines always stay crisp and on top of
color, and undo is just swapping the fill layer.

## Line art algorithm

Aim for FEW, THICK, CLOSED lines — a coloring page, not a photocopy. When in doubt,
throw detail away. A simple page that colors nicely beats a detailed one that
doesn't.

1. Downscale the photo so the long edge is ~1400px.
2. Bilateral filter (or a couple of median-blur passes) to kill texture and noise
   while keeping real edges. Skin, grass, and fabric texture must NOT become lines.
3. Convert to grayscale.
4. Extract edges with XDoG (difference-of-Gaussians with a thresholding curve) —
   it produces smoother, more connected, more hand-drawn strokes than Canny.
   Fall back to adaptive threshold if XDoG is too slow.
5. Despeckle: drop connected line blobs under a few hundred px.
6. Dilate the surviving lines to ~2-3px so they read as ink and so the closing step
   in the region pipeline has something solid to work with.

The Detail slider should drive the blur radius and the XDoG threshold together —
low detail = heavier blur + higher threshold = fewer, bolder lines.

## Stack

- Vite + React + TypeScript.
- All image work in plain Canvas 2D + typed arrays. Do the heavy pipeline in a Web
  Worker so the UI doesn't freeze, and show a progress state while it runs.
- No image-processing npm dependencies unless one is genuinely necessary — hand-write
  the convolutions and the labeling pass.
- Tailwind for styling. Keep the UI nearly empty: the artwork is the interface.

## Quality bar

- A tap must never leak color outside the shape the user aimed at. This is the
  whole product.
- Fill must feel instant — under 50ms from tap to painted.
- Everything must work with a thumb on a phone. Big tap targets, no hover states,
  no accidental scrolling while coloring.
- Pinch to zoom and two-finger pan on the coloring canvas, because small regions are
  impossible to hit otherwise.

## Build order

Build it in this order and stop after each step so I can look at it:

1. Upload a photo → show line art on screen, with a working Detail slider.
2. Region map + tap-to-fill with a fixed 12-color palette.
3. Undo/redo, reset, save PNG, pinch-zoom.

Start with step 1.
```

---

## Tweaking it

**Want a real iPhone app instead of a web app?** Replace the Stack section with
Expo + React Native + `react-native-skia` for the canvas. Everything else in the
prompt stays identical. Web-first is still the faster path to knowing whether the
idea feels good, and it wraps to native later with Capacitor.

**Want it to look hand-drawn rather than machine-traced?** Add: "After generating
line art, redraw each contour as a slightly wobbling variable-width stroke so it
reads as pen-on-paper rather than a filter."

**Optional additions, once the core works**

- A "fill everything with the original photo's colors" button — one tap, and the
  page becomes a soft painted version of the photo. Good for the moment where
  someone gives up on a hard page.
- Long-press a region to sample a color from the original photo at that spot.
- Print-friendly PDF export of the blank line art. Parents and teachers want paper,
  and no competitor does this well.
- Save the palette used per image and let people share finished pages as before/after.
