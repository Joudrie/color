/**
 * Square mode (majority) filter over a small-alphabet index image.
 *
 * Run after quantisation: it dissolves speckle and rounds off the jagged
 * boundaries k-means leaves behind. Boundary smoothness has to happen here
 * rather than later, because merging regions only ever *removes* borders — it
 * never creates a rough new one — so a smooth index map yields smooth lines
 * all the way through.
 */
export function majorityFilter(src: Uint8Array, w: number, h: number, k: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const counts = new Int32Array(k)

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius)
    const y2 = Math.min(h - 1, y + radius)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius)
      const x2 = Math.min(w - 1, x + radius)

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
