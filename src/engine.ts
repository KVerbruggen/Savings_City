import { type Project, timeSaved, timeSavingsRatio } from './services/storageService'

export const TILE_W = 64
export const TILE_H = 32
const PLOT_GAP = 1 // road width
const VERTICAL_SCALE = 1.2
let projectionAngle = 0

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

/** Spiral over a lattice of 3x3-tile cells separated by 1-tile roads. */
const CELL = 3
const STRIDE = CELL + PLOT_GAP
export function spiralCell(n: number): [number, number] {
  if (n === 0) return [0, 0]
  let x = 0, y = 0, dx = 1, dy = 0, seg = 1, left = 1, turns = 0
  for (let i = 0; i < n; i++) {
    x += dx; y += dy
    if (--left === 0) {
      ;[dx, dy] = [-dy, dx]
      if (++turns % 2 === 0) seg++
      left = seg
    }
  }
  return [x, y]
}

export interface Placed {
  p: Project
  size: number
  gx: number // top-left tile of the plot
  gy: number
  start: number // ms offset when construction begins
  duration: number // ms
}

export function layout(projects: Project[], constructionStarts = new Map<string, number>()): Placed[] {
  return projects.map((p, i) => {
    const [cx, cy] = spiralCell(i)
    const size = footprint(p)
    const off = Math.floor((CELL - size) / 2)
    return {
      p, size,
      gx: cx * STRIDE + off,
      gy: cy * STRIDE + off,
      // Projects loaded together start together. A newly submitted project can
      // provide its own elapsed start time without shifting older buildings.
      start: constructionStarts.get(p.id) ?? 0,
      duration: 3000 + Math.min(p.time_estimated_no_ai, 300) * 15,
    }
  })
}

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`
}

type Ctx = CanvasRenderingContext2D
function poly(ctx: Ctx, pts: [number, number][], fill: string, stroke?: string) {
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke() }
}

function diamond(ctx: Ctx, gx: number, gy: number, w: number, h: number, z: number, fill: string, stroke?: string) {
  const a = toIso(gx, gy), b = toIso(gx + w, gy), c = toIso(gx + w, gy + h), d = toIso(gx, gy + h)
  poly(ctx, [[a.x, a.y - z], [b.x, b.y - z], [c.x, c.y - z], [d.x, d.y - z]], fill, stroke)
}

/** Draw an extruded box; returns nothing. */
function box(ctx: Ctx, gx: number, gy: number, w: number, h: number, height: number, color: string, opts: { windows?: string; z0?: number; alpha?: number } = {}) {
  const z0 = opts.z0 ?? 0
  const top = z0 + height
  const A = toIso(gx, gy), B = toIso(gx + w, gy), C = toIso(gx + w, gy + h), D = toIso(gx, gy + h)
  const corners = [A, B, C, D]
  // The two walls that meet at the nearest projected corner are visible. This
  // changes with each compass direction; keeping C fixed only worked in the
  // initial north-facing view.
  const nearest = corners.reduce((best, corner, index) => corner.y > corners[best].y ? index : best, 0)
  const previous = corners[(nearest + 3) % 4]
  const current = corners[nearest]
  const next = corners[(nearest + 1) % 4]
  const face = (from: typeof A, to: typeof A, fill: string) =>
    poly(ctx, [[from.x, from.y - z0], [to.x, to.y - z0], [to.x, to.y - top], [from.x, from.y - top]], fill)
  ctx.save()
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha
  face(previous, current, shade(color, 0.75))
  face(current, next, shade(color, 0.55))
  if (opts.windows && height > 12) {
    ctx.fillStyle = opts.windows
    const rows = Math.floor(height / 12)
    const cols = Math.max(1, Math.round(w * 2))
    const drawWindows = (from: typeof A, to: typeof A, tint: string) => {
      const dx = to.x - from.x, dy = to.y - from.y
      const length = Math.hypot(dx, dy)
      const wx = dx / length * 5, wy = dy / length * 5
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < cols; k++) {
          const t = (k + 0.3) / cols
          const x = from.x + dx * t, y = from.y + dy * t - z0 - 5 - r * 12
          poly(ctx, [[x, y], [x + wx, y + wy], [x + wx, y + wy - 6.5], [x, y - 6.5]], tint)
        }
      }
    }
    drawWindows(previous, current, opts.windows)
    drawWindows(current, next, shade(opts.windows, 0.8))
  }
  // Draw the roof after facade details so it masks the wall at its top edge.
  poly(ctx, [[A.x, A.y - top], [B.x, B.y - top], [C.x, C.y - top], [D.x, D.y - top]], shade(color, 1.1))
  ctx.restore()
}

function line(ctx: Ctx, pts: [number, number][], color: string, w = 1) {
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke()
}

export type Style = 'glass' | 'mixed' | 'brick'
export const styleOf = (p: Project): Style => {
  const r = timeSavingsRatio(p)
  return r > 0.7 ? 'glass' : r < 0.3 ? 'brick' : 'mixed'
}
export const finalHeight = (p: Project) => Math.max(10, timeSaved(p) * VERTICAL_SCALE)

function drawFinished(ctx: Ctx, b: Placed, h: number, time: number) {
  const { p, size, gx, gy } = b
  const style = styleOf(p)
  const rich = p.budget_spent > 5000, mid = p.budget_spent > 1500
  const color = style === 'glass' ? '#5fc3e8' : style === 'brick' ? '#b5523b' : '#b8b0a0'
  const win = rich ? '#ffe36b' : style === 'glass' ? '#d8f4ff' : '#f3e2b0'
  const m = 0.12
  box(ctx, gx + m, gy + m, size - 2 * m, size - 2 * m, h, color, { windows: win })
  // Put bands on the facade before the roof so they cannot paint over its lower half.
  if (mid || rich) box(ctx, gx + 0.04, gy + 0.04, size - 0.08, size - 0.08, 3, '#e6b422', { z0: Math.max(0, h - 3) })
  if (style === 'glass') {
    // crystal tapered crown
    box(ctx, gx + size * 0.3, gy + size * 0.3, size * 0.4, size * 0.4, 14, '#9fe3ff', { z0: h })
  } else if (style === 'brick') {
    box(ctx, gx + 0.05, gy + 0.05, size - 0.1, size - 0.1, 4, '#7a3524', { z0: h }) // cornice
  } else {
    box(ctx, gx + size * 0.25, gy + size * 0.25, size * 0.5, size * 0.5, 8, '#8d867a', { z0: h })
  }
  const c = toIso(gx + size / 2, gy + size / 2)
  if (rich) {
    // helipad
    const top = h + (style === 'brick' ? 4 : style === 'glass' ? 14 : 8)
    const pc = toIso(gx + size / 2, gy + size / 2)
    ctx.beginPath()
    ctx.ellipse(pc.x, pc.y - top, 12, 6, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#333'; ctx.fill()
    ctx.fillStyle = '#fff'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'
    ctx.fillText('H', pc.x, pc.y - top + 3)
    // neon glow
    const pulse = 0.5 + 0.5 * Math.sin(time / 400)
    ctx.save(); ctx.globalAlpha = 0.25 + 0.2 * pulse
    ctx.fillStyle = '#ff3df2'
    ctx.beginPath(); ctx.ellipse(c.x, c.y, size * 24, size * 12, 0, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
}

function drawSite(ctx: Ctx, b: Placed, prog: number, h: number, time: number) {
  const { size, gx, gy } = b
  // slab
  box(ctx, gx, gy, size, size, 2, '#9a9a9a')
  // dirt piles & barriers
  const d = toIso(gx - 0.3, gy + size + 0.1)
  ctx.fillStyle = '#8b6b3e'; ctx.beginPath(); ctx.ellipse(d.x, d.y - 2, 9, 4.5, 0, Math.PI, 0); ctx.fill()
  for (let k = 0; k < size * 2; k++) {
    const t = (k + 0.5) / (size * 2)
    const p = toIso(gx + size * t, gy + size + 0.15)
    box(ctx, gx + size * t - 0.08, gy + size + 0.1, 0.16, 0.1, 5, k % 2 ? '#f4c20d' : '#d94b2b')
    void p
  }
  // growing core (steel frame lower, concrete floors)
  const cur = Math.max(2, h * prog)
  const m = size * 0.15
  const floors = Math.floor(cur / 10)
  for (let f = 0; f < floors; f++) {
    box(ctx, gx + m, gy + m, size - 2 * m, size - 2 * m, 8, '#b9b5ac', { z0: 2 + f * 10, alpha: f > floors - 3 ? 0.9 : 1 })
  }
  // steel beams
  const top = 2 + cur
  const corners: [number, number][] = [[gx + m, gy + m], [gx + size - m, gy + m], [gx + size - m, gy + size - m], [gx + m, gy + size - m]]
  corners.forEach(([x, y]) => { const q = toIso(x, y); line(ctx, [[q.x, q.y - 2], [q.x, q.y - top - 6]], '#c0562a', 2) })
  // scaffolding on front faces
  const sh = Math.min(top, 2 + cur) + 4
  for (const [x1, y1, x2, y2] of [[gx, gy + size, gx + size, gy + size], [gx + size, gy + size, gx + size, gy]]) {
    const a = toIso(x1, y1), c = toIso(x2, y2)
    line(ctx, [[a.x, a.y - 2], [a.x, a.y - sh]], '#e8c547')
    line(ctx, [[c.x, c.y - 2], [c.x, c.y - sh]], '#e8c547')
    for (let z = 8; z < sh; z += 10) line(ctx, [[a.x, a.y - z], [c.x, c.y - z]], '#e8c547')
    line(ctx, [[a.x, a.y - 2], [c.x, c.y - sh]], '#c9a227', 0.8)
  }
  // crane
  const base = toIso(gx - 0.35, gy - 0.35)
  const mast = Math.max(h, 30) + 40
  const bx = base.x, by = base.y - 2
  box(ctx, gx - 0.6, gy - 0.6, 0.5, 0.5, 4, '#777')
  line(ctx, [[bx - 3, by], [bx - 3, by - mast]], '#f2a900', 2)
  line(ctx, [[bx + 3, by], [bx + 3, by - mast]], '#f2a900', 2)
  for (let z = 0; z < mast; z += 10) line(ctx, [[bx - 3, by - z], [bx + 3, by - z - 10]], '#f2a900', 1)
  // jib overhangs the building toward +x/+y
  const tip = { x: bx + (toIso(gx + size / 2, gy + size / 2).x - bx) * 1.5 + 14, y: by - mast + 0 }
  const cab = { x: bx, y: by - mast }
  line(ctx, [[bx - 14, cab.y + 1], [tip.x, cab.y + 1]], '#f2a900', 3)
  line(ctx, [[bx, cab.y - 14], [tip.x, cab.y + 1]], '#c98a00', 1)
  line(ctx, [[bx, cab.y - 14], [bx - 14, cab.y + 1]], '#c98a00', 1)
  box(ctx, gx - 0.65, gy - 0.65, 0.2, 0.2, 0, '#444')
  ctx.fillStyle = '#555'; ctx.fillRect(bx - 18, cab.y - 2, 8, 6) // counterweight
  ctx.fillStyle = '#fff'; ctx.fillRect(bx - 4, cab.y - 6, 8, 6) // cab
  // hook cycling: lowers to building top, raises with material
  const cx = bx + (tip.x - bx) * 0.7
  const phase = (Math.sin(time / 700) + 1) / 2
  const topY = base.y - top - 8
  const hookY = cab.y + 10 + (topY - cab.y - 10) * phase
  line(ctx, [[cx, cab.y + 1], [cx, hookY]], '#222', 1)
  ctx.fillStyle = '#222'; ctx.fillRect(cx - 2, hookY, 4, 4)
  if (phase > 0.15) { ctx.fillStyle = '#c0562a'; ctx.fillRect(cx - 6, hookY + 4, 12, 4) }
  // progress bar
  const lb = toIso(gx + size / 2, gy + size / 2)
  ctx.fillStyle = '#0006'; ctx.fillRect(lb.x - 20, lb.y + size * 16 + 6, 40, 5)
  ctx.fillStyle = '#4ade80'; ctx.fillRect(lb.x - 20, lb.y + size * 16 + 6, 40 * prog, 5)
}

export interface Traffic {
  position: number
  speed: number
  baseSpeed: number
  road: number
  horizontal: boolean
  color: string
  dir: 1 | -1
  lastTime: number
}

export interface Camera { x: number; y: number; zoom: number; angle: number }

export interface RenderState {
  placed: Placed[]
  elapsed: number // retained for the rendering/picking API
  time: number
  cam: Camera
  selected?: string
  cars: Traffic[]
}

export const progressOf = (b: Placed, elapsed: number) =>
  b.duration <= 0 ? 1 : Math.max(0, Math.min(1, (elapsed - b.start) / b.duration))

function viewDepth(b: Placed, angle: number) {
  const c = toIso(b.gx + b.size / 2, b.gy + b.size / 2, angle)
  // The projected vertical axis determines which footprint is farther away.
  return c.y + b.size
}

export const carCountFor = (n: number) => (n < 1 ? 0 : Math.min(60, n * 4))

export function makeCars(placed: Placed[]): Traffic[] {
  const count = carCountFor(placed.length)
  const colors = ['#ef4444', '#3b82f6', '#facc15', '#ffffff', '#22c55e']
  const roads = [...new Set(placed.flatMap((b) => {
    const cx = Math.round(b.gx / STRIDE), cy = Math.round(b.gy / STRIDE)
    return [{ road: cx, horizontal: true }, { road: cy, horizontal: false }]
  }).map((r) => `${r.horizontal ? 'h' : 'v'}${r.road}`))]
  return Array.from({ length: count }, (_, i) => ({
    position: (i % Math.max(1, Math.ceil(count / Math.max(1, roads.length)))) * 0.16,
    speed: 0.04 + (i % 4) * 0.012, baseSpeed: 0.04 + (i % 4) * 0.012,
    road: roads.length ? Number(roads[i % roads.length].slice(1)) : 0,
    horizontal: roads.length ? roads[i % roads.length][0] === 'h' : true,
    color: colors[i % 5], dir: i % 2 ? -1 : 1, lastTime: 0,
  }))
}

export function render(ctx: Ctx, w: number, h: number, s: RenderState) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#bfe3f5'); g.addColorStop(1, '#e8f4ea')
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h)
  ctx.translate(w / 2 + s.cam.x, h / 2 + s.cam.y)
  ctx.scale(s.cam.zoom, s.cam.zoom)
  projectionAngle = s.cam.angle

  // Ground: rings of cells, roads between
  const extent = s.placed.reduce((m, b) => Math.max(m, Math.abs(Math.round(b.gx / STRIDE)), Math.abs(Math.round(b.gy / STRIDE))), 0)
  const ring = Math.max(1, extent + 1)
  const lo = -ring * STRIDE - 1, hi = ring * STRIDE + CELL + 1
  diamond(ctx, lo, lo, hi - lo, hi - lo, 0, '#7fb069')
  for (let cy = -ring; cy <= ring; cy++) for (let cx = -ring; cx <= ring; cx++) {
    diamond(ctx, cx * STRIDE, cy * STRIDE, CELL, CELL, 0, '#a5c98f', '#8fb27a')
  }
  // road surfaces (gaps)
  for (let k = -ring; k <= ring + 1; k++) {
    const r = k * STRIDE - PLOT_GAP
    diamond(ctx, lo, r, hi - lo, PLOT_GAP, 0, '#555a62')
    diamond(ctx, r, lo, PLOT_GAP, hi - lo, 0, '#555a62')
  }
  // traffic (drawn on roads before buildings)
  const span = hi - lo
  // Advance each lane as a small circular queue. Cars use the roads adjacent to
  // occupied blocks and reduce their speed when another car is too close ahead.
  const previous = s.cars.map((car) => car.position)
  s.cars.forEach((car, index) => {
    const dt = car.lastTime ? Math.min(80, s.time - car.lastTime) / 1000 : 0
    const sameLane = s.cars.filter((other, j) => j !== index && other.road === car.road && other.horizontal === car.horizontal && other.dir === car.dir)
    const ahead = Math.min(...sameLane.map((other) => {
      const otherIndex = s.cars.indexOf(other)
      return ((previous[otherIndex] - previous[index]) * car.dir + 1) % 1
    }), 1)
    const gap = ahead
    car.speed = gap < 0.1 ? 0 : Math.min(car.baseSpeed, car.baseSpeed * Math.max(0.25, (gap - 0.06) / 0.12))
    car.position = (car.position + dt * car.speed * car.dir + 1) % 1
    car.lastTime = s.time
    const horizontal = car.horizontal
    const k = car.road
    const lane = k * STRIDE - PLOT_GAP + (car.dir === 1 ? 0.3 : 0.65)
    const pos = lo + car.position * span
    const [gx, gy] = horizontal ? [pos, lane] : [lane, pos]
    const q = toIso(gx, gy)
    ctx.fillStyle = car.color
    ctx.beginPath(); ctx.ellipse(q.x, q.y - 2, 4, 2.5, 0, 0, Math.PI * 2); ctx.fill()
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
}

/** Find the building whose footprint contains the screen point. */
export function pick(placed: Placed[], elapsed: number, sx: number, sy: number, w: number, h: number, cam: Camera): Placed | undefined {
  const screenX = (sx - w / 2 - cam.x) / cam.zoom
  const screenY = (sy - h / 2 - cam.y) / cam.zoom
  const cos = Math.cos(cam.angle), sin = Math.sin(cam.angle)
  const order = [...placed].sort((a, b) => viewDepth(b, cam.angle) - viewDepth(a, cam.angle))
  for (const b of order) {
    if (progressOf(b, elapsed) < 1) continue
    const fh = finalHeight(b.p)
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

export const centerOn = (b: Placed): Camera => {
  // centerOn returns to the default north-facing view, so use unrotated map
  // coordinates rather than the projection from the last rendered frame.
  const c = {
    x: ((b.gx + b.size / 2) - (b.gy + b.size / 2)) * (TILE_W / 2),
    y: ((b.gx + b.size / 2) + (b.gy + b.size / 2)) * (TILE_H / 2),
  }
  const zoom = 1.2
  return { x: -c.x * zoom, y: (-c.y + finalHeight(b.p) / 2) * zoom, zoom, angle: 0 }
}
