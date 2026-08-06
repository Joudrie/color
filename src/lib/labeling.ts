/**
 * Two-pass connected-component labeling with union-find, 4-connectivity.
 *
 * This is what makes a tap O(1): every enclosed area gets an id once, up front,
 * so filling is a lookup instead of a traversal that can escape through a gap.
 */

export interface Regions {
  /** Region id per pixel, or -1 where the pixel is not part of the labeled set. */
  labels: Int32Array
  count: number
  size: Int32Array
  minX: Int32Array
  minY: Int32Array
  maxX: Int32Array
  maxY: Int32Array
  /** Regions touching the image edge — the outer background, not real shapes. */
  touchesBorder: Uint8Array
}

/**
 * Label connected runs of *equal value* — every pixel gets a region.
 *
 * This is the one that matters for a coloring page: regions come out of the
 * image content itself, so each is closed by construction and a fill has
 * nowhere to escape to. Deriving lines from region borders (rather than
 * deriving regions from detected lines) is what makes leaks impossible.
 */
export function labelByValue(src: Uint8Array, w: number, h: number): Regions {
  const n = w * h
  const prov = new Int32Array(n).fill(-1)

  let cap = 4096
  let parent = new Int32Array(cap)
  let next = 0

  const makeSet = (): number => {
    if (next >= cap) {
      cap *= 2
      const grown = new Int32Array(cap)
      grown.set(parent)
      parent = grown
    }
    parent[next] = next
    return next++
  }

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

  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    if (ra < rb) parent[rb] = ra
    else parent[ra] = rb
  }

  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const i = row + x
      const v = src[i]
      const west = x > 0 && src[i - 1] === v ? prov[i - 1] : -1
      const north = y > 0 && src[i - w] === v ? prov[i - w] : -1
      if (west >= 0 && north >= 0) {
        prov[i] = west < north ? west : north
        if (west !== north) union(west, north)
      } else if (west >= 0) {
        prov[i] = west
      } else if (north >= 0) {
        prov[i] = north
      } else {
        prov[i] = makeSet()
      }
    }
  }

  const remap = new Int32Array(next).fill(-1)
  let count = 0
  for (let i = 0; i < next; i++) {
    if (find(i) === i) remap[i] = count++
  }

  const labels = new Int32Array(n)
  const size = new Int32Array(count)
  const minX = new Int32Array(count).fill(w)
  const minY = new Int32Array(count).fill(h)
  const maxX = new Int32Array(count).fill(-1)
  const maxY = new Int32Array(count).fill(-1)
  const touchesBorder = new Uint8Array(count)

  for (let y = 0; y < h; y++) {
    const row = y * w
    const edgeRow = y === 0 || y === h - 1
    for (let x = 0; x < w; x++) {
      const i = row + x
      const id = remap[find(prov[i])]
      labels[i] = id
      size[id]++
      if (x < minX[id]) minX[id] = x
      if (x > maxX[id]) maxX[id] = x
      if (y < minY[id]) minY[id] = y
      if (y > maxY[id]) maxY[id] = y
      if (edgeRow || x === 0 || x === w - 1) touchesBorder[id] = 1
    }
  }

  return { labels, count, size, minX, minY, maxX, maxY, touchesBorder }
}
