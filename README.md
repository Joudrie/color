# Colorbook

Turns a photo into a coloring page in the browser. No backend, no upload — the whole
pipeline runs on-device in a Web Worker.

Step 1 of [`PROMPT.md`](./PROMPT.md): photo → line art, with a Detail slider and a
debug region-map view. Tap-to-fill is step 2 and not built yet.

```bash
npm install
npm run dev
```

## How it works

Lines are derived from regions, not regions from lines. Edge detection on a photo
produces open contours — outlines with gaps — so a flood fill escapes and floods the
page. Instead the image is segmented into regions first, and the lines are simply
where two regions meet. Every enclosed area is closed by construction, so a fill has
nowhere to leak to.

    decode (EXIF-aware) → downscale to 1400px → median smooth (RGB)
      → CIELAB with L scaled to 0.4 → Sobel gradient over true luma
      → k-means quantise → majority filter
      → connected-component labeling
      → merge small → merge similar → merge small
      → lines = region boundaries

Two things keep the lines on objects rather than on lighting:

**Lightness is worth 0.4 of what hue is.** Shadows, highlights and wrinkles are
almost entirely L variation, while "still the same blue shirt" across a highlight is
an a/b fact. At full L weight, every lit surface bands into contour lines.

**Merging is edge-aware.** Two adjacent regions merge only if their colours are
close *and* the border between them isn't a real edge. A shirt's lighting band and
an eye look identical to a clustering algorithm — the difference is that one border
is a gradual ramp and the other is a step, which the Sobel gradient measures. The
threshold is a percentile of the photo's own gradient distribution, so a furry
subject and a flat one both get a sensible answer. Small regions get the same
protection, which is what keeps eyes, nostrils and lips from dissolving.

The Detail slider sets the cluster count, minimum region size, and both merge
thresholds together. Each of the five levels is cached after its first render.

| file | what it does |
| --- | --- |
| `src/lib/color.ts` | sRGB→CIELAB with L weighting, k-means++ quantisation |
| `src/lib/gradient.ts` | Sobel magnitude — the "is this a real edge?" signal |
| `src/lib/median.ts` | 3×3 median via a median-of-9 sorting network |
| `src/lib/majority.ts` | square mode filter over the cluster indices |
| `src/lib/labeling.ts` | two-pass union-find connected components |
| `src/lib/segment.ts` | edge-aware region merging, boundary extraction |
| `src/lib/morphology.ts` | separable binary dilation |
| `src/worker/pipeline.worker.ts` | orchestration, rendering, stats |

## Checking the output

Tick **Show region map** to false-colour the segmentation. Correct output looks like
a stained-glass window: every shape its own hue, adjacent shapes clearly different.
One hue spanning two separate objects is a leak.

The readout under the canvas reports region count, interior regions, largest region
share, ink share, and elapsed ms. A healthy photo gives 30–150 regions with most of
them interior.

## Known limits

- Smooth-gradient photos (night skies, fog, sunsets) segment into concentric contour
  bands — a valid coloring page and a bad one.
- Thin lighting ribbons survive along arms and shoulders. A thinness test to remove
  them was tried and reverted: a smiling eye is a crescent, so any threshold that
  catches a shading ribbon also deletes the eyes.
- Heavily textured subjects (a wrinkled pug, curly fur) come out as pleasant
  abstract shapes without resolved features. The wrinkles are genuine strong edges,
  so they're correctly kept — nothing in the pipeline knows an eye matters more
  than a fold.
- Faces are clean and recognisable but flat: no shading, jawline often implied
  rather than drawn. That's the right look for a coloring page.
