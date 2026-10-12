import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Project, dataService, timeSaved, timeSavingsRatio, costEfficiency,
} from './services/storageService'
import {
  type Camera, type Placed, type Traffic, centerOn, layout, makeCars, pick, progressOf, render, styleOf,
} from './engine'

const HOME: Camera = { x: 0, y: 0, zoom: 1 }

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [rate, setRate] = useState(75)
  const [form, setForm] = useState({ name: '', description: '', ai: '', est: '', budget: '' })
  const [selected, setSelected] = useState<string>()
  const [tip, setTip] = useState<{ b: Placed; x: number; y: number }>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const camRef = useRef<Camera>({ ...HOME })
  const startRef = useRef(performance.now())
  const placed = useMemo(() => layout(projects), [projects])
  const carsRef = useRef<Traffic[]>([])
  const stateRef = useRef({ placed, selected })
  stateRef.current = { placed, selected }

  useEffect(() => { dataService.list().then(setProjects) }, [])
  useEffect(() => { carsRef.current = makeCars(projects.length) }, [projects.length])

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
      render(ctx, w, h, {
        placed: stateRef.current.placed, elapsed: now - startRef.current, time: now,
        cam: camRef.current, selected: stateRef.current.selected, cars: carsRef.current,
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Pan / zoom / click
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const zoomBy = useCallback((f: number) => {
    camRef.current = { ...camRef.current, zoom: Math.min(3, Math.max(0.3, camRef.current.zoom * f)) }
  }, [])
  useEffect(() => {
    const cv = canvasRef.current!
    const wheel = (e: WheelEvent) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 0.9) }
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => cv.removeEventListener('wheel', wheel)
  }, [zoomBy])

  const onClick = (e: React.PointerEvent) => {
    const cv = canvasRef.current!
    const r = cv.getBoundingClientRect()
    const b = pick(placed, performance.now() - startRef.current, e.clientX - r.left, e.clientY - r.top, r.width, r.height, camRef.current)
    setTip(b ? { b, x: e.clientX - r.left, y: e.clientY - r.top } : undefined)
    setSelected(b?.p.id)
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const ai = parseFloat(form.ai), est = parseFloat(form.est), budget = parseFloat(form.budget) || 0
    if (!form.name.trim() || !(ai >= 0) || !(est > 0)) return
    const p = await dataService.create({
      name: form.name.trim(), description: form.description.trim(),
      time_spent_ai: ai, time_estimated_no_ai: est, budget_spent: Math.max(0, budget),
    })
    // new building starts constructing now; older ones stay complete
    const list = await dataService.list()
    const lp = layout(list).find((x) => x.p.id === p.id)!
    startRef.current = performance.now() - lp.start
    setProjects(list)
    setForm({ name: '', description: '', ai: '', est: '', budget: '' })
  }

  const replay = () => { startRef.current = performance.now(); setTip(undefined) }
  const focus = (id: string) => {
    const b = placed.find((x) => x.p.id === id)
    if (!b) return
    camRef.current = centerOn(b)
    setSelected(id)
    if (progressOf(b, performance.now() - startRef.current) >= 1) setTip(undefined)
  }

  const totalSaved = projects.reduce((s, p) => s + Math.max(0, timeSaved(p)), 0)
  const input = 'w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm'

  return (
    <div className="flex h-full bg-slate-900 text-slate-100">
      <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-r border-slate-700 p-4">
        <h1 className="text-2xl font-bold">🏙️ Savings City</h1>
        <form onSubmit={add} className="flex flex-col gap-2">
          <input className={input} placeholder="Project name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <textarea className={input} placeholder="Description" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div className="grid grid-cols-3 gap-2">
            <input className={input} type="number" min="0" step="any" placeholder="Hours (AI)" value={form.ai} onChange={(e) => setForm({ ...form, ai: e.target.value })} required />
            <input className={input} type="number" min="0.1" step="any" placeholder="Est. manual" value={form.est} onChange={(e) => setForm({ ...form, est: e.target.value })} required />
            <input className={input} type="number" min="0" step="any" placeholder="Budget $" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          </div>
          <button className="rounded bg-amber-500 py-2 font-semibold text-slate-900 hover:bg-amber-400">Construct Project</button>
        </form>

        <section className="rounded bg-slate-800 p-3">
          <div className="text-xs uppercase text-slate-400">Total time saved</div>
          <div className="text-4xl font-bold text-emerald-400">{totalSaved.toFixed(1)} h</div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            Hourly rate $<input className="w-20 rounded border border-slate-600 bg-slate-900 px-1 text-slate-100" type="number" min="0" value={rate} onChange={(e) => setRate(parseFloat(e.target.value) || 0)} />
          </div>
          <div className="mt-2 text-xs uppercase text-slate-400">Estimated financial gain</div>
          <div className="text-2xl font-semibold">${(totalSaved * rate - projects.reduce((s, p) => s + p.budget_spent, 0)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
          <div className="mt-2 text-xs uppercase text-slate-400">Projects completed</div>
          <div className="text-2xl font-semibold">{projects.length}</div>
          <button onClick={replay} className="mt-3 w-full rounded border border-slate-500 py-1 text-sm hover:bg-slate-700">▶ Replay City Growth</button>
        </section>

        <section className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold uppercase text-slate-400">Projects</h2>
          {[...projects].reverse().map((p) => (
            <div key={p.id} className={`flex items-center justify-between rounded px-2 py-1 text-sm ${selected === p.id ? 'bg-slate-600' : 'bg-slate-800 hover:bg-slate-700'}`}>
              <button className="flex-1 text-left" onClick={() => focus(p.id)}>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-slate-400">{timeSaved(p).toFixed(1)} h saved · {(timeSavingsRatio(p) * 100).toFixed(0)}%</div>
              </button>
              <button aria-label="Delete" className="px-1 text-slate-400 hover:text-red-400" onClick={async () => { await dataService.remove(p.id); setProjects(await dataService.list()); setTip(undefined) }}>✕</button>
            </div>
          ))}
          {projects.length === 0 && <p className="text-sm text-slate-500">No projects yet. Construct your first one!</p>}
        </section>
      </aside>

      <main className="relative min-w-0 flex-1">
        <canvas
          ref={canvasRef}
          className="h-full w-full cursor-grab touch-none"
          onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; (e.target as Element).setPointerCapture(e.pointerId) }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            const dx = e.clientX - d.x, dy = e.clientY - d.y
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
            camRef.current = { ...camRef.current, x: camRef.current.x + dx, y: camRef.current.y + dy }
            d.x = e.clientX; d.y = e.clientY
          }}
          onPointerUp={(e) => { if (drag.current && !drag.current.moved) onClick(e); drag.current = null }}
        />
        <div className="absolute right-3 top-3 flex flex-col gap-1">
          <button className="h-8 w-8 rounded bg-slate-800/90 text-lg" onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
          <button className="h-8 w-8 rounded bg-slate-800/90 text-lg" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
          <button className="h-8 w-8 rounded bg-slate-800/90" onClick={() => (camRef.current = { ...HOME })} aria-label="Recenter">⌖</button>
        </div>
        {tip && (
          <div className="pointer-events-none absolute w-56 rounded-lg border-2 border-amber-400 bg-slate-900/95 p-3 text-sm shadow-xl" style={{ left: Math.min(tip.x + 12, 9999), top: tip.y + 12 }}>
            <div className="font-bold">{tip.b.p.name}</div>
            <div className="mb-1 text-xs text-slate-400">{tip.b.p.description}</div>
            <div>Hours saved: {timeSaved(tip.b.p).toFixed(1)}</div>
            <div>Savings ratio: {(timeSavingsRatio(tip.b.p) * 100).toFixed(0)}% ({styleOf(tip.b.p)})</div>
            <div>Budget: ${tip.b.p.budget_spent.toLocaleString()}</div>
            <div>ROI: {costEfficiency(tip.b.p, rate).toFixed(2)}×</div>
          </div>
        )}
      </main>
    </div>
  )
}
