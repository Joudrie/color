/// <reference lib="webworker" />
import { rgbaToLab } from '../lib/color'
import { sobelMagnitude } from '../lib/gradient'
import { median3x3 } from '../lib/median'
import { segmentImage, type Segmentation } from '../lib/segment'
import type { SegmentStats, WorkerRequest } from '../types'

const MAX_EDGE = 1400

/**
 * Lightness counts for ~40% of what hue does when deciding whether two pixels
 * belong to the same thing. Shadows, highlights and wrinkles are L-only
 * variation; object identity lives in a/b.
 */
const L_WEIGHT = 0.4

/**
 * Simple -> detailed.
 *
 * `k` over-segments on colour; `colorThreshold` then merges neighbours back
 * together below that perceptual distance — that pair is what decides whether a
 * shirt reads as one shape or as lighting bands. `minFrac` is the smallest
 * region kept, and `preserve` the colour distance at which a small region is
 * spared anyway (eyes, nostrils, lips).
 */
/**
 * `edgePct` is a percentile of the photo's own gradient distribution, not an
 * absolute number. A textured photo (fur, foliage) has strong gradients
 * everywhere, so "this is a real edge" has to mean "strong relative to *this*
 * image" — an absolute threshold protects every fur strand in one photo and
 * nothing at all in another.
 */
const LEVELS = [
  { k: 10, minFrac: 0.0022, colorThreshold: 15, preserve: 17, edgePct: 0.985, lineWeight: 1 },
  { k: 14, minFrac: 0.0013, colorThreshold: 13, preserve: 16, edgePct: 0.98, lineWeight: 1 },
  { k: 18, minFrac: 0.0008, colorThreshold: 11, preserve: 15, edgePct: 0.975, lineWeight: 1 },
  { k: 24, minFrac: 0.00045, colorThreshold: 9, preserve: 14, edgePct: 0.97, lineWeight: 0 },
  { k: 30, minFrac: 0.00025, colorThreshold: 7, preserve: 12, edgePct: 0.965, lineWeight: 0 },
]

interface Loaded {
  w: number
  h: number
  lab: Float32Array
  rgba: Uint8ClampedArray
  grad: Float32Array
  gradPercentile: (p: number) => number
}

let state: Loaded | null = null
let lastEdgeThreshold = 0
const cache = new Map<number, Segmentation>()

function medianRGB(rgba: Uint8ClampedArray, w: number, h: number, passes: number): Uint8ClampedArray {
  const n = w * h
  const out = new Uint8ClampedArray(rgba.length)
  for (let c = 0; c < 3; c++) {
    let plane: Uint8ClampedArray = new Uint8ClampedArray(n)
    for (let i = 0; i < n; i++) plane[i] = rgba[i * 4 + c]
    for (let p = 0; p < passes; p++) plane = median3x3(plane, w, h)
    for (let i = 0; i < n; i++) out[i * 4 + c] = plane[i]
  }
  for (let i = 0; i < n; i++) out[i * 4 + 3] = 255
  return out
}

function load(bitmap: ImageBitmap): void {
  const t0 = performance.now()
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, w, h)
  const raw = ctx.getImageData(0, 0, w, h).data
  bitmap.close()

  // Smooth in colour, not luma: the segmentation downstream is a colour
  // decision, so texture has to come out of all three channels.
  const rgba = medianRGB(raw, w, h, 2)
  const lab = rgbaToLab(rgba, w * h, L_WEIGHT)

  // True luma, unweighted — this is the "is there actually an edge here?"
  // signal the merge steps consult, so it must not be the flattened L.
  const gray = new Uint8ClampedArray(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    gray[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]
  }
  const grad = sobelMagnitude(gray, w, h)

  const BINS = 1024
  let gradMax = 0
  for (let i = 0; i < grad.length; i++) if (grad[i] > gradMax) gradMax = grad[i]
  const hist = new Int32Array(BINS)
  const binScale = gradMax > 0 ? (BINS - 1) / gradMax : 0
  for (let i = 0; i < grad.length; i++) hist[(grad[i] * binScale) | 0]++
  const gradPercentile = (p: number): number => {
    const want = p * grad.length
    let acc = 0
    for (let b = 0; b < BINS; b++) {
      acc += hist[b]
      if (acc >= want) return binScale > 0 ? b / binScale : 0
    }
    return gradMax
  }

  cache.clear()
  state = { w, h, lab, rgba, grad, gradPercentile }
  const ms = Math.round(performance.now() - t0)
  console.log(`[pipeline] loaded ${w}x${h} in ${ms}ms`)
  self.postMessage({ type: 'loaded', width: w, height: h, ms })
}

function levelFor(detail: number): number {
  return Math.min(LEVELS.length - 1, Math.max(0, Math.round(detail * (LEVELS.length - 1))))
}

function segmentAt(levelIndex: number): Segmentation {
  const cached = cache.get(levelIndex)
  if (cached) return cached
  const { w, h, lab, rgba, grad, gradPercentile } = state!
  const { k, minFrac, colorThreshold, preserve, edgePct, lineWeight } = LEVELS[levelIndex]
  const edgeThreshold = gradPercentile(edgePct)
  const seg = segmentImage(lab, rgba, grad, w, h, {
    k,
    minSize: Math.max(24, minFrac * w * h),
    colorThreshold,
    preserveDistance: preserve,
    edgeThreshold,
    lineWeight,
  })
  lastEdgeThreshold = edgeThreshold
  cache.set(levelIndex, seg)
  return seg
}

function renderLine(line: Uint8Array, w: number, h: number): ImageData {
  const img = new ImageData(w, h)
  const d = img.data
  for (let i = 0; i < line.length; i++) {
    const o = i * 4
    const v = line[i] ? 0 : 255
    d[o] = v
    d[o + 1] = v
    d[o + 2] = v
    d[o + 3] = 255
  }
  return img
}

function hslToRgb(hDeg: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = hDeg / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = l - c / 2
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/** False-colour the region map: adjacent shapes in different hues means the
 *  segmentation is sound; one hue spanning two shapes means a leak. */
function renderDebug(seg: Segmentation, w: number, h: number): ImageData {
  const img = new ImageData(w, h)
  const d = img.data
  const palette = new Uint8ClampedArray(seg.count * 3)
  const GOLDEN = 0.618033988749895
  for (let id = 0; id < seg.count; id++) {
    const [r, g, b] = hslToRgb((((id + 1) * GOLDEN) % 1) * 360, 0.7, 0.6)
    palette[id * 3] = r
    palette[id * 3 + 1] = g
    palette[id * 3 + 2] = b
  }
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    if (seg.line[i]) {
      d[o] = 20
      d[o + 1] = 20
      d[o + 2] = 20
    } else {
      const id = seg.labels[i]
      d[o] = palette[id * 3]
      d[o + 1] = palette[id * 3 + 1]
      d[o + 2] = palette[id * 3 + 2]
    }
    d[o + 3] = 255
  }
  return img
}

function statsFor(seg: Segmentation, w: number, h: number, ms: number): SegmentStats {
  const n = w * h
  let ink = 0
  for (let i = 0; i < n; i++) ink += seg.line[i]

  let largestInterior = 0
  let interiorCount = 0
  let fillable = 0
  for (let id = 0; id < seg.count; id++) {
    fillable += seg.size[id]
    if (seg.touchesBorder[id]) continue
    interiorCount++
    if (seg.size[id] > largestInterior) largestInterior = seg.size[id]
  }

  let largestOverall = 0
  for (let id = 0; id < seg.count; id++) {
    if (seg.size[id] > largestOverall) largestOverall = seg.size[id]
  }

  return {
    regions: seg.count,
    interiorRegions: interiorCount,
    largestInteriorShare: fillable > 0 ? largestInterior / fillable : 0,
    // Includes the background, so a runaway region can't hide behind
    // "it touches the border" the way it did in the edge-detection build.
    largestOverallShare: fillable > 0 ? largestOverall / fillable : 0,
    inkShare: ink / n,
    lowContrast: seg.count < 20,
    ms,
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      load(msg.bitmap)
      return
    }
    if (!state) return
    const { w, h } = state

    if (msg.type === 'segment') {
      const t0 = performance.now()
      const seg = segmentAt(levelFor(msg.detail))
      const stats = statsFor(seg, w, h, Math.round(performance.now() - t0))

      const lineImg = renderLine(seg.line, w, h)
      const debugImg = renderDebug(seg, w, h)

      console.log(
        `[pipeline] detail=${msg.detail.toFixed(2)} regions=${stats.regions} ` +
          `interior=${stats.interiorRegions} largest=${(stats.largestOverallShare * 100).toFixed(1)}% ` +
          `ink=${(stats.inkShare * 100).toFixed(1)}% edgeT=${lastEdgeThreshold.toFixed(0)} ${stats.ms}ms`,
      )

      self.postMessage({ type: 'segment', line: lineImg, debug: debugImg, stats }, [
        lineImg.data.buffer,
        debugImg.data.buffer,
      ])
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
