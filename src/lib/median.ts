/**
 * 3x3 median filter on an 8-bit single-channel image.
 *
 * Uses the standard 19-comparison median-of-9 sorting network rather than a
 * generic sort — at ~1.5M pixels a per-pixel Array.sort is seconds of work.
 */
export function median3x3(src: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h)
  const p = new Uint8ClampedArray(9)

  const sort2 = (a: number, b: number) => {
    if (p[a] > p[b]) {
      const t = p[a]
      p[a] = p[b]
      p[b] = t
    }
  }

  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0
    const y2 = y < h - 1 ? y + 1 : h - 1
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0
      const x2 = x < w - 1 ? x + 1 : w - 1

      p[0] = src[y0 * w + x0]; p[1] = src[y0 * w + x]; p[2] = src[y0 * w + x2]
      p[3] = src[y * w + x0];  p[4] = src[y * w + x];  p[5] = src[y * w + x2]
      p[6] = src[y2 * w + x0]; p[7] = src[y2 * w + x]; p[8] = src[y2 * w + x2]

      sort2(1, 2); sort2(4, 5); sort2(7, 8)
      sort2(0, 1); sort2(3, 4); sort2(6, 7)
      sort2(1, 2); sort2(4, 5); sort2(7, 8)
      sort2(0, 3); sort2(5, 8); sort2(4, 7)
      sort2(3, 6); sort2(1, 4); sort2(2, 5)
      sort2(4, 7); sort2(4, 2); sort2(6, 4)
      sort2(4, 2)

      out[y * w + x] = p[4]
    }
  }

  return out
}
