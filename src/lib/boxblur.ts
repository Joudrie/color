/**
 * Large-radius blur via three running-sum box passes.
 *
 * Cost is independent of radius, which matters because flat-fielding needs a
 * blur radius in the hundreds of pixels — a Gaussian kernel that wide would be
 * thousands of taps per pixel. Three box passes approximate a Gaussian closely
 * enough for an illumination estimate.
 */

function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
  const len = horizontal ? w : h
  const outer = horizontal ? h : w
  const window = 2 * r + 1

  for (let o = 0; o < outer; o++) {
    const at = (i: number): number => (horizontal ? o * w + i : i * w + o)

    // Prime the running sum with the clamped left/top edge.
    let sum = src[at(0)] * (r + 1)
    for (let i = 1; i <= r; i++) sum += src[at(Math.min(i, len - 1))]

    for (let i = 0; i < len; i++) {
      dst[at(i)] = sum / window
      const add = src[at(Math.min(i + r + 1, len - 1))]
      const drop = src[at(Math.max(i - r, 0))]
      sum += add - drop
    }
  }
}

export function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius))
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  let cur = src
  for (let pass = 0; pass < 3; pass++) {
    boxPass(cur, tmp, w, h, r, true)
    boxPass(tmp, out, w, h, r, false)
    cur = out
  }
  return out
}
