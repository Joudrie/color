export interface SegmentStats {
  regions: number
  /** Regions not touching the image edge — the actual shapes in the drawing. */
  interiorRegions: number
  largestInteriorShare: number
  /** Largest region including the background. The honest leak indicator. */
  largestOverallShare: number
  inkShare: number
  lowContrast: boolean
  ms: number
}

export type WorkerRequest =
  | { type: 'load'; bitmap: ImageBitmap }
  | { type: 'segment'; detail: number }

export type WorkerResponse =
  | { type: 'loaded'; width: number; height: number; ms: number }
  | { type: 'segment'; line: ImageData; debug: ImageData; stats: SegmentStats }
  | { type: 'error'; message: string }
