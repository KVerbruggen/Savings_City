import { type Project, timeSaved, timeSavingsRatio } from './services/storageService'

export const TILE_W = 64
export const TILE_H = 32
// Floors follow MAX_FLOORS * (1 - e^(-(hours / FLOOR_CURVE_HOURS)^FLOOR_CURVE_POWER)).
// 50h saved ≈ 5 floors, 100h ≈ 13, 500h ≈ 106, 1000h ≈ 177; never exceeds MAX_FLOORS.
const MAX_FLOORS = 200
const FLOOR_CURVE_HOURS = 600
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
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1]
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0]
const len = (a: V2) => Math.hypot(a[0], a[1])
const dist = (a: V2, b: V2) => len(sub(a, b))
const norm = (a: V2): V2 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l]
}

/* ---------------- polygon geometry (free placement, no grid) ---------------- */

export function polyArea(pts: V2[]) {
  let s = 0
  for (let i = 0; i < pts.length; i++) s += cross(pts[i], pts[(i + 1) % pts.length])
  return Math.abs(s) / 2
}

/** Winding-number point-in-polygon: robust for any query point that is not
 * exactly on the boundary, independent of vertex/edge alignment. */
export function pointInPoly(pt: V2, pts: V2[]) {
  let wn = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    const cr = (xj - xi) * (pt[1] - yi) - (yj - yi) * (pt[0] - xi)
    if (yi <= pt[1]) {
      if (yj > pt[1] && cr > 0) wn++
    } else if (yj <= pt[1] && cr < 0) wn--
  }
  return wn !== 0
}

/** Is pt on segment a-b, within tolerance? */
export function pointOnSeg(pt: V2, a: V2, b: V2, tol: number) {
  const e = sub(b, a)
  const L2 = dot(e, e)
  if (L2 < 1e-12) return dist(pt, a) <= tol
  const t = dot(sub(pt, a), e) / L2
  if (t < -0.02 || t > 1.02) return false
  return dist(pt, add(a, mul(e, Math.max(0, Math.min(1, t))))) <= tol
}

/** Strict crossing only, with tolerance: shared streets and slight
 * edge/vertex touches do not count, so neighbouring plots may share a street. */
function segsCross(a: V2, b: V2, c: V2, d: V2) {
  const r = sub(b, a), s = sub(d, c)
  const d1 = cross(r, sub(c, a)), d2 = cross(r, sub(d, a))
  const d3 = cross(s, sub(a, c)), d4 = cross(s, sub(b, c))
  const lenR = Math.max(0.001, len(r)), lenS = Math.max(0.001, len(s))
  const eps = 1e-7
  return (d1 / lenR) * (d2 / lenR) < -eps && (d3 / lenS) * (d4 / lenS) < -eps
}

export function isSimple(pts: V2[]) {
  const n = pts.length
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue
    if (segsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false
  }
  return true
}

/** pt inside the polygon, or on its boundary within tol (tolerance along and
 * across edges). Pure ray-cast for the interior, segment test for the rim. */
export function pointInPolyTol(pt: V2, pts: V2[], tol: number) {
  if (pointInPoly(pt, pts)) return true
  for (let i = 0; i < pts.length; i++) if (pointOnSeg(pt, pts[i], pts[(i + 1) % pts.length], tol)) return true
  return false
}

/** True when pt lies strictly inside the polygon — NOT merely on its
 * boundary. Boundary points (shared streets/corners) return false, which is
 * what lets neighbouring plots share a street without counting as overlap.
 * Uses a winding test, but nudges the query point in four directions and only
 * accepts the result when all agree, so a vertex that touches two edges (where
 * a single winding test is unreliable) is treated as boundary. */
function strictlyInside(pt: V2, pts: V2[]) {
  const eps = 1e-4
  return pointInPoly(pt, pts)
    && pointInPoly([pt[0] + eps, pt[1] + eps], pts)
    && pointInPoly([pt[0] - eps, pt[1] - eps], pts)
    && pointInPoly([pt[0] + eps, pt[1] - eps], pts)
    && pointInPoly([pt[0] - eps, pt[1] + eps], pts)
}

export function polysOverlap(a: V2[], b: V2[]) {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++)
    if (segsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true
  // Containment tests use strict interior: a vertex resting on a shared street
  // or corner is boundary, not overlap. Test every vertex, edge midpoint and
  // the centroid, since the first vertex alone may sit on the shared boundary
  // while the rest of the plot lies inside the other.
  const probes = (p: V2[]): V2[] => {
    const c: V2 = [0, 0]
    const pts = [...p]
    p.forEach((v, i) => {
      const w = p[(i + 1) % p.length]
      pts.push([(v[0] + w[0]) / 2, (v[1] + w[1]) / 2])
      c[0] += v[0] / p.length; c[1] += v[1] / p.length
    })
    pts.push(c)
    return pts
  }
  return probes(a).some((p) => strictlyInside(p, b)) || probes(b).some((p) => strictlyInside(p, a))
}

/** Smallest interior angle in degrees; reflex corners are counted via the polygon winding. */
function minAngle(pts: V2[]) {
  let shoelace = 0
  for (let i = 0; i < pts.length; i++) shoelace += cross(pts[i], pts[(i + 1) % pts.length])
  const ccw = shoelace > 0
  let min = 360
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const e1 = norm(sub(p, pts[(i + pts.length - 1) % pts.length]))
    const e2 = norm(sub(pts[(i + 1) % pts.length], p))
    const cos = Math.max(-1, Math.min(1, dot(e1, e2)))
    let a = 180 - (Math.acos(cos) * 180) / Math.PI
    const reflex = ccw ? cross(e1, e2) < 0 : cross(e1, e2) > 0
    if (reflex) a = 360 - a
    if (a < min) min = a
  }
  return min
}

export interface PlotFit {
  origin: V2
  u: V2 // unit vector along the street edge
  v: V2 // unit vector pointing into the plot
  size: number
}

/**
 * Fit the tier-sized square building inside a free-form plot. The square stays
 * axis-aligned with a plot edge (the street frontage), so leftover corners of
 * an irregular plot simply become greenery. Returns undefined when it does not
 * fit; that is what enforces a minimum plot area.
 */
export function fitBuilding(plot: V2[], size: number): PlotFit | undefined {
  const cen: V2 = mul(plot.reduce((s, p) => add(s, p), [0, 0] as V2), 1 / plot.length)
  const edges = plot
    .map((p, i) => [p, plot[(i + 1) % plot.length]] as [V2, V2])
    .sort((x, y) => dist(y[0], y[1]) - dist(x[0], x[1]))
  const ok = (o: V2, u: V2, v: V2) => {
    const corners = [o, add(o, mul(u, size)), add(o, add(mul(u, size), mul(v, size))), add(o, mul(v, size))]
    if (!corners.every((c) => pointInPolyTol(c, plot, 0.04))) return false
    // Corner containment is not enough for concave plots: an edge can dip
    // through the square, so the square's sides must not cross the boundary.
    for (let i = 0; i < 4; i++) for (let j = 0; j < plot.length; j++)
      if (segsCross(corners[i], corners[(i + 1) % 4], plot[j], plot[(j + 1) % plot.length])) return false
    return true
  }
  for (const [a, b] of edges) {
    const L = dist(a, b)
    if (L < size) continue
    const u = norm(sub(b, a))
    let v: V2 = [-u[1], u[0]]
    if (dot(v, sub(cen, a)) < 0) v = mul(v, -1) // v must point into the plot
    // Prefer a square centred on the street edge; fall back to other offsets.
    const mids = Array.from({ length: 13 }, (_, k) => ((L - size) * k) / 12)
      .sort((x, y) => Math.abs(x - (L - size) / 2) - Math.abs(y - (L - size) / 2))
    for (const inset of [0.12, 0.35, 0.65, 1, 1.5, 2.2, 3.2]) for (const t of mids) {
      const o = add(add(a, mul(u, t)), mul(v, inset))
      if (ok(o, u, v)) return { origin: o, u, v, size }
    }
  }
  return undefined
}

/* ---------------- plot picking ---------------- */

export interface StreetRef {
  plot: number
  edge: number
}
export interface Click {
  pt: V2
  street?: StreetRef
}

/** Snap a map point to the nearest plot edge; streets line every plot. */
export function snapPoint(pt: V2, placed: Placed[], radius = 0.6): Click {
  let best: Click = { pt }
  let bestD = radius
  placed.forEach((b, pi) => {
    b.plot.forEach((p, ei) => {
      const q = b.plot[(ei + 1) % b.plot.length]
      const e = sub(q, p)
      const t = Math.max(0, Math.min(1, dot(sub(pt, p), e) / (dot(e, e) || 1)))
      const proj = add(p, mul(e, t))
      const d = dist(pt, proj)
      if (d < bestD) {
        bestD = d
        best = { pt: proj, street: { plot: pi, edge: ei } }
      }
    })
  })
  return best
}

/** How close corner 1 must be to an existing plot vertex for the corner rule. */
const CORNER_TOL = 0.3

/** The street edge of a clicked corner, as [A, B]. */
const streetEnds = (s: StreetRef, placed: Placed[]): [V2, V2] => {
  const p = placed[s.plot].plot
  return [p[s.edge], p[(s.edge + 1) % p.length]]
}

/** A street corner 2 may lie on: the line through `origin` along `dir`, and
 * the allowed sign of the projection onto `dir` measured FROM the start of the
 * street run (`from`). `sign` 0 = both ways. The origin lets a continuation
 * street be snapped to ON its own line rather than parallel-offset in the
 * grass. `end` is where the street stops because it runs INTO a building
 * (another edge blocks the junction at a clearly different angle); corner 2 is
 * clamped there. A street that simply ends in open grass — or bends on through
 * a shallow junction — has NO end, so corner 2 may extend it. `endBack`
 * (two-way streets only) is the same limit the other way. */
interface GuidedDir { dir: V2; origin: V2; from: V2; sign: 1 | -1 | 0; end?: V2; endBack?: V2 }

/** Largest bend (degrees) between two streets meeting at a junction that still
 * counts as "the same street", so a big building may run straight across a
 * junction of short streets. The result must stay convex, so only shallow
 * (nearly-straight) continuations qualify. */
const JUNCTION_MAX_BEND = 35

/** The streets constraining corner 2: always the first corner's own street;
 * when that corner sits on an existing plot vertex, also the other street
 * meeting at that vertex. A street that continues a guided street through a
 * junction at a shallow angle also counts — chained through as many junctions
 * as stay shallow — so a large building can span several short streets and
 * finish on the extension of the last one. */
export function guidedDirs(prev: Click, placed: Placed[]): GuidedDir[] {
  if (!prev.street) return []
  const plot = placed[prev.street.plot]?.plot
  if (!plot) return []
  const [A, B] = streetEnds(prev.street, placed)
  const out: GuidedDir[] = []

  // Collect every edge of every plot once, with its unit direction and owner.
  const edges: { a: V2; b: V2; d: V2; plot: number }[] = []
  placed.forEach((b, pi) => {
    const n = b.plot.length
    for (let i = 0; i < n; i++) {
      const a = b.plot[i], q = b.plot[(i + 1) % n]
      const L = dist(a, q)
      if (L > 1e-6) edges.push({ a, b: q, d: norm(sub(q, a)), plot: pi })
    }
  })

  const corner = [A, B].find((v) => dist(v, prev.pt) <= CORNER_TOL)
    ?? placed.flatMap((b) => b.plot).find((v) => dist(v, prev.pt) <= CORNER_TOL)

  // Seed the run: the street(s) corner 2 may start along, each with the point
  // it is measured from and the junction it leads to for continuation.
  // queue entries: the line to offer, plus where it ends for the next hop.
  const cosMax = Math.cos((JUNCTION_MAX_BEND * Math.PI) / 180)
  const seen = (dir: V2, origin: V2) =>
    out.some((e) => Math.abs(cross(e.dir, dir)) < 1e-6 && dist(e.origin, origin) < CORNER_TOL)

  if (!corner) {
    // Mid-street: corner 2 may run both ways along the street it starts on.
    // Each direction is clamped only where the street runs INTO a building.
    const dir = norm(sub(B, A))
    const own = prev.street.plot
    const endA = streetEnd(A, norm(sub(A, prev.pt)), own)
    const endB = streetEnd(B, norm(sub(B, prev.pt)), own)
    // `end` is the limit along +dir, `endBack` along -dir (order the endpoints).
    const alongA = endA ? dot(sub(endA, prev.pt), dir) < 0 : endB ? dot(sub(endB, prev.pt), dir) > 0 : true
    out.push({
      dir, origin: prev.pt, from: prev.pt, sign: 0,
      end: alongA ? endB : endA, endBack: alongA ? endA : endB,
    })
    chainJunctions(A, norm(sub(A, prev.pt)), prev.pt)
    chainJunctions(B, norm(sub(B, prev.pt)), prev.pt)
  } else {
    // On a corner: each street meeting there runs one-way into the street.
    for (const e of edges) {
      const aIs = dist(e.a, corner) <= CORNER_TOL
      const bIs = dist(e.b, corner) <= CORNER_TOL
      if (!aIs && !bIs) continue
      const dir = aIs ? e.d : mul(e.d, -1)
      const far = aIs ? e.b : e.a
      const end = streetEnd(far, dir, e.plot)
      if (!seen(dir, corner)) out.push({ dir, origin: corner, from: corner, sign: 1, end })
      chainJunctions(far, dir, corner)
    }
  }

  // Where the street starting at `at` heading in `dir` finally dead-ends INTO
  // a building, following shallow junctions on the way. `own` is the plot whose
  // street we are on; as we cross junctions it becomes each continued plot.
  // Returns undefined when the street never dead-ends — it ends in open grass
  // or bends on through shallow junctions, and corner 2 may extend it without
  // limit. Only the endpoint of the last street in the run can be blocked, so
  // an open-ended chain stays extensible no matter how far it has gone.
  function streetEnd(at: V2, dir: V2, own: number): V2 | undefined {
    let cur = at, arrive = dir, plot = own, guard = 0
    while (guard++ < 16) {
      const next = shallowContinuation(cur, arrive)
      if (!next) return blocked(cur, arrive, plot) ? cur : undefined
      cur = next.far
      arrive = next.dir
      plot = next.plot
    }
    return undefined
  }

  // Is the street vertex `at` blocked by a building — does a DIFFERENT plot's
  // edge meet the street here at a clearly different (non-collinear) angle than
  // the street we arrive on? That covers both a neighbour whose corner touches
  // the street end and a wall whose edge passes straight through it (a
  // T-junction into the building's side). The street's own plot always has a
  // side edge at each corner, so only a neighbour's edge counts. A vertex where
  // the street just stops in open grass has no such edge.
  function blocked(at: V2, arrive: V2, own: number): boolean {
    const cosCollinear = Math.cos((JUNCTION_MAX_BEND * Math.PI) / 180)
    for (const e of edges) {
      if (e.plot === own) continue // the street's own building, not a blocker
      const aIs = dist(e.a, at) <= CORNER_TOL
      const bIs = dist(e.b, at) <= CORNER_TOL
      if (!aIs && !bIs && !pointOnSeg(at, e.a, e.b, CORNER_TOL)) continue
      const outDir = aIs ? e.d : mul(e.d, -1)
      if (dot(outDir, arrive) < -1 + 1e-6) continue // the street we arrived on
      if (Math.abs(dot(outDir, arrive)) < cosCollinear) return true // a building turns away here
    }
    return false
  }

  // The straightest street leaving `at` within JUNCTION_MAX_BEND of `arrive`,
  // excluding the street we arrived on. (Stricter turn/open-space tests were
  // tried and dropped: a point probed just past the junction lies numerically
  // ON the continued street's edge, so point-in-polygon is unreliable there
  // and broke chaining at the second junction.)
  function shallowContinuation(at: V2, arrive: V2): { dir: V2; far: V2; plot: number } | undefined {
    let next: { dir: V2; far: V2; plot: number } | undefined
    for (const e of edges) {
      const aIs = dist(e.a, at) <= CORNER_TOL
      const bIs = dist(e.b, at) <= CORNER_TOL
      if (!aIs && !bIs) continue
      const outDir = aIs ? e.d : mul(e.d, -1)
      if (dot(outDir, arrive) < -1 + 1e-6) continue // the street we arrived on
      if (dot(outDir, arrive) < cosMax) continue // bend too sharp
      // Only the straightest continuation counts as "the same street".
      if (!next || dot(outDir, arrive) > dot(next.dir, arrive)) next = { dir: outDir, far: aIs ? e.b : e.a, plot: e.plot }
    }
    return next
  }

  // Follow a street through successive shallow-angle junctions, offering each
  // continuation street (snapped on its own line) until the bend is too sharp.
  function chainJunctions(jp: V2, inDir: V2, from: V2) {
    let at = jp, arrive = inDir, guard = 0
    while (guard++ < 16) {
      const next = shallowContinuation(at, arrive)
      if (!next) return
      if (!seen(next.dir, at)) out.push({ dir: next.dir, origin: at, from, sign: 1 })
      at = next.far
      arrive = next.dir
    }
  }

  return out
}

/**
 * Guided snap for the second corner: it is always pulled onto the infinite
 * line through the first corner parallel to its street. When the first corner
 * sits on an existing plot vertex, both streets meeting at that vertex are
 * offered, and the line closer to the cursor wins — but only the half of each
 * line running ALONG the street (through the corner) is legal, so the first
 * edge follows that existing street. The point is always clamped onto the
 * legal ray; `ok` reports whether the cursor was already on that legal half.
 */
export function snapGuided(prev: Click, pt: V2, placed: Placed[]): { pt: V2; ok: boolean } {
  const dirs = guidedDirs(prev, placed)
  if (!dirs.length) return { pt, ok: false }
  // Pick the street whose own line is closest to the cursor, so a continuation
  // street is followed along its actual path instead of a parallel offset.
  let best: GuidedDir | undefined, bestD = Infinity
  for (const g of dirs) {
    const d = Math.abs(cross(g.dir, sub(pt, g.origin)))
    if (d < bestD) { bestD = d; best = g }
  }
  const { dir, origin, from, sign, end, endBack } = best!
  let proj = dot(sub(pt, origin), dir)
  // Only a street that runs INTO a building stops corner 2. A street ending in
  // open grass, or bending on through shallow junctions, has no end and may be
  // extended without limit.
  if (end) proj = Math.min(proj, dot(sub(end, origin), dir))
  if (endBack) proj = Math.max(proj, dot(sub(endBack, origin), dir))
  let pt2 = add(origin, mul(dir, proj))
  // Legality is measured from the start of the street run: the edge from
  // corner 1 to corner 2 must travel forward along the street(s), never
  // doubling back over an existing building.
  let ok = sign === 0 || dot(sub(pt2, from), dir) * sign >= 0
  // Snap to an existing street corner (plot vertex) when the cursor is close to
  // it, but only one lying on the chosen line and on the legal side.
  for (const b of placed) {
    for (const v of b.plot) {
      const onLine = Math.abs(cross(dir, sub(v, origin))) <= CORNER_TOL
      const legalSide = sign === 0 || dot(sub(v, from), dir) * sign >= 0
      if (onLine && legalSide && dist(pt2, v) <= CORNER_TOL) { pt2 = v; ok = true; break }
    }
  }
  return { pt: pt2, ok }
}

/**
 * The actual street path from corner 1 to corner 2, following junctions: the
 * bend points (junction vertices) between them, in order, so the preview can
 * draw the first edge bending along the streets instead of one straight line.
 * Returns [] when the two points lie on a single straight street.
 */
export function streetPath(p1: Click, p2: V2, placed: Placed[]): V2[] {
  const dirs = guidedDirs(p1, placed)
  if (!dirs.length) return []
  // Find the guided street whose line corner 2 lies on (the one snapGuided used).
  let target: GuidedDir | undefined, bestD = Infinity
  for (const g of dirs) {
    const d = Math.abs(cross(g.dir, sub(p2, g.origin)))
    if (d < bestD) { bestD = d; target = g }
  }
  if (!target) return []
  // Walk the chain from corner 1 toward corner 2's street, collecting the
  // junction vertices where the direction changes. Each guided street's origin
  // is the junction it passes through; keep those strictly between the points.
  const bends: V2[] = []
  const start = p1.pt
  for (const g of dirs) {
    // A bend point is a guided street's origin that is not corner 1 itself and
    // lies strictly between start and corner 2 along the run.
    if (dist(g.origin, start) <= CORNER_TOL) continue
    if (dist(g.origin, p2) <= CORNER_TOL) continue
    bends.push(g.origin)
  }
  // Order bends by distance from corner 1 along the run, and dedupe.
  const uniq = bends.filter((v, i) => bends.findIndex((w) => dist(w, v) <= CORNER_TOL) === i)
  uniq.sort((x, y) => dist(x, start) - dist(y, start))
  // Drop any bend that is collinear with its neighbours (no visible corner).
  return uniq.filter((v, i) => {
    const a = i === 0 ? start : uniq[i - 1]
    const b = i === uniq.length - 1 ? p2 : uniq[i + 1]
    return Math.abs(cross(norm(sub(v, a)), norm(sub(b, v)))) > 1e-6
  })
}

/** Vertices of OTHER plots lying near the segment and strictly between a and
 * b, ordered from a to b. When a plot edge follows a street through junctions,
 * these are the junction vertices, so the edge can be drawn bending along the
 * street instead of as one straight line. The stored plot keeps exactly its 4
 * corners — the bends are render-time only, so the tolerance is generous: a
 * snapped corner 2 sits on the street, but the stored straight edge can drift
 * off it by the accumulated bend. */
export function streetBends(a: V2, b: V2, placed: Placed[], tol = 1): V2[] {
  const L = dist(a, b)
  if (L < 1e-6) return []
  const dir = norm(sub(b, a))
  const pts: { t: number; v: V2 }[] = []
  for (const o of placed) {
    for (const v of o.plot) {
      if (Math.abs(cross(dir, sub(v, a))) > tol) continue
      const t = dot(sub(v, a), dir)
      if (t > tol && t < L - tol && !pts.some((x) => dist(x.v, v) <= tol)) pts.push({ t, v })
    }
  }
  return pts.sort((x, y) => x.t - y.t).map((x) => x.v)
}

/** A plot edge with any junction bends spliced in, for drawing. */
const bentEdge = (a: V2, b: V2, placed: Placed[]): V2[] => [a, ...streetBends(a, b, placed), b]

/** Streets the user can connect to right now: every plot edge before the
 * first corner and from the third corner on (those may go anywhere); while
 * picking the second corner, only the streets whose directions constrain the
 * snap are valid (the first corner's street, plus the other street meeting at
 * a corner vertex when the first corner sits on one). */
export function allowedStreets(clicks: Click[], placed: Placed[]): [V2, V2][] {
  const last = clicks[clicks.length - 1]
  if (!last?.street || clicks.length >= 2)
    return placed.flatMap((b) => b.plot.map((p, i) => [p, b.plot[(i + 1) % b.plot.length]] as [V2, V2]))
  const dirs = guidedDirs(last, placed)
  if (!dirs.length) return []
  // Highlight the streets corner 2 can snap to: every segment lying on a guided
  // street's line (its own street, the streets meeting at a corner vertex, and
  // any shallow-angle junction continuations chained from them).
  return placed.flatMap((b) =>
    b.plot.map((p, i) => [p, b.plot[(i + 1) % b.plot.length]] as [V2, V2])
      .filter(([a, q]) =>
        dirs.some((g) =>
          Math.abs(cross(g.dir, norm(sub(q, a)))) < 1e-6
          && Math.abs(cross(g.dir, sub(a, g.origin))) <= CORNER_TOL)))
}

/** A plot may be this much larger than its tier-sized building; the rest is
 * greenery. Kept generous so finding a valid shape stays easy. */
export const plotAreaCap = (size: number) => 4 * size * size

/** A plot whose greenery ring would be narrower than half the building's
 * footprint is effectively surrounded; the building fills the whole plot.
 * This is a render-time decision only — the stored plot points never change. */
export const surrounded = (b: Placed) => polyArea(b.plot) < 1.5 * b.size * b.size

/** Smallest angle between two streets (plot edges) allowed where they meet at
 * a junction. Shallower junctions make the buildings run nearly parallel for a
 * long stretch, so creating them is rejected at validation time. */
export const JUNCTION_MIN_ANGLE = 15

/** Error message, or undefined when the plot can be built on. `streetEdge` is
 * the corner-1→2 edge when it follows an existing street: it is exempt from
 * the junction-angle check because, spanning a junction, it is stored as a
 * straight chord that deviates from the street by up to half the bend. */
export function validatePlot(plot: V2[], size: number, existing: V2[][], streetEdge?: [V2, V2]): string | undefined {
  if (plot.length < 3) return 'Needs at least 3 points'
  for (let i = 0; i < plot.length; i++)
    if (dist(plot[i], plot[(i + 1) % plot.length]) < 0.3) return 'Points are too close together'
  if (!isSimple(plot)) return 'Edges must not cross'
  if (minAngle(plot) < 25) return 'A corner is too sharp'
  if (existing.some((e) => polysOverlap(plot, e))) return 'Overlaps an existing plot'
  if (shallowJunction(plot, existing, streetEdge)) return 'Junction angle too shallow (min 15°)'
  const area = polyArea(plot)
  if (area > plotAreaCap(size)) return `Plot too large (max ${plotAreaCap(size)} tiles²)`
  if (!fitBuilding(plot, size)) return 'The building does not fit inside this shape'
  return undefined
}

/** A shallow junction the plot would create: where, the existing street's
 * direction, the new edge's direction, and the angle between them. */
export interface JunctionIssue { at: V2; streetDir: V2; edgeDir: V2; degrees: number }

/** The first junction the new plot would create with an angle in (0°,
 * JUNCTION_MIN_ANGLE): a FREE corner (2–4; corner 1's street edge is exempt)
 * sitting exactly on an existing street/corner, with its side edge leaving
 * that street at a shallow-but-not-collinear angle. Fully collinear (0°) is a
 * normal street continuation and is ignored. Junction points are snapped, so
 * the match tolerance is tight: a vertex merely NEAR a street is not a
 * junction and must not trip the check. */
export function shallowJunction(plot: V2[], existing: V2[][], streetEdge?: [V2, V2]): JunctionIssue | undefined {
  const cosMin = Math.cos((JUNCTION_MIN_ANGLE * Math.PI) / 180)
  const AT = 0.05
  // unit direction toward `to`, or undefined when the point is too close
  const dirTo = (from: V2, to: V2) => (dist(from, to) < 1e-6 ? undefined : norm(sub(to, from)))
  for (let i = 0; i < plot.length; i++) {
    const v = plot[i]
    const next = plot[(i + 1) % plot.length], prev = plot[(i - 1 + plot.length) % plot.length]
    // Skip the street-following edge's endpoints: its angle is dictated by the
    // street snap, and across a junction the stored chord deviates by design.
    const isStreet = (a: V2, b: V2) =>
      streetEdge && ((dist(a, streetEdge[0]) < 1e-6 && dist(b, streetEdge[1]) < 1e-6)
        || (dist(a, streetEdge[1]) < 1e-6 && dist(b, streetEdge[0]) < 1e-6))
    const sides = [
      isStreet(v, next) ? undefined : dirTo(v, next),
      isStreet(v, prev) ? undefined : dirTo(v, prev),
    ].filter((d): d is V2 => !!d)
    if (!sides.length) continue
    for (const e of existing) {
      const n = e.length
      for (let j = 0; j < n; j++) {
        const a = e[j], b = e[(j + 1) % n]
        // The new vertex must sit ON this existing street (junction point).
        if (dist(v, a) > AT && dist(v, b) > AT && !pointOnSeg(v, a, b, AT)) continue
        const d = norm(sub(b, a))
        for (const nd of sides) {
          const c = Math.abs(dot(nd, d))
          if (c < 1 - 1e-4 && c > cosMin) {
            const degrees = (Math.acos(c) * 180) / Math.PI
            // Point the street direction toward the same side as the new edge,
            // so the arc between them is the acute junction angle.
            const streetDir = dot(d, nd) < 0 ? mul(d, -1) : d
            return { at: v, streetDir, edgeDir: nd, degrees }
          }
        }
      }
    }
  }
  // Reverse case: an existing corner lying on a new (non-street) edge, e.g. the
  // last edge closing the plot along a neighbour's corner at a shallow angle.
  for (let i = 0; i < plot.length; i++) {
    const a = plot[i], b = plot[(i + 1) % plot.length]
    const street = streetEdge && ((dist(a, streetEdge[0]) < 1e-6 && dist(b, streetEdge[1]) < 1e-6)
      || (dist(a, streetEdge[1]) < 1e-6 && dist(b, streetEdge[0]) < 1e-6))
    if (street || dist(a, b) < 1e-6) continue
    const nd = norm(sub(b, a))
    for (const e of existing) {
      const n = e.length
      for (let j = 0; j < n; j++) {
        const w = e[j]
        if (dist(w, a) <= AT || dist(w, b) <= AT || !pointOnSeg(w, a, b, AT)) continue
        for (const o of [e[(j + 1) % n], e[(j - 1 + n) % n]]) {
          if (dist(o, w) < 1e-6) continue
          const d = norm(sub(o, w))
          const c = Math.abs(dot(nd, d))
          if (c < 1 - 1e-4 && c > cosMin) {
            const degrees = (Math.acos(c) * 180) / Math.PI
            return { at: w, streetDir: dot(d, nd) < 0 ? mul(nd, -1) : nd, edgeDir: d, degrees }
          }
        }
      }
    }
  }
  return undefined
}

/** Free corner (3 or 4) snapping: onto a street if close, otherwise onto the
 * direction of an existing street leaving the previous corner (or, for corner
 * 4, corner 1), so existing angles such as a 90° junction can be followed. */
export function snapFree(pt: V2, prior: Click[], placed: Placed[], tol = 0.5): Click {
  const s = snapPoint(pt, placed)
  if (s.street) return s
  const anchors = prior.length >= 3 ? [prior[2].pt, prior[0].pt] : prior.length === 2 ? [prior[1].pt] : []
  let best: V2 | undefined
  let bestD = tol
  for (const an of anchors) {
    for (const b of placed) {
      const n = b.plot.length
      for (let j = 0; j < n; j++) {
        const a = b.plot[j], c = b.plot[(j + 1) % n]
        if (dist(an, a) > 0.05 && dist(an, c) > 0.05 && !pointOnSeg(an, a, c, 0.05)) continue
        const d = norm(sub(c, a))
        for (const dd of [d, mul(d, -1)]) {
          const t = dot(sub(pt, an), dd)
          if (t < 0.3) continue
          const proj = add(an, mul(dd, t))
          const e = dist(pt, proj)
          if (e < bestD) { bestD = e; best = proj }
        }
      }
    }
  }
  return best ? { pt: best } : s
}

/* ---------------- layout ---------------- */

export interface Placed {
  p: Project
  size: number
  plot: V2[]
  fit: PlotFit
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

export function layout(projects: Project[], constructionStarts = new Map<string, number>(), prev: Placed[] = []): Placed[] {
  const out: Placed[] = []
  for (const p of projects) {
    // plot: null marks a project mid-placement; it is not rendered yet.
    if (!p.plot) continue
    const size = footprint(p)
    // Projects loaded together start together. A newly submitted project can
    // provide its own elapsed start time without shifting older buildings.
    const start = constructionStarts.get(p.id) ?? 0
    const duration = buildDuration(p)
    // Keep the previously fitted position when nothing about the plot or the
    // tier changed, so editing a project does not move its building.
    const old = prev.find((x) => x.p.id === p.id)
    const fit = old && old.size === size && JSON.stringify(old.plot) === JSON.stringify(p.plot)
      ? old.fit
      : fitBuilding(p.plot, size)
    if (fit) out.push({ p, size, plot: p.plot, fit, start, duration })
  }
  return out
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

/** Extruded box on map-space corners A,B,C,D (in order); works for rotated frames. */
function prism(ctx: Ctx, A: V2, B: V2, C: V2, D: V2, height: number, color: string, opts: { windows?: string; z0?: number; alpha?: number } = {}) {
  // The window math assumes a parallelogram; non-parallelogram bases (a
  // plot-filled building) tolerate it.
  const parallelogram = dist(add(A, C), add(B, D)) < 1e-6
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
  if (opts.windows && height > 12 && parallelogram) {
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

/** Position in a building's local frame: origin + a*u + b*v. */
type Frame = (a: number, b: number) => V2
const frameOf = (fit: PlotFit): Frame => (a, b) => add(fit.origin, add(mul(fit.u, a), mul(fit.v, b)))

/** The map-space quad a building is drawn on: normally the fitted square, but
 * a surrounded building fills its whole plot. Plots always have exactly 4
 * points; they are rotated (never reordered) so the first edge is the street
 * frontage the fit was built against, keeping the walls' orientation stable. */
const baseQuad = (b: Placed): V2[] => {
  if (!surrounded(b)) {
    const at = frameOf(b.fit)
    return [at(0, 0), at(b.size, 0), at(b.size, b.size), at(0, b.size)]
  }
  const u = b.plot.map((p, i) => norm(sub(b.plot[(i + 1) % b.plot.length], p)))
  const best = b.plot.reduce((k, _, i) =>
    Math.abs(cross(u[i], b.fit.u)) < Math.abs(cross(u[k], b.fit.u)) ? i : k, 0)
  return b.plot.map((_, i) => b.plot[(best + i) % b.plot.length])
}

const scaleOf = (p: number, q: number, s: number) => q + (p - q) * s
/** Frame mapping the unit square onto a quad, bilinearly. */
const quadFrame = (base: V2[]): Frame => (a, b) => {
  const w = scaleOf(base[0][0], base[1][0], a), n = scaleOf(base[0][1], base[1][1], a)
  const e = scaleOf(base[3][0], base[2][0], a), s = scaleOf(base[3][1], base[2][1], a)
  return [scaleOf(w, e, b), scaleOf(n, s, b)]
}
/** Drawing frame for a building: the fit, or the plot quad when surrounded. */
const baseFrameOf = (b: Placed): Frame => (surrounded(b) ? quadFrame(baseQuad(b)) : frameOf(b.fit))

/** Local centre of the plot quad: the anchor point for details drawn in
 * screen space (helipad, crane base, progress bar). */
const quadCenter = (b: Placed) => {
  const q = toIso(...baseFrameOf(b)(0.5, 0.5))
  return { x: q.x, y: q.y, rx: (b.size * TILE_W) / 2, ry: (b.size * TILE_H) / 2 }
}

/** Box in a local frame: a in [x, x+w], b in [y, y+h]. */
function boxAt(ctx: Ctx, at: Frame, x: number, y: number, w: number, h: number, height: number, color: string, opts: { windows?: string; z0?: number; alpha?: number } = {}) {
  prism(ctx, at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h), height, color, opts)
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
export const finalHeight = (p: Project) => {
  const hours = Math.max(0, timeSaved(p))
  const floors = MAX_FLOORS * (1 - Math.exp(-Math.pow(hours / FLOOR_CURVE_HOURS, FLOOR_CURVE_POWER)))
  return Math.max(10, floors * FLOOR_HEIGHT)
}

/** Project-name sign on the more camera-facing of the two visible walls of a
 * box. The text is drawn in the wall's own plane, so it foreshortens with the
 * map rotation and is skipped when the wall is seen too edge-on to read. */
function drawBanner(ctx: Ctx, A: V2, B: V2, C: V2, D: V2, height: number, name: string, accent: string) {
  if (height < 18 || !name) return
  const mapCorners = [A, B, C, D]
  const corners = mapCorners.map((p) => toIso(p[0], p[1]))
  const nearest = corners.reduce((best, corner, index) => corner.y > corners[best].y ? index : best, 0)
  // The banner lives on the fixed A-B wall; it is only visible while that wall
  // is one of the two walls facing the camera.
  if (nearest !== 0 && nearest !== 1) return
  const mapLen = dist(A, B)
  let from = corners[0], to = corners[1]
  if (to.x < from.x) [from, to] = [to, from]
  const facing = mapLen ? (to.x - from.x) / (mapLen * TILE_W / 2) : 0
  if (facing < 0.4) return
  const W = mapLen * TILE_W / 2 * 0.8
  const bh = Math.min(11, height * 0.35)
  const y0 = Math.min(height - 3, height * 0.9 + bh / 2)
  ctx.save()
  ctx.globalAlpha = Math.min(1, (facing - 0.4) / 0.3 + 0.35)
  const k = 1 / (mapLen * TILE_W / 2)
  ctx.transform((to.x - from.x) * k, (to.y - from.y) * k, 0, 1,
    from.x + (to.x - from.x) * 0.1, from.y + (to.y - from.y) * 0.1 - y0)
  ctx.font = `bold ${Math.max(5, bh - 4)}px sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const pad = 3
  let text = name
  while (text.length > 1 && ctx.measureText(text).width > W - 2 * pad) text = text.slice(0, -1)
  if (text !== name) text = text.slice(0, -1) + '…'
  const bw = Math.min(W, ctx.measureText(text).width + 2 * pad)
  ctx.fillStyle = '#1b2230'
  ctx.fillRect(0, 0, bw, bh)
  ctx.fillStyle = accent
  ctx.fillRect(0, 0, bw, 1.5)
  ctx.fillStyle = '#fff'
  ctx.fillText(text, pad, bh / 2 + 0.5)
  ctx.restore()
}

function drawFinished(ctx: Ctx, b: Placed, h: number, time: number) {
  const { p, size } = b
  const full = surrounded(b)
  // A surrounded building fills its plot; its base is the plot quad and
  // detail boxes are placed on it bilinearly (fractions of the quad edges).
  const at = baseFrameOf(b)
  const u = full ? 1 : size
  const style = styleOf(p)
  const rich = p.budget_spent > 5000, mid = p.budget_spent > 1500
  const color = randomColor(p.id)
  const win = rich ? '#ffe36b' : style === 'glass' ? '#d8f4ff' : '#f3e2b0'
  const m = 0.12 / u
  boxAt(ctx, at, m, m, u - 2 * m, u - 2 * m, h, color, { windows: full ? undefined : win })
  drawBanner(ctx, at(m, m), at(u - m, m), at(u - m, u - m), at(m, u - m), h, p.name, '#e6b422')
  // Put bands on the facade before the roof so they cannot paint over its lower half.
  if (mid || rich) boxAt(ctx, at, 0.04 / u, 0.04 / u, u - 0.08 / u, u - 0.08 / u, 3, '#e6b422', { z0: Math.max(0, h - 3) })
  if (style === 'glass') {
    // crystal tapered crown
    boxAt(ctx, at, u * 0.3, u * 0.3, u * 0.4, u * 0.4, 14, '#9fe3ff', { z0: h })
  } else if (style === 'brick') {
    boxAt(ctx, at, 0.05 / u, 0.05 / u, u - 0.1 / u, u - 0.1 / u, 4, '#7a3524', { z0: h }) // cornice
  } else {
    boxAt(ctx, at, u * 0.25, u * 0.25, u * 0.5, u * 0.5, 8, '#8d867a', { z0: h })
  }
  const q = toIso(...at(u / 2, u / 2))
  const c = { x: q.x, y: q.y, rx: size * 24, ry: size * 12 }
  if (rich) {
    // helipad
    const top = h + (style === 'brick' ? 4 : style === 'glass' ? 14 : 8)
    ctx.beginPath()
    ctx.ellipse(c.x, c.y - top, 12, 6, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#333'; ctx.fill()
    ctx.fillStyle = '#fff'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'
    ctx.fillText('H', c.x, c.y - top + 3)
    // neon glow
    const pulse = 0.5 + 0.5 * Math.sin(time / 400)
    ctx.save(); ctx.globalAlpha = 0.25 + 0.2 * pulse
    ctx.fillStyle = '#ff3df2'
    ctx.beginPath(); ctx.ellipse(c.x, c.y, c.rx, c.ry, 0, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
}

function drawSite(ctx: Ctx, b: Placed, prog: number, h: number, time: number) {
  const { size } = b
  const full = surrounded(b)
  // A surrounded building grows on the whole plot; everything scales with it.
  const at = baseFrameOf(b)
  const u = full ? 1 : size
  const iso = (a: number, c: number) => toIso(...at(a, c))
  const s = full ? size : 1 // map-tile scale of one frame unit
  // slab
  boxAt(ctx, at, 0, 0, u, u, 2, '#9a9a9a')
  // dirt piles & barriers
  const d = iso(-0.3 / u, u + 0.1 / u)
  ctx.fillStyle = '#8b6b3e'; ctx.beginPath(); ctx.ellipse(d.x, d.y - 2, 9, 4.5, 0, Math.PI, 0); ctx.fill()
  for (let k = 0; k < size * 2; k++) {
    const t = (k + 0.5) / (size * 2)
    boxAt(ctx, at, t - 0.08 / u, u + 0.1 / u, 0.16 / u, 0.1 / u, 5, k % 2 ? '#f4c20d' : '#d94b2b')
  }
  // growing core (steel frame lower, concrete floors)
  const cur = Math.max(2, h * prog)
  const m = u * 0.15
  const floors = Math.floor(cur / 10)
  for (let f = 0; f < floors; f++) {
    boxAt(ctx, at, m, m, u - 2 * m, u - 2 * m, 8, '#b9b5ac', { z0: 2 + f * 10, alpha: f > floors - 3 ? 0.9 : 1 })
  }
  // steel beams
  const top = 2 + cur
  const corners: [number, number][] = [[m, m], [u - m, m], [u - m, u - m], [m, u - m]]
  corners.forEach(([x, y]) => { const q = iso(x, y); line(ctx, [[q.x, q.y - 2], [q.x, q.y - top - 6]], '#c0562a', 2) })
  // scaffolding on two adjacent faces
  const sh = Math.min(top, 2 + cur) + 4
  for (const [x1, y1, x2, y2] of [[0, u, u, u], [u, u, u, 0]]) {
    const a = iso(x1, y1), c = iso(x2, y2)
    line(ctx, [[a.x, a.y - 2], [a.x, a.y - sh]], '#e8c547')
    line(ctx, [[c.x, c.y - 2], [c.x, c.y - sh]], '#e8c547')
    for (let z = 8; z < sh; z += 10) line(ctx, [[a.x, a.y - z], [c.x, c.y - z]], '#e8c547')
    line(ctx, [[a.x, a.y - 2], [c.x, c.y - sh]], '#c9a227', 0.8)
  }
  // crane
  const base = full
    ? (() => { const c = quadCenter(b); return { x: c.x - c.rx * 1.35, y: c.y + c.ry * 1.35 } })()
    : iso(-0.35, -0.35)
  const mast = Math.max(h, 30) + 40
  const bx = base.x, by = base.y - 2
  if (!full) boxAt(ctx, at, -0.6 / u, -0.6 / u, 0.5 / u, 0.5 / u, 4, '#777')
  line(ctx, [[bx - 3, by], [bx - 3, by - mast]], '#f2a900', 2)
  line(ctx, [[bx + 3, by], [bx + 3, by - mast]], '#f2a900', 2)
  for (let z = 0; z < mast; z += 10) line(ctx, [[bx - 3, by - z], [bx + 3, by - z - 10]], '#f2a900', 1)
  // jib overhangs the building toward the centre
  const tip = { x: bx + (iso(u / 2, u / 2).x - bx) * 1.5 + 14, y: by - mast + 0 }
  const cab = { x: bx, y: by - mast }
  line(ctx, [[bx - 14, cab.y + 1], [tip.x, cab.y + 1]], '#f2a900', 3)
  line(ctx, [[bx, cab.y - 14], [tip.x, cab.y + 1]], '#c98a00', 1)
  line(ctx, [[bx, cab.y - 14], [bx - 14, cab.y + 1]], '#c98a00', 1)
  if (!full) boxAt(ctx, at, -0.65 / u, -0.65 / u, 0.2 / u, 0.2 / u, 0, '#444')
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
  const lb = iso(u / 2, u / 2)
  ctx.fillStyle = '#0006'; ctx.fillRect(lb.x - 20, lb.y + s * 16 + 6, 40, 5)
  ctx.fillStyle = '#4ade80'; ctx.fillRect(lb.x - 20, lb.y + s * 16 + 6, 40 * prog, 5)
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

export interface Preview {
  polygon: V2[] // clicked points (+ auto street corners) + the live cursor point
  points: V2[] // clicked points only
  ok: boolean
  size: number
  height: number
  cursor: V2 // map position of the cursor (for the area readout)
  hover: V2 // where a click would land right now (after snapping); drawn as a dot
  areaPct?: number // plot area as a percentage of the 2x tier cap
  streets?: [V2, V2][] // streets that may be connected to, drawn in green
  edge12?: V2[] // junction bends between corners 1 and 2, so that edge follows the streets
  junctionIssue?: JunctionIssue // a junction shallower than 15°; the angle and its arc are drawn at the corner
}

export interface RenderState {
  placed: Placed[]
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
  const m = add(b.fit.origin, add(mul(b.fit.u, b.size / 2), mul(b.fit.v, b.size / 2)))
  // The projected vertical axis determines which footprint is farther away.
  return toIso(m[0], m[1], angle).y + b.size
}

/** Every plot edge is a street; cars drive along them. */
const plotEdges = (placed: Placed[]): [V2, V2][] =>
  placed.flatMap((b) => b.plot.map((p, i) => [p, b.plot[(i + 1) % b.plot.length]] as [V2, V2]))

/** The streets as actually drawn: each plot edge split at its junction bends,
 * so cars never cut across a corner where no street is rendered. */
const carEdges = (placed: Placed[]): [V2, V2][] =>
  plotEdges(placed).flatMap(([a, b]) => {
    const pts = bentEdge(a, b, placed)
    return pts.slice(0, -1).map((p, i) => [p, pts[i + 1]] as [V2, V2]).filter(([p, q]) => dist(p, q) >= 0.01)
  })

export const carCountFor = (n: number) => (n < 1 ? 0 : Math.min(30, n * 2))

export function makeCars(placed: Placed[]): Traffic[] {
  const count = carCountFor(placed.length)
  const edges = carEdges(placed)
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
  {
    const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => screenToMap(x, y, w, h, s.cam))
    const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1])
    const m = ((Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys))) / 4
    diamond(ctx, Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) - Math.min(...xs) + 2 * m, Math.max(...ys) - Math.min(...ys) + 2 * m, 0, '#7fb069')
    grassBlades(ctx, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))
  }
  // Plots: a grass tile with a street kerb around it. The tile boundary bends
  // at junction vertices lying on an edge, so it hugs the drawn street.
  for (const b of s.placed) {
    const bent = b.plot.flatMap((p, i) => bentEdge(p, b.plot[(i + 1) % b.plot.length], s.placed).slice(0, -1))
    poly(ctx, bent.map((p) => { const q = toIso(p[0], p[1]); return [q.x, q.y] as [number, number] }), '#a5c98f', '#555a62', 0.4)
    const px = b.plot.map((p) => p[0]), py = b.plot.map((p) => p[1])
    grassBlades(ctx, Math.min(...px), Math.min(...py), Math.max(...px), Math.max(...py), (x, y) => pointInPolyTol([x, y], bent, 0.03), true)
  }

  const drawn = plotEdges(s.placed)
  // Streets: asphalt band centred on each plot edge, with kerbs and a dashed
  // centre line. Edges that follow a street through junctions bend at the
  // junction vertices instead of cutting straight across.
  {
    const hw = 0.15
    const iso = (p: V2): [number, number] => { const q = toIso(p[0], p[1]); return [q.x, q.y] }
    const band = (a: V2, b: V2, half: number) => {
      const n = norm(sub(b, a)), p: V2 = [-n[1], n[0]]
      return [add(a, mul(p, half)), add(b, mul(p, half)), sub(b, mul(p, half)), sub(a, mul(p, half))].map(iso)
    }
    const disc = (c: V2, r: number) =>
      Array.from({ length: 20 }, (_, i) => iso([c[0] + Math.cos(i / 20 * Math.PI * 2) * r, c[1] + Math.sin(i / 20 * Math.PI * 2) * r]))
    // Butt-ended bands with round joints, so streets meeting at odd angles blend smoothly
    const layer = (half: number, color: string) => {
      for (const [a, b] of drawn) {
        const pts = bentEdge(a, b, s.placed)
        for (let i = 0; i + 1 < pts.length; i++) {
          poly(ctx, band(pts[i], pts[i + 1], half), color)
          poly(ctx, disc(pts[i], half), color)
        }
        poly(ctx, disc(pts[pts.length - 1], half), color)
      }
    }
    layer(hw + 0.09, '#d6d3cc')
    layer(hw, '#4a4e57')
    for (const [a, b] of drawn) {
      const pts = bentEdge(a, b, s.placed)
      ctx.save()
      ctx.setLineDash([10, 9])
      for (let i = 0; i + 1 < pts.length; i++)
        if (dist(pts[i], pts[i + 1]) >= 0.01) line(ctx, [iso(pts[i]), iso(pts[i + 1])], 'rgba(250,220,90,0.9)', 1.2)
      ctx.restore()
    }
  }

  // traffic on the drawn streets only (drawn before buildings)
  const edges = carEdges(s.placed)
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
    const pos = add(add(e[0], mul(n, L * (car.dir === 1 ? car.t : 1 - car.t))), mul(perp, 0.07 * car.dir))
    const q = toIso(pos[0], pos[1])
    ctx.fillStyle = car.color
    ctx.beginPath(); ctx.ellipse(q.x, q.y - 2, 3, 1.9, 0, 0, Math.PI * 2); ctx.fill()
  })

  // depth-sorted buildings
  const order = [...s.placed].sort((a, b) => viewDepth(a, s.cam.angle) - viewDepth(b, s.cam.angle) || a.fit.origin[0] - b.fit.origin[0])
  for (const b of order) {
    const prog = progressOf(b, s.elapsed)
    if (prog <= 0) continue
    const fh = finalHeight(b.p)
    if (prog < 1) drawSite(ctx, b, prog, fh, s.time)
    else drawFinished(ctx, b, fh, s.time)
    if (s.selected === b.p.id) {
      const bent = b.plot.flatMap((p, i) => bentEdge(p, b.plot[(i + 1) % b.plot.length], s.placed).slice(0, -1))
      poly(ctx, bent.map((p) => { const q = toIso(p[0], p[1]); return [q.x, q.y] as [number, number] }), 'rgba(255,255,255,0.25)', '#fff')
    }
  }

  // live plot-placement preview
  if (s.preview) {
    // Streets that may be connected to are highlighted in green.
    if (s.preview.streets) {
      for (const [a, b] of s.preview.streets) {
        const qa = toIso(a[0], a[1]), qb = toIso(b[0], b[1])
        line(ctx, [[qa.x, qa.y], [qb.x, qb.y]], 'rgba(74,222,128,0.9)', 0.28)
        line(ctx, [[qa.x, qa.y], [qb.x, qb.y]], '#bbf7d0', 0.1)
      }
    }
    // A white dot marks where a click would land (after snapping), so the
    // snap is visible even before any shape has been drawn. toIso() returns
    // screen px, so this is a real pixel size — visible at every zoom.
    const hq = toIso(s.preview.hover[0], s.preview.hover[1])
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = 'rgba(15,23,42,0.85)'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(hq.x, hq.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
  }
  if (s.preview && s.preview.polygon.length >= 2) {
    const { polygon, points, ok, size, height } = s.preview
    // The edge from corner 1 to corner 2 follows the streets, so splice in the
    // junction bends instead of drawing it as one straight line.
    const polyMap = s.preview.edge12?.length
      ? [polygon[0], ...s.preview.edge12, ...polygon.slice(1)]
      : polygon
    const pts = polyMap.map((p): [number, number] => { const q = toIso(p[0], p[1]); return [q.x, q.y] })
    const enough = polygon.length >= 4
    const fill = !enough ? 'rgba(255,255,255,0.10)' : ok ? 'rgba(74,222,128,0.22)' : 'rgba(248,113,113,0.22)'
    const stroke = !enough ? '#ffffff' : ok ? '#4ade80' : '#f87171'
    // Incomplete shapes use a thick white outline so the edge that follows
    // the cursor is clearly visible.
    ctx.save()
    ctx.setLineDash([0.35, 0.2])
    if (pts.length >= 3) poly(ctx, pts, fill, stroke, enough ? 0.12 : 0.22)
    else line(ctx, pts, stroke, 0.22)
    ctx.restore()
    // A junction shallower than 15°: draw the offending angle as an arc with
    // its degree measure, so the user sees which corner is too shallow. The
    // arc is a map-space circle projected point by point (the isometric view
    // squashes it into an ellipse arc).
    if (s.preview.junctionIssue) {
      const { at, streetDir, edgeDir, degrees } = s.preview.junctionIssue
      const r = 0.6 // map tiles
      const a0 = Math.atan2(streetDir[1], streetDir[0]), a1 = Math.atan2(edgeDir[1], edgeDir[0])
      // Sweep the shorter way from the street to the new edge.
      let sweep = a1 - a0
      while (sweep > Math.PI) sweep -= Math.PI * 2
      while (sweep < -Math.PI) sweep += Math.PI * 2
      const N = 20
      const arc: [number, number][] = []
      for (let i = 0; i <= N; i++) {
        const a = a0 + (sweep * i) / N
        const q = toIso(at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r)
        arc.push([q.x, q.y])
      }
      ctx.save()
      ctx.strokeStyle = '#f87171'
      ctx.lineWidth = 2
      ctx.beginPath()
      arc.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.stroke()
      // Degree label just outside the arc's bisector.
      const mid = a0 + sweep / 2
      const lp = toIso(at[0] + Math.cos(mid) * (r + 0.4), at[1] + Math.sin(mid) * (r + 0.4))
      const text = `${Math.round(degrees)}°`
      ctx.font = '600 12px system-ui, sans-serif'
      const tw = ctx.measureText(text).width
      ctx.fillStyle = 'rgba(15,23,42,0.85)'
      ctx.beginPath(); ctx.roundRect(lp.x - tw / 2 - 4, lp.y - 9, tw + 8, 18, 5); ctx.fill()
      ctx.fillStyle = '#fca5a5'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, lp.x, lp.y)
      ctx.restore()
    }
    // Ghost of the building from the triangle stage onwards. If it does not
    // fit, draw it centered on the shape anyway (deep red) so the user can
    // see how much larger the plot needs to be.
    if (polygon.length >= 3) {
      const fit = fitBuilding(polygon, size)
      let at: Frame
      let color = '#ffffff'
      if (fit) {
        at = frameOf(fit)
      } else {
        const cen = mul(polygon.reduce((s, p) => add(s, p), [0, 0] as V2), 1 / polygon.length)
        const angle = polygon.reduce((best, p, i) => {
          const q = polygon[(i + 1) % polygon.length]
          return dist(p, q) > dist(polygon[best], polygon[(best + 1) % polygon.length]) ? i : best
        }, 0)
        const u = norm(sub(polygon[(angle + 1) % polygon.length], polygon[angle]))
        const origin = sub(cen, mul(add(u, [-u[1], u[0]]), size / 2))
        at = (a, b) => add(origin, add(mul(u, a), mul([-u[1], u[0]], b)))
        color = '#7f1d1d'
      }
      prism(ctx, at(0, 0), at(size, 0), at(size, size), at(0, size), height, color, { alpha: 0.3 })
    }
    // Corner markers: filled dot plus a ring in the shape's colour, showing
    // where to grab a point to move it.
    for (const p of points) {
      const q = toIso(p[0], p[1])
      ctx.fillStyle = '#fbbf24'
      ctx.beginPath(); ctx.arc(q.x, q.y, 0.1, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = stroke
      ctx.lineWidth = 0.09
      ctx.beginPath(); ctx.arc(q.x, q.y, 0.3, 0, Math.PI * 2); ctx.stroke()
    }
    // Area readout next to the cursor: how much of the plot cap is used.
    if (s.preview.areaPct !== undefined) {
      const q = toIso(s.preview.cursor[0], s.preview.cursor[1])
      const px = 1 / s.cam.zoom // keep the text a constant screen size
      ctx.font = `${13 * px}px sans-serif`
      ctx.textAlign = 'left'
      ctx.lineWidth = 3 * px
      ctx.strokeStyle = '#0f172a'
      const label = `${Math.round(s.preview.areaPct)}%`
      const tx = q.x + 14 * px, ty = q.y - 10 * px
      ctx.strokeText(label, tx, ty)
      ctx.fillStyle = s.preview.areaPct > 100 ? '#f87171' : '#ffffff'
      ctx.fillText(label, tx, ty)
    }
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
    if (progressOf(b, elapsed) < 1) continue
    const fh = finalHeight(b.p)
    // test against the footprint, shifted down by heights up to the roof
    for (let z = 0; z <= fh + 14; z += 6) {
      // Convert the projected point into rotated map space, then undo the
      // camera's compass rotation. Building height is always screen-vertical.
      const rotated = toGrid(screenX, screenY + z)
      const g: V2 = [rotated.gx * cos + rotated.gy * sin, -rotated.gx * sin + rotated.gy * cos]
      // A surrounded building is clickable over its whole visible footprint.
      if (surrounded(b) && pointInPoly(g, b.plot)) return b
      const d = sub(g, b.fit.origin)
      const a = dot(d, b.fit.u), c = dot(d, b.fit.v)
      if (a >= 0 && a <= b.size && c >= 0 && c <= b.size) return b
    }
  }
  return undefined
}

export const centerOn = (b: Placed, cur?: Camera): Camera => {
  const m = add(b.fit.origin, add(mul(b.fit.u, b.size / 2), mul(b.fit.v, b.size / 2)))
  const angle = cur?.angle ?? 0
  const zoom = cur?.zoom ?? 1.2
  const c = toIso(m[0], m[1], angle)
  return { x: -c.x * zoom, y: (-c.y + finalHeight(b.p) / 2) * zoom, zoom, angle }
}
