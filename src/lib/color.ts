/** sRGB -> CIELAB, plus k-means colour quantisation in Lab space.
 *
 * Lab rather than RGB because merging decisions are perceptual: two greens a
 * human reads as "the same green" can be far apart in RGB. */

function srgbToLinear(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function labF(t: number): number {
  return t > 0.008856451679035631 ? Math.cbrt(t) : t / 0.12841854934601665 + 4 / 29
}

/**
 * Returns a Float32Array of n*3 holding L, a, b per pixel.
 *
 * `lWeight` scales lightness down before any distance is measured. This is the
 * single most important knob in the app: lighting, shadow and wrinkles are
 * almost entirely L variation, while a shirt staying "the same blue" across a
 * highlight is an a/b fact. Weighting L at ~0.4 means a lit and a shadowed part
 * of one object cluster together instead of banding into contour lines.
 */
export function rgbaToLab(rgba: Uint8ClampedArray, n: number, lWeight = 1): Float32Array {
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const r = srgbToLinear(rgba[o])
    const g = srgbToLinear(rgba[o + 1])
    const b = srgbToLinear(rgba[o + 2])

    // Linear sRGB -> XYZ (D65), then normalised by the white point.
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883

    const fx = labF(x)
    const fy = labF(y)
    const fz = labF(z)

    const t = i * 3
    out[t] = (116 * fy - 16) * lWeight
    out[t + 1] = 500 * (fx - fy)
    out[t + 2] = 200 * (fy - fz)
  }
  return out
}

/** Deterministic LCG — reproducible runs matter when tuning by eye. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * k-means over a subsample of the pixels (k-means++ init, Lloyd iterations).
 * Subsampling keeps this in the tens of milliseconds; the full-image pass is
 * the assignment step below.
 */
export function kmeansCentroids(lab: Float32Array, n: number, k: number, sampleTarget = 20000): Float32Array {
  const stride = Math.max(1, Math.floor(n / sampleTarget))
  const samples: number[] = []
  for (let i = 0; i < n; i += stride) {
    const t = i * 3
    samples.push(lab[t], lab[t + 1], lab[t + 2])
  }
  const m = samples.length / 3
  const rand = lcg(0x5eed)
  const cent = new Float32Array(k * 3)

  // k-means++ seeding.
  const first = Math.floor(rand() * m)
  cent[0] = samples[first * 3]
  cent[1] = samples[first * 3 + 1]
  cent[2] = samples[first * 3 + 2]

  const dist = new Float32Array(m).fill(Infinity)
  for (let c = 1; c < k; c++) {
    let total = 0
    for (let i = 0; i < m; i++) {
      const dl = samples[i * 3] - cent[(c - 1) * 3]
      const da = samples[i * 3 + 1] - cent[(c - 1) * 3 + 1]
      const db = samples[i * 3 + 2] - cent[(c - 1) * 3 + 2]
      const d = dl * dl + da * da + db * db
      if (d < dist[i]) dist[i] = d
      total += dist[i]
    }
    let target = rand() * total
    let pick = m - 1
    for (let i = 0; i < m; i++) {
      target -= dist[i]
      if (target <= 0) {
        pick = i
        break
      }
    }
    cent[c * 3] = samples[pick * 3]
    cent[c * 3 + 1] = samples[pick * 3 + 1]
    cent[c * 3 + 2] = samples[pick * 3 + 2]
  }

  const sum = new Float32Array(k * 3)
  const cnt = new Int32Array(k)
  for (let iter = 0; iter < 12; iter++) {
    sum.fill(0)
    cnt.fill(0)
    for (let i = 0; i < m; i++) {
      const l = samples[i * 3]
      const a = samples[i * 3 + 1]
      const b = samples[i * 3 + 2]
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < k; c++) {
        const dl = l - cent[c * 3]
        const da = a - cent[c * 3 + 1]
        const db = b - cent[c * 3 + 2]
        const d = dl * dl + da * da + db * db
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      sum[best * 3] += l
      sum[best * 3 + 1] += a
      sum[best * 3 + 2] += b
      cnt[best]++
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c] === 0) continue
      cent[c * 3] = sum[c * 3] / cnt[c]
      cent[c * 3 + 1] = sum[c * 3 + 1] / cnt[c]
      cent[c * 3 + 2] = sum[c * 3 + 2] / cnt[c]
    }
  }

  return cent
}

/** Assign every pixel to its nearest centroid. */
export function assignClusters(lab: Float32Array, n: number, cent: Float32Array, k: number): Uint8Array {
  const idx = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const t = i * 3
    const l = lab[t]
    const a = lab[t + 1]
    const b = lab[t + 2]
    let best = 0
    let bestD = Infinity
    for (let c = 0; c < k; c++) {
      const dl = l - cent[c * 3]
      const da = a - cent[c * 3 + 1]
      const db = b - cent[c * 3 + 2]
      const d = dl * dl + da * da + db * db
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    idx[i] = best
  }
  return idx
}
