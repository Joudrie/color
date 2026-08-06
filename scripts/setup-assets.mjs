/**
 * Fetches the two large runtime assets that are deliberately not in git:
 * the ONNX Runtime wasm binary (vendored from node_modules) and the
 * Informative Drawings model (downloaded once, ~17MB).
 *
 * Runs on postinstall; both steps are skipped if the file already exists.
 */
import { createWriteStream, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const WASM = [
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.wasm',
]
const MODEL_URL =
  'https://huggingface.co/rocca/informative-drawings-line-art-onnx/resolve/main/model.onnx'
const MODEL_PATH = path.join(root, 'public/models/informative-drawings.onnx')

mkdirSync(path.join(root, 'public/ort'), { recursive: true })
for (const file of WASM) {
  const from = path.join(root, 'node_modules/onnxruntime-web/dist', file)
  const to = path.join(root, 'public/ort', file)
  if (!existsSync(from)) {
    console.warn(`[setup] missing ${from} — run npm install first`)
    continue
  }
  if (existsSync(to)) continue
  copyFileSync(from, to)
  console.log(`[setup] vendored ${file}`)
}

mkdirSync(path.dirname(MODEL_PATH), { recursive: true })
if (existsSync(MODEL_PATH)) {
  console.log('[setup] line model already present')
} else {
  console.log('[setup] downloading line model (~17MB)…')
  const res = await fetch(MODEL_URL)
  if (!res.ok || !res.body) {
    console.error(`[setup] download failed: ${res.status}. AI lines mode will not work.`)
    process.exit(0)
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(MODEL_PATH))
  console.log('[setup] line model ready')
}
