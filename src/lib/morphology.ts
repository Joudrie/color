/**
 * Binary dilation with a square structuring element.
 *
 * A square SE is separable, so this runs as a horizontal pass followed by a
 * vertical one instead of a (2r+1)^2 window per pixel. Used to give the region
 * borders some ink weight. Input and output are 0/1 per pixel.
 */

function maxPass(src: Uint8Array, w: number, h: number, r: number, horizontal: boolean): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0
      for (let i = -r; i <= r; i++) {
        let sx = x
        let sy = y
        if (horizontal) {
          sx = x + i
          if (sx < 0 || sx >= w) continue
        } else {
          sy = y + i
          if (sy < 0 || sy >= h) continue
        }
        if (src[sy * w + sx]) {
          hit = 1
          break
        }
      }
      out[y * w + x] = hit
    }
  }
  return out
}

export function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) {
    const copy = new Uint8Array(src.length)
    copy.set(src)
    return copy
  }
  return maxPass(maxPass(src, w, h, r, true), w, h, r, false)
}
