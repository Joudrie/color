/// <reference lib="webworker" />
import { boxBlur } from '../lib/boxblur'
import { rgbaToLab } from '../lib/color'
import { extractChains, simplify, smooth, type Chain } from '../lib/contours'
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
const L_WEIGHT = 0.5

/**
 * Flat-field radius as a fraction of the long edge. The blurred luminance at
 * this scale *is* the lighting: subtract it and a cheek shadow stops existing
 * as a colour difference at all, so nothing downstream can outline it. Too
 * small a radius starts eating real tonal differences between objects.
 */
const FLATFIELD_FRACTION = 0.14

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
  { k: 10, minFrac: 0.0022, colorThreshold: 15, preserve: 17, edgePct: 0.985, ink: 4.2 },
  { k: 14, minFrac: 0.0013, colorThreshold: 13, preserve: 16, edgePct: 0.98, ink: 3.9 },
  { k: 18, minFrac: 0.0008, colorThreshold: 11, preserve: 15, edgePct: 0.975, ink: 3.6 },
  { k: 24, minFrac: 0.00045, colorThreshold: 9, preserve: 14, edgePct: 0.97, ink: 3.2 },
  { k: 30, minFrac: 0.00025, colorThreshold: 7, preserve: 12, edgePct: 0.965, ink: 2.8 },
]

interface Loaded {
  w: number
  h: number
  lab: Float32Array
  rgba: Uint8ClampedArray
  grad: Float32Array
  gradPercentile: (p: number) => number
}

interface Rendered {
  seg: Segmentation
  chains: Chain[]
  ink: number
}

let state: Loaded | null = null
let lastEdgeThreshold = 0
const cache = new Map<number, Rendered>()

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
  const n = w * h
  const lab = rgbaToLab(rgba, n)

  // Flat-field the lightness: estimate the illumination as a very wide blur of
  // L, subtract it, and recentre. Shading and wrinkles are broad, smooth L
  // variation, so they vanish here — while local contrast (an eye against a
  // cheek) is untouched because it is far finer than the blur radius.
  const lPlane = new Float32Array(n)
  for (let i = 0; i < n; i++) lPlane[i] = lab[i * 3]
  const illumination = boxBlur(lPlane, w, h, Math.max(w, h) * FLATFIELD_FRACTION)
  let lMean = 0
  for (let i = 0; i < n; i++) lMean += lPlane[i]
  lMean /= n
  for (let i = 0; i < n; i++) {
    lab[i * 3] = (lPlane[i] - illumination[i] + lMean) * L_WEIGHT
  }

  // True luma, unweighted and un-flattened — this is the "is there actually an
  // edge here?" signal the merge steps consult.
  const gray = new Uint8ClampedArray(n)
  for (let i = 0; i < n; i++) {
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

function segmentAt(levelIndex: number): Rendered {
  const cached = cache.get(levelIndex)
  if (cached) {
    lastEdgeThreshold = 0
    return cached
  }
  const { w, h, lab, rgba, grad, gradPercentile } = state!
  const { k, minFrac, colorThreshold, preserve, edgePct, ink } = LEVELS[levelIndex]
  const edgeThreshold = gradPercentile(edgePct)
  const seg = segmentImage(lab, rgba, grad, w, h, {
    k,
    minSize: Math.max(24, minFrac * w * h),
    colorThreshold,
    preserveDistance: preserve,
    edgeThreshold,
    lineWeight: 0,
  })
  lastEdgeThreshold = edgeThreshold

  // Straighten the pixel staircase, then round the corners. Done once per
  // level; a chain between two junctions keeps its endpoints, so neighbouring
  // chains still meet exactly.
  const chains = extractChains(seg.labels, w, h).map((c) => {
    if (c.pts.length < 6) return c
    return { ...c, pts: smooth(simplify(c.pts, 1.6), 2, c.closed) }
  })

  const entry: Rendered = { seg, chains, ink }
  cache.set(levelIndex, entry)
  return entry
}

/**
 * Stroke weight by hierarchy.
 *
 * With every line the same weight, a background window frame shouts as loudly
 * as an eye and the drawing reads as noise. Heaviest on the silhouette, medium
 * on strong internal contrast, thinnest where two regions barely differ — which
 * also quietly demotes the inter-tooth lines that make a smile look like a
 * snarl.
 */
function strokeWidth(seg: Segmentation, a: number, b: number, base: number): number {
  const dr = seg.meanColor[a * 3] - seg.meanColor[b * 3]
  const dg = seg.meanColor[a * 3 + 1] - seg.meanColor[b * 3 + 1]
  const db = seg.meanColor[a * 3 + 2] - seg.meanColor[b * 3 + 2]
  const contrast = Math.min(1, Math.hypot(dr, dg, db) / 160)

  const silhouette = seg.touchesBorder[a] !== seg.touchesBorder[b]
  if (silhouette) return base * 1.5

  // Never let a line fade to nothing — a border that renders as pale grey looks
  // like a printing fault, and it has to survive being photocopied.
  return base * (0.55 + 0.6 * contrast)
}

function renderChains(entry: Rendered, w: number, h: number): ImageData {
  const { seg, chains, ink } = entry
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = '#141414'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const c of chains) {
    if (c.pts.length < 4) continue
    ctx.lineWidth = strokeWidth(seg, c.a, c.b, ink)
    ctx.beginPath()
    ctx.moveTo(c.pts[0], c.pts[1])
    for (let i = 2; i < c.pts.length; i += 2) ctx.lineTo(c.pts[i], c.pts[i + 1])
    ctx.stroke()
  }

  return ctx.getImageData(0, 0, w, h)
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
      const entry = segmentAt(levelFor(msg.detail))
      const seg = entry.seg
      const stats = statsFor(seg, w, h, Math.round(performance.now() - t0))

      const lineImg = renderChains(entry, w, h)
      const debugImg = renderDebug(seg, w, h)

      console.log(
        `[pipeline] detail=${msg.detail.toFixed(2)} regions=${stats.regions} ` +
          `interior=${stats.interiorRegions} largest=${(stats.largestOverallShare * 100).toFixed(1)}% ` +
          `chains=${entry.chains.length} edgeT=${lastEdgeThreshold.toFixed(0)} ${stats.ms}ms`,
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
