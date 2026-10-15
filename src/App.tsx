import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Project, dataService, roadService, timeSaved, timeSavingsRatio,
} from './services/storageService'
import {
  type Camera, type Facing, type Footprint, type Placed, type Preview, type Traffic,
  buildingColor, randomBuildingColor, centerOn, formatRemaining, progressOf, edgeRun, finalHeight, footprint, frontEdges, layout, makeCars, nearestEdge, pick,
  placementAt, placementError, render, roadError, roadsToAdd, roadsToDeleteWithOrphans, roadsToPrune, screenToMap, toIso,
} from './engine'

type Tool = 'none' | 'road' | 'delete'

const EMPTY_FORM = { name: '', description: '', ai: '', est: '', budget: '' }

const HOME: Camera = { x: 0, y: 0, zoom: 1, angle: 0 }

// Toggle from the console: `smoothRotation = true`
// Toggle from the console: `showPerfTracking = true`
declare global { interface Window { smoothRotation?: boolean; showPerfTracking?: boolean } }
window.smoothRotation ??= false
window.showPerfTracking ??= false
const smoothRotation = () => !!window.smoothRotation

interface Placing {
  id: string
  name: string
  fp: Footprint
  height: number
  facing: Facing
  origin?: { gx: number; gy: number; facing: Facing }
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [form, setForm] = useState({ ...EMPTY_FORM, color: '#888888' })
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [tip, setTip] = useState<{ b: Placed; x: number; y: number }>()
  const tipRef = useRef<HTMLDivElement>(null)
  const statsRef = useRef<HTMLPreElement>(null)
  const tipIdRef = useRef<string | undefined>(undefined)
  tipIdRef.current = tip?.b.p.id
  const [placing, setPlacing] = useState<Placing>()
  const [placeError, setPlaceError] = useState<string>()
  const [roads, setRoads] = useState<Set<string>>(new Set())
  const [roadMenu, setRoadMenu] = useState(false)
  const [tool, setTool] = useState<Tool>('none')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const camRef = useRef<Camera>({ ...HOME })
  const startRef = useRef(0)
  const constructionStartsRef = useRef(new Map<string, number>())
  const [startsVersion, setStartsVersion] = useState(0)
  // startsVersion forces a recompute after the map is mutated when a new
  // building's construction starts.
  // oxlint-disable-next-line refs -- layout() only reads the map at call time; startsVersion re-triggers it after a mutation
  const placed = useMemo(() => layout(projects, constructionStartsRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startsVersion intentionally invalidates this memo
    [projects, startsVersion])
  const [nowTick, setNowTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNowTick(performance.now()), 250)
    return () => clearInterval(id)
  }, [])
  const carsRef = useRef<Traffic[]>([])
  const cursorRef = useRef({ x: -9999, y: -9999 })
  const stateRef = useRef<{ placed: Placed[]; roads: Set<string>; selected?: string; placing?: Placing; tool: Tool; roadMenu: boolean }>({ placed: [], roads: new Set(), tool: 'none', roadMenu: false })

  // Set the construction clock once on mount. Guarded so the double-invoked
  // effects of StrictMode do not reset it, and so the sync effect below (which
  // runs every render) never touches it — that was resetting the clock on each
  // keystroke and restarting every building's construction.
  useEffect(() => {
    if (startRef.current === 0) startRef.current = performance.now()
  }, [])

  useEffect(() => {
    // Sync the mutable snapshot read by the render loop on every render.
    stateRef.current = { placed, roads, selected, placing, tool, roadMenu }
  })

  useEffect(() => {
    dataService.list().then(async (loaded) => {
      // Reconstruct construction progress across reloads from the creation
      // timestamp. `elapsed` counts ms since page load, so a project created
      // `age` ms before the page loaded gets a negative start offset — its
      // progress is then correct (already finished, or part-way through a
      // long build). Recorded once per project so re-renders never reset it.
      for (const p of loaded) {
        if (constructionStartsRef.current.has(p.id)) continue
        const createdAt = Date.parse(p.created_at)
        const age = Number.isFinite(createdAt) ? Date.now() - createdAt : 0
        constructionStartsRef.current.set(p.id, -Math.max(0, age))
      }
      const list = loaded
      const known = new Set(await roadService.list())
      setRoads(known)
      setProjects(list)
      // Start focused on the first building, so a city that grew away from
      // the origin still opens on the city instead of empty grass.
      const first = layout(list)[0]
      if (first) camRef.current = centerOn(first)
    })
  }, [])
  useEffect(() => {
    // Keep existing vehicles in place when a project is added; only create the
    // additional vehicles needed for the new roads/buildings.
    const desired = makeCars(placed, roads)
    carsRef.current = carsRef.current.length ? [...carsRef.current, ...desired.slice(carsRef.current.length)] : desired
  }, [placed, roads])

  // Render loop
  useEffect(() => {
    const cv = canvasRef.current!
    let raf = 0
    const statsAcc = { last: 0, windowStart: 0, frames: 0, worst: 0, renderTotal: 0, renderMax: 0 }
    const frame = (now: number) => {
      const dpr = window.devicePixelRatio || 1
      const w = cv.clientWidth, h = cv.clientHeight
      if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr }
      const ctx = cv.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cur = stateRef.current
      let preview: Preview | undefined
      if (cur.placing || cur.tool !== 'none') {
        const map = screenToMap(cursorRef.current.x, cursorRef.current.y, w, h, camRef.current)
        if (cur.placing) {
          const { fp, height, facing } = cur.placing
          const { gx, gy } = placementAt(map, fp)
          preview = { kind: 'building', gx, gy, fp, height, facing, ok: !placementError(gx, gy, fp, facing, cur.placed, cur.roads) }
        } else {
          const run = runRef.current
          preview = {
            kind: 'road',
            mode: run?.del || cur.tool === 'delete' ? 'delete' : 'add',
            edges: run ? edgeRun(run.start, map) : [nearestEdge(map)],
          }
        }
      }
      const renderStart = performance.now()
      render(ctx, w, h, {
        placed: cur.placed, roads: cur.roads, elapsed: now - startRef.current, time: now,
        cam: camRef.current, selected: cur.selected, cars: carsRef.current, preview,
      })
      const st = statsAcc
      const renderMs = performance.now() - renderStart
      if (statsRef.current) statsRef.current.hidden = !window.showPerfTracking
      if (st.last) st.worst = Math.max(st.worst, now - st.last)
      st.last = now
      st.frames++
      st.renderTotal += renderMs
      st.renderMax = Math.max(st.renderMax, renderMs)
      if (!st.windowStart) st.windowStart = now
      if (now - st.windowStart >= 500 && statsRef.current) {
        const secs = (now - st.windowStart) / 1000
        statsRef.current.textContent =
          `${(st.frames / secs).toFixed(0)} fps · frame ${(1000 * secs / st.frames).toFixed(1)} ms (worst ${st.worst.toFixed(0)})\n` +
          `render ${(st.renderTotal / st.frames).toFixed(1)} ms (max ${st.renderMax.toFixed(1)})\n` +
          `${cur.placed.length} buildings · ${carsRef.current.length} cars · ${cur.roads.size} roads`
        st.frames = 0; st.renderTotal = 0; st.renderMax = 0; st.worst = 0; st.windowStart = now
      }
      const tipEl = tipRef.current
      if (tipEl && tipIdRef.current) {
        const b = cur.placed.find((q) => q.p.id === tipIdRef.current)
        if (b) {
          const cam = camRef.current
          const c = toIso(b.gx + b.fp.w / 2, b.gy + b.fp.d / 2, cam.angle)
          const hgt = finalHeight(b.p) * Math.max(0, Math.min(1, progressOf(b, now - startRef.current)))
          tipEl.style.left = `${w / 2 + cam.x + c.x * cam.zoom}px`
          tipEl.style.top = `${h / 2 + cam.y + (c.y - hgt / 2) * cam.zoom}px`
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Pan / zoom / click
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const runRef = useRef<{ start: string; del: boolean; button: number } | null>(null)
  const zoomBy = useCallback((f: number, dx = 0, dy = 0) => {
    // dx/dy: anchor offset from the view center; that point stays fixed on screen.
    const cam = camRef.current
    const zoom = Math.min(4.5, Math.max(0.3, cam.zoom * f))
    const k = zoom / cam.zoom
    camRef.current = { ...cam, zoom, x: dx - (dx - cam.x) * k, y: dy - (dy - cam.y) * k }
  }, [])
  const buttonRot = useRef(0)
  const rotateBy = useCallback((degrees: number) => {
    const fullTurn = Math.PI * 2
    const angle = (camRef.current.angle + degrees * Math.PI / 180 + fullTurn) % fullTurn
    // Pivot around the map point at the view center, not the map origin.
    const cam = camRef.current
    const center = screenToMap(0, 0, 0, 0, cam)
    const p = toIso(center[0], center[1], angle)
    camRef.current = { ...cam, angle, x: -p.x * cam.zoom, y: -p.y * cam.zoom }
  }, [])
  useEffect(() => {
    const cv = canvasRef.current!
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = cv.getBoundingClientRect()
      zoomBy(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2)
    }
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => cv.removeEventListener('wheel', wheel)
  }, [zoomBy])

  useEffect(() => {
    const down = new Set<string>()
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
    const watched = /^(Arrow(Up|Down|Left|Right)|Key[WASDQE]|Shift(Left|Right)|Control(Left|Right))$/
    const onDown = (e: KeyboardEvent) => {
      if (typing(e) || !watched.test(e.code)) return
      if (e.code.startsWith('Arrow')) e.preventDefault()
      if (e.code === 'KeyQ' || e.code === 'KeyE') {
        if (smoothRotation()) { down.add(e.code); return }
        if (e.repeat) return
        const quarter = Math.PI / 2
        const snapped = Math.round(camRef.current.angle / quarter) * quarter
        camRef.current = { ...camRef.current, angle: snapped }
        rotateBy(e.code === 'KeyE' ? 90 : -90)
        return
      }
      down.add(e.code)
    }
    const onUp = (e: KeyboardEvent) => { down.delete(e.code) }
    const clear = () => down.clear()
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(50, now - last) / 16.67
      last = now
      const has = (...codes: string[]) => codes.some((c) => down.has(c))
      if (smoothRotation()) {
        const dir = (has('KeyE') ? 1 : 0) - (has('KeyQ') ? 1 : 0) + buttonRot.current
        if (dir) rotateBy(Math.sign(dir) * 2 * dt)
      }
      if (down.size) {
        const dx = (has('ArrowLeft', 'KeyA') ? 1 : 0) - (has('ArrowRight', 'KeyD') ? 1 : 0)
        const dy = (has('ArrowUp', 'KeyW') ? 1 : 0) - (has('ArrowDown', 'KeyS') ? 1 : 0)
        if (dx || dy) {
          const cam = camRef.current
          camRef.current = { ...cam, x: cam.x + dx * 10 * dt, y: cam.y + dy * 10 * dt }
        }
        const zoom = (has('ShiftLeft', 'ShiftRight') ? 1 : 0) - (has('ControlLeft', 'ControlRight') ? 1 : 0)
        if (zoom) zoomBy(Math.pow(1.02, zoom * dt))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', clear)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', clear)
    }
  }, [rotateBy, zoomBy])

  const rotateDoor = useCallback(() => {
    setPlacing((pl) => pl && { ...pl, facing: ((pl.facing + 1) % 4) as Facing })
  }, [])

  const cancelPlacement = useCallback(async () => {
    const pl = stateRef.current.placing
    if (!pl) return
    if (pl.origin) {
      await dataService.update(pl.id, { gx: pl.origin.gx, gy: pl.origin.gy, facing: pl.origin.facing })
      setProjects(await dataService.list())
      setPlacing(undefined)
      setPlaceError(undefined)
      return
    }
    // The project was just created; cancelling placement removes it again.
    await dataService.remove(pl.id)
    setProjects(await dataService.list())
    setPlacing(undefined)
    setPlaceError(undefined)
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return
      if (e.key === 'Escape') {
        if (runRef.current) runRef.current = null
        else if (stateRef.current.placing) void cancelPlacement()
        else if (stateRef.current.tool !== 'none') { setTool('none'); setPlaceError(undefined) }
        else if (stateRef.current.roadMenu) setRoadMenu(false)
      } else if ((e.key === 'r' || e.key === 'R') && stateRef.current.placing) rotateDoor()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [cancelPlacement, rotateDoor])

  useEffect(() => {
    if (!showForm) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setShowForm(false)
      setEditingId(undefined)
      setForm({ ...EMPTY_FORM, color: '#888888' })
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [showForm])

  const applyRun = async (e: React.PointerEvent, run: { start: string; del: boolean; button?: number }) => {
    const r = canvasRef.current!.getBoundingClientRect()
    const map = screenToMap(e.clientX - r.left, e.clientY - r.top, r.width, r.height, camRef.current)
    const edges = edgeRun(run.start, map)
    if (run.del) {
      if (run.button === 2 && tool === 'delete') { setTool('none'); setPlaceError(undefined); return }
      const keys = roadsToDeleteWithOrphans(edges, placed, roads)
      if (!keys.length && run.button === 2 && tool === 'road' && !edges.some((k) => roads.has(k))) { setTool('none'); setPlaceError(undefined); return }
      if (keys.length) setRoads(new Set(await roadService.remove(keys)))
      setPlaceError(!keys.length && edges.some((k) => roads.has(k)) ? "Can't delete the road in front of a building" : undefined)
      return
    }
    const keys = roadsToAdd(edges, placed, roads)
    if (!keys.length) { setPlaceError(roadError(edges[0], placed, roads) ?? 'Cannot build a road here.'); return }
    setRoads(new Set(await roadService.add(keys)))
    setPlaceError(undefined)
  }

  const pruneRoads = async (list: Project[], current: Set<string>) => {
    const bad = roadsToPrune(layout(list), current)
    return bad.length ? new Set(await roadService.remove(bad)) : current
  }

  const onClick = async (e: React.PointerEvent) => {
    const cv = canvasRef.current!
    const r = cv.getBoundingClientRect()
    const sx = e.clientX - r.left, sy = e.clientY - r.top
    if (placing) {
      const map = screenToMap(sx, sy, r.width, r.height, camRef.current)
      const { gx, gy } = placementAt(map, placing.fp)
      const error = placementError(gx, gy, placing.fp, placing.facing, placed, roads)
      if (error) { setPlaceError(error); return }
      await dataService.update(placing.id, { gx, gy, facing: placing.facing })
      const withFront = new Set(await roadService.add(frontEdges(gx, gy, placing.fp, placing.facing)))
      const list = await dataService.list()
      setRoads(placing.origin ? await pruneRoads(list, withFront) : withFront)
      // Construction only starts on the first placement; moves and resize re-placements keep their progress.
      if (!constructionStartsRef.current.has(placing.id)) {
        constructionStartsRef.current.set(placing.id, performance.now() - startRef.current)
        setStartsVersion((v) => v + 1)
      }
      setProjects(await dataService.list())
      setPlacing(undefined)
      setPlaceError(undefined)
      return
    }
    const b = pick(placed, performance.now() - startRef.current, sx, sy, r.width, r.height, camRef.current)
    setTip(b ? { b, x: sx, y: sy } : undefined)
    setSelected(b?.p.id)
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const ai = parseFloat(form.ai), est = parseFloat(form.est), budget = parseFloat(form.budget) || 0
    if (!form.name.trim() || !(ai >= 0) || !(est > 0)) return
    const values = {
      name: form.name.trim(), description: form.description.trim(),
      time_spent_ai: ai, time_estimated_no_ai: est, budget_spent: Math.max(0, budget), color: form.color,
    }
    if (editingId) {
      // Keep the original construction start. The new duration is applied to
      // the elapsed time, so edits update the current building in place.
      const old = projects.find((p) => p.id === editingId)
      const updated = old && { ...old, ...values }
      const resized = !!old && !!updated && typeof old.gx === 'number' && footprint(updated) !== footprint(old)
      let anchored: { gx: number; gy: number } | undefined
      if (resized && updated && old) {
        // Scale around the door: the front edge stays put and the door stays centred on the same spot.
        const f = (old.facing ?? 2) as Facing, fo = footprint(old), fu = footprint(updated), dw = fo.w - fu.w, dd = fo.d - fu.d, ox = old.gx as number, oy = old.gy as number
        const sx = f === 1 ? dw : f === 3 ? 0 : dw / 2, sy = f === 2 ? dd : f === 0 ? 0 : dd / 2
        const others = stateRef.current.placed
        const xs = [...new Set([Math.floor(ox + sx), Math.ceil(ox + sx)])], ys = [...new Set([Math.floor(oy + sy), Math.ceil(oy + sy)])]
        for (const x of xs) for (const y of ys)
          if (!anchored && !placementError(x, y, footprint(updated), f, others, roads, old.id)) anchored = { gx: x, gy: y }
      }
      if (resized && updated && anchored) {
        await dataService.update(editingId, { ...values, ...anchored })
        setProjects(await dataService.list())
      } else if (resized && updated) {
        // No valid position around the door: clear the position and make the user re-place it.
        await dataService.update(editingId, { ...values, gx: null, gy: null })
        setProjects(await dataService.list())
        setPlacing({ id: updated.id, name: updated.name, fp: footprint(updated), height: finalHeight(updated), facing: updated.facing ?? 2 })
        setPlaceError('The building changed size. Place it again.')
      } else {
        await dataService.update(editingId, values)
        setProjects(await dataService.list())
      }
    } else {
      // gx: null marks the project as awaiting placement, so it stays
      // invisible until the user has placed it on the map.
      const created = await dataService.create({ ...values, gx: null, gy: null, facing: 2 })
      setProjects(await dataService.list())
      setPlacing({ id: created.id, name: created.name, fp: footprint(created), height: finalHeight(created), facing: 2 })
      setTool('none')
      setRoadMenu(false)
      setPlaceError(undefined)
    }
    setForm({ ...EMPTY_FORM, color: '#888888' })
    setEditingId(undefined)
    setShowForm(false)
  }

  const edit = (p: Project) => {
    setTip(undefined)
    setEditingId(p.id)
    setForm({
      name: p.name, description: p.description,
      ai: String(p.time_spent_ai), est: String(p.time_estimated_no_ai), budget: String(p.budget_spent),
      color: p.color ?? buildingColor(p.id),
    })
    setShowForm(true)
  }
  const move = async (p: Project) => {
    if (placing || typeof p.gx !== 'number' || typeof p.gy !== 'number') return
    const origin = { gx: p.gx, gy: p.gy, facing: (p.facing ?? 2) as Facing }
    setTip(undefined)
    await dataService.update(p.id, { gx: null, gy: null })
    setProjects(await dataService.list())
    setPlacing({ id: p.id, name: p.name, fp: footprint(p), height: finalHeight(p), facing: origin.facing, origin })
    setTool('none')
    setRoadMenu(false)
    setTip(undefined)
    setPlaceError(undefined)
  }
  const closeForm = () => {
    setShowForm(false)
    setEditingId(undefined)
    setForm({ ...EMPTY_FORM, color: '#888888' })
  }

  const focus = (id: string) => {
    const b = placed.find((x) => x.p.id === id)
    if (!b) return
    camRef.current = centerOn(b, camRef.current)
    setSelected(id)
    setTip(undefined)
  }

  const totalSaved = projects.reduce((s, p) => s + Math.max(0, timeSaved(p)), 0)
  const input = 'w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm'

  return (
    <div className="flex h-full bg-slate-900 text-slate-100">
      <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-r border-slate-700 p-4">
        <h1 className="text-2xl font-bold">🏙️ Savings City</h1>


        <section className="rounded bg-slate-800 p-3">
          <div className="text-xs uppercase text-slate-400">Total time saved</div>
          <div className="text-4xl font-bold text-emerald-400">{totalSaved.toFixed(1)} h</div>
          <div className="mt-2 text-xs uppercase text-slate-400">Budget spent</div>
          <div className="text-2xl font-semibold">${projects.reduce((s, p) => s + p.budget_spent, 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </section>

        <section className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold uppercase text-slate-400">Projects</h2>
          {[...projects].reverse().map((p) => (
            <div key={p.id} className={`flex items-center justify-between rounded px-2 py-1 text-sm ${selected === p.id ? 'bg-slate-600' : 'bg-slate-800 hover:bg-slate-700'}`}>
              <button className="flex-1 text-left" onClick={() => focus(p.id)}>
                <div className="font-medium">{p.name}{p.gx === null && <span className="ml-1 text-xs text-amber-400">(placing…)</span>}</div>
                <div className="text-xs text-slate-400">{timeSaved(p).toFixed(1)} h / {(timeSavingsRatio(p) * 100).toFixed(0)}% saved</div>
                {(() => {
                  const b = placed.find((x) => x.p.id === p.id)
                  const pct = b ? progressOf(b, nowTick - startRef.current) * 100 : 0
                  if (!b || pct >= 100) return null
                  return (
                    <>
                      <div className="text-xs text-slate-400">{pct.toFixed(0)}% finished · {formatRemaining(b, nowTick - startRef.current)} left</div>
                      <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-slate-700">
                        <div className="h-full bg-emerald-400" style={{ width: `${pct}%` }} />
                      </div>
                    </>
                  )
                })()}
              </button>
              <button aria-label="Move" title="Move" disabled={!!placing || p.gx === null} className="px-1 text-slate-400 hover:text-sky-300 disabled:opacity-40" onClick={() => void move(p)}>✥</button>
              <button aria-label="Edit" className="px-1 text-slate-400 hover:text-amber-300" onClick={() => edit(p)}>✎</button>
              <button aria-label="Delete" className="px-1 text-slate-400 hover:text-red-400" onClick={async () => { await dataService.remove(p.id); const list = await dataService.list(); setProjects(list); setRoads(await pruneRoads(list, roads)); setTip(undefined) }}>✕</button>
            </div>
          ))}
          {projects.length === 0 && <p className="text-sm text-slate-500">No projects yet. Construct your first one!</p>}
        </section>

      </aside>

      <main className="relative min-w-0 flex-1">
        <canvas
          ref={canvasRef}
          className={`h-full w-full touch-none ${placing || tool !== 'none' ? 'cursor-crosshair' : 'cursor-grab'}`}
          onPointerDown={(e) => {
            // Left pans/clicks (or starts a road run with a tool), middle always pans, right deletes runs (or rotates the building while placing).
            if (e.button === 1) e.preventDefault()
            if (runRef.current) {
              if (e.button !== runRef.current.button) runRef.current = null
              return
            }
            const run = !placing && tool !== 'none' && (e.button === 0 || e.button === 2)
            if (run) {
              const r = e.currentTarget.getBoundingClientRect()
              const map = screenToMap(e.clientX - r.left, e.clientY - r.top, r.width, r.height, camRef.current)
              runRef.current = { start: nearestEdge(map), del: e.button === 2 || tool === 'delete', button: e.button }
            } else if (e.button === 1 || (e.button === 0 && tool === 'none') || (e.button === 0 && placing)) {
              drag.current = { x: e.clientX, y: e.clientY, moved: false }
            } else return
            ;(e.target as Element).setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            cursorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top }
            const d = drag.current
            if (!d) return
            const dx = e.clientX - d.x, dy = e.clientY - d.y
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
            camRef.current = { ...camRef.current, x: camRef.current.x + dx, y: camRef.current.y + dy }
            d.x = e.clientX; d.y = e.clientY
          }}
          onPointerUp={(e) => {
            const run = runRef.current
            if (run) {
              if (e.button === run.button) { runRef.current = null; void applyRun(e, run) }
              return
            }
            if (e.button === 0 && drag.current && !drag.current.moved) void onClick(e)
            if (e.button === 0 || e.button === 1) drag.current = null
          }}
          onContextMenu={(e) => { e.preventDefault(); if (placing) rotateDoor() }}
        />
        <pre ref={statsRef} hidden={!window.showPerfTracking} className="pointer-events-none absolute left-3 top-3 rounded bg-slate-900/80 px-2 py-1 font-mono text-xs leading-snug text-emerald-300" />
        <div className="absolute right-3 top-3 flex flex-col gap-1">
          <button className="h-8 w-8 rounded bg-slate-800/90 text-lg" onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
          <button className="h-8 w-8 rounded bg-slate-800/90 text-lg" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
          <button className="h-8 w-8 rounded bg-slate-800/90" onClick={() => { if (!smoothRotation()) rotateBy(90) }}
            onPointerDown={() => { if (smoothRotation()) buttonRot.current = 1 }} onPointerUp={() => { buttonRot.current = 0 }}
            onPointerLeave={() => { buttonRot.current = 0 }} onPointerCancel={() => { buttonRot.current = 0 }} aria-label="Rotate view left">↺</button>
          <button className="h-8 w-8 rounded bg-slate-800/90" onClick={() => { if (!smoothRotation()) rotateBy(-90) }}
            onPointerDown={() => { if (smoothRotation()) buttonRot.current = -1 }} onPointerUp={() => { buttonRot.current = 0 }}
            onPointerLeave={() => { buttonRot.current = 0 }} onPointerCancel={() => { buttonRot.current = 0 }} aria-label="Rotate view right">↻</button>
          <button className="h-8 w-8 rounded bg-slate-800/90" onClick={() => (camRef.current = { ...HOME })} aria-label="Recenter">⌖</button>
        </div>
        <div className="absolute bottom-4 left-4 flex flex-col items-start gap-3">
          {roadMenu && !placing && tool !== 'none' && (
            <p className="w-64 rounded-lg bg-slate-900/90 px-3 py-2 text-xs text-slate-300 shadow-lg">
              {tool === 'road'
                ? 'Click or drag along a grid edge next to a building to add roads. Right-click (or drag) deletes.'
                : 'Click or drag along roads to delete them.'} Middle-drag to pan.
            </p>
          )}
          {roadMenu && !placing && (
            <div className="flex gap-3">
              {(['road', 'delete'] as const).map((t) => (
                <button
                  key={t}
                  title={t === 'road' ? 'Road tool' : 'Delete tool'}
                  aria-label={t === 'road' ? 'Road tool' : 'Delete tool'}
                  onClick={() => { setTool(tool === t ? 'none' : t); setPlaceError(undefined) }}
                  className={`h-11 w-11 rounded-full text-xl shadow-lg ${tool === t ? 'bg-sky-500 text-slate-900 hover:bg-sky-400' : 'bg-slate-800/90 hover:bg-slate-700'}`}
                >{t === 'road' ? '➕' : '🗑️'}</button>
              ))}
            </div>
          )}
          <div className="flex gap-3">
            <button
              title="Construct Project"
              aria-label="Construct Project"
              onClick={() => { setTool('none'); setRoadMenu(false); setPlaceError(undefined); setForm({ ...EMPTY_FORM, color: randomBuildingColor() }); setShowForm(true) }}
              disabled={!!placing}
              className="h-14 w-14 rounded-full bg-amber-500 text-2xl shadow-lg hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >🏗️</button>
            <button
              title="Roads"
              aria-label="Roads"
              onClick={() => { setTool(roadMenu ? 'none' : 'road'); setRoadMenu(!roadMenu); setPlaceError(undefined) }}
              disabled={!!placing}
              className={`h-14 w-14 rounded-full text-2xl shadow-lg disabled:cursor-not-allowed disabled:opacity-50 ${roadMenu ? 'bg-sky-500 hover:bg-sky-400' : 'bg-slate-800/90 hover:bg-slate-700'}`}
            >🛣️</button>
          </div>
        </div>
        {placing && (
          <div className="absolute left-1/2 top-3 w-80 -translate-x-1/2 rounded-lg border border-amber-400 bg-slate-900/95 px-4 py-2 text-sm shadow-xl">
            <div className="font-semibold">Click to place “{placing.name}”</div>
            <div className="text-xs text-slate-400">
              The door’s road must connect to an existing road (the first building can go anywhere). R / right-click to rotate, Esc cancels.
            </div>
            {placeError && <div className="mt-1 text-xs text-red-400">{placeError}</div>}
            <div className="mt-2 flex gap-2">
              <button onClick={rotateDoor} className="rounded border border-slate-500 px-3 py-1 text-xs hover:bg-slate-700">Rotate door</button>
              <button onClick={() => void cancelPlacement()} className="rounded border border-slate-500 px-3 py-1 text-xs hover:bg-slate-700">Cancel</button>
            </div>
          </div>
        )}
        {tool !== 'none' && !placing && placeError && (
          <div className="absolute left-1/2 top-3 w-80 -translate-x-1/2 rounded-lg border border-amber-400 bg-slate-900/95 px-4 py-2 text-sm shadow-xl">
            <div className="text-xs text-red-400">{placeError}</div>
          </div>
        )}
        {tip && !placing && (
          <div ref={tipRef} className="pointer-events-none absolute w-56 rounded-lg border-2 border-amber-400 bg-slate-900/95 p-3 text-sm shadow-xl" style={{ left: tip.x, top: tip.y }}>
            <button aria-label="Move" title="Move" className="pointer-events-auto absolute right-2 top-2 h-7 w-7 rounded bg-slate-800 text-slate-300 hover:text-sky-300" onClick={() => void move(tip.b.p)}>✥</button>
            <button aria-label="Edit" title="Edit" className="pointer-events-auto absolute right-11 top-2 h-7 w-7 rounded bg-slate-800 text-slate-300 hover:text-amber-300" onClick={() => edit(tip.b.p)}>✎</button>
            <div className="pr-16 font-bold">{tip.b.p.name}</div>
            <div className="mb-1 text-xs text-slate-400">{tip.b.p.description}</div>
            <div>Hours saved: {timeSaved(tip.b.p).toFixed(1)}</div>
            <div>Hours spent with AI: {tip.b.p.time_spent_ai.toFixed(1)}</div>
            <div>Estimated hours without AI: {tip.b.p.time_estimated_no_ai.toFixed(1)}</div>
            <div>Savings ratio: {(timeSavingsRatio(tip.b.p) * 100).toFixed(0)}%</div>
            <div>Budget: ${tip.b.p.budget_spent.toLocaleString()}</div>
            {(() => {
              const el = nowTick - startRef.current
              const pct = progressOf(tip.b, el) * 100
              if (pct >= 100) return null
              return <div>Finished: {pct.toFixed(0)}% · {formatRemaining(tip.b, el)} left</div>
            })()}
          </div>
        )}
        {showForm && (
          <div className="absolute inset-0 flex items-start justify-center bg-slate-950/60 p-6 pt-12" onMouseDown={(e) => { if (e.target === e.currentTarget) closeForm() }}>
            <form onSubmit={add} className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-slate-600 bg-slate-800 p-5 shadow-2xl">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">{editingId ? 'Edit project' : 'Construct a project'}</h2>
                <div className="flex items-center gap-2">
                  <label className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded border border-slate-500 hover:border-amber-400" title="Building color" aria-label="Building color">
                    <span aria-hidden="true">🎨</span>
                    <span className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full border border-white" style={{ background: form.color }} />
                    <input type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
                  </label>
                  <button type="button" onClick={closeForm} className="text-xl text-slate-400 hover:text-white" aria-label="Close">✕</button>
                </div>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                Project name
                <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Description
                <textarea className={input} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Hours spent with AI
                <input className={input} type="number" min="0" step="any" value={form.ai} onChange={(e) => setForm({ ...form, ai: e.target.value })} required />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Estimated hours spent without AI
                <input className={input} type="number" min="0.1" step="any" value={form.est} onChange={(e) => setForm({ ...form, est: e.target.value })} required />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Budget used
                <span className="flex items-center rounded border border-slate-600 bg-slate-900 px-2 text-sm">
                  <span className="text-slate-400">$</span>
                  <input className="w-full bg-transparent px-1 py-1 outline-none" type="number" min="0" step="any" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
                </span>
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={closeForm} className="rounded border border-slate-500 px-4 py-2 text-sm hover:bg-slate-700">Cancel</button>
                <button className="rounded bg-amber-500 px-4 py-2 font-semibold text-slate-900 hover:bg-amber-400">{editingId ? 'Save Changes' : 'Construct Project'}</button>
              </div>
            </form>
          </div>
        )}
      </main>
    </div>
  )
}
