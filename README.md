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
      → CIELAB → k-means quantise → majority filter
      → connected-component labeling → merge small regions
      → lines = region boundaries

The Detail slider sets the cluster count and the minimum region size together — how
many shapes the page has. Each of the five levels is cached after its first render.

| file | what it does |
| --- | --- |
| `src/lib/color.ts` | sRGB→CIELAB, k-means++ quantisation |
| `src/lib/median.ts` | 3×3 median via a median-of-9 sorting network |
| `src/lib/majority.ts` | 3×3 mode filter over the cluster indices |
| `src/lib/labeling.ts` | two-pass union-find connected components |
| `src/lib/segment.ts` | region merging, boundary extraction |
| `src/lib/morphology.ts` | separable binary dilate/erode |
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
- Faces lose fine features; eyes and mouths come out as flat shapes. More clusters
  doesn't fix it, it just adds noise elsewhere.
