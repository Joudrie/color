/**
 * Region borders as smooth polylines instead of jagged pixel masks.
 *
 * Boundaries live on the "crack" lattice *between* pixels, so a border is a
 * graph: vertices at pixel corners, edges where two neighbouring pixels have
 * different labels. Tracing that graph once — rather than outlining each region
 * separately — means a border shared by two regions is a single chain, drawn
 * once. Outline regions independently and every internal border gets drawn
 * twice, slightly differently after smoothing, which reads as a doubled line.
 *
 * Each chain runs between junctions (where three or more regions meet), so
 * smoothing can never pull a border away from the corner it has to meet.
 */

export interface Chain {
  pts: number[]
  /** The two regions this border separates. */
  a: number
  b: number
  closed: boolean
}

const W = 0
const E = 1
const N = 2
const S = 3

export function extractChains(labels: Int32Array, w: number, h: number): Chain[] {
  const hStride = w
  const vStride = w + 1
  const hEdge = new Uint8Array(hStride * (h + 1))
  const vEdge = new Uint8Array(vStride * h)

  // Interior cracks only — the image border is not a drawn line.
  for (let vy = 1; vy < h; vy++) {
    for (let vx = 0; vx < w; vx++) {
      if (labels[(vy - 1) * w + vx] !== labels[vy * w + vx]) hEdge[vy * hStride + vx] = 1
    }
  }
  for (let vy = 0; vy < h; vy++) {
    for (let vx = 1; vx < w; vx++) {
      if (labels[vy * w + vx - 1] !== labels[vy * w + vx]) vEdge[vy * vStride + vx] = 1
    }
  }

  const hSeen = new Uint8Array(hEdge.length)
  const vSeen = new Uint8Array(vEdge.length)

  const hasEdge = (dir: number, vx: number, vy: number): boolean => {
    switch (dir) {
      case W:
        return vx >= 1 && hEdge[vy * hStride + vx - 1] === 1
      case E:
        return vx <= w - 1 && hEdge[vy * hStride + vx] === 1
      case N:
        return vy >= 1 && vEdge[(vy - 1) * vStride + vx] === 1
      default:
        return vy <= h - 1 && vEdge[vy * vStride + vx] === 1
    }
  }

  const seen = (dir: number, vx: number, vy: number): boolean => {
    switch (dir) {
      case W:
        return hSeen[vy * hStride + vx - 1] === 1
      case E:
        return hSeen[vy * hStride + vx] === 1
      case N:
        return vSeen[(vy - 1) * vStride + vx] === 1
      default:
        return vSeen[vy * vStride + vx] === 1
    }
  }

  const mark = (dir: number, vx: number, vy: number): void => {
    switch (dir) {
      case W:
        hSeen[vy * hStride + vx - 1] = 1
        break
      case E:
        hSeen[vy * hStride + vx] = 1
        break
      case N:
        vSeen[(vy - 1) * vStride + vx] = 1
        break
      default:
        vSeen[vy * vStride + vx] = 1
    }
  }

  const degree = (vx: number, vy: number): number => {
    let d = 0
    for (let dir = 0; dir < 4; dir++) if (hasEdge(dir, vx, vy)) d++
    return d
  }

  /** The two labels an edge separates, read from the pixels flanking it. */
  const sides = (dir: number, vx: number, vy: number): [number, number] => {
    switch (dir) {
      case E:
        return [labels[(vy - 1) * w + vx], labels[vy * w + vx]]
      case W:
        return [labels[(vy - 1) * w + vx - 1], labels[vy * w + vx - 1]]
      case S:
        return [labels[vy * w + vx - 1], labels[vy * w + vx]]
      default:
        return [labels[(vy - 1) * w + vx - 1], labels[(vy - 1) * w + vx]]
    }
  }

  const stepX = [-1, 1, 0, 0]
  const stepY = [0, 0, -1, 1]
  const reverse = [E, W, S, N]

  const chains: Chain[] = []

  const trace = (sx: number, sy: number, startDir: number): void => {
    const [a, b] = sides(startDir, sx, sy)
    const pts: number[] = [sx, sy]
    let cx = sx
    let cy = sy
    let dir = startDir

    for (;;) {
      mark(dir, cx, cy)
      const nx = cx + stepX[dir]
      const ny = cy + stepY[dir]
      pts.push(nx, ny)
      if (degree(nx, ny) !== 2) break

      let next = -1
      const back = reverse[dir]
      for (let d = 0; d < 4; d++) {
        if (d !== back && hasEdge(d, nx, ny)) {
          next = d
          break
        }
      }
      if (next < 0 || seen(next, nx, ny)) break
      cx = nx
      cy = ny
      dir = next
    }

    const closed = pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]
    chains.push({ pts, a: Math.min(a, b), b: Math.max(a, b), closed })
  }

  // Chains anchored at junctions and endpoints first.
  for (let vy = 0; vy <= h; vy++) {
    for (let vx = 0; vx <= w; vx++) {
      const d = degree(vx, vy)
      if (d === 0 || d === 2) continue
      for (let dir = 0; dir < 4; dir++) {
        if (hasEdge(dir, vx, vy) && !seen(dir, vx, vy)) trace(vx, vy, dir)
      }
    }
  }

  // Whatever is left is a closed loop of degree-2 vertices.
  for (let vy = 0; vy <= h; vy++) {
    for (let vx = 0; vx < w; vx++) {
      if (hEdge[vy * hStride + vx] === 1 && hSeen[vy * hStride + vx] === 0) trace(vx, vy, E)
    }
  }
  for (let vy = 0; vy < h; vy++) {
    for (let vx = 0; vx <= w; vx++) {
      if (vEdge[vy * vStride + vx] === 1 && vSeen[vy * vStride + vx] === 0) trace(vx, vy, S)
    }
  }

  return chains
}

/** Douglas–Peucker. Removes the pixel staircase before any smoothing. */
export function simplify(pts: number[], epsilon: number): number[] {
  const n = pts.length / 2
  if (n < 3) return pts.slice()

  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1

  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()!
    if (last <= first + 1) continue
    const x0 = pts[first * 2]
    const y0 = pts[first * 2 + 1]
    const x1 = pts[last * 2]
    const y1 = pts[last * 2 + 1]
    const dx = x1 - x0
    const dy = y1 - y0
    const len = Math.hypot(dx, dy)

    let worst = -1
    let worstDist = 0
    for (let i = first + 1; i < last; i++) {
      const px = pts[i * 2]
      const py = pts[i * 2 + 1]
      const dist =
        len === 0
          ? Math.hypot(px - x0, py - y0)
          : Math.abs(dy * px - dx * py + x1 * y0 - y1 * x0) / len
      if (dist > worstDist) {
        worstDist = dist
        worst = i
      }
    }

    if (worstDist > epsilon && worst > 0) {
      keep[worst] = 1
      stack.push([first, worst], [worst, last])
    }
  }

  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1])
  }
  return out
}

/**
 * Chaikin corner cutting. Endpoints of an open chain are pinned so chains still
 * meet exactly at their shared junctions after smoothing.
 */
export function smooth(pts: number[], iterations: number, closed: boolean): number[] {
  let cur = pts
  for (let iter = 0; iter < iterations; iter++) {
    const n = cur.length / 2
    if (n < 3) break
    const out: number[] = []
    if (!closed) out.push(cur[0], cur[1])
    const last = closed ? n : n - 1
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n
      const x0 = cur[i * 2]
      const y0 = cur[i * 2 + 1]
      const x1 = cur[j * 2]
      const y1 = cur[j * 2 + 1]
      out.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25)
      out.push(x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75)
    }
    if (!closed) out.push(cur[(n - 1) * 2], cur[(n - 1) * 2 + 1])
    cur = out
  }
  return cur
}
