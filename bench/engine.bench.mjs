import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', configFile: false })
const e = await server.ssrLoadModule('/src/engine.ts')

const mkProject = (i, gx, gy) => ({
  id: 'p' + i, name: 'Project ' + i, description: '', time_spent_ai: 1 + (i % 7),
  time_estimated_no_ai: [20, 100, 200][i % 3] + i, budget_spent: (i % 3) * 3000, created_at: '', gx, gy, facing: i % 4,
})
const projects = [], roads = new Set()
const N = 150, cols = 15
for (let i = 0; i < N; i++) projects.push(mkProject(i, (i % cols) * 5, Math.floor(i / cols) * 5))
for (let x = -1; x <= cols * 5; x++) for (let y = -1; y <= 55; y += 5) roads.add(e.edgeKey(x, y, 'h'))
for (let y = -1; y <= 55; y++) for (let x = -1; x <= cols * 5; x += 5) roads.add(e.edgeKey(x, y, 'v'))
const placed = e.layout(projects)

const noop = () => {}
const ctx = new Proxy({}, { get: (t, k) => k === 'createLinearGradient' ? () => ({ addColorStop: noop }) : k === 'measureText' ? () => ({ width: 10 }) : (t[k] ?? noop), set: (t, k, v) => (t[k] = v, true) })
globalThis.Path2D = class { moveTo() {} lineTo() {} }

const bench = (name, n, fn) => {
  for (let i = 0; i < Math.min(3, n); i++) fn()
  const t = performance.now()
  for (let i = 0; i < n; i++) fn()
  console.log(name.padEnd(28), ((performance.now() - t) / n).toFixed(3), 'ms/op')
}
const cars = e.makeCars(placed, roads)
const cam = { x: 0, y: 0, zoom: 0.6, angle: 0.3 }
let time = 0
const state = (preview) => ({ placed, roads, elapsed: 1e12, time: (time += 16), cam, cars, preview })
bench('render', 100, () => e.render(ctx, 1600, 900, state()))
bench('render road-add preview', 10, () => e.render(ctx, 1600, 900, state({ kind: 'road', mode: 'add', edges: [e.edgeKey(3, 3, 'h')] })))
bench('roadsToPrune', 20, () => e.roadsToPrune(placed, roads))
bench('roadsToAdd', 20, () => e.roadsToAdd(e.edgeRun(e.edgeKey(0, -1, 'h'), [30, 0]), placed, roads))
bench('placementError', 200, () => e.placementError(200, 200, 2, 2, placed, roads))
bench('pick', 500, () => e.pick(placed, 1e12, 800, 450, 1600, 900, cam))
const mk = (el) => ({ placed, roads, elapsed: el, time: (time += 16), cam, cars, preview: undefined })
bench('render all constructing', 50, () => e.render(ctx, 1600, 900, mk(1000)))
const noCars = []
bench('render no cars', 50, () => e.render(ctx, 1600, 900, { ...mk(1e12), cars: noCars }))
bench('render only cars(30)+constr', 50, () => e.render(ctx, 1600, 900, { ...mk(1000), placed: [] }))
bench('ground+roads only', 50, () => e.render(ctx, 1600, 900, { ...mk(1000), placed: [], cars: [] }))
bench('buildings only finished', 50, () => e.render(ctx, 1600, 900, { ...mk(1e12), roads: new Set(), cars: [] }))
bench('buildings only constructing', 50, () => e.render(ctx, 1600, 900, { ...mk(1000), roads: new Set(), cars: [] }))
await server.close()


