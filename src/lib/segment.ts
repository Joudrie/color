import { assignClusters, kmeansCentroids } from './color'
import { labelByValue } from './labeling'
import { majorityFilter } from './majority'
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

interface Labelling {
  labels: Int32Array
  count: number
  size: Int32Array
}

// A thinness (isoperimetric) test was tried here to remove the lighting ribbons
// that survive along arms and shoulders. It was reverted: squinting or smiling
// eyes are crescents, so any threshold that catches a shading ribbon also
// deletes the eyes. Losing a feature to remove an artefact is a bad trade.

function makeUnionFind(count: number) {
  const parent = new Int32Array(count)
  for (let i = 0; i < count; i++) parent[i] = i
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
  const union = (a: number, b: number): boolean => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return false
    parent[ra] = rb
    return true
  }
  return { find, union }
}

function compact(labels: Int32Array, count: number, find: (a: number) => number): Labelling {
  const remap = new Int32Array(count).fill(-1)
  let next = 0
  for (let i = 0; i < count; i++) {
    if (find(i) === i) remap[i] = next++
  }
  const out = new Int32Array(labels.length)
  const size = new Int32Array(next)
  for (let i = 0; i < labels.length; i++) {
    const id = remap[find(labels[i])]
    out[i] = id
    size[id]++
  }
  return { labels: out, count: next, size }
}

/** Mean Lab per region. Distances are measured in the *weighted* Lab passed in,
 *  so lightness differences count for less than hue differences. */
function regionMeans(labels: Int32Array, count: number, size: Int32Array, lab: Float32Array): Float32Array {
  const sums = new Float64Array(count * 3)
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i]
    const t = i * 3
    sums[id * 3] += lab[t]
    sums[id * 3 + 1] += lab[t + 1]
    sums[id * 3 + 2] += lab[t + 2]
  }
  const means = new Float32Array(count * 3)
  for (let id = 0; id < count; id++) {
    const s = size[id] || 1
    means[id * 3] = sums[id * 3] / s
    means[id * 3 + 1] = sums[id * 3 + 1] / s
    means[id * 3 + 2] = sums[id * 3 + 2] / s
  }
  return means
}

function colorDistance(means: Float32Array, a: number, b: number): number {
  const dl = means[a * 3] - means[b * 3]
  const da = means[a * 3 + 1] - means[b * 3 + 1]
  const db = means[a * 3 + 2] - means[b * 3 + 2]
  return Math.sqrt(dl * dl + da * da + db * db)
}

/**
 * Shared border length and mean gradient along it, for every adjacent pair.
 * Keyed a*count+b with a<b.
 *
 * The gradient is the interesting half: a border running along a strong
 * luminance edge is a real feature outline, while a weak one is just where two
 * shading bands happened to meet.
 */
function adjacency(
  labels: Int32Array,
  count: number,
  w: number,
  h: number,
  grad: Float32Array,
): { shared: Map<number, number>; strength: Map<number, number> } {
  const shared = new Map<number, number>()
  const gradSum = new Map<number, number>()
  const bump = (a: number, b: number, g: number) => {
    const key = a < b ? a * count + b : b * count + a
    shared.set(key, (shared.get(key) ?? 0) + 1)
    gradSum.set(key, (gradSum.get(key) ?? 0) + g)
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const i = row + x
      const a = labels[i]
      if (x + 1 < w && labels[i + 1] !== a) {
        bump(a, labels[i + 1], Math.max(grad[i], grad[i + 1]))
      }
      if (y + 1 < h && labels[i + w] !== a) {
        bump(a, labels[i + w], Math.max(grad[i], grad[i + w]))
      }
    }
  }
  const strength = new Map<number, number>()
  for (const [key, sum] of gradSum) strength.set(key, sum / (shared.get(key) ?? 1))
  return { shared, strength }
}

/**
 * Merge adjacent regions that are close in colour *and* not separated by a real
 * edge.
 *
 * This is what turns "a T-shirt in five lighting bands" into "a T-shirt" while
 * leaving an eye or a nostril intact: the shirt's internal borders are gradual
 * shading ramps, the eye's border is a step. Only one merge per region per
 * pass, so a smooth gradient can't chain-collapse in a single go; repeated
 * passes handle the rest under control.
 */
function mergeSimilarRegions(
  input: Labelling,
  w: number,
  h: number,
  lab: Float32Array,
  grad: Float32Array,
  threshold: number,
  edgeThreshold: number,
  maxPasses = 4,
): Labelling {
  let cur = input

  for (let pass = 0; pass < maxPasses; pass++) {
    if (cur.count < 2) break
    const means = regionMeans(cur.labels, cur.count, cur.size, lab)
    const { shared, strength } = adjacency(cur.labels, cur.count, w, h, grad)

    const edges: { a: number; b: number; d: number }[] = []
    for (const key of shared.keys()) {
      if ((strength.get(key) ?? 0) >= edgeThreshold) continue
      const a = Math.floor(key / cur.count)
      const b = key % cur.count
      const d = colorDistance(means, a, b)
      if (d < threshold) edges.push({ a, b, d })
    }
    if (edges.length === 0) break
    edges.sort((p, q) => p.d - q.d)

    const uf = makeUnionFind(cur.count)
    const touched = new Uint8Array(cur.count)
    let merged = 0
    for (const { a, b } of edges) {
      if (touched[a] || touched[b]) continue
      if (!uf.union(a, b)) continue
      touched[a] = 1
      touched[b] = 1
      merged++
    }
    if (merged === 0) break
    cur = compact(cur.labels, cur.count, uf.find)
  }

  return cur
}

/**
 * Absorb regions below `minSize` into whichever neighbour shares the longest
 * border with them.
 *
 * A small region whose colour is strongly unlike its neighbours is kept — that
 * exception is what preserves eyes, nostrils and lips, which are exactly the
 * features a plain size threshold deletes and whose loss makes a face read as
 * a blank mask.
 */
function mergeSmallRegions(
  input: Labelling,
  w: number,
  h: number,
  lab: Float32Array,
  grad: Float32Array,
  minSize: number,
  preserveDistance: number,
  edgeThreshold: number,
  hardFloor: number,
  maxPasses = 8,
): Labelling {
  const n = w * h
  let cur = input

  for (let pass = 0; pass < maxPasses; pass++) {
    const small: number[] = []
    const isSmall = new Uint8Array(cur.count)
    for (let id = 0; id < cur.count; id++) {
      if (cur.size[id] < minSize) {
        small.push(id)
        isSmall[id] = 1
      }
    }
    if (small.length === 0) break

    const means = regionMeans(cur.labels, cur.count, cur.size, lab)
    const nbr = new Map<number, Map<number, number>>()
    const nbrGrad = new Map<number, Map<number, number>>()
    const bump = (a: number, b: number, g: number) => {
      let m = nbr.get(a)
      if (!m) {
        m = new Map()
        nbr.set(a, m)
      }
      m.set(b, (m.get(b) ?? 0) + 1)
      let mg = nbrGrad.get(a)
      if (!mg) {
        mg = new Map()
        nbrGrad.set(a, mg)
      }
      mg.set(b, (mg.get(b) ?? 0) + g)
    }

    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w; x++) {
        const i = row + x
        const a = cur.labels[i]
        if (x + 1 < w) {
          const b = cur.labels[i + 1]
          if (a !== b) {
            const g = Math.max(grad[i], grad[i + 1])
            if (isSmall[a]) bump(a, b, g)
            if (isSmall[b]) bump(b, a, g)
          }
        }
        if (y + 1 < h) {
          const b = cur.labels[i + w]
          if (a !== b) {
            const g = Math.max(grad[i], grad[i + w])
            if (isSmall[a]) bump(a, b, g)
            if (isSmall[b]) bump(b, a, g)
          }
        }
      }
    }

    const uf = makeUnionFind(cur.count)
    small.sort((p, q) => cur.size[p] - cur.size[q])
    let merged = 0
    for (const id of small) {
      const m = nbr.get(id)
      if (!m) continue
      let best = -1
      let bestShared = -1
      const root = uf.find(id)
      for (const [nid, shared] of m) {
        if (uf.find(nid) === root) continue
        if (shared > bestShared) {
          bestShared = shared
          best = nid
        }
      }
      if (best < 0) continue
      // Keep a small feature that is either chromatically distinct or ringed by
      // a real edge — eyes, nostrils and lips die here otherwise, and a face
      // without them reads as a blank mask.
      if (cur.size[id] >= hardFloor) {
        const distinct = colorDistance(means, id, best) >= preserveDistance
        const shared = bestShared || 1
        const edged = (nbrGrad.get(id)?.get(best) ?? 0) / shared >= edgeThreshold
        if (distinct || edged) continue
      }
      if (uf.union(id, best)) merged++
    }
    if (merged === 0) break
    cur = compact(cur.labels, cur.count, uf.find)
    if (cur.labels.length !== n) break
  }

  return cur
}

/**
 * Photo -> closed, colourable regions.
 *
 * Over-segment on colour, then merge back on perceptual similarity. Lines are a
 * *consequence* of the regions, which is why every enclosed area is guaranteed
 * fillable.
 */
export function segmentImage(
  lab: Float32Array,
  rgba: Uint8ClampedArray,
  grad: Float32Array,
  w: number,
  h: number,
  opts: {
    k: number
    minSize: number
    colorThreshold: number
    preserveDistance: number
    edgeThreshold: number
    lineWeight: number
  },
): Segmentation {
  const n = w * h
  const { k, minSize, colorThreshold, preserveDistance, edgeThreshold, lineWeight } = opts

  const cent = kmeansCentroids(lab, n, k)
  let idx = assignClusters(lab, n, cent, k)
  idx = majorityFilter(idx, w, h, k, 1)
  idx = majorityFilter(idx, w, h, k, 2)
  idx = majorityFilter(idx, w, h, k, 2)

  const initial = labelByValue(idx, w, h)
  let cur: Labelling = { labels: initial.labels, count: initial.count, size: initial.size }

  const hardFloor = Math.max(24, minSize * 0.12)
  cur = mergeSmallRegions(cur, w, h, lab, grad, minSize, preserveDistance, edgeThreshold, hardFloor)
  cur = mergeSimilarRegions(cur, w, h, lab, grad, colorThreshold, edgeThreshold)
  cur = mergeSmallRegions(cur, w, h, lab, grad, minSize, preserveDistance, edgeThreshold, hardFloor)

  const { labels, count } = cur
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
