export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Trim uniform flat bars from the edges of an image.
 *
 * People upload phone screenshots constantly, and a screenshot of a photo
 * carries black bars top and bottom. Left in, those bars become huge regions
 * and skew every threshold that is expressed as a fraction of image area.
 */
export function detectContentRect(source: ImageBitmap, tolerance = 10): Rect {
  const probe = 256
  const scale = Math.min(1, probe / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h).data

  const rowIsFlat = (y: number): boolean => {
    const o0 = y * w * 4
    const r0 = d[o0]
    const g0 = d[o0 + 1]
    const b0 = d[o0 + 2]
    for (let x = 1; x < w; x++) {
      const o = (y * w + x) * 4
      if (
        Math.abs(d[o] - r0) > tolerance ||
        Math.abs(d[o + 1] - g0) > tolerance ||
        Math.abs(d[o + 2] - b0) > tolerance
      ) {
        return false
      }
    }
    return true
  }

  const colIsFlat = (x: number): boolean => {
    const o0 = x * 4
    const r0 = d[o0]
    const g0 = d[o0 + 1]
    const b0 = d[o0 + 2]
    for (let y = 1; y < h; y++) {
      const o = (y * w + x) * 4
      if (
        Math.abs(d[o] - r0) > tolerance ||
        Math.abs(d[o + 1] - g0) > tolerance ||
        Math.abs(d[o + 2] - b0) > tolerance
      ) {
        return false
      }
    }
    return true
  }

  let top = 0
  while (top < h - 1 && rowIsFlat(top)) top++
  let bottom = h - 1
  while (bottom > top && rowIsFlat(bottom)) bottom--
  let left = 0
  while (left < w - 1 && colIsFlat(left)) left++
  let right = w - 1
  while (right > left && colIsFlat(right)) right--

  // Refuse to crop away most of the picture — a genuinely flat photo exists.
  if (bottom - top < h * 0.2 || right - left < w * 0.2) {
    return { x: 0, y: 0, w: source.width, h: source.height }
  }

  const inv = 1 / scale
  const x = Math.floor(left * inv)
  const y = Math.floor(top * inv)
  return {
    x,
    y,
    w: Math.min(source.width - x, Math.ceil((right - left + 1) * inv)),
    h: Math.min(source.height - y, Math.ceil((bottom - top + 1) * inv)),
  }
}
