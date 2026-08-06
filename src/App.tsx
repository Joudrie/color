import { useCallback, useEffect, useRef, useState } from 'react'
import { detectContentRect } from './lib/letterbox'
import { lineArtToImageData, runLineArt } from './lib/lineModel'
import type { SegmentStats, WorkerResponse } from './types'

type Status = 'empty' | 'loading' | 'ready'
type Mode = 'regions' | 'ai'

const MODEL_MAX_EDGE = 1024

const SAMPLES = [
  { label: 'Dog', src: '/samples/pet.jpg' },
  { label: 'Portrait', src: '/samples/portrait.jpg' },
  { label: 'Landscape', src: '/samples/landscape.jpg' },
]

export default function App() {
  const workerRef = useRef<Worker | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const lineRef = useRef<ImageData | null>(null)
  const debugRef = useRef<ImageData | null>(null)
  const inFlight = useRef(false)
  const pending = useRef<number | null>(null)

  const sourceRef = useRef<ImageBitmap | null>(null)
  const aiRef = useRef<ImageData | null>(null)

  const [status, setStatus] = useState<Status>('empty')
  const [detail, setDetail] = useState(0.5)
  const [debug, setDebug] = useState(false)
  const [mode, setMode] = useState<Mode>('regions')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMs, setAiMs] = useState<number | null>(null)
  const [stats, setStats] = useState<SegmentStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Refs mirror state so the worker handler always reads current values.
  const detailRef = useRef(detail)
  const showDebugRef = useRef(debug)
  const modeRef = useRef(mode)

  const paint = useCallback((img: ImageData | null) => {
    const canvas = canvasRef.current
    if (!canvas || !img) return
    if (canvas.width !== img.width || canvas.height !== img.height) {
      canvas.width = img.width
      canvas.height = img.height
    }
    canvas.getContext('2d')!.putImageData(img, 0, 0)
  }, [])

  const request = useCallback((value: number) => {
    const worker = workerRef.current
    if (!worker) return
    if (inFlight.current) {
      pending.current = value
      return
    }
    inFlight.current = true
    worker.postMessage({ type: 'segment', detail: value })
  }, [])

  useEffect(() => {
    const worker = new Worker(new URL('./worker/pipeline.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.type === 'loaded') {
        request(detailRef.current)
        return
      }
      if (msg.type === 'segment') {
        inFlight.current = false
        lineRef.current = msg.line
        debugRef.current = msg.debug
        setStats(msg.stats)
        setStatus('ready')
        if (modeRef.current === 'regions') paint(showDebugRef.current ? msg.debug : msg.line)
        const queued = pending.current
        if (queued !== null) {
          pending.current = null
          request(queued)
        }
        return
      }
      if (msg.type === 'error') {
        inFlight.current = false
        setError(msg.message)
        setStatus('empty')
      }
    }

    return () => worker.terminate()
  }, [paint, request])

  useEffect(() => {
    detailRef.current = detail
  }, [detail])

  useEffect(() => {
    showDebugRef.current = debug
    if (modeRef.current === 'regions') paint(debug ? debugRef.current : lineRef.current)
  }, [debug, paint])

  const runModel = useCallback(async () => {
    const source = sourceRef.current
    if (!source || aiBusy) return
    if (aiRef.current) {
      paint(aiRef.current)
      return
    }
    setAiBusy(true)
    try {
      const t0 = performance.now()
      const art = await runLineArt(source, MODEL_MAX_EDGE)
      setAiMs(Math.round(performance.now() - t0))
      const img = lineArtToImageData(art)
      aiRef.current = img
      if (modeRef.current === 'ai') paint(img)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The line model failed to run.')
    } finally {
      setAiBusy(false)
    }
  }, [aiBusy, paint])

  useEffect(() => {
    modeRef.current = mode
    if (mode === 'ai') void runModel()
    else paint(showDebugRef.current ? debugRef.current : lineRef.current)
    // runModel is intentionally omitted: it changes identity while running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, paint])

  const ingest = useCallback(async (blob: Blob) => {
    setError(null)
    setStatus('loading')
    setStats(null)
    debugRef.current = null
    lineRef.current = null
    aiRef.current = null
    setAiMs(null)
    inFlight.current = false
    pending.current = null
    try {
      // imageOrientation honours EXIF — without it every portrait phone photo
      // arrives on its side.
      const oriented = await createImageBitmap(blob, { imageOrientation: 'from-image' })
      const rect = detectContentRect(oriented)

      // Two crops: one is transferred to the worker (which closes it), one is
      // kept here for the model.
      const forWorker = await createImageBitmap(oriented, rect.x, rect.y, rect.w, rect.h)
      const forModel = await createImageBitmap(oriented, rect.x, rect.y, rect.w, rect.h)
      oriented.close()

      sourceRef.current?.close()
      sourceRef.current = forModel
      workerRef.current!.postMessage({ type: 'load', bitmap: forWorker }, [forWorker])
      if (modeRef.current === 'ai') void runModel()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that image.')
      setStatus('empty')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void ingest(file)
  }

  const loadSample = async (src: string) => {
    const res = await fetch(src)
    void ingest(await res.blob())
  }

  const onDetail = (value: number) => {
    setDetail(value)
    if (status === 'ready') request(value)
  }

  return (
    <div className="min-h-full bg-neutral-100 text-neutral-900 flex flex-col items-center">
      <header className="w-full max-w-3xl px-4 pt-6 pb-3 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Colorbook</h1>
        {status === 'ready' && (
          <label className="text-sm text-neutral-500 underline cursor-pointer">
            New photo
            <input type="file" accept="image/*" className="hidden" onChange={onFile} />
          </label>
        )}
      </header>

      <main className="w-full max-w-3xl px-4 pb-10 flex-1 flex flex-col gap-4">
        {status === 'empty' && (
          <div className="mt-8 rounded-2xl border-2 border-dashed border-neutral-300 bg-white p-10 text-center">
            <p className="text-neutral-600 mb-5">Turn a photo into a coloring page.</p>
            <label className="inline-block rounded-full bg-neutral-900 text-white px-6 py-3 font-medium cursor-pointer">
              Choose a photo
              <input
                type="file"
                accept="image/*"
                className="hidden"
                data-testid="file-input"
                onChange={onFile}
              />
            </label>
            <div className="mt-6 flex items-center justify-center gap-2 text-sm">
              <span className="text-neutral-400">or try</span>
              {SAMPLES.map((s) => (
                <button
                  key={s.src}
                  onClick={() => void loadSample(s.src)}
                  className="rounded-full border border-neutral-300 px-3 py-1 hover:bg-neutral-50"
                >
                  {s.label}
                </button>
              ))}
            </div>
            {error && <p className="mt-5 text-sm text-red-600">{error}</p>}
          </div>
        )}

        {status === 'loading' && (
          <div className="mt-16 text-center text-neutral-500" data-testid="loading">
            Tracing your photo…
          </div>
        )}

        <div className={status === 'ready' ? 'flex flex-col gap-4' : 'hidden'}>
          <div className="rounded-2xl overflow-hidden bg-white shadow-sm border border-neutral-200 flex items-center justify-center">
            <canvas
              ref={canvasRef}
              data-testid="canvas"
              className="max-w-full max-h-[65vh] w-auto h-auto block"
            />
          </div>

          {stats?.lowContrast && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              This photo didn't have enough contrast to trace well — try one with clearer
              shapes and brighter light.
            </p>
          )}

          <div className="rounded-2xl bg-white border border-neutral-200 p-4 flex flex-col gap-3">
            <div className="flex rounded-full bg-neutral-100 p-1 text-sm">
              {(['regions', 'ai'] as Mode[]).map((m) => (
                <button
                  key={m}
                  data-testid={`mode-${m}`}
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded-full py-1.5 ${
                    mode === m ? 'bg-white shadow-sm font-medium' : 'text-neutral-500'
                  }`}
                >
                  {m === 'regions' ? 'Regions' : 'AI lines'}
                </button>
              ))}
            </div>

            {mode === 'ai' && (
              <p className="text-xs text-neutral-400" data-testid="ai-status">
                {aiBusy
                  ? 'Running the line model…'
                  : aiMs !== null
                    ? `Informative Drawings · ${aiMs}ms`
                    : 'Informative Drawings'}
              </p>
            )}

            <div className={`flex items-center gap-3 ${mode === 'ai' ? 'opacity-40' : ''}`}>
              <span className="text-sm text-neutral-500 w-12">Simple</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={detail}
                data-testid="detail"
                onChange={(e) => onDetail(Number(e.target.value))}
                className="flex-1 accent-neutral-900"
              />
              <span className="text-sm text-neutral-500 w-14 text-right">Detailed</span>
            </div>

            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-neutral-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={debug}
                  data-testid="debug"
                  onChange={(e) => setDebug(e.target.checked)}
                  className="accent-neutral-900"
                />
                Show region map
              </label>
              {stats && (
                <span className="text-xs text-neutral-400 tabular-nums" data-testid="stats">
                  {stats.regions} regions ({stats.interiorRegions} interior) · largest{' '}
                  {(stats.largestOverallShare * 100).toFixed(1)}% · ink{' '}
                  {(stats.inkShare * 100).toFixed(1)}% · {stats.ms}ms
                </span>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
