/// <reference lib="webworker" />
import { rgbaToLab } from '../lib/color'
import { median3x3 } from '../lib/median'
import { segmentImage, type Segmentation } from '../lib/segment'
import type { SegmentStats, WorkerRequest } from '../types'

const MAX_EDGE = 1400

/**
 * Simple -> detailed. `k` is the colour-quantisation count, `minFrac` the
 * smallest region we keep as a share of image area. Together they set how many
 * shapes the page has, which is the only thing "detail" means on a coloring page.
 */
const LEVELS = [
  { k: 6, minFrac: 0.0022, lineWeight: 1 },
  { k: 9, minFrac: 0.0013, lineWeight: 1 },
  { k: 12, minFrac: 0.0008, lineWeight: 1 },
  { k: 16, minFrac: 0.00045, lineWeight: 0 },
  { k: 22, minFrac: 0.00025, lineWeight: 0 },
]

interface Loaded {
  w: number
  h: number
  lab: Float32Array
  rgba: Uint8ClampedArray
}

let state: Loaded | null = null
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
  const lab = rgbaToLab(rgba, w * h)

  cache.clear()
  state = { w, h, lab, rgba }
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
  const { w, h, lab, rgba } = state!
  const { k, minFrac, lineWeight } = LEVELS[levelIndex]
  const seg = segmentImage(lab, rgba, w, h, k, Math.max(24, minFrac * w * h), lineWeight)
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
          `ink=${(stats.inkShare * 100).toFixed(1)}% ${stats.ms}ms`,
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
