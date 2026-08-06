/**
 * Sobel gradient magnitude over luma.
 *
 * Used to tell a *real* edge from a shading transition. Both look like a colour
 * change to a clustering algorithm, but an eye against fur is a sharp step
 * while light falling across a muzzle is a gradual ramp. Measuring the gradient
 * along a shared border is what lets the merge step erase the ramp and keep the
 * step.
 */
export function sobelMagnitude(gray: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const yUp = y > 0 ? y - 1 : 0
    const yDn = y < h - 1 ? y + 1 : h - 1
    for (let x = 0; x < w; x++) {
      const xL = x > 0 ? x - 1 : 0
      const xR = x < w - 1 ? x + 1 : w - 1

      const tl = gray[yUp * w + xL]
      const tc = gray[yUp * w + x]
      const tr = gray[yUp * w + xR]
      const ml = gray[y * w + xL]
      const mr = gray[y * w + xR]
      const bl = gray[yDn * w + xL]
      const bc = gray[yDn * w + x]
      const br = gray[yDn * w + xR]

      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl)
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr)
      out[y * w + x] = Math.sqrt(gx * gx + gy * gy)
    }
  }
  return out
}
