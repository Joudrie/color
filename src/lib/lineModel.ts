import * as ort from 'onnxruntime-web'

/**
 * Informative Drawings (carolineec/informative-drawings) via ONNX Runtime Web.
 *
 * A trained photo→line-drawing model, which is the thing classical segmentation
 * fundamentally cannot be: it knows a t-shirt is one surface and a face has
 * features, rather than inferring that from colour statistics.
 *
 * Note the output is a line *image*, not closed regions — filling still needs a
 * segmentation derived from it.
 */

// The bundled `onnxruntime-web` entry inlines its JS glue but still fetches the
// wasm binary at runtime. Only the binary goes in /public — Vite refuses to
// serve a .mjs from there as a module, so pointing wasmPaths at a directory
// (which would make ORT look for both) fails. Object form, wasm only.
ort.env.wasm.wasmPaths = { wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm' }
// Single-threaded: multi-threading needs cross-origin isolation headers we
// can't count on when this is deployed to static hosting.
ort.env.wasm.numThreads = 1

const MODEL_URL = '/models/informative-drawings.onnx'

let sessionPromise: Promise<ort.InferenceSession> | null = null

export function loadLineModel(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  }
  return sessionPromise
}

export interface LineArt {
  /** 0 = full ink, 1 = paper. One float per pixel. */
  strength: Float32Array
  width: number
  height: number
}

export async function runLineArt(source: ImageBitmap, maxEdge: number): Promise<LineArt> {
  const session = await loadLineModel()

  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height))
  // The network is fully convolutional but downsamples internally; keeping both
  // sides a multiple of 8 avoids an off-by-a-few-pixels output size.
  const w = Math.max(8, Math.round((source.width * scale) / 8) * 8)
  const h = Math.max(8, Math.round((source.height * scale) / 8) * 8)

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)

  // Planar CHW, 0..1 — not the interleaved RGBA the canvas gives us.
  const n = w * h
  const input = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    input[i] = data[o] / 255
    input[n + i] = data[o + 1] / 255
    input[2 * n + i] = data[o + 2] / 255
  }

  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor('float32', input, [1, 3, h, w]),
  }
  const results = await session.run(feeds)
  const out = results[session.outputNames[0]]
  const strength = out.data as Float32Array
  const outH = out.dims[2] as number
  const outW = out.dims[3] as number

  return { strength: Float32Array.from(strength), width: outW, height: outH }
}

/**
 * Render the line map as black-on-white.
 *
 * Raw model output is a pale pencil sketch — most strokes sit around 0.6–0.9
 * brightness, which prints as barely-there grey. Levels are stretched from the
 * image's own percentiles rather than fixed constants, because how dark the
 * model draws depends heavily on how contrasty the photo was.
 */
export function lineArtToImageData(art: LineArt, gamma = 3.0, thicken = true): ImageData {
  const n = art.strength.length
  const BINS = 512
  const hist = new Int32Array(BINS)
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(1, art.strength[i]))
    hist[Math.min(BINS - 1, (v * BINS) | 0)]++
  }
  const percentile = (p: number): number => {
    const want = p * n
    let acc = 0
    for (let b = 0; b < BINS; b++) {
      acc += hist[b]
      if (acc >= want) return b / BINS
    }
    return 1
  }

  // Darkest half-percent becomes true black; the bulk of the paper becomes
  // true white. The steep gamma does the real work — a linear stretch can't
  // rescue strokes that sit only slightly below paper value.
  const lo = percentile(0.005)
  const hi = Math.max(lo + 0.02, percentile(0.8))
  const span = hi - lo

  const shaded = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(1, art.strength[i]))
    const stretched = Math.max(0, Math.min(1, (v - lo) / span))
    shaded[i] = Math.pow(stretched, gamma)
  }

  // A 3x3 minimum filter: each pixel takes its darkest neighbour, which
  // thickens every stroke by a pixel. The model draws hairlines at 1024px;
  // scaled to a page they'd disappear.
  const out = thicken ? new Float32Array(n) : shaded
  if (thicken) {
    const { width: w, height: h } = art
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0
      const y2 = y < h - 1 ? y + 1 : h - 1
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0
        const x2 = x < w - 1 ? x + 1 : w - 1
        let min = 1
        for (let yy = y0; yy <= y2; yy++) {
          const row = yy * w
          for (let xx = x0; xx <= x2; xx++) {
            const s = shaded[row + xx]
            if (s < min) min = s
          }
        }
        out[y * w + x] = min
      }
    }
  }

  const img = new ImageData(art.width, art.height)
  const d = img.data
  for (let i = 0; i < n; i++) {
    const c = out[i] * 255
    const o = i * 4
    d[o] = c
    d[o + 1] = c
    d[o + 2] = c
    d[o + 3] = 255
  }
  return img
}
