import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Project, dataService, timeSaved, timeSavingsRatio,
} from './services/storageService'
import {
  type Camera, type Click, type Placed, type Preview, type Traffic, type V2, snapFree,
  centerOn, finalHeight, fitBuilding, footprint, layout, makeCars, pick,
  polyArea, render, screenToMap, snapGuided, snapPoint, styleOf, toIso, validatePlot, plotAreaCap, allowedStreets, streetPath, shallowJunction,
} from './engine'

const HOME: Camera = { x: 0, y: 0, zoom: 1, angle: 0 }

/** Street attachment rule: corner 1 must sit on an existing street; corner 2
 * is auto-snapped onto the line through corner 1 parallel to its street (or
 * along either street meeting at a corner vertex), so it is always satisfied
 * once corner 1 is on a street. */
function streetError(clicks: Click[], placed: Placed[]): string | undefined {
  if (!placed.length) return undefined
  // Corner 1 is always street-snapped (see the click handler), so this only
  // guards the corner-2 path where a street ref must have been carried over.
  if (!clicks[0]?.street) return 'The first corner must sit on an existing street'
  // Corner 2 must lie on the legal side of the street run, so the first edge
  // really follows part of an existing street instead of just touching a corner.
  if (clicks.length >= 2 && !snapGuided(clicks[0], clicks[1].pt, placed).ok) return 'The first edge must follow an existing street'
  return undefined
}

interface Placing {
  id: string
  name: string
  size: number
  height: number
  clicks: Click[]
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [form, setForm] = useState({ name: '', description: '', ai: '', est: '', budget: '' })
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [tip, setTip] = useState<{ b: Placed; x: number; y: number }>()
  const [placing, setPlacing] = useState<Placing>()
  const [placeError, setPlaceError] = useState<string>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const camRef = useRef<Camera>({ ...HOME })
  const startRef = useRef(0)
  const constructionStartsRef = useRef(new Map<string, number>())
  const [startsVersion, setStartsVersion] = useState(0)
  // Read once per committed render; startsVersion forces a recompute after
  // the map is mutated when a new building's construction starts.
  // layout() uses the previous placements to keep fitted positions stable.
  const placedRef = useRef<Placed[]>([])
  // oxlint-disable-next-line refs -- layout() only reads the map at call time; startsVersion re-triggers it after a mutation
  const placed = useMemo(() => layout(projects, constructionStartsRef.current, placedRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startsVersion intentionally invalidates this memo
    [projects, startsVersion])
  placedRef.current = placed
  const carsRef = useRef<Traffic[]>([])
  const cursorRef = useRef({ x: -9999, y: -9999 })
  const stateRef = useRef<{ placed: Placed[]; selected?: string; placing?: Placing }>({ placed: [] })

  // Set the construction clock once on mount. Guarded so the double-invoked
  // effects of StrictMode do not reset it, and so the sync effect below (which
  // runs every render) never touches it — that was resetting the clock on each
  // keystroke and restarting every building's construction.
  useEffect(() => {
    if (startRef.current === 0) startRef.current = performance.now()
  }, [])

  useEffect(() => {
    // Sync the mutable snapshot read by the render loop on every render.
    stateRef.current = { placed, selected, placing }
  })

  useEffect(() => {
    dataService.list().then((list) => {
      // Reconstruct construction progress across reloads from the creation
      // timestamp. `elapsed` counts ms since page load, so a project created
      // `age` ms before the page loaded gets a negative start offset — its
      // progress is then correct (already finished, or part-way through a
      // long build). Recorded once per project so re-renders never reset it.
      for (const p of list) {
        if (constructionStartsRef.current.has(p.id)) continue
        const createdAt = Date.parse(p.created_at)
        const age = Number.isFinite(createdAt) ? Date.now() - createdAt : 0
        constructionStartsRef.current.set(p.id, -Math.max(0, age))
      }
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
    const desired = makeCars(placed)
    carsRef.current = carsRef.current.length ? [...carsRef.current, ...desired.slice(carsRef.current.length)] : desired
  }, [placed])

  // Render loop
  useEffect(() => {
    const cv = canvasRef.current!
    let raf = 0
    const frame = (now: number) => {
      const dpr = window.devicePixelRatio || 1
      const w = cv.clientWidth, h = cv.clientHeight
      if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr }
      const ctx = cv.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cur = stateRef.current
      // Live plot-placement preview: the polygon is re-validated every frame so
      // the cursor-following corner always shows whether the shape is legal.
      let preview: Preview | undefined
      if (cur.placing) {
        const map = screenToMap(cursorRef.current.x, cursorRef.current.y, w, h, camRef.current)
        const n = cur.placing.clicks.length
        // Corners 1 & 2 are always pulled onto a street (so snaps are felt,
        // not just validated at the end); corners 3+ are free with a small
        // street snap. Corner 2 follows a street line away from the building.
        let hover: Click
        if (n === 0 && cur.placed.length > 0) {
          // First corner: force onto the nearest street.
          const s = snapPoint(map, cur.placed, Infinity)
          hover = s.street ? s : snapPoint(map, cur.placed)
        } else if (n === 1) {
          const prev = cur.placing.clicks[0]
          if (prev.street) hover = { pt: snapGuided(prev, map, cur.placed).pt, street: prev.street }
          else hover = snapPoint(map, cur.placed)
        } else {
          hover = snapFree(map, cur.placing.clicks.slice(0, Math.min(n, 3)), cur.placed)
        }
        const clicks = n >= 4 ? cur.placing.clicks : [...cur.placing.clicks, hover]
        // Plots are always 4-sided: the polygon is just the clicked points.
        const polygon = clicks.map((c) => c.pt)
        // The first edge follows the streets through any junctions; compute its
        // bends so the preview draws it bending instead of straight.
        const edge12 = cur.placing.clicks[0]?.street && clicks.length >= 2
          ? streetPath(cur.placing.clicks[0], clicks[1].pt, cur.placed)
          : undefined
        let ok = polygon.length >= 4
        if (ok && cur.placed.length > 0 && streetError(clicks, cur.placed)) ok = false
        const streetEdge: [V2, V2] | undefined = cur.placing.clicks[0]?.street && clicks.length >= 2
          ? [clicks[0].pt, clicks[1].pt]
          : undefined
        if (ok && validatePlot(polygon, cur.placing.size, cur.placed.map((b) => b.plot), streetEdge)) ok = false
        // Flag a would-be shallow junction as soon as a shape is forming, so
        // its angle and arc can be drawn at the offending corner.
        const junctionIssue = polygon.length >= 3
          ? shallowJunction(polygon, cur.placed.map((b) => b.plot), streetEdge)
          : undefined
        // Show the plot size relative to the cap as soon as there is an area.
        const areaPct = polygon.length >= 3 ? (polyArea(polygon) / plotAreaCap(cur.placing.size)) * 100 : undefined
        preview = {
          polygon, points: cur.placing.clicks.map((c) => c.pt), ok,
          size: cur.placing.size, height: cur.placing.height, cursor: hover.pt, hover: hover.pt, areaPct,
          streets: allowedStreets(cur.placing.clicks, cur.placed), edge12, junctionIssue,
        }
      }
      render(ctx, w, h, {
        placed: cur.placed, elapsed: now - startRef.current, time: now,
        cam: camRef.current, selected: cur.selected, cars: carsRef.current, preview,
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Pan / zoom / click
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const dragPoint = useRef<number | null>(null) // index of a placed corner being dragged
  const zoomBy = useCallback((f: number, dx = 0, dy = 0) => {
    // dx/dy: anchor offset from the view center; that point stays fixed on screen.
    const cam = camRef.current
    const zoom = Math.min(3, Math.max(0.3, cam.zoom * f))
    const k = zoom / cam.zoom
    camRef.current = { ...cam, zoom, x: dx - (dx - cam.x) * k, y: dy - (dy - cam.y) * k }
  }, [])
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

  const undoPoint = useCallback(() => {
    setPlaceError(undefined)
    setPlacing((pl) => pl && { ...pl, clicks: pl.clicks.slice(0, -1) })
  }, [])

  const cancelPlacement = useCallback(async () => {
    const pl = stateRef.current.placing
    if (!pl) return
    // The project was just created; cancelling placement removes it again.
    await dataService.remove(pl.id)
    setProjects(await dataService.list())
    setPlacing(undefined)
    setPlaceError(undefined)
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stateRef.current.placing) {
        if (stateRef.current.placing.clicks.length) undoPoint()
        else void cancelPlacement()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [undoPoint, cancelPlacement])

  const onClick = async (e: React.PointerEvent) => {
    const cv = canvasRef.current!
    const r = cv.getBoundingClientRect()
    const sx = e.clientX - r.left, sy = e.clientY - r.top
    if (placing) {
      const map = screenToMap(sx, sy, r.width, r.height, camRef.current)
      const n = placing.clicks.length
      let click: Click
      if (n === 0 && placed.length > 0) {
        const s = snapPoint(map, placed, Infinity)
        click = s.street ? s : snapPoint(map, placed)
      } else if (n === 1) {
        const prev = placing.clicks[0]
        if (prev.street) click = { pt: snapGuided(prev, map, placed).pt, street: prev.street }
        else click = snapPoint(map, placed)
      } else {
        click = snapFree(map, placing.clicks.slice(0, Math.min(n, 3)), placed)
      }
      // With 4 corners down, further clicks adjust the last corner.
      const clicks = placing.clicks.length >= 4 ? [...placing.clicks.slice(0, 3), click] : [...placing.clicks, click]
      if (clicks.length === 4) {
        const polygon = clicks.map((c) => c.pt)
        const streetEdge: [V2, V2] | undefined = placing.clicks[0]?.street
          ? [clicks[0].pt, clicks[1].pt]
          : undefined
        const error = (placed.length > 0 && streetError(clicks, placed)) || validatePlot(polygon, placing.size, placed.map((b) => b.plot), streetEdge)
        if (!error) {
          await dataService.update(placing.id, { plot: polygon })
          // Construction only starts once the plot is chosen.
          constructionStartsRef.current.set(placing.id, performance.now() - startRef.current)
          setStartsVersion((v) => v + 1)
          setProjects(await dataService.list())
          setPlacing(undefined)
          setPlaceError(undefined)
          return
        }
        setPlaceError(error)
      } else setPlaceError(undefined)
      setPlacing({ ...placing, clicks })
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
      time_spent_ai: ai, time_estimated_no_ai: est, budget_spent: Math.max(0, budget),
    }
    if (editingId) {
      // Keep the original construction start. The new duration is applied to
      // the elapsed time, so edits update the current building in place.
      const old = projects.find((p) => p.id === editingId)
      const updated = old && { ...old, ...values }
      const outgrown = !!updated?.plot && !!old?.plot && (() => {
        const size = footprint(updated)
        return polyArea(updated.plot!) > plotAreaCap(size) || !fitBuilding(updated.plot!, size)
      })()
      if (outgrown && updated) {
        // The building outgrew its plot: clear the plot and make the user re-place it.
        await dataService.update(editingId, { ...values, plot: null })
        setProjects(await dataService.list())
        setPlacing({ id: updated.id, name: updated.name, size: footprint(updated), height: finalHeight(updated), clicks: [] })
        setPlaceError('The building outgrew its plot. Place it again.')
      } else {
        await dataService.update(editingId, values)
        setProjects(await dataService.list())
      }
    } else {
      // plot: null marks the project as awaiting placement, so it stays
      // invisible until the user has picked its corners on the map.
      const created = await dataService.create({ ...values, plot: null })
      setProjects(await dataService.list())
      setPlacing({ id: created.id, name: created.name, size: footprint(created), height: finalHeight(created), clicks: [] })
      setPlaceError(undefined)
    }
    setForm({ name: '', description: '', ai: '', est: '', budget: '' })
    setEditingId(undefined)
    setShowForm(false)
  }

  const edit = (p: Project) => {
    setEditingId(p.id)
    setForm({
      name: p.name, description: p.description,
      ai: String(p.time_spent_ai), est: String(p.time_estimated_no_ai), budget: String(p.budget_spent),
    })
    setShowForm(true)
  }
  const closeForm = () => {
    setShowForm(false)
    setEditingId(undefined)
    setForm({ name: '', description: '', ai: '', est: '', budget: '' })
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
        <button onClick={() => setShowForm(true)} disabled={!!placing} className="rounded bg-amber-500 py-2 font-semibold text-slate-900 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50">Construct Project</button>

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
                <div className="font-medium">{p.name}{p.plot === null && <span className="ml-1 text-xs text-amber-400">(placing…)</span>}</div>
                <div className="text-xs text-slate-400">{timeSaved(p).toFixed(1)} h saved · {(timeSavingsRatio(p) * 100).toFixed(0)}%</div>
              </button>
              <button aria-label="Edit" className="px-1 text-slate-400 hover:text-amber-300" onClick={() => edit(p)}>✎</button>
              <button aria-label="Delete" className="px-1 text-slate-400 hover:text-red-400" onClick={async () => { await dataService.remove(p.id); setProjects(await dataService.list()); setTip(undefined) }}>✕</button>
            </div>
          ))}
          {projects.length === 0 && <p className="text-sm text-slate-500">No projects yet. Construct your first one!</p>}
        </section>
      </aside>

      <main className="relative min-w-0 flex-1">
        <canvas
          ref={canvasRef}
          className={`h-full w-full touch-none ${placing ? 'cursor-crosshair' : 'cursor-grab'}`}
          onPointerDown={(e) => {
            // Only the left button interacts; the right button is for undo.
            if (e.button !== 0) return
            const r = e.currentTarget.getBoundingClientRect()
            const pl = stateRef.current.placing
            if (pl) {
              // Grabbing (near) an existing corner moves it instead of panning.
              const map = screenToMap(e.clientX - r.left, e.clientY - r.top, r.width, r.height, camRef.current)
              const i = pl.clicks.findIndex((c) => Math.hypot(c.pt[0] - map[0], c.pt[1] - map[1]) < 0.35)
              if (i >= 0) {
                dragPoint.current = i
                ;(e.target as Element).setPointerCapture(e.pointerId)
                return
              }
            }
            drag.current = { x: e.clientX, y: e.clientY, moved: false }
            ;(e.target as Element).setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            cursorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top }
            // Dragging a placed corner snaps it like a fresh click would.
            if (dragPoint.current !== null && stateRef.current.placing) {
              const pl = stateRef.current.placing
              const map = screenToMap(cursorRef.current.x, cursorRef.current.y, r.width, r.height, camRef.current)
              const click = snapPoint(map, placed)
              const clicks = pl.clicks.map((c, i) => (i === dragPoint.current ? click : c))
              setPlacing({ ...pl, clicks })
              setPlaceError(undefined)
              return
            }
            const d = drag.current
            if (!d) return
            const dx = e.clientX - d.x, dy = e.clientY - d.y
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
            camRef.current = { ...camRef.current, x: camRef.current.x + dx, y: camRef.current.y + dy }
            d.x = e.clientX; d.y = e.clientY
          }}
          onPointerUp={(e) => {
            if (e.button !== 0) { drag.current = null; return }
            if (dragPoint.current !== null) { dragPoint.current = null; return }
            if (drag.current && !drag.current.moved) void onClick(e)
            drag.current = null
          }}
          onContextMenu={(e) => { e.preventDefault(); if (placing) undoPoint() }}
        />
        <div className="absolute right-3 top-3 flex flex-col gap-1">
          <button className="h-8 w-8 rounded bg-slate-800/90 text-lg" onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
          <button className="h-8 w-8 rounded bg-slate-800/90 text-lg" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
          <button className="h-8 w-8 rounded bg-slate-800/90" onClick={() => rotateBy(90)} aria-label="Rotate view left">↺</button>
          <button className="h-8 w-8 rounded bg-slate-800/90" onClick={() => rotateBy(-90)} aria-label="Rotate view right">↻</button>
          <button className="h-8 w-8 rounded bg-slate-800/90" onClick={() => (camRef.current = { ...HOME })} aria-label="Recenter">⌖</button>
        </div>
        {placing && (
          <div className="absolute left-1/2 top-3 w-80 -translate-x-1/2 rounded-lg border border-amber-400 bg-slate-900/95 px-4 py-2 text-sm shadow-xl">
            <div className="font-semibold">Place “{placing.name}” — click 4 corners ({placing.clicks.length}/4)</div>
            <div className="text-xs text-slate-400">
              {placed.length === 0
                ? 'The first building can be placed anywhere.'
                : 'The first corner must sit on an existing street (plot edges snap).'}{' '}
              Drag a corner to move it, right-click to undo, Esc to cancel.
            </div>
            {placeError && <div className="mt-1 text-xs text-red-400">{placeError}</div>}
            <div className="mt-2 flex gap-2">
              <button onClick={undoPoint} disabled={!placing.clicks.length} className="rounded border border-slate-500 px-3 py-1 text-xs hover:bg-slate-700 disabled:opacity-40">Undo point</button>
              <button onClick={() => void cancelPlacement()} className="rounded border border-slate-500 px-3 py-1 text-xs hover:bg-slate-700">Cancel</button>
            </div>
          </div>
        )}
        {tip && !placing && (
          <div className="pointer-events-none absolute w-56 rounded-lg border-2 border-amber-400 bg-slate-900/95 p-3 text-sm shadow-xl" style={{ left: Math.min(tip.x + 12, 9999), top: tip.y + 12 }}>
            <div className="font-bold">{tip.b.p.name}</div>
            <div className="mb-1 text-xs text-slate-400">{tip.b.p.description}</div>
            <div>Hours saved: {timeSaved(tip.b.p).toFixed(1)}</div>
            <div>Hours spent with AI: {tip.b.p.time_spent_ai.toFixed(1)}</div>
            <div>Estimated hours without AI: {tip.b.p.time_estimated_no_ai.toFixed(1)}</div>
            <div>Savings ratio: {(timeSavingsRatio(tip.b.p) * 100).toFixed(0)}% ({styleOf(tip.b.p)})</div>
            <div>Budget: ${tip.b.p.budget_spent.toLocaleString()}</div>
          </div>
        )}
        {showForm && (
          <div className="absolute inset-0 flex items-start justify-center bg-slate-950/60 p-6 pt-12" onMouseDown={(e) => { if (e.target === e.currentTarget) closeForm() }}>
            <form onSubmit={add} className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-slate-600 bg-slate-800 p-5 shadow-2xl">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">{editingId ? 'Edit project' : 'Construct a project'}</h2>
                <button type="button" onClick={closeForm} className="text-xl text-slate-400 hover:text-white" aria-label="Close">✕</button>
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
