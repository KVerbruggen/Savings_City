import { type Project, timeSaved, timeSavingsRatio } from './services/storageService'

export const TILE_W = 64
export const TILE_H = 32
// Floors follow MAX_FLOORS * (1 - e^(-(hours / FLOOR_CURVE_HOURS)^FLOOR_CURVE_POWER)).
// 50h saved ≈ 5 floors, 100h ≈ 13, 500h ≈ 106, 1000h ≈ 177; never exceeds MAX_FLOORS.
const MAX_FLOORS = 200
const FLOOR_CURVE_HOURS = 600
const BUILDING_MARGIN = 0.3 // clears the sidewalk (0.24 from the road centre line)
const FLOOR_CURVE_POWER = 1.5 // >1 keeps low-hour buildings short, then ramps up
const FLOOR_HEIGHT = 10 // px per floor
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

export const footprint = (p: Project) =>
  p.time_estimated_no_ai < 40 ? 1 : p.time_estimated_no_ai <= 160 ? 2 : 3

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
  size: number
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
      p, size: footprint(p), gx: p.gx, gy: p.gy,
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

/** Lattice points along the front side of a building (size + 1 of them). */
const frontVertices = (gx: number, gy: number, size: number, facing: Facing): string[] =>
  Array.from({ length: size + 1 }, (_, i) =>
    facing === 0 ? `${gx + i},${gy}`
      : facing === 1 ? `${gx + size},${gy + i}`
        : facing === 2 ? `${gx + i},${gy + size}`
          : `${gx},${gy + i}`)

export function frontEdges(gx: number, gy: number, size: number, facing: Facing): string[] {
  return Array.from({ length: size }, (_, i) =>
    facing === 0 ? edgeKey(gx + i, gy, 'h')
      : facing === 1 ? edgeKey(gx + size, gy + i, 'v')
        : facing === 2 ? edgeKey(gx + i, gy + size, 'h')
          : edgeKey(gx, gy + i, 'v'))
}

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
    for (let x = 0; x < b.size; x++) for (let y = 0; y < b.size; y++) tiles.add(`${b.gx + x},${b.gy + y}`)
  }
  return tiles
}

export function placementError(gx: number, gy: number, size: number, facing: Facing, placed: Placed[], roads: Set<string>, ignoreId?: string): string | undefined {
  const tiles = occupied(placed, ignoreId)
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++)
    if (tiles.has(`${gx + x},${gy + y}`)) return 'Overlaps another building'
  if (roads.size > 0) {
    const verts = roadVertices(roads)
    if (!frontVertices(gx, gy, size, facing).some((v) => verts.has(v))) return 'The front must touch an existing road'
  }
  return undefined
}

export const placementAt = (map: V2, size: number): { gx: number; gy: number } =>
  ({ gx: Math.round(map[0] - size / 2), gy: Math.round(map[1] - size / 2) })

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
  const rects = placed.map((b): [number, number, number, number] => [b.gx, b.gy, b.gx + b.size, b.gy + b.size])
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

export function roadError(key: string, placed: Placed[], roads: Set<string>): string | undefined {
  if (roads.has(key)) return 'Already a road'
  const [a0, b0] = parseEdge(key)
  const edge: [number, number, number, number] = [a0[0], a0[1], b0[0], b0[1]]
  if (!buildingReach(placed).some((b) => gapBetween(edge, b.rect) <= b.reach)) return 'A road must be near a building'
  if (roads.size > 0) {
    const verts = roadVertices(roads)
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
  const out: string[] = []
  for (const key of run) {
    if (roadError(key, placed, work)) break
    work.add(key)
    out.push(key)
  }
  return out
}

export const roadsToDelete = (run: string[], roads: Set<string>): string[] => run.filter((k) => roads.has(k))

/** Run edges plus any roads left with no connection to a building: every
 * connected piece of road must contain an edge touching a building. */
export function roadsToDeleteWithOrphans(run: string[], placed: Placed[], roads: Set<string>): string[] {
  const fronts = new Set(placed.flatMap((b) => frontEdges(b.gx, b.gy, b.size, b.facing)))
  const gone = new Set(roadsToDelete(run, roads).filter((k) => !fronts.has(k)))
  if (!gone.size) return []
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

/* ---------------- drawing ---------------- */

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`
}

/** Stable pseudo-random building color derived from the project id. */
function randomColor(id: string) {
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
function prism(ctx: Ctx, A: V2, B: V2, C: V2, D: V2, height: number, color: string, opts: { windows?: string; z0?: number; alpha?: number } = {}) {
  const z0 = opts.z0 ?? 0
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
  ctx.save()
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha
  face(previous, current, shade(color, 0.75))
  face(current, next, shade(color, 0.55))
  if (opts.windows && height > 12) {
    ctx.fillStyle = opts.windows
    const rows = Math.floor(height / 12)
    const drawWindows = (from: typeof current, to: typeof current, mapLen: number, tint: string) => {
      const dx = to.x - from.x, dy = to.y - from.y
      const length = Math.hypot(dx, dy)
      const wx = dx / length * 5, wy = dy / length * 5
      const cols = Math.max(1, Math.round(mapLen * 2))
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < cols; k++) {
          const t = (k + 0.3) / cols
          const x = from.x + dx * t, y = from.y + dy * t - z0 - 5 - r * 12
          poly(ctx, [[x, y], [x + wx, y + wy], [x + wx, y + wy - 6.5], [x, y - 6.5]], tint)
        }
      }
    }
    drawWindows(previous, current, dist(mapCorners[pi], mapCorners[nearest]), opts.windows)
    drawWindows(current, next, dist(mapCorners[nearest], mapCorners[ni]), shade(opts.windows, 0.8))
  }
  // Draw the roof after facade details so it masks the wall at its top edge.
  poly(ctx, corners.map((q) => [q.x, q.y - top] as [number, number]), shade(color, 1.1))
  ctx.restore()
}

/** Position in a building's local frame: origin + (a, b). */
type Frame = (a: number, b: number) => V2
const frameOf = (b: { gx: number; gy: number }): Frame => (x, y) => [b.gx + x, b.gy + y]

/** Box in a local frame: a in [x, x+w], b in [y, y+h]. */
function boxAt(ctx: Ctx, at: Frame, x: number, y: number, w: number, h: number, height: number, color: string, opts: { windows?: string; z0?: number; alpha?: number } = {}) {
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
function drawDoor(ctx: Ctx, gx: number, gy: number, size: number, facing: Facing, m: number, z0 = 0, alpha = 1) {
  const n = NORMALS[facing]
  if (toIso(n[0], n[1]).y <= 0.01) return
  const c: V2 = facing === 0 ? [gx + size / 2, gy + m]
    : facing === 1 ? [gx + size - m, gy + size / 2]
      : facing === 2 ? [gx + size / 2, gy + size - m]
        : [gx + m, gy + size / 2]
  const t: V2 = n[0] === 0 ? [1, 0] : [0, 1]
  const quad = (hw: number, hgt: number, fill: string) => {
    const p1 = toIso(...sub(c, mul(t, hw))), p2 = toIso(...add(c, mul(t, hw)))
    poly(ctx, [[p1.x, p1.y - z0], [p2.x, p2.y - z0], [p2.x, p2.y - z0 - hgt], [p1.x, p1.y - z0 - hgt]], fill)
  }
  ctx.save()
  ctx.globalAlpha = alpha
  quad(0.17, 8, '#e8d5b0')
  quad(0.13, 7, '#4a2f1b')
  ctx.restore()
}

export type Style = 'glass' | 'mixed' | 'brick'
export const styleOf = (p: Project): Style => {
  const r = timeSavingsRatio(p)
  return r > 0.7 ? 'glass' : r < 0.3 ? 'brick' : 'mixed'
}
export const finalHeight = (p: Project) => {
  const hours = Math.max(0, timeSaved(p))
  const floors = MAX_FLOORS * (1 - Math.exp(-Math.pow(hours / FLOOR_CURVE_HOURS, FLOOR_CURVE_POWER)))
  return Math.max(10, floors * FLOOR_HEIGHT)
}

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
function drawFinished(ctx: Ctx, b: Placed, h: number, time: number) {
  const { p, size } = b
  const at = frameOf(b)
  const style = styleOf(p)
  const rich = p.budget_spent > 5000, mid = p.budget_spent > 1500
  const color = randomColor(p.id)
  const win = rich ? '#ffe36b' : style === 'glass' ? '#d8f4ff' : '#f3e2b0'
  const m = BUILDING_MARGIN
  const inner = size - 2 * m
  boxAt(ctx, at, m, m, inner, inner, h, color, { windows: win })
  drawDoor(ctx, b.gx, b.gy, size, b.facing, m)
  const wall: [V2, V2][] = [[at(m, m), at(size - m, m)], [at(size - m, m), at(size - m, size - m)], [at(m, size - m), at(size - m, size - m)], [at(m, m), at(m, size - m)]]
  if (size > 1) drawSign(ctx, wall[b.facing][0], wall[b.facing][1], NORMALS[b.facing], h + (style === 'brick' ? 4 : 0), p.name, '#e6b422')
  // Put bands on the facade before the roof so they cannot paint over its lower half.
  if (mid || rich) boxAt(ctx, at, m - 0.03, m - 0.03, inner + 0.06, inner + 0.06, 3, '#e6b422', { z0: Math.max(0, h - 3) })
  if (style === 'glass') {
    // crystal tapered crown
    boxAt(ctx, at, m + inner * 0.3, m + inner * 0.3, inner * 0.4, inner * 0.4, 14, '#9fe3ff', { z0: h })
  } else if (style === 'brick') {
    boxAt(ctx, at, m - 0.02, m - 0.02, inner + 0.04, inner + 0.04, 4, '#7a3524', { z0: h }) // cornice
  } else {
    boxAt(ctx, at, m + inner * 0.25, m + inner * 0.25, inner * 0.5, inner * 0.5, 8, '#8d867a', { z0: h })
  }
  const c = toIso(...at(size / 2, size / 2))
  const top = h + (style === 'brick' ? 4 : style === 'glass' ? 14 : 8)
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
    ctx.beginPath(); ctx.ellipse(c.x, c.y, size * 24, size * 12, 0, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
}

function drawSite(ctx: Ctx, b: Placed, prog: number, h: number, time: number) {
  const { size } = b
  const at = frameOf(b)
  const iso = (a: number, c: number) => toIso(...at(a, c))
  // slab
  const edge = BUILDING_MARGIN
  boxAt(ctx, at, edge, edge, size - 2 * edge, size - 2 * edge, 2, '#9a9a9a')
  // dirt piles & barriers
  const d = iso(edge - 0.1, size - edge + 0.05)
  ctx.fillStyle = '#8b6b3e'; ctx.beginPath(); ctx.ellipse(d.x, d.y - 2, 9, 4.5, 0, Math.PI, 0); ctx.fill()
  const fence = size - 2 * edge
  for (let k = 0; k < size * 2; k++) {
    const t = (k + 0.5) / (size * 2)
    boxAt(ctx, at, edge + t * fence - 0.08, size - edge, 0.16, 0.1, 5, k % 2 ? '#f4c20d' : '#d94b2b')
  }
  // growing core (steel frame lower, concrete floors)
  const cur = Math.max(2, h * prog)
  const m = edge + fence * 0.15
  const floors = Math.floor(cur / 10)
  for (let f = 0; f < floors; f++) {
    boxAt(ctx, at, m, m, size - 2 * m, size - 2 * m, 8, '#b9b5ac', { z0: 2 + f * 10, alpha: f > floors - 3 ? 0.9 : 1 })
  }
  drawDoor(ctx, b.gx, b.gy, size, b.facing, m, 2)
  // steel beams
  const top = 2 + cur
  const corners: [number, number][] = [[m, m], [size - m, m], [size - m, size - m], [m, size - m]]
  corners.forEach(([x, y]) => { const q = iso(x, y); line(ctx, [[q.x, q.y - 2], [q.x, q.y - top - 6]], '#c0562a', 2) })
  // scaffolding on two adjacent faces
  const sh = Math.min(top, 2 + cur) + 4
  for (const [x1, y1, x2, y2] of [[edge, size - edge, size - edge, size - edge], [size - edge, size - edge, size - edge, edge]]) {
    const a = iso(x1, y1), c = iso(x2, y2)
    line(ctx, [[a.x, a.y - 2], [a.x, a.y - sh]], '#e8c547')
    line(ctx, [[c.x, c.y - 2], [c.x, c.y - sh]], '#e8c547')
    for (let z = 8; z < sh; z += 10) line(ctx, [[a.x, a.y - z], [c.x, c.y - z]], '#e8c547')
    line(ctx, [[a.x, a.y - 2], [c.x, c.y - sh]], '#c9a227', 0.8)
  }
  // crane
  const base = iso(-0.35, -0.35)
  const mast = Math.max(h, 30) + 40
  const bx = base.x, by = base.y - 2
  boxAt(ctx, at, -0.6, -0.6, 0.5, 0.5, 4, '#777')
  line(ctx, [[bx - 3, by], [bx - 3, by - mast]], '#f2a900', 2)
  line(ctx, [[bx + 3, by], [bx + 3, by - mast]], '#f2a900', 2)
  for (let z = 0; z < mast; z += 10) line(ctx, [[bx - 3, by - z], [bx + 3, by - z - 10]], '#f2a900', 1)
  // jib overhangs the building toward the centre
  const tip = { x: bx + (iso(size / 2, size / 2).x - bx) * 1.5 + 14, y: by - mast + 0 }
  const cab = { x: bx, y: by - mast }
  line(ctx, [[bx - 14, cab.y + 1], [tip.x, cab.y + 1]], '#f2a900', 3)
  line(ctx, [[bx, cab.y - 14], [tip.x, cab.y + 1]], '#c98a00', 1)
  line(ctx, [[bx, cab.y - 14], [bx - 14, cab.y + 1]], '#c98a00', 1)
  boxAt(ctx, at, -0.65, -0.65, 0.2, 0.2, 0, '#444')
  ctx.fillStyle = '#555'; ctx.fillRect(bx - 18, cab.y - 2, 8, 6) // counterweight
  ctx.fillStyle = '#fff'; ctx.fillRect(bx - 4, cab.y - 6, 8, 6) // cab
  // hook cycling: lowers to building top, raises with material
  const cx = bx + (tip.x - bx) * 0.7
  let seed = 2166136261
  const sid = String(b.p.id)
  for (let i = 0; i < sid.length; i++) seed = Math.imul(seed ^ sid.charCodeAt(i), 16777619)
  seed >>>= 0
  const offset = (seed % 6283) / 1000 // 0..2π radians
  const period = 600 + ((seed >>> 13) % 300) // 600..900 ms
  const phase = (Math.sin(time / period + offset) + 1) / 2
  const topY = base.y - top - 8
  const hookY = cab.y + 10 + (topY - cab.y - 10) * phase
  line(ctx, [[cx, cab.y + 1], [cx, hookY]], '#222', 1)
  ctx.fillStyle = '#222'; ctx.fillRect(cx - 2, hookY, 4, 4)
  if (phase > 0.15) { ctx.fillStyle = '#c0562a'; ctx.fillRect(cx - 6, hookY + 4, 12, 4) }
  // progress bar
  const lb = iso(size / 2, size / 2)
  ctx.fillStyle = '#0006'; ctx.fillRect(lb.x - 20, lb.y + size * 16 + 6, 40, 5)
  ctx.fillStyle = '#4ade80'; ctx.fillRect(lb.x - 20, lb.y + size * 16 + 6, 40 * prog, 5)
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
}

export interface Camera { x: number; y: number; zoom: number; angle: number }

export type Preview =
  | { kind: 'building'; gx: number; gy: number; size: number; height: number; facing: Facing; ok: boolean }
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

function viewDepth(b: Placed, angle: number) {
  // The projected vertical axis determines which footprint is farther away.
  return toIso(b.gx + b.size / 2, b.gy + b.size / 2, angle).y + b.size
}

export const carCountFor = (n: number) => (n < 1 ? 0 : Math.min(30, n * 2))

const roadEdges = (roads: Set<string>): [V2, V2][] => [...roads].map(parseEdge)

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
function grassBlades(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, accept?: (x: number, y: number) => boolean, light = false) {
  const step = 0.3
  // When zoomed out, skip whole rows/columns of the fixed grid (in power-of-two
  // strides) rather than resizing it, so blades never shift against the map.
  const cells = ((x1 - x0) / step) * ((y1 - y0) / step)
  let stride = 1
  while (cells / (stride * stride) > 12000) stride *= 2
  const shades = light ? ['#8fb87a', '#b9d9a3', '#7aa866'] : ['#5f9a4c', '#8cc274', '#4e8a3d']
  const paths = shades.map(() => new Path2D())
  for (let gx = Math.floor(x0 / step / stride) * stride; gx <= Math.ceil(x1 / step); gx += stride) {
    for (let gy = Math.floor(y0 / step / stride) * stride; gy <= Math.ceil(y1 / step); gy += stride) {
      if (hash2(gx, gy, 1) > 0.6) continue
      const x = (gx + hash2(gx, gy, 2)) * step, y = (gy + hash2(gx, gy, 3)) * step
      if (accept && !accept(x, y)) continue
      const q = toIso(x, y)
      const hgt = 2.5 + hash2(gx, gy, 4) * 3
      const lean = (hash2(gx, gy, 5) - 0.5) * 3
      const p = paths[Math.floor(hash2(gx, gy, 6) * shades.length)]
      for (const o of [-1.2, 0, 1.2]) {
        p.moveTo(q.x + o, q.y)
        p.lineTo(q.x + o * 1.8 + lean, q.y - hgt + Math.abs(o))
      }
    }
  }
  ctx.save()
  ctx.lineWidth = 0.8
  ctx.lineCap = 'round'
  shades.forEach((c, i) => { ctx.strokeStyle = c; ctx.stroke(paths[i]) })
  ctx.restore()
}

export function render(ctx: Ctx, w: number, h: number, s: RenderState) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#bfe3f5'); g.addColorStop(1, '#e8f4ea')
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h)
  ctx.translate(w / 2 + s.cam.x, h / 2 + s.cam.y)
  ctx.scale(s.cam.zoom, s.cam.zoom)
  projectionAngle = s.cam.angle

  // Ground covers the whole viewport, so the city can grow in any direction;
  // the "map" is effectively infinite. Project the screen corners back to map
  // space and fill their (rotated) bounding box, plus a margin for the tilt.
  const view = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => screenToMap(x, y, w, h, s.cam))
  const xs = view.map((p) => p[0]), ys = view.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  {
    const m = ((maxX - minX) + (maxY - minY)) / 4
    diamond(ctx, minX - m, minY - m, maxX - minX + 2 * m, maxY - minY + 2 * m, 0, '#7fb069')
    grassBlades(ctx, minX, minY, maxX, maxY)
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
    const disc = (c: V2, r: number) =>
      Array.from({ length: 20 }, (_, i) => iso([c[0] + Math.cos(i / 20 * Math.PI * 2) * r, c[1] + Math.sin(i / 20 * Math.PI * 2) * r]))
    const verts = [...roadVertices(s.roads)].map((v) => v.split(',').map(Number) as V2)
    const layer = (half: number, color: string) => {
      for (const [a, b] of edges) poly(ctx, band(a, b, half), color)
      for (const v of verts) poly(ctx, disc(v, half), color)
    }
    layer(0.24, '#d6d3cc')
    layer(hw, '#4a4e57')
    ctx.save()
    ctx.setLineDash([10, 9])
    for (const [a, b] of edges) line(ctx, [iso(a), iso(b)], 'rgba(250,220,90,0.9)', 1.2)
    ctx.restore()
  }

  // traffic on the roads only (drawn before buildings)
  // Advance each car as a small queue per edge. Cars reduce their speed when
  // another car is too close ahead on the same edge in the same direction.
  const previous = s.cars.map((car) => car.t)
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
    const sameLane = s.cars.filter((other, j) => j !== index && other.edge === car.edge && other.dir === car.dir)
    const ahead = Math.min(...sameLane.map((other) => {
      const otherIndex = s.cars.indexOf(other)
      const d = previous[otherIndex] - previous[index]
      // Only cars further along this street block us (streets aren't loops); ties go to the lower index so nobody deadlocks.
      return d > 0 || (d === 0 && otherIndex < index) ? d : 1
    }), 1)
    const gap = ahead * L
    const blocked = ahead < 1
    car.speed = blocked && gap < 1.2 ? 0 : blocked ? Math.min(car.baseSpeed, car.baseSpeed * Math.max(0.25, (gap - 0.8) / 1.5)) : car.baseSpeed
    car.t += (dt * car.speed) / L
    car.lastTime = s.time
    if (car.t >= 1) {
      // Reached a junction: pick a random street leaving it (no U-turn unless dead end).
      const end = car.dir === 1 ? e[1] : e[0]
      const near = (p: V2) => dist(p, end) < 0.01
      const same = (f: [V2, V2]) =>
        (dist(f[0], e[0]) < 0.01 && dist(f[1], e[1]) < 0.01) || (dist(f[0], e[1]) < 0.01 && dist(f[1], e[0]) < 0.01)
      const options: { edge: number; dir: 1 | -1 }[] = []
      edges.forEach((f, j) => {
        if (same(f)) return
        if (near(f[0])) options.push({ edge: j, dir: 1 })
        else if (near(f[1])) options.push({ edge: j, dir: -1 })
      })
      if (options.length) {
        const o = options[Math.floor(Math.random() * options.length)]
        car.edge = o.edge; car.dir = o.dir; car.seg = edges[o.edge]
      } else {
        car.dir = car.dir === 1 ? -1 : 1
      }
      car.t = 0
      return
    }
    const n = norm(sub(e[1], e[0]))
    const perp: V2 = [n[1], -n[0]]
    // Keep right: the offset flips with the driving direction.
    const pos = add(add(e[0], mul(n, L * (car.dir === 1 ? car.t : 1 - car.t))), mul(perp, -0.07 * car.dir))
    const q = toIso(pos[0], pos[1])
    ctx.fillStyle = car.color
    ctx.beginPath(); ctx.ellipse(q.x, q.y - 2, 3, 1.9, 0, 0, Math.PI * 2); ctx.fill()
  })

  // depth-sorted buildings
  const order = [...s.placed].sort((a, b) => viewDepth(a, s.cam.angle) - viewDepth(b, s.cam.angle) || a.gx - b.gx)
  for (const b of order) {
    const prog = progressOf(b, s.elapsed)
    if (prog <= 0) continue
    const fh = finalHeight(b.p)
    if (prog < 1) drawSite(ctx, b, prog, fh, s.time)
    else drawFinished(ctx, b, fh, s.time)
    if (s.selected === b.p.id) {
      diamond(ctx, b.gx - 0.1, b.gy - 0.1, b.size + 0.2, b.size + 0.2, 0, 'rgba(255,255,255,0.25)', '#fff')
    }
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
        for (const b of s.placed) for (const f of [0, 1, 2, 3] as Facing[]) for (const k of frontEdges(b.gx, b.gy, b.size, f)) cands.add(k)
      }
      for (const key of cands) if (!roadError(key, s.placed, s.roads)) open.add(key)
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
    const { gx, gy, size, height, facing, ok } = pv
    diamond(ctx, gx, gy, size, size, 0, ok ? 'rgba(74,222,128,0.35)' : 'rgba(248,113,113,0.35)', ok ? '#4ade80' : '#f87171')
    const at = frameOf({ gx, gy })
    const m = BUILDING_MARGIN
    boxAt(ctx, at, m, m, size - 2 * m, size - 2 * m, height, ok ? '#e5e7eb' : '#fca5a5', { alpha: 0.35 })
    drawDoor(ctx, gx, gy, size, facing, m, 0, 0.7)
    ctx.save()
    ctx.setLineDash([6, 5])
    for (const key of frontEdges(gx, gy, size, facing)) {
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
      if (gx >= b.gx && gx <= b.gx + b.size && gy >= b.gy && gy <= b.gy + b.size) return b
    }
  }
  return undefined
}

export const centerOn = (b: Placed, cur?: Camera): Camera => {
  const angle = cur?.angle ?? 0
  const zoom = cur?.zoom ?? 1.2
  const c = toIso(b.gx + b.size / 2, b.gy + b.size / 2, angle)
  return { x: -c.x * zoom, y: (-c.y + finalHeight(b.p) / 2) * zoom, zoom, angle }
}
