/**
 * 3x3 mode filter over a small-alphabet index image.
 *
 * Run after quantisation: it dissolves single-pixel speckle and smooths the
 * jagged boundaries k-means leaves behind, which is most of what stops a photo
 * from segmenting into a manageable number of regions.
 */
export function majority3x3(src: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const counts = new Int32Array(k)

  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0
    const y2 = y < h - 1 ? y + 1 : h - 1
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0
      const x2 = x < w - 1 ? x + 1 : w - 1

      counts.fill(0)
      for (let yy = y0; yy <= y2; yy++) {
        const row = yy * w
        for (let xx = x0; xx <= x2; xx++) counts[src[row + xx]]++
      }

      const centre = src[y * w + x]
      let best = centre
      let bestCount = counts[centre]
      for (let c = 0; c < k; c++) {
        if (counts[c] > bestCount) {
          bestCount = counts[c]
          best = c
        }
      }
      out[y * w + x] = best
    }
  }

  return out
}
