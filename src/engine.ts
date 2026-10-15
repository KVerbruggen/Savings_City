import { type Project, type Settings, DEFAULT_SETTINGS } from './services/storageService'

export const TILE_W = 64
export const TILE_H = 32
const BUILDING_MARGIN = 0.3 // clears the sidewalk (0.24 from the road centre line)
let projectionAngle = 0

export type V2 = [number, number]

export const toIso = (gx: number, gy: number, angle = projectionAngle) => {
  // Change the camera's compass direction in map space before projecting it.
  // Rotating the already-projected screen point makes the wide isometric
  // diamond tall at 90°, which is a canvas rotation rather than a new view.
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const mapX = gx * cos - gy * sin
  const mapY = gx * sin + gy * cos
  const x = (mapX - mapY) * (TILE_W / 2)
  const y = (mapX + mapY) * (TILE_H / 2)
  return {
    x,
    y,
  }
}
export const toGrid = (x: number, y: number) => ({
  gx: y / TILE_H + x / TILE_W,
  gy: y / TILE_H - x / TILE_W,
})

/** Building footprint in grid cells. L-shapes are the w x d bounding box minus the corner region x >= notch.x, y >= notch.y. */
export interface Footprint { name: string; w: number; d: number; notch?: V2; minSide: number; rot?: number; base?: Footprint }

let settings: Settings = DEFAULT_SETTINGS
export const setSettings = (s: Settings) => { settings = s }
/** Max floors by the narrowest part of the footprint (configurable in settings). */
export const maxFloorsOf = (fp: Footprint) => settings.maxFloorsByWidth[fp.minSide]
const rectFp = (w: number, d: number): Footprint => ({ name: `${w}x${d}`, w, d, minSide: Math.min(w, d) })
const lFp = (w: number, d: number, notch: V2, name: string): Footprint =>
  ({ name, w, d, notch, minSide: Math.min(notch[0], notch[1], w - notch[0], d - notch[1]) })

// Ordered by number of grid cells.
export const FOOTPRINTS: Footprint[] = [
  rectFp(1, 1), rectFp(1, 2), lFp(2, 2, [1, 1], '1x2+1x1'), rectFp(2, 2), rectFp(2, 3), rectFp(2, 4), rectFp(3, 3), rectFp(2, 5),
  lFp(4, 4, [2, 2], '2x4+2x2'), rectFp(3, 4), rectFp(3, 5), rectFp(4, 4), rectFp(4, 5), rectFp(5, 5),
]

const MAX_CURVE_HOURS = 1000
const FLOOR_HEIGHT = 10 // px per floor

/** Footprint depends only on the estimated hours without AI. */
export const footprint = (p: Project): Footprint => {
  const hours = Math.min(Math.max(0, p.time_estimated_no_ai), MAX_CURVE_HOURS)
  const t = Math.pow(hours / MAX_CURVE_HOURS, settings.footprintCurve)
  return FOOTPRINTS[Math.min(FOOTPRINTS.length - 1, Math.floor(t * FOOTPRINTS.length))]
}

/** Floors depend on the fraction of time saved: 1 at no savings, the footprint's maximum at full savings. */
export const floorsOf = (p: Project) => {
  const est = p.time_estimated_no_ai
  const saved = est > 0 ? Math.min(1, Math.max(0, (est - Math.max(0, p.time_spent_ai)) / est)) : 0
  return 1 + Math.round(Math.pow(saved, settings.heightCurve) * (maxFloorsOf(footprint(p)) - 1))
}

const orientCache = new WeakMap<Footprint, Footprint[]>()
/** L-shapes turn with the door: facing 2 is the base shape, each further step is a quarter turn clockwise. Rectangles are unchanged. */
export const orient = (fp: Footprint, facing: Facing): Footprint => {
  const base = fp.base ?? fp
  if (!base.notch) return base
  let list = orientCache.get(base)
  if (!list) orientCache.set(base, list = [0, 1, 2, 3].map((r) => ({ ...base, rot: r, base })))
  return list[facing]
}

const turnPoint = (fp: Footprint, [x, y]: V2): V2 => {
  for (let k = 0; k < (fp.rot ?? 0); k++) [x, y] = [fp.w - y, x]
  return [x, y]
}

/** Rectangles (x, y, w, d in the local frame) covering the footprint, inset by m on every outer side. Two parts abut along a shared plane. */
export const footprintRects = (fp: Footprint, m = 0): [number, number, number, number][] => {
  if (!fp.notch) return [[m, m, fp.w - 2 * m, fp.d - 2 * m]]
  const [b, a] = fp.notch
  const rects: [number, number, number, number][] = [[m, m, fp.w - 2 * m, a - 2 * m], [m, a - m, b - 2 * m, fp.d - a]]
  return rects.map(([x, y, w, d]) => {
    const p = turnPoint(fp, [x, y]), q = turnPoint(fp, [x + w, y + d])
    return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])]
  })
}

/** Outline of the footprint inset by m, clockwise in map space. */
export const footprintOutline = (fp: Footprint, m = 0): V2[] => {
  const { w, d } = fp
  if (!fp.notch) return [[m, m], [w - m, m], [w - m, d - m], [m, d - m]]
  const [b, a] = fp.notch
  const pts: V2[] = [[m, m], [w - m, m], [w - m, a - m], [b - m, a - m], [b - m, d - m], [m, d - m]]
  return pts.map((q) => turnPoint(fp, q))
}

export const hasCell = (fp: Footprint, x: number, y: number) => {
  if (x < 0 || y < 0 || x >= fp.w || y >= fp.d) return false
  for (let k = 0; k < (fp.rot ?? 0); k++) [x, y] = [y, fp.w - 1 - x]
  return !(fp.notch && x >= fp.notch[0] && y >= fp.notch[1])
}

/** Occupied cells (local frame). */
const cellsOf = (fp: Footprint): V2[] => {
  const out: V2[] = []
  for (let x = 0; x < fp.w; x++) for (let y = 0; y < fp.d; y++) if (hasCell(fp, x, y)) out.push([x, y])
  return out
}

/* ---------------- vector helpers ---------------- */
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]]
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]]
const mul = (a: V2, s: number): V2 => [a[0] * s, a[1] * s]
const len = (a: V2) => Math.hypot(a[0], a[1])
const dist = (a: V2, b: V2) => len(sub(a, b))
const norm = (a: V2): V2 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l]
}

/* ---------------- layout ---------------- */

export type Facing = 0 | 1 | 2 | 3

export interface Placed {
  p: Project
  fp: Footprint
  gx: number
  gy: number
  facing: Facing
  start: number // ms offset when construction begins
  duration: number // ms
}

// Build time is linear in hours spent with AI, with no cap: one hour of build
// time per hour spent, plus a 3s minimum. A project that saves a lot for
// little spend rises tall but finishes fast. 1h ≈ 1 h, 10h ≈ 10 h, 48h ≈ 2 days.
const BUILD_HOURS_PER_HOUR_SPENT = 1
export const buildDuration = (p: Project) => {
  const hours = Math.max(0, p.time_spent_ai)
  return 3000 + hours * BUILD_HOURS_PER_HOUR_SPENT * 3600 * 1000
}

export function layout(projects: Project[], constructionStarts = new Map<string, number>()): Placed[] {
  const out: Placed[] = []
  for (const p of projects) {
    // A project without a position is mid-placement and is not rendered yet.
    if (typeof p.gx !== 'number' || typeof p.gy !== 'number') continue
    out.push({
      p, fp: orient(footprint(p), (p.facing ?? 2) as Facing), gx: p.gx, gy: p.gy,
      facing: (p.facing ?? 2) as Facing,
      // Projects loaded together start together. A newly submitted project can
      // provide its own elapsed start time without shifting older buildings.
      start: constructionStarts.get(p.id) ?? 0,
      duration: buildDuration(p),
    })
  }
  return out
}

/* ---------------- roads on grid lines ---------------- */

export const edgeKey = (x: number, y: number, dir: 'h' | 'v') => `${x},${y},${dir}`

export function parseEdge(key: string): [V2, V2] {
  const [x, y, d] = key.split(',')
  const px = Number(x), py = Number(y)
  return d === 'h' ? [[px, py], [px + 1, py]] : [[px, py], [px, py + 1]]
}

/** Edges along the front side of a building: the cells touching the bounding box side the door faces. */
export function frontEdges(gx: number, gy: number, fp: Footprint, facing: Facing): string[] {
  fp = orient(fp, facing)
  const out: string[] = []
  for (const [x, y] of cellsOf(fp)) {
    if (facing === 0 && y === 0) out.push(edgeKey(gx + x, gy, 'h'))
    else if (facing === 1 && x === fp.w - 1) out.push(edgeKey(gx + fp.w, gy + y, 'v'))
    else if (facing === 2 && y === fp.d - 1) out.push(edgeKey(gx + x, gy + fp.d, 'h'))
    else if (facing === 3 && x === 0) out.push(edgeKey(gx, gy + y, 'v'))
  }
  return out
}

/** Lattice points along the front side of a building. */
const frontVertices = (gx: number, gy: number, fp: Footprint, facing: Facing): string[] =>
  frontEdges(gx, gy, fp, facing).flatMap((k) => parseEdge(k).map((v) => `${v[0]},${v[1]}`))

export function roadVertices(roads: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const key of roads) {
    const [a, b] = parseEdge(key)
    out.add(`${a[0]},${a[1]}`)
    out.add(`${b[0]},${b[1]}`)
  }
  return out
}

const occupied = (placed: Placed[], ignoreId?: string) => {
  const tiles = new Set<string>()
  for (const b of placed) {
    if (b.p.id === ignoreId) continue
    for (const [x, y] of cellsOf(b.fp)) tiles.add(`${b.gx + x},${b.gy + y}`)
  }
  return tiles
}

export function placementError(gx: number, gy: number, fp: Footprint, facing: Facing, placed: Placed[], roads: Set<string>, ignoreId?: string): string | undefined {
  fp = orient(fp, facing)
  const tiles = occupied(placed, ignoreId)
  for (const [x, y] of cellsOf(fp))
    if (tiles.has(`${gx + x},${gy + y}`)) return 'Overlaps another building'
  for (const [x, y] of cellsOf(fp)) {
    if (hasCell(fp, x, y - 1) && roads.has(edgeKey(gx + x, gy + y, 'h'))) return 'Overlaps an existing road'
    if (hasCell(fp, x - 1, y) && roads.has(edgeKey(gx + x, gy + y, 'v'))) return 'Overlaps an existing road'
  }
  if (roads.size > 0) {
    const verts = roadVertices(roads)
    if (!frontVertices(gx, gy, fp, facing).some((v) => verts.has(v))) return 'The front must touch an existing road'
  }
  const others = ignoreId ? placed.filter((b) => b.p.id !== ignoreId) : placed
  if (others.length) {
    const rect: [number, number, number, number] = [gx, gy, gx + fp.w, gy + fp.d]
    if (!buildingReach(others).some((b) => gapBetween(rect, b.rect) <= b.reach)) return 'Too far from other buildings'
  }
  return undefined
}

export const placementAt = (map: V2, fp: Footprint): { gx: number; gy: number } =>
  ({ gx: Math.round(map[0] - fp.w / 2), gy: Math.round(map[1] - fp.d / 2) })

/** Grid edge nearest to a map point. */
export function nearestEdge(map: V2): string {
  const cx = Math.floor(map[0]), cy = Math.floor(map[1])
  const fx = map[0] - cx, fy = map[1] - cy
  const sides: [number, string][] = [
    [fy, edgeKey(cx, cy, 'h')],
    [1 - fy, edgeKey(cx, cy + 1, 'h')],
    [fx, edgeKey(cx, cy, 'v')],
    [1 - fx, edgeKey(cx + 1, cy, 'v')],
  ]
  return sides.reduce((best, s) => (s[0] < best[0] ? s : best))[1]
}

const NEAR_REACH = 1, GROUP_GAP = 2, GROUP_SIZE = 10, GROUP_REACH = 19

const gapBetween = (a: [number, number, number, number], b: [number, number, number, number]) =>
  Math.max(0, b[0] - a[2], a[0] - b[2], b[1] - a[3], a[1] - b[3])

const reachCache = new WeakMap<Placed[], { rect: [number, number, number, number]; reach: number }[]>()
function buildingReach(placed: Placed[]) {
  let out = reachCache.get(placed)
  if (out) return out
  const rects = placed.map((b): [number, number, number, number] => [b.gx, b.gy, b.gx + b.fp.w, b.gy + b.fp.d])
  const parent = rects.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++)
      if (gapBetween(rects[i], rects[j]) <= GROUP_GAP) parent[find(i)] = find(j)
  const counts = new Map<number, number>()
  rects.forEach((_, i) => counts.set(find(i), (counts.get(find(i)) ?? 0) + 1))
  out = rects.map((rect, i) => ({ rect, reach: (counts.get(find(i)) ?? 0) >= GROUP_SIZE ? GROUP_REACH : NEAR_REACH }))
  reachCache.set(placed, out)
  return out
}

/** True when both sides of the edge lie within the building's footprint. */
function edgeInsideBuilding(key: string, b: Placed): boolean {
  const [x, y, d] = key.split(',')
  const px = Number(x) - b.gx, py = Number(y) - b.gy
  return d === 'h' ? hasCell(b.fp, px, py - 1) && hasCell(b.fp, px, py) : hasCell(b.fp, px - 1, py) && hasCell(b.fp, px, py)
}

export function roadError(key: string, placed: Placed[], roads: Set<string>, verts?: Set<string>): string | undefined {
  if (roads.has(key)) return 'Already a road'
  const [a0, b0] = parseEdge(key)
  const edge: [number, number, number, number] = [a0[0], a0[1], b0[0], b0[1]]
  if (placed.some((b) => edgeInsideBuilding(key, b))) return 'A road cannot cross a building'
  if (!buildingReach(placed).some((b) => gapBetween(edge, b.rect) <= b.reach)) return 'A road must be near a building'
  if (roads.size > 0) {
    verts ??= roadVertices(roads)
    const [a, b] = parseEdge(key)
    if (!verts.has(`${a[0]},${a[1]}`) && !verts.has(`${b[0]},${b[1]}`)) return 'A road must connect to an existing road'
  }
  return undefined
}

export function edgeRun(start: string, map: V2): string[] {
  const [x, y, d] = start.split(',')
  const sx = Number(x), sy = Number(y)
  const s = d === 'h' ? sx : sy
  const e = Math.floor(d === 'h' ? map[0] : map[1])
  const step = e >= s ? 1 : -1
  const out: string[] = []
  for (let i = s; i !== e + step; i += step) out.push(d === 'h' ? edgeKey(i, sy, 'h') : edgeKey(sx, i, 'v'))
  return out
}

export function roadsToAdd(run: string[], placed: Placed[], roads: Set<string>): string[] {
  const work = new Set(roads)
  let verts: Set<string> | undefined
  const out: string[] = []
  for (const key of run) {
    if (roadError(key, placed, work, verts ??= roadVertices(roads))) break
    work.add(key)
    const [a, b] = parseEdge(key)
    verts.add(`${a[0]},${a[1]}`); verts.add(`${b[0]},${b[1]}`)
    out.push(key)
  }
  return out
}

export const roadsToDelete = (run: string[], roads: Set<string>): string[] => run.filter((k) => roads.has(k))

/** Run edges plus any roads left with no connection to a building: every
 * connected piece of road must contain an edge touching a building. */
export function roadsToDeleteWithOrphans(run: string[], placed: Placed[], roads: Set<string>, force = false): string[] {
  const fronts = new Set(placed.flatMap((b) => frontEdges(b.gx, b.gy, b.fp, b.facing)))
  const gone = new Set(roadsToDelete(run, roads).filter((k) => !fronts.has(k)))
  if (!gone.size && !force) return []
  const left = [...roads].filter((k) => !gone.has(k))
  const tiles = occupied(placed)
  const touches = (key: string) => {
    const [x, y, d] = key.split(',').map((v, i) => (i < 2 ? Number(v) : v)) as [number, number, string]
    const sides = d === 'h' ? [`${x},${y - 1}`, `${x},${y}`] : [`${x - 1},${y}`, `${x},${y}`]
    return sides.some((t) => tiles.has(t))
  }
  const byVertex = new Map<string, string[]>()
  for (const key of left) {
    const [a, b] = parseEdge(key)
    for (const v of [`${a[0]},${a[1]}`, `${b[0]},${b[1]}`]) (byVertex.get(v) ?? byVertex.set(v, []).get(v)!).push(key)
  }
  const keep = new Set<string>()
  const stack = left.filter(touches)
  for (const k of stack) keep.add(k)
  while (stack.length) {
    const [a, b] = parseEdge(stack.pop()!)
    for (const v of [`${a[0]},${a[1]}`, `${b[0]},${b[1]}`])
      for (const n of byVertex.get(v) ?? []) if (!keep.has(n)) { keep.add(n); stack.push(n) }
  }
  return [...gone, ...left.filter((k) => !keep.has(k))]
}

/** Roads that no longer satisfy the placement rules: out of reach of every
 * building, or part of a road piece that touches no building. */
export function roadsToPrune(placed: Placed[], roads: Set<string>): string[] {
  const reach = buildingReach(placed)
  const far = [...roads].filter((key) => {
    const [a, b] = parseEdge(key)
    const edge: [number, number, number, number] = [a[0], a[1], b[0], b[1]]
    return !reach.some((r) => gapBetween(edge, r.rect) <= r.reach)
  })
  const farSet = new Set(far)
  const rest = roadsToDeleteWithOrphans([], placed, new Set([...roads].filter((k) => !farSet.has(k))), true)
  return [...far, ...rest]
}

/* ---------------- drawing ---------------- */

/** Fixed sun direction in map space (unit-ish), independent of the camera angle. */
const LIGHT_DIR: V2 = [0.97, 0.24]

const shadeCache = new Map<string, string>()
function shade(hex: string, f: number) {
  const ck = hex + f
  const hit = shadeCache.get(ck)
  if (hit) return hit
  const r = shadeRaw(hex, f)
  shadeCache.set(ck, r)
  return r
}
function shadeRaw(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`
}

/** Stable pseudo-random building color derived from the project id. */
const colorCache = new Map<string, string>()
function randomColor(id: string) {
  let c = colorCache.get(id)
  if (!c) colorCache.set(id, c = randomColorRaw(id))
  return c
}
function randomColorRaw(id: string) {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  h >>>= 0
  const hue = h % 360, s = 0.45 + ((h >>> 9) % 30) / 100, l = 0.5 + ((h >>> 17) % 15) / 100
  const k = (n: number) => (n + hue / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')
}

type Ctx = CanvasRenderingContext2D
function poly(ctx: Ctx, pts: [number, number][], fill: string, stroke?: string, lineWidth = 1) {
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke() }
}

function diamond(ctx: Ctx, gx: number, gy: number, w: number, h: number, z: number, fill: string, stroke?: string) {
  const a = toIso(gx, gy), b = toIso(gx + w, gy), c = toIso(gx + w, gy + h), d = toIso(gx, gy + h)
  poly(ctx, [[a.x, a.y - z], [b.x, b.y - z], [c.x, c.y - z], [d.x, d.y - z]], fill, stroke)
}

/** Extruded box on map-space corners A,B,C,D (in order). */
function prism(ctx: Ctx, A: V2, B: V2, C: V2, D: V2, height: number, color: string, opts: { windows?: string; z0?: number; alpha?: number; windowScale?: number; noWindowsOn?: [V2, V2][] } = {}) {
  const z0 = opts.z0 ?? 0
  const ws = opts.windowScale ?? 1
  const top = z0 + height
  const mapCorners = [A, B, C, D]
  const corners = mapCorners.map((p) => toIso(p[0], p[1]))
  // The two walls that meet at the nearest projected corner are visible. This
  // changes with each compass direction; keeping C fixed only worked in the
  // initial north-facing view.
  const nearest = corners.reduce((best, corner, index) => corner.y > corners[best].y ? index : best, 0)
  const pi = (nearest + 3) % 4, ni = (nearest + 1) % 4
  const previous = corners[pi]
  const current = corners[nearest]
  const next = corners[ni]
  const face = (from: typeof current, to: typeof current, fill: string) =>
    poly(ctx, [[from.x, from.y - z0], [to.x, to.y - z0], [to.x, to.y - top], [from.x, from.y - top]], fill)
  const centre: V2 = [(A[0] + B[0] + C[0] + D[0]) / 4, (A[1] + B[1] + C[1] + D[1]) / 4]
  const wallLight = (i: number, j: number) => {
    const p = mapCorners[i], q = mapCorners[j]
    const e = norm(sub(q, p))
    let n: V2 = [e[1], -e[0]]
    const mid: V2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
    if (n[0] * (mid[0] - centre[0]) + n[1] * (mid[1] - centre[1]) < 0) n = [-n[0], -n[1]]
    return Math.max(0.45, 0.5 + 0.3 * (n[0] * LIGHT_DIR[0] + n[1] * LIGHT_DIR[1]))
  }
  const lightPrev = wallLight(pi, nearest), lightNext = wallLight(nearest, ni)
  ctx.save()
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha
  face(previous, current, shade(color, lightPrev))
  face(current, next, shade(color, lightNext))
  if (opts.windows && height >= 8) {
    ctx.fillStyle = opts.windows
    const rows = Math.max(1, Math.floor(height / 12))
    const base = Math.min(5, (height - 6.5 * ws) / 2)
    const drawWindows = (from: typeof current, to: typeof current, mapLen: number, tint: string) => {
      const dx = to.x - from.x, dy = to.y - from.y
      const length = Math.hypot(dx, dy)
      const wx = dx / length * 5, wy = dy / length * 5
      const cols = Math.max(1, Math.round(mapLen * 2))
      ctx.beginPath()
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < cols; k++) {
          const t = ws < 1 ? (dx >= 0 ? 0.42 : 0.58) - 2.5 / length : (k + 0.3) / cols
          const x = from.x + dx * t, y = from.y + dy * t - z0 - base - r * 12
          ctx.moveTo(x, y); ctx.lineTo(x + wx, y + wy); ctx.lineTo(x + wx, y + wy - 6.5 * ws); ctx.lineTo(x, y - 6.5 * ws); ctx.closePath()
        }
      }
      ctx.fillStyle = tint
      ctx.fill()
    }
    const prevBrighter = lightPrev >= lightNext
    const isDoorWall = (i: number, j: number) => !!opts.noWindowsOn?.some((w) =>
      [[i, j], [j, i]].some(([a, c]) => mapCorners[a][0] === w[0][0] && mapCorners[a][1] === w[0][1] &&
        mapCorners[c][0] === w[1][0] && mapCorners[c][1] === w[1][1]))
    if (!isDoorWall(pi, nearest)) drawWindows(previous, current, dist(mapCorners[pi], mapCorners[nearest]), prevBrighter ? opts.windows : shade(opts.windows, 0.8))
    if (!isDoorWall(nearest, ni)) drawWindows(current, next, dist(mapCorners[nearest], mapCorners[ni]), prevBrighter ? shade(opts.windows, 0.8) : opts.windows)
  }
  // Draw the roof after facade details so it masks the wall at its top edge.
  poly(ctx, corners.map((q) => [q.x, q.y - top] as [number, number]), shade(color, 1.1))
  ctx.restore()
}

/** Position in a building's local frame: origin + (a, b). */
type Frame = (a: number, b: number) => V2
const frameOf = (b: { gx: number; gy: number }): Frame => (x, y) => [b.gx + x, b.gy + y]

/** Box in a local frame: a in [x, x+w], b in [y, y+h]. */
function boxAt(ctx: Ctx, at: Frame, x: number, y: number, w: number, h: number, height: number, color: string, opts: { windows?: string; z0?: number; alpha?: number; windowScale?: number; noWindowsOn?: [V2, V2][] } = {}) {
  prism(ctx, at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h), height, color, opts)
}

function line(ctx: Ctx, pts: [number, number][], color: string, w = 1) {
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke()
}

const NORMALS: V2[] = [[0, -1], [1, 0], [0, 1], [-1, 0]]

/** Door on the front wall of the box inset by m from the footprint, drawn
 * only while that wall faces the camera. */
/** Longest contiguous run of front cells [from, to] along the side the door faces. */
function frontRun(fp: Footprint, facing: Facing): [number, number] {
  const horizontal = facing === 0 || facing === 2
  const len = horizontal ? fp.w : fp.d
  let best: [number, number] = [0, 0], start = -1
  for (let i = 0; i <= len; i++) {
    const front = i < len && (horizontal ? hasCell(fp, i, facing === 0 ? 0 : fp.d - 1) : hasCell(fp, facing === 3 ? 0 : fp.w - 1, i))
    if (front && start < 0) start = i
    if (!front && start >= 0) { if (i - start > best[1] - best[0]) best = [start, i]; start = -1 }
  }
  return best
}

/** The front wall of the body inset by m, as a segment in the local frame. */
function frontWall(fp: Footprint, facing: Facing, m: number): [V2, V2] {
  const [r0, r1] = frontRun(fp, facing)
  const a = r0 + m, b = r1 - m
  return facing === 0 ? [[a, m], [b, m]] : facing === 1 ? [[fp.w - m, a], [fp.w - m, b]]
    : facing === 2 ? [[a, fp.d - m], [b, fp.d - m]] : [[m, a], [m, b]]
}

function drawDoor(ctx: Ctx, gx: number, gy: number, fp: Footprint, facing: Facing, m: number, z0 = 0, alpha = 1, win?: string) {
  const n = NORMALS[facing]
  if (toIso(n[0], n[1]).y <= 0.01) return
  const [w0, w1] = frontWall(fp, facing, m)
  let c: V2 = [gx + (w0[0] + w1[0]) / 2, gy + (w0[1] + w1[1]) / 2]
  let t: V2 = n[0] === 0 ? [1, 0] : [0, 1]
  if (win) {
    // Thin door left of centre, window to its right as seen on screen.
    if (toIso(t[0], t[1]).x < 0) t = mul(t, -1)
    const wc = add(c, mul(t, 0.1)), ww = 0.06
    c = sub(c, mul(t, 0.08))
    const p1 = toIso(...sub(wc, mul(t, ww))), p2 = toIso(...add(wc, mul(t, ww)))
    const y0 = z0 + 3.5, y1 = y0 + 4.9
    ctx.save()
    ctx.globalAlpha = alpha
    poly(ctx, [[p1.x, p1.y - y0], [p2.x, p2.y - y0], [p2.x, p2.y - y1], [p1.x, p1.y - y1]], win)
    ctx.restore()
  }
  const dw = win ? 0.5 : 1
  const quad = (hw: number, hgt: number, fill: string) => {
    const p1 = toIso(...sub(c, mul(t, hw))), p2 = toIso(...add(c, mul(t, hw)))
    poly(ctx, [[p1.x, p1.y - z0], [p2.x, p2.y - z0], [p2.x, p2.y - z0 - hgt], [p1.x, p1.y - z0 - hgt]], fill)
  }
  ctx.save()
  ctx.globalAlpha = alpha
  quad(0.17 * dw, 8, '#e8d5b0')
  quad(0.13 * dw, 7, '#4a2f1b')
  ctx.restore()
}

export const finalHeight = (p: Project) => floorsOf(p) * FLOOR_HEIGHT

/** Project-name sign standing on the roof edge above the front-door wall A-B. It lies in the wall's plane, so it foreshortens
 * with the map rotation and is skipped when the wall faces away or is seen too edge-on. */
function drawSign(ctx: Ctx, A: V2, B: V2, outward: V2, z: number, name: string, accent: string) {
  if (!name) return
  if (toIso(outward[0], outward[1]).y <= 0.01) return
  const mapLen = dist(A, B)
  let from = toIso(A[0], A[1]), to = toIso(B[0], B[1])
  if (to.x < from.x) { [from, to] = [to, from]; [A, B] = [B, A] }
  const facing = mapLen ? (to.x - from.x) / (mapLen * TILE_W / 2) : 0
  if (facing < 0.4) return
  const W = mapLen * TILE_W / 2 * 0.8
  const S = 1.5, post = 3 * S, bh = 5 * S, pad = 2 * S
  ctx.save()
  ctx.globalAlpha = Math.min(1, (facing - 0.4) / 0.3 + 0.35)
  const k = 1 / (mapLen * TILE_W / 2)
  ctx.font = `bold ${2.8 * S}px sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let text = name
  while (text.length > 1 && ctx.measureText(text).width > W - 2 * pad) text = text.slice(0, -1)
  if (text !== name) text = text.slice(0, -1) + '�'
  const bw = Math.min(W, ctx.measureText(text).width + 2 * pad)
  // Rear braces: from each post top back along the roof to the surface.
  ctx.strokeStyle = '#4b5563'
  ctx.lineWidth = 0.8 * S
  ctx.beginPath()
  for (const px of [1.5 * S, bw - 1.5 * S]) {
    const t = 0.1 + px * k
    const mx = A[0] + (B[0] - A[0]) * t, my = A[1] + (B[1] - A[1]) * t
    const top = toIso(mx, my), back = toIso(mx - outward[0] * 0.12 * S, my - outward[1] * 0.12 * S)
    ctx.moveTo(top.x, top.y - (z + post)); ctx.lineTo(back.x, back.y - z)
  }
  ctx.stroke()
  ctx.save()
  ctx.transform((to.x - from.x) * k, (to.y - from.y) * k, 0, 1,
    from.x + (to.x - from.x) * 0.1, from.y + (to.y - from.y) * 0.1 - (z + post + bh))
  ctx.strokeStyle = '#4b5563'
  ctx.lineWidth = 0.8 * S
  ctx.beginPath()
  ctx.moveTo(1.5 * S, bh); ctx.lineTo(1.5 * S, bh + post)
  ctx.moveTo(bw - 1.5 * S, bh); ctx.lineTo(bw - 1.5 * S, bh + post)
  ctx.stroke()
  ctx.fillStyle = '#1b2230'
  ctx.fillRect(0, 0, bw, bh)
  ctx.fillStyle = accent
  ctx.fillRect(0, 0, bw, 0.8 * S)
  ctx.fillStyle = '#fff'
  ctx.fillText(text, pad, bh / 2 + 0.3 * S)
  ctx.restore()
  ctx.restore()
}
/** Extruded body of the footprint inset by m; the parts of an L-shape are drawn far one first. */
function bodyAt(ctx: Ctx, at: Frame, fp: Footprint, m: number, height: number, color: string, opts: Parameters<typeof boxAt>[8] = {}) {
  const rects = footprintRects(fp, m)
  if (rects.length > 1 && toIso(0, 1).y <= 0) rects.reverse()
  for (const [x, y, w, d] of rects) boxAt(ctx, at, x, y, w, d, height, color, opts)
}

const baseWidth = (fp: Footprint) => fp.notch
  ? Math.min(fp.notch[0], fp.notch[1], fp.w - fp.notch[0], fp.d - fp.notch[1])
  : Math.min(fp.w, fp.d)

function drawGableRoof(ctx: Ctx, at: Frame, rect: [number, number, number, number], height: number, roofH: number) {
  const [x, y, w, d] = rect
  const alongX = w >= d
  const start = alongX ? at(x, y + d / 2) : at(x + w / 2, y)
  const end = alongX ? at(x + w, y + d / 2) : at(x + w / 2, y + d)
  const eaves: [V2, V2, V2, V2] = [at(x, y), at(x + w, y), at(x + w, y + d), at(x, y + d)]
  const point = (q: V2, z: number) => {
    const p = toIso(q[0], q[1])
    return [p.x, p.y - z] as [number, number]
  }
  const ridgeStart = point(start, height + roofH), ridgeEnd = point(end, height + roofH)
  const base = eaves.map((q) => point(q, height))
  poly(ctx, [base[0], base[1], ridgeEnd, ridgeStart], '#9fe3ff')
  poly(ctx, [ridgeStart, ridgeEnd, base[2], base[3]], shade('#9fe3ff', 0.9))
  if (alongX) {
    poly(ctx, [base[0], ridgeStart, base[3]], shade('#9fe3ff', 0.82))
    poly(ctx, [ridgeEnd, base[1], base[2]], shade('#9fe3ff', 1.05))
  } else {
    poly(ctx, [base[0], base[1], ridgeStart], shade('#9fe3ff', 0.82))
    poly(ctx, [ridgeEnd, base[2], base[3]], shade('#9fe3ff', 1.05))
  }
}

function drawFinished(ctx: Ctx, b: Placed, h: number, time: number) {
  const { p, fp } = b
  const at = frameOf(b)
  const rich = p.budget_spent > 5000, mid = p.budget_spent > 1500
  const color = randomColor(p.id)
  const win = rich ? '#ffe36b' : '#d8f4ff'
  const m = BUILDING_MARGIN
  const single = fp.w === 1 && fp.d === 1
  const narrow = baseWidth(fp) === 1
  const innerW = fp.w - 2 * m, innerD = fp.d - 2 * m
  const wall: [V2, V2][] = [0, 1, 2, 3].map((f) => frontWall(fp, f as Facing, m).map((q) => at(q[0], q[1])) as [V2, V2])
  bodyAt(ctx, at, fp, m, h, color, { windows: win, windowScale: narrow ? 0.75 : 1, noWindowsOn: narrow ? [wall[b.facing], wall[(b.facing + 2) % 4]] : undefined })
  drawDoor(ctx, b.gx, b.gy, fp, b.facing, m, 0, 1, narrow ? win : undefined)
  if (!narrow) drawSign(ctx, wall[b.facing][0], wall[b.facing][1], NORMALS[b.facing], h, p.name, '#e6b422')
  // Put bands on the facade before the roof so they cannot paint over its lower half.
  if (mid || rich) bodyAt(ctx, at, fp, m - 0.03, 3, '#e6b422', { z0: Math.max(0, h - 3) })
  const block = !fp.notch && Math.min(fp.w, fp.d) >= 3
  const roofH = narrow ? 8 : block ? 14 : 0
  if (single) {
    const roofColor = '#9fe3ff'
    const pts = [at(m, m), at(1 - m, m), at(1 - m, 1 - m), at(m, 1 - m)].map((q) => toIso(q[0], q[1]))
    const near = pts.reduce((best, q, i) => q.y > pts[best].y ? i : best, 0)
    const apex = toIso(...at(0.5, 0.5))
    const apexY = apex.y - h - roofH
    const tri = (i: number, j: number, f: number) =>
      poly(ctx, [[pts[i].x, pts[i].y - h], [pts[j].x, pts[j].y - h], [apex.x, apexY]], shade(roofColor, f))
    tri((near + 3) % 4, near, 0.9)
    tri(near, (near + 1) % 4, 1.05)
  } else if (narrow) {
    for (const rect of footprintRects(fp, m)) drawGableRoof(ctx, at, rect, h, roofH)
  } else if (block) {
    // roof block in the back-right corner as seen from outside the door
    const n = NORMALS[b.facing]
    const back: V2 = [-n[0], -n[1]], right: V2 = [n[1], -n[0]]
    const w = Math.min(innerW, innerD) * 0.4
    const cx = fp.w / 2 + (back[0] + right[0]) * innerW * 0.3
    const cy = fp.d / 2 + (back[1] + right[1]) * innerD * 0.3
    const roofColor = '#9fe3ff'
    boxAt(ctx, at, cx - w / 2, cy - w / 2, w, w, roofH, roofColor, { z0: h })
  }
  const c = toIso(...at(fp.w / 2, fp.d / 2))
  const top = narrow ? h + roofH : h
  if (rich) {
    // helipad
    ctx.beginPath()
    ctx.ellipse(c.x, c.y - top, 12, 6, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#333'; ctx.fill()
    ctx.fillStyle = '#fff'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'
    ctx.fillText('H', c.x, c.y - top + 3)
    // neon glow
    const pulse = 0.5 + 0.5 * Math.sin(time / 400)
    ctx.save(); ctx.globalAlpha = 0.25 + 0.2 * pulse
    ctx.fillStyle = '#ff3df2'
    ctx.beginPath(); ctx.ellipse(c.x, c.y, (fp.w + fp.d) * 12, (fp.w + fp.d) * 6, 0, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
}

/** Crane base position relative to the site origin; deliberately not on the diagonal. */
const craneBase = (fp: Footprint): V2 => [-0.42, BUILDING_MARGIN - 0.3 + (fp.d - 2 * BUILDING_MARGIN) * 0.25]

function craneDepth(b: Placed, angle: number) {
  const [cx, cy] = craneBase(b.fp)
  return toIso(b.gx + cx, b.gy + cy, angle).y
}

function drawSite(ctx: Ctx, b: Placed, prog: number, h: number, time: number, part: 'site' | 'crane') {
  const { fp } = b
  const at = frameOf(b)
  const iso = (a: number, c: number) => toIso(...at(a, c))
  if (part === 'crane') {
    drawCrane(ctx, b, prog, h, time)
    return
  }
  // slab
  const edge = BUILDING_MARGIN
  bodyAt(ctx, at, fp, edge, 2, '#9a9a9a')
  // dirt piles & barriers
  const d = iso(edge - 0.1, fp.d - edge + 0.05)
  ctx.fillStyle = '#8b6b3e'; ctx.beginPath(); ctx.ellipse(d.x, d.y - 2, 9, 4.5, 0, Math.PI, 0); ctx.fill()
  const outline = (inset: number) => {
    const pts = footprintOutline(fp, inset)
    return pts.map((q, i) => [q, pts[(i + 1) % pts.length]] as [V2, V2])
  }
  for (const [[x1, y1], [x2]] of outline(edge)) {
    if (x2 >= x1) continue
    const span = x1 - x2
    const n = Math.max(1, Math.round(span * 2))
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n
      boxAt(ctx, at, x2 + t * span - 0.08, y1, 0.16, 0.1, 5, k % 2 ? '#f4c20d' : '#d94b2b')
    }
  }
  // growing core (steel frame lower, concrete floors)
  const cur = Math.max(2, h * prog)
  const m = edge + (Math.min(fp.w, fp.d) - 2 * edge) * 0.15
  const floors = Math.floor(cur / 10)
  for (let f = 0; f < floors; f++) {
    bodyAt(ctx, at, fp, m, 8, '#b9b5ac', { z0: 2 + f * 10, alpha: f > floors - 3 ? 0.9 : 1 })
  }
  drawDoor(ctx, b.gx, b.gy, fp, b.facing, m, 2)
  // steel beams
  const top = 2 + cur
  for (const [x, y] of footprintOutline(fp, m)) { const q = iso(x, y); line(ctx, [[q.x, q.y - 2], [q.x, q.y - top - 6]], '#c0562a', 2) }
  // scaffolding on the faces pointing right and down
  const sh = Math.min(top, 2 + cur) + 4
  for (const [[x1, y1], [x2, y2]] of outline(edge)) {
    if (!(y2 > y1 || x2 < x1)) continue
    const a = iso(x1, y1), c = iso(x2, y2)
    line(ctx, [[a.x, a.y - 2], [a.x, a.y - sh]], '#e8c547')
    line(ctx, [[c.x, c.y - 2], [c.x, c.y - sh]], '#e8c547')
    for (let z = 8; z < sh; z += 10) line(ctx, [[a.x, a.y - z], [c.x, c.y - z]], '#e8c547')
    line(ctx, [[a.x, a.y - 2], [c.x, c.y - sh]], '#c9a227', 0.8)
  }
}

function drawProgressBar(ctx: Ctx, b: Placed, prog: number) {
  const { fp } = b
  const lb = toIso(b.gx + fp.w / 2, b.gy + fp.d / 2)
  const off = (fp.w + fp.d) * 8 + 6
  ctx.fillStyle = '#0006'; ctx.fillRect(lb.x - 20, lb.y + off, 40, 5)
  ctx.fillStyle = '#4ade80'; ctx.fillRect(lb.x - 20, lb.y + off, 40 * prog, 5)
}

function drawCrane(ctx: Ctx, b: Placed, prog: number, h: number, time: number) {
  const { fp } = b
  const at = frameOf(b)
  const iso = (a: number, c: number) => toIso(...at(a, c))
  const top = 2 + Math.max(2, h * prog)
  const [CRANE_X, CRANE_Y] = craneBase(fp)
  const base = iso(CRANE_X, CRANE_Y)
  const mast = Math.max(h, 30) + 40
  const bx = base.x, by = base.y - 2
  boxAt(ctx, at, CRANE_X - 0.3, CRANE_Y - 0.3, 0.6, 0.6, 1, '#444')
  boxAt(ctx, at, CRANE_X - 0.25, CRANE_Y - 0.25, 0.5, 0.5, 4, '#777', { z0: 1 })
  const drawMast = () => {
    line(ctx, [[bx - 3, by], [bx - 3, by - mast]], '#f2a900', 2)
    line(ctx, [[bx + 3, by], [bx + 3, by - mast]], '#f2a900', 2)
    for (let z = 0; z < mast; z += 10) line(ctx, [[bx - 3, by - z], [bx + 3, by - z - 10]], '#f2a900', 1)
  }
  // jib overhangs the building toward the centre, in world space so it stays visible from every angle
  const bw = at(CRANE_X, CRANE_Y), cw = at(fp.w / 2, fp.d / 2)
  const JIB_SKEW = 15 * Math.PI / 180 // keeps the jib from ever lining up exactly with the camera axis
  const dx = cw[0] - bw[0], dy = cw[1] - bw[1]
  let seed = 2166136261
  const sid = String(b.p.id)
  for (let i = 0; i < sid.length; i++) seed = Math.imul(seed ^ sid.charCodeAt(i), 16777619)
  seed >>>= 0
  const offset = (seed % 6283) / 1000 // 0..2π radians
  const period = 600 + ((seed >>> 13) % 300) // 600..900 ms
  // Occasionally swing 25° counter-clockwise for ~2 hook cycles, then back.
  // Positive map rotation is clockwise on screen, so counter-clockwise is negative.
  const hookCycles = time / (2 * Math.PI * period) + offset / (2 * Math.PI)
  const cycle = 12 + ((seed >>> 8) % 19) // 12..30 hook cycles per crane, fixed
  const u = ((hookCycles % cycle) + cycle) % cycle
  const s0 = cycle - 6
  const ease = (x: number) => x * x * (3 - 2 * x)
  const swing = ease(Math.min(1, Math.max(0, (u - s0) / 0.5))) * (1 - ease(Math.min(1, Math.max(0, (u - s0 - 2.5) / 0.5))))
  const variation = (((seed >>> 3) % 2001) / 1000 - 1) * 5 // -5..+5 degrees
  const rot = JIB_SKEW - (5 + variation) * Math.PI / 180 - swing * 25 * Math.PI / 180
  const jx = dx * Math.cos(rot) - dy * Math.sin(rot)
  const jy = dx * Math.sin(rot) + dy * Math.cos(rot)
  const jibAt = (t: number) => {
    const q = toIso(bw[0] + jx * t, bw[1] + jy * t)
    return { x: q.x, gy: q.y, y: q.y - 2 - mast }
  }
  const tip = jibAt(1.4), tail = jibAt(-0.25)
  const cab = { x: bx, y: by - mast }
  const drawCounterweight = () => { ctx.fillStyle = '#555'; ctx.fillRect(tail.x - 4, tail.y - 2, 8, 6) }
  // hook cycling: lowers to building top, raises with material
  const hp = jibAt(0.9)
  const cx = hp.x
  const phase = (Math.sin(time / period + offset) + 1) / 2
  const topY = hp.gy - top - 8
  const hookY = hp.y + 10 + (topY - hp.y - 10) * phase
  const drawHook = () => {
    line(ctx, [[cx, hp.y + 1], [cx, hookY]], '#222', 1)
    ctx.fillStyle = '#222'; ctx.fillRect(cx - 2, hookY, 4, 4)
    if (phase > 0.15) { ctx.fillStyle = '#c0562a'; ctx.fillRect(cx - 6, hookY + 4, 12, 4) }
  }
  const tipFar = tip.gy < tail.gy
  const drawTipSide = () => {
    drawHook() // always behind the arm: the camera looks down from above
    line(ctx, [[bx, cab.y + 1], [tip.x, tip.y + 1]], '#f2a900', 3)
    line(ctx, [[bx, cab.y - 14], [tip.x, tip.y + 1]], '#c98a00', 1)
  }
  const drawTailSide = () => {
    line(ctx, [[tail.x, tail.y + 1], [bx, cab.y + 1]], '#f2a900', 3)
    line(ctx, [[bx, cab.y - 14], [tail.x, tail.y + 1]], '#c98a00', 1)
    drawCounterweight()
  }
  // Whichever side points away from the camera is hidden behind the mast and cab.
  if (tipFar) { drawTipSide(); drawMast(); drawTailSide() }
  else { drawTailSide(); drawMast(); drawTipSide() }
  ctx.fillStyle = '#fff'; ctx.fillRect(bx - 4, cab.y - 6, 8, 6) // cab
}

export interface Traffic {
  edge: number
  seg?: [V2, V2] // endpoints of the street the car is on, so it survives edge reindexing
  t: number
  speed: number
  baseSpeed: number
  color: string
  dir: 1 | -1
  lastTime: number
  cruise?: number // speed before the corner slowdown is applied
  turn?: { seg: [V2, V2]; dir: 1 | -1; a: V2; c: V2; c2?: V2; b: V2; r1: number; r2: number; passed: boolean; slow: number; lut: number[]; len: number } // visual curve through the next junction
}

export interface Camera { x: number; y: number; zoom: number; angle: number }

export type Preview =
  | { kind: 'building'; gx: number; gy: number; fp: Footprint; height: number; facing: Facing; ok: boolean }
  | { kind: 'road'; mode: 'add' | 'delete'; edges: string[] }
  | { kind: 'grid' }

export interface RenderState {
  placed: Placed[]
  roads: Set<string>
  elapsed: number // retained for the rendering/picking API
  time: number
  cam: Camera
  selected?: string
  cars: Traffic[]
  preview?: Preview
}

export const progressOf = (b: Placed, elapsed: number) =>
  b.duration <= 0 ? 1 : Math.max(0, Math.min(1, (elapsed - b.start) / b.duration))

export function formatRemaining(b: Placed, elapsed: number) {
  const s = Math.max(0, Math.ceil((b.start + b.duration - elapsed) / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function viewDepth(b: Placed, angle: number) {
  // The projected vertical axis determines which footprint is farther away.
  return toIso(b.gx + b.fp.w / 2, b.gy + b.fp.d / 2, angle).y + (b.fp.w + b.fp.d) / 2
}

export const carCountFor = (n: number) => (n < 1 ? 0 : Math.min(30, n * 2))

const bezier = (a: V2, c: V2, b: V2, u: number, c2?: V2): V2 => {
  if (c2) {
    const m = 1 - u, w0 = m * m * m, w1 = 3 * m * m * u, w2 = 3 * m * u * u, w3 = u * u * u
    return [w0 * a[0] + w1 * c[0] + w2 * c2[0] + w3 * b[0], w0 * a[1] + w1 * c[1] + w2 * c2[1] + w3 * b[1]]
  }
  const w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u
  return [w0 * a[0] + w1 * c[0] + w2 * b[0], w0 * a[1] + w1 * c[1] + w2 * b[1]]
}

// Road sets are replaced, never mutated, once they reach the renderer.
const roadGeom = new WeakMap<Set<string>, { edges: [V2, V2][]; verts: V2[] }>()
const roadGeometry = (roads: Set<string>) => {
  let g = roadGeom.get(roads)
  if (!g) roadGeom.set(roads, g = { edges: [...roads].map(parseEdge), verts: [...roadVertices(roads)].map((v) => v.split(',').map(Number) as V2) })
  return g
}
const roadEdges = (roads: Set<string>) => roadGeometry(roads).edges

export function makeCars(placed: Placed[], roads: Set<string>): Traffic[] {
  const count = carCountFor(placed.length)
  const edges = roadEdges(roads)
  const colors = ['#ef4444', '#3b82f6', '#facc15', '#ffffff', '#22c55e']
  if (!edges.length) return []
  return Array.from({ length: count }, (_, i) => ({
    edge: i % edges.length,
    t: (i * 0.37) % 1,
    speed: 0.9 + (i % 4) * 0.25, baseSpeed: 0.9 + (i % 4) * 0.25, // tiles per second
    color: colors[i % 5], dir: i % 2 ? -1 : 1, lastTime: 0,
  }))
}

const hash2 = (x: number, y: number, k: number) => {
  const v = Math.sin(x * 127.1 + y * 311.7 + k * 74.7) * 43758.5453
  return v - Math.floor(v)
}

/** Scatter small grass blades over a map-space rectangle. Positions are hashed
 * from the grid cell, so the pattern is stable while panning and zooming. */
/* Repeating grass texture. Blade bases sit on a cell grid in projected (screen-plane) coordinates that
 * wraps every GRASS_W x GRASS_H units, so one pre-drawn tile covers the whole map and panning or
 * zooming only moves a pattern. Because it lives in the projected plane it does not rotate with
 * the map. */
const GRASS_W = 1024, GRASS_H = 512, GRASS_NX = 107, GRASS_NY = 54
const GRASS_DENSITY = 0.3 // fraction of cells that get a blade
const GRASS_SCALES = [1, 2, 0.5]
const grassTiles = new Map<number, HTMLCanvasElement>()
let grassWarmup = false

function buildGrassTile(scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(GRASS_W * scale); canvas.height = Math.round(GRASS_H * scale)
  const c = canvas.getContext('2d')!
  c.scale(scale, scale)
  const cw = GRASS_W / GRASS_NX, ch = GRASS_H / GRASS_NY
  const shades = ['#5f9a4c', '#8cc274', '#4e8a3d']
  const paths = shades.map(() => new Path2D())
  for (let i = 0; i < GRASS_NX; i++) {
    for (let j = 0; j < GRASS_NY; j++) {
      if (hash2(i, j, 1) > GRASS_DENSITY) continue
      const x = (i + hash2(i, j, 2)) * cw, y = (j + hash2(i, j, 3)) * ch
      const hgt = 2.5 + hash2(i, j, 4) * 3
      const lean = (hash2(i, j, 5) - 0.5) * 3
      const p = paths[Math.floor(hash2(i, j, 6) * shades.length)]
      // Blades near an edge are repeated on the far side so the tile wraps seamlessly.
      for (const ox of [-GRASS_W, 0, GRASS_W]) {
        if (x + ox < -7 || x + ox > GRASS_W + 7) continue
        for (const oy of [-GRASS_H, 0, GRASS_H]) {
          if (y + oy < -7 || y + oy > GRASS_H + 7) continue
          for (const o of [-1.2, 0, 1.2]) {
            p.moveTo(x + ox + o, y + oy)
            p.lineTo(x + ox + o * 1.8 + lean, y + oy - hgt + Math.abs(o))
          }
        }
      }
    }
  }
  c.lineWidth = 0.8
  c.lineCap = 'round'
  shades.forEach((color, i) => { c.strokeStyle = color; c.stroke(paths[i]) })
  grassTiles.set(scale, canvas)
  return canvas
}

// Build the other quality levels one per timer tick, so zooming across a boundary never has to build a tile mid-frame.
function warmGrassTiles() {
  if (grassWarmup) return
  grassWarmup = true
  const next = () => {
    const missing = GRASS_SCALES.find((sc) => !grassTiles.has(sc))
    if (missing === undefined) return
    buildGrassTile(missing)
    setTimeout(next, 50)
  }
  setTimeout(next, 200)
}

function texturedGrass(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, scale: number) {
  const tile = grassTiles.get(scale) ?? buildGrassTile(scale)
  warmGrassTiles()
  for (let ty = Math.floor(y0 / GRASS_H); ty * GRASS_H < y1; ty++)
    for (let tx = Math.floor(x0 / GRASS_W); tx * GRASS_W < x1; tx++)
    {
      // Draw only the part of the tile that is visible.
      const ax = Math.max(x0, tx * GRASS_W), ay = Math.max(y0, ty * GRASS_H)
      const bx = Math.min(x1, (tx + 1) * GRASS_W), by = Math.min(y1, (ty + 1) * GRASS_H)
      if (bx > ax && by > ay) ctx.drawImage(tile, (ax - tx * GRASS_W) * scale, (ay - ty * GRASS_H) * scale, (bx - ax) * scale, (by - ay) * scale, ax, ay, bx - ax, by - ay)
    }
}

const groundCache: { key: string; last: string; canvas?: HTMLCanvasElement } = { key: '', last: '' }

export function render(ctx: Ctx, w: number, h: number, s: RenderState) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#bfe3f5'); g.addColorStop(1, '#e8f4ea')
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h)
  ctx.translate(w / 2 + s.cam.x, h / 2 + s.cam.y)
  ctx.scale(s.cam.zoom, s.cam.zoom)
  projectionAngle = s.cam.angle
  // Visible rectangle in projected (pre-camera) coordinates, used to skip off-screen drawing.
  const vx0 = (-w / 2 - s.cam.x) / s.cam.zoom, vx1 = (w / 2 - s.cam.x) / s.cam.zoom
  const vy0 = (-h / 2 - s.cam.y) / s.cam.zoom, vy1 = (h / 2 - s.cam.y) / s.cam.zoom

  // Ground covers the whole viewport, so the city can grow in any direction;
  // the "map" is effectively infinite. Project the screen corners back to map
  // space and fill their (rotated) bounding box, plus a margin for the tilt.
  const view = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => screenToMap(x, y, w, h, s.cam))
  const xs = view.map((p) => p[0]), ys = view.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  {
    const m = ((maxX - minX) + (maxY - minY)) / 4
    const paintGround = (c: Ctx) => {
      diamond(c, minX - m, minY - m, maxX - minX + 2 * m, maxY - minY + 2 * m, 0, '#7fb069')
      const need = s.cam.zoom * (ctx.canvas.width / w)
      const scale = Math.min(2, Math.max(0.5, 2 ** Math.round(Math.log2(need))))
      texturedGrass(c, vx0 - 12, vy0 - 12, vx1 + 12, vy1 + 12, scale)
    }
    // The ground is the costliest part of a frame and only changes with the camera.
    // Once the camera has held still for a frame, paint it once into a bitmap and
    // reuse that until the camera or canvas size changes.
    const key = [ctx.canvas.width, ctx.canvas.height, w, h, s.cam.x, s.cam.y, s.cam.zoom, s.cam.angle].join('|')
    const gc = groundCache
    if (gc.key !== key && gc.last === key) {
      const oc = gc.canvas ??= document.createElement('canvas')
      oc.width = ctx.canvas.width; oc.height = ctx.canvas.height
      const o = oc.getContext('2d')!
      o.translate(w / 2 + s.cam.x, h / 2 + s.cam.y)
      o.scale(s.cam.zoom, s.cam.zoom)
      paintGround(o)
      gc.key = key
    }
    if (gc.key === key && gc.canvas) {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(gc.canvas, 0, 0)
      ctx.restore()
    } else paintGround(ctx)
    gc.last = key
  }

  // Faint grid while placing, so the edges are visible.
  if (s.preview && maxX - minX < 90 && maxY - minY < 90) {
    const x0 = Math.floor(minX), x1 = Math.ceil(maxX), y0 = Math.floor(minY), y1 = Math.ceil(maxY)
    ctx.beginPath()
    for (let x = x0; x <= x1; x++) {
      const a = toIso(x, y0), b = toIso(x, y1)
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
    }
    for (let y = y0; y <= y1; y++) {
      const a = toIso(x0, y), b = toIso(x1, y)
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  const edges = roadEdges(s.roads)
  // Roads: asphalt band centred on each grid edge, with kerbs and a dashed
  // centre line. Discs at the vertices round off the joints.
  if (edges.length) {
    const hw = 0.15
    const iso = (p: V2): [number, number] => { const q = toIso(p[0], p[1]); return [q.x, q.y] }
    const band = (a: V2, b: V2, half: number) => {
      const n = norm(sub(b, a)), p: V2 = [-n[1], n[0]]
      return [add(a, mul(p, half)), add(b, mul(p, half)), sub(b, mul(p, half)), sub(a, mul(p, half))].map(iso)
    }
    const unit = Array.from({ length: 20 }, (_, i) => [Math.cos(i / 20 * Math.PI * 2), Math.sin(i / 20 * Math.PI * 2)])
    const disc = (c: V2, r: number) => unit.map((u) => iso([c[0] + u[0] * r, c[1] + u[1] * r]))
    const verts = roadGeometry(s.roads).verts
    const onScreen = (x0: number, y0: number, x1: number, y1: number) =>
      Math.max(x0, x1) + 30 >= vx0 && Math.min(x0, x1) - 30 <= vx1 && Math.max(y0, y1) + 30 >= vy0 && Math.min(y0, y1) - 30 <= vy1
    const visEdges = edges.filter(([a, b]) => { const p = toIso(a[0], a[1]), q = toIso(b[0], b[1]); return onScreen(p.x, p.y, q.x, q.y) })
    const visVerts = verts.filter((v) => { const p = toIso(v[0], v[1]); return onScreen(p.x, p.y, p.x, p.y) })
    // One path per layer. Discs are wound opposite to the bands so overlaps never cancel under the nonzero rule.
    const layer = (half: number, color: string) => {
      ctx.beginPath()
      const add = (pts: [number, number][]) => { pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath() }
      for (const [a, b] of visEdges) add(band(a, b, half) as [number, number][])
      for (const v of visVerts) add((disc(v, half) as [number, number][]).reverse())
      ctx.fillStyle = color
      ctx.fill()
    }
    layer(0.24, '#d6d3cc')
    layer(hw, '#4a4e57')
    ctx.save()
    ctx.setLineDash([10, 9])
    ctx.beginPath()
    for (const [a, b] of visEdges) { const p = iso(a), q = iso(b); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]) }
    ctx.strokeStyle = 'rgba(250,220,90,0.9)'; ctx.lineWidth = 1.2; ctx.stroke()
    ctx.restore()
  }

  // traffic on the roads only (drawn before buildings)
  // Advance each car as a small queue per edge. Cars reduce their speed when
  // another car is too close ahead on the same edge in the same direction.
  const previous = s.cars.map((car) => car.t)
  const previousSpeed = s.cars.map((car) => car.speed)
  s.cars.forEach((car, index) => {
    if (!edges.length) return
    const sameSeg = (f: [V2, V2], g: [V2, V2]) =>
      (dist(f[0], g[0]) < 0.01 && dist(f[1], g[1]) < 0.01) || (dist(f[0], g[1]) < 0.01 && dist(f[1], g[0]) < 0.01)
    if (!car.seg) car.seg = edges[car.edge % edges.length]
    if (!edges[car.edge] || !sameSeg(edges[car.edge], car.seg)) {
      const found = edges.findIndex((f) => sameSeg(f, car.seg!))
      if (found >= 0) car.edge = found
      else { car.edge = Math.floor(Math.random() * edges.length); car.seg = edges[car.edge]; car.t = 0 }
    }
    const e = edges[car.edge]
    const L = Math.max(0.001, dist(e[0], e[1]))
    const dt = car.lastTime ? Math.min(80, s.time - car.lastTime) / 1000 : 0
    let ahead = 1
    let leader: Traffic | undefined
    let leaderIndex = -1
    for (let otherIndex = 0; otherIndex < s.cars.length; otherIndex++) {
      const other = s.cars[otherIndex]
      if (otherIndex === index || other.edge !== car.edge || other.dir !== car.dir) continue
      const d = previous[otherIndex] - previous[index]
      // Only cars further along this street block us (streets aren't loops); ties go to the lower index so nobody deadlocks.
      if ((d > 0 || (d === 0 && otherIndex < index)) && d < ahead) { ahead = d; leader = other; leaderIndex = otherIndex }
    }
    const gap = ahead * L
    if (leader) {
      // Match the leader's pace instead of stopping; close the gap to a quarter of the old following distance.
      const leaderSpeed = Math.min(car.baseSpeed, previousSpeed[leaderIndex] || leader.baseSpeed)
      const t = Math.min(1, Math.max(0, (gap - 0.3) / 0.75))
      car.speed = leaderSpeed + (car.baseSpeed - leaderSpeed) * t
    } else car.speed = car.baseSpeed
    // Ease toward the target speed so following cars don't surge and brake.
    const prevSpeed = car.cruise ?? (previousSpeed[index] || car.baseSpeed)
    const maxStep = car.baseSpeed * 0.5 * dt
    car.speed = prevSpeed + Math.max(-maxStep, Math.min(maxStep, car.speed - prevSpeed))
    car.cruise = car.speed
    // Slow down through corners. The factor is already smooth in distance, so it is applied directly.
    if (car.turn) {
      const dj = car.turn.passed ? car.t * L : (1 - car.t) * L
      const w = Math.max(0, Math.min(1, 1 - dj / 0.5))
      car.speed *= 1 - (1 - car.turn.slow) * w * w * (3 - 2 * w)
    }
    // The curve's length differs from the street distance it replaces; compensate so the real speed matches.
    const pathScale = car.turn && (car.turn.passed ? car.t * L < car.turn.r2 : (1 - car.t) * L < car.turn.r1) ? (car.turn.r1 + car.turn.r2) / car.turn.len : 1
    car.t += (dt * car.speed * pathScale) / L
    if (leader) {
      // Hard floor on the gap so frame-order effects can't let the car creep up on the leader.
      const li = leaderIndex
      const limit = previous[li] + (dt * (previousSpeed[li] || 0)) / L - 0.3 / L
      car.t = Math.max(previous[index], Math.min(car.t, limit))
    }
    car.lastTime = s.time
    const laneOffset = (seg: [V2, V2], dir: 1 | -1): V2 => {
      const m = norm(sub(seg[1], seg[0]))
      return mul([m[1], -m[0]], -0.07 * dir)
    }
    const lanePoint = (seg: [V2, V2], dir: 1 | -1, t: number): V2 => {
      const sl = Math.max(0.001, dist(seg[0], seg[1]))
      return add(add(seg[0], mul(norm(sub(seg[1], seg[0])), sl * (dir === 1 ? t : 1 - t))), laneOffset(seg, dir))
    }
    // Pick the street to take at the end of this one (no U-turn unless dead end) and build the
    // curve joining the two lanes. The curve is purely visual: car.t / car.edge keep the original
    // logic, so queueing is unaffected.
    const planTurn = () => {
      const end = car.dir === 1 ? e[1] : e[0]
      const near = (p: V2) => dist(p, end) < 0.01
      const options: { seg: [V2, V2]; dir: 1 | -1 }[] = []
      edges.forEach((f) => {
        if (sameSeg(f, e)) return
        if (near(f[0])) options.push({ seg: f, dir: 1 })
        else if (near(f[1])) options.push({ seg: f, dir: -1 })
      })
      const o = options.length ? options[Math.floor(Math.random() * options.length)] : { seg: e, dir: (car.dir === 1 ? -1 : 1) as 1 | -1 }
      const nL = Math.max(0.001, dist(o.seg[0], o.seg[1]))
      const uTurnPlanned = !options.length || dist(o.seg[0], e[0]) < 0.01 && dist(o.seg[1], e[1]) < 0.01 || sameSeg(o.seg, e)
      const r1 = Math.min(uTurnPlanned ? 0.1 : 0.25, L / 2), r2 = Math.min(r1, nL / 2)
      const oldOff = laneOffset(e, car.dir), newOff = laneOffset(o.seg, o.dir)
      const d1 = mul(norm(sub(e[1], e[0])), car.dir), d2 = mul(norm(sub(o.seg[1], o.seg[0])), o.dir)
      const k = 1 + d1[0] * d2[0] + d1[1] * d2[1]
      const a = lanePoint(e, car.dir, 1 - r1 / L), b = lanePoint(o.seg, o.dir, r2 / nL)
      // Control point = where the two lane lines cross, so the curve is tangent to both.
      const uTurn = k < 0.2
      const c = uTurn ? add(a, mul(d1, dist(a, b))) : add(end, mul(add(oldOff, newOff), 1 / k))
      const c2 = uTurn ? add(b, mul(d1, dist(a, b))) : undefined
      const lut = [0]
      let prev = a
      for (let i = 1; i <= 16; i++) {
        const p = bezier(a, c, b, i / 16, c2)
        lut.push(lut[i - 1] + dist(prev, p)); prev = p
      }
      car.turn = { seg: o.seg, dir: o.dir, a, c, c2, b, r1, r2, passed: false, slow: (() => { const d = d1[0] * d2[0] + d1[1] * d2[1]; return d >= 0 ? 0.3 + 0.7 * d : 0.3 + 0.18 * d })(), lut, len: Math.max(0.001, lut[16]) }
    }
    if ((!car.turn || car.turn.passed) && (1 - car.t) * L <= 0.5) planTurn()
    if (car.t >= 1) {
      if (!car.turn || car.turn.passed) planTurn()
      const tr = car.turn!
      const found = edges.findIndex((f) => sameSeg(f, tr.seg))
      if (found >= 0) { car.edge = found; car.dir = tr.dir; car.seg = edges[found] }
      else car.dir = car.dir === 1 ? -1 : 1
      tr.passed = true
      car.t = 0
    }
    const ce = edges[car.edge]
    const cL = Math.max(0.001, dist(ce[0], ce[1]))
    if (car.turn?.passed && car.t * cL >= 0.5) car.turn = undefined
    let pos: V2
    if (car.turn && (car.turn.passed ? car.t * cL < car.turn.r2 : (1 - car.t) * L < car.turn.r1)) {
      const { r1, r2, passed, lut, len } = car.turn
      const frac = Math.max(0, Math.min(1, (passed ? r1 + car.t * cL : r1 - (1 - car.t) * cL) / Math.max(0.001, r1 + r2)))
      const target = frac * len
      let i = 1
      while (i < 16 && lut[i] < target) i++
      const seglen = Math.max(1e-6, lut[i] - lut[i - 1])
      pos = bezier(car.turn.a, car.turn.c, car.turn.b, (i - 1 + Math.max(0, Math.min(1, (target - lut[i - 1]) / seglen))) / 16, car.turn.c2)
    } else {
      pos = lanePoint(ce, car.dir, car.t)
    }
    const q = toIso(pos[0], pos[1])
    ctx.fillStyle = car.color
    ctx.beginPath(); ctx.ellipse(q.x, q.y - 2, 3, 1.9, 0, 0, Math.PI * 2); ctx.fill()
  })

  // depth-sorted buildings
  const items: { b: Placed; crane: boolean; depth: number }[] = []
  for (const b of s.placed) {
    items.push({ b, crane: false, depth: viewDepth(b, s.cam.angle) })
    if ((b.fp.w > 1 || b.fp.d > 1) && progressOf(b, s.elapsed) < 1) items.push({ b, crane: true, depth: craneDepth(b, s.cam.angle) })
  }
  items.sort((a, c) => a.depth - c.depth || a.b.gx - c.b.gx || Number(a.crane) - Number(c.crane))
  for (const { b, crane } of items) {
    const prog = progressOf(b, s.elapsed)
    if (prog <= 0) continue
    const fh = finalHeight(b.p)
    const bc = toIso(b.gx + b.fp.w / 2, b.gy + b.fp.d / 2)
    const pad = Math.max(b.fp.w, b.fp.d) * TILE_W + 100
    if (bc.x + pad < vx0 || bc.x - pad > vx1 || bc.y + pad < vy0 || bc.y - pad - fh - 120 > vy1) continue
    if (crane) { drawSite(ctx, b, prog, fh, s.time, 'crane'); continue }
    if (prog < 1) drawSite(ctx, b, prog, fh, s.time, 'site')
    else drawFinished(ctx, b, fh, s.time)
    if (s.selected === b.p.id) {
      poly(ctx, footprintOutline(b.fp, -0.1).map(([x, y]) => { const q = toIso(b.gx + x, b.gy + y); return [q.x, q.y] as [number, number] }), 'rgba(255,255,255,0.25)', '#fff')
    }
  }
  for (const b of s.placed) {
    const prog = progressOf(b, s.elapsed)
    if (prog > 0 && prog < 1) drawProgressBar(ctx, b, prog)
  }

  // live placement preview
  const pv = s.preview
  if (pv?.kind === 'road') {
    const seg = (key: string, color: string, width: number) => {
      const [a, b] = parseEdge(key)
      const qa = toIso(a[0], a[1]), qb = toIso(b[0], b[1])
      line(ctx, [[qa.x, qa.y], [qb.x, qb.y]], color, width)
    }
    const dashed = (keys: Iterable<string>, color: string) => {
      ctx.save()
      ctx.setLineDash([6, 5])
      for (const key of keys) seg(key, color, 3)
      ctx.restore()
    }
    if (pv.mode === 'add') {
      // Every edge the tool could add right now: edges touching an existing road.
      const open = new Set<string>()
      const cands = new Set<string>()
      for (const v of roadVertices(s.roads)) {
        const [x, y] = v.split(',').map(Number)
        cands.add(edgeKey(x, y, 'h')); cands.add(edgeKey(x - 1, y, 'h'))
        cands.add(edgeKey(x, y, 'v')); cands.add(edgeKey(x, y - 1, 'v'))
      }
      if (!s.roads.size) {
        for (const b of s.placed) for (const f of [0, 1, 2, 3] as Facing[]) for (const k of frontEdges(b.gx, b.gy, b.fp, f)) cands.add(k)
      }
      const rv = roadVertices(s.roads)
      for (const key of cands) if (!roadError(key, s.placed, s.roads, rv)) open.add(key)
      dashed(open, 'rgba(56,189,248,0.9)')
      const good = new Set(roadsToAdd(pv.edges, s.placed, s.roads))
      for (const key of pv.edges) {
        const ok = good.has(key)
        seg(key, ok ? 'rgba(74,222,128,0.85)' : 'rgba(248,113,113,0.85)', 7)
        seg(key, ok ? '#bbf7d0' : '#fecaca', 2)
      }
    } else {
      dashed(s.roads, 'rgba(251,113,60,0.9)')
      for (const key of pv.edges) if (!s.roads.has(key)) seg(key, 'rgba(148,163,184,0.7)', 1.5)
      for (const key of roadsToDeleteWithOrphans(pv.edges, s.placed, s.roads)) {
        seg(key, 'rgba(239,68,68,0.9)', 7)
        seg(key, '#fecaca', 2)
      }
    }
  } else if (pv?.kind === 'building') {
    const { gx, gy, height, facing, ok } = pv
    const fp = orient(pv.fp, facing)
    poly(ctx, footprintOutline(fp).map(([x, y]) => { const q = toIso(gx + x, gy + y); return [q.x, q.y] as [number, number] }), ok ? 'rgba(74,222,128,0.35)' : 'rgba(248,113,113,0.35)', ok ? '#4ade80' : '#f87171')
    const at = frameOf({ gx, gy })
    const m = BUILDING_MARGIN
    bodyAt(ctx, at, fp, m, height, ok ? '#e5e7eb' : '#fca5a5', { alpha: 0.35 })
    drawDoor(ctx, gx, gy, fp, facing, m, 0, 0.7)
    ctx.save()
    ctx.setLineDash([6, 5])
    for (const key of frontEdges(gx, gy, fp, facing)) {
      const [a, b] = parseEdge(key)
      const qa = toIso(a[0], a[1]), qb = toIso(b[0], b[1])
      line(ctx, [[qa.x, qa.y], [qb.x, qb.y]], ok ? '#4ade80' : '#f87171', 3)
    }
    ctx.restore()
  }
}

/** Convert a canvas point to free map coordinates (inverse of camera + projection). */
export function screenToMap(sx: number, sy: number, w: number, h: number, cam: Camera): V2 {
  const screenX = (sx - w / 2 - cam.x) / cam.zoom
  const screenY = (sy - h / 2 - cam.y) / cam.zoom
  const r = toGrid(screenX, screenY)
  const cos = Math.cos(cam.angle), sin = Math.sin(cam.angle)
  return [r.gx * cos + r.gy * sin, -r.gx * sin + r.gy * cos]
}

/** Find the building whose footprint contains the screen point. */
export function pick(placed: Placed[], elapsed: number, sx: number, sy: number, w: number, h: number, cam: Camera): Placed | undefined {
  const screenX = (sx - w / 2 - cam.x) / cam.zoom
  const screenY = (sy - h / 2 - cam.y) / cam.zoom
  const cos = Math.cos(cam.angle), sin = Math.sin(cam.angle)
  const order = [...placed].sort((a, b) => viewDepth(b, cam.angle) - viewDepth(a, cam.angle))
  for (const b of order) {
    const fh = finalHeight(b.p) * Math.max(0, Math.min(1, progressOf(b, elapsed)))
    // test against the footprint, shifted down by heights up to the roof
    for (let z = 0; z <= fh + 14; z += 6) {
      // Convert the projected point into rotated map space, then undo the
      // camera's compass rotation. Building height is always screen-vertical.
      const rotated = toGrid(screenX, screenY + z)
      const gx = rotated.gx * cos + rotated.gy * sin
      const gy = -rotated.gx * sin + rotated.gy * cos
      if (hasCell(b.fp, Math.floor(gx - b.gx), Math.floor(gy - b.gy))) return b
    }
  }
  return undefined
}

export const centerOn = (b: Placed, cur?: Camera): Camera => {
  const angle = cur?.angle ?? 0
  const zoom = cur?.zoom ?? 1.2
  const c = toIso(b.gx + b.fp.w / 2, b.gy + b.fp.d / 2, angle)
  return { x: -c.x * zoom, y: (-c.y + finalHeight(b.p) / 2) * zoom, zoom, angle }
}
