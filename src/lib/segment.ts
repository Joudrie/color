import { assignClusters, kmeansCentroids } from './color'
import { labelByValue } from './labeling'
import { majority3x3 } from './majority'
import { dilate } from './morphology'

export interface Segmentation {
  labels: Int32Array
  count: number
  size: Int32Array
  minX: Int32Array
  minY: Int32Array
  maxX: Int32Array
  maxY: Int32Array
  touchesBorder: Uint8Array
  /** Average sRGB per region — powers "fill with the photo's real colours". */
  meanColor: Uint8ClampedArray
  /** 1 where a region boundary is drawn as ink. */
  line: Uint8Array
}

/**
 * Absorb regions below `minSize` into whichever neighbour shares the longest
 * border with them, repeating until nothing small is left.
 *
 * Adjacency is only tracked for small regions, so the bookkeeping stays
 * proportional to the noise rather than to the image.
 */
function mergeSmallRegions(
  labels: Int32Array,
  count: number,
  size: Int32Array,
  w: number,
  h: number,
  minSize: number,
): { labels: Int32Array; count: number } {
  const n = w * h
  let cur = labels
  let curCount = count
  let curSize = size

  for (let pass = 0; pass < 8; pass++) {
    const small: number[] = []
    const isSmall = new Uint8Array(curCount)
    for (let id = 0; id < curCount; id++) {
      if (curSize[id] < minSize) {
        small.push(id)
        isSmall[id] = 1
      }
    }
    if (small.length === 0) break

    const nbr = new Map<number, Map<number, number>>()
    const bump = (a: number, b: number) => {
      let m = nbr.get(a)
      if (!m) {
        m = new Map()
        nbr.set(a, m)
      }
      m.set(b, (m.get(b) ?? 0) + 1)
    }

    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w; x++) {
        const i = row + x
        const a = cur[i]
        if (x + 1 < w) {
          const b = cur[i + 1]
          if (a !== b) {
            if (isSmall[a]) bump(a, b)
            if (isSmall[b]) bump(b, a)
          }
        }
        if (y + 1 < h) {
          const b = cur[i + w]
          if (a !== b) {
            if (isSmall[a]) bump(a, b)
            if (isSmall[b]) bump(b, a)
          }
        }
      }
    }

    const parent = new Int32Array(curCount)
    for (let i = 0; i < curCount; i++) parent[i] = i
    const find = (a: number): number => {
      let root = a
      while (parent[root] !== root) root = parent[root]
      while (parent[a] !== root) {
        const up = parent[a]
        parent[a] = root
        a = up
      }
      return root
    }

    small.sort((p, q) => curSize[p] - curSize[q])
    let merged = 0
    for (const id of small) {
      const m = nbr.get(id)
      if (!m) continue
      let best = -1
      let bestShared = -1
      const rootId = find(id)
      for (const [nid, shared] of m) {
        if (find(nid) === rootId) continue
        if (shared > bestShared) {
          bestShared = shared
          best = nid
        }
      }
      if (best < 0) continue
      const ra = find(id)
      const rb = find(best)
      if (ra !== rb) {
        parent[ra] = rb
        merged++
      }
    }
    if (merged === 0) break

    const remap = new Int32Array(curCount).fill(-1)
    let nc = 0
    for (let i = 0; i < curCount; i++) {
      if (find(i) === i) remap[i] = nc++
    }
    const next = new Int32Array(n)
    const nextSize = new Int32Array(nc)
    for (let i = 0; i < n; i++) {
      const id = remap[find(cur[i])]
      next[i] = id
      nextSize[id]++
    }
    cur = next
    curCount = nc
    curSize = nextSize
  }

  return { labels: cur, count: curCount }
}

/**
 * Photo -> closed, colourable regions.
 *
 * Quantise colour, smooth the index map, label connected areas, absorb the
 * small ones, then draw the borders. Lines are a *consequence* of the regions,
 * which is why every enclosed area is guaranteed fillable.
 */
export function segmentImage(
  lab: Float32Array,
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  k: number,
  minSize: number,
  lineWeight: number,
): Segmentation {
  const n = w * h

  const cent = kmeansCentroids(lab, n, k)
  let idx = assignClusters(lab, n, cent, k)
  idx = majority3x3(idx, w, h, k)
  idx = majority3x3(idx, w, h, k)

  const initial = labelByValue(idx, w, h)
  const { labels, count } = mergeSmallRegions(initial.labels, initial.count, initial.size, w, h, minSize)

  const size = new Int32Array(count)
  const minX = new Int32Array(count).fill(w)
  const minY = new Int32Array(count).fill(h)
  const maxX = new Int32Array(count).fill(-1)
  const maxY = new Int32Array(count).fill(-1)
  const touchesBorder = new Uint8Array(count)
  const sumR = new Float64Array(count)
  const sumG = new Float64Array(count)
  const sumB = new Float64Array(count)

  for (let y = 0; y < h; y++) {
    const row = y * w
    const edgeRow = y === 0 || y === h - 1
    for (let x = 0; x < w; x++) {
      const i = row + x
      const id = labels[i]
      size[id]++
      if (x < minX[id]) minX[id] = x
      if (x > maxX[id]) maxX[id] = x
      if (y < minY[id]) minY[id] = y
      if (y > maxY[id]) maxY[id] = y
      if (edgeRow || x === 0 || x === w - 1) touchesBorder[id] = 1
      const o = i * 4
      sumR[id] += rgba[o]
      sumG[id] += rgba[o + 1]
      sumB[id] += rgba[o + 2]
    }
  }

  const meanColor = new Uint8ClampedArray(count * 3)
  for (let id = 0; id < count; id++) {
    const s = size[id] || 1
    meanColor[id * 3] = sumR[id] / s
    meanColor[id * 3 + 1] = sumG[id] / s
    meanColor[id * 3 + 2] = sumB[id] / s
  }

  // Ink every pixel that touches a different region — the border falls between
  // regions rather than eating into one side.
  let line: Uint8Array = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const i = row + x
      const id = labels[i]
      if (
        (x + 1 < w && labels[i + 1] !== id) ||
        (x > 0 && labels[i - 1] !== id) ||
        (y + 1 < h && labels[i + w] !== id) ||
        (y > 0 && labels[i - w] !== id)
      ) {
        line[i] = 1
      }
    }
  }
  if (lineWeight > 0) line = dilate(line, w, h, lineWeight)

  return { labels, count, size, minX, minY, maxX, maxY, touchesBorder, meanColor, line }
}
