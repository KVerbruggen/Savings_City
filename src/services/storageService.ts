export interface Project {
  id: string
  name: string
  description: string
  time_spent_ai: number
  time_estimated_no_ai: number
  budget_spent: number
  created_at: string
}

export type NewProject = Omit<Project, 'id' | 'created_at'>

export interface DataService {
  list(): Promise<Project[]>
  create(p: NewProject): Promise<Project>
  update(id: string, p: Partial<NewProject>): Promise<Project | undefined>
  remove(id: string): Promise<void>
}

const KEY = 'savings_city_projects'

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 3) | 8).toString(16)
      })

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()

/** Demo projects covering every footprint size and facade style. */
function seedProjects(): Project[] {
  return [
    { id: uuid(), name: 'Invoice Autopilot', description: 'Automated invoice parsing and reconciliation scripts.', time_spent_ai: 6, time_estimated_no_ai: 30, budget_spent: 120, created_at: daysAgo(4) },
    { id: uuid(), name: 'Crystal Dashboard', description: 'Analytics dashboard with live KPIs, built with AI pair programming.', time_spent_ai: 20, time_estimated_no_ai: 120, budget_spent: 6500, created_at: daysAgo(3) },
    { id: uuid(), name: 'Legacy Migration', description: 'Enterprise migration of a legacy reporting system.', time_spent_ai: 90, time_estimated_no_ai: 240, budget_spent: 2200, created_at: daysAgo(2) },
    { id: uuid(), name: 'Docs Refresh', description: 'Rewrite of the internal handbook.', time_spent_ai: 20, time_estimated_no_ai: 25, budget_spent: 40, created_at: daysAgo(1) },
  ]
}

function read(): Project[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw !== null) return JSON.parse(raw) as Project[]
  } catch {
    return []
  }
  const seeded = seedProjects()
  write(seeded)
  return seeded
}
function write(p: Project[]) {
  try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* storage unavailable */ }
}

/** Local Storage implementation (default). Seeds demo data when empty on first load. */
export const localDataService: DataService = {
  async list() {
    return read().sort((a, b) => a.created_at.localeCompare(b.created_at))
  },
  async create(p) {
    const project: Project = { ...p, id: uuid(), created_at: new Date().toISOString() }
    write([...read(), project])
    return project
  },
  async update(id, p) {
    const all = read()
    const i = all.findIndex((x) => x.id === id)
    if (i < 0) return undefined
    all[i] = { ...all[i], ...p }
    write(all)
    return all[i]
  },
  async remove(id) {
    write(read().filter((x) => x.id !== id))
  },
}

/** Supabase implementation using the PostgREST API (no extra dependency). */
function supabaseDataService(url: string, key: string): DataService {
  const base = `${url.replace(/\/$/, '')}/rest/v1/projects`
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' }
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, { ...init, headers })
    if (!res.ok) throw new Error(`Supabase error ${res.status}`)
    return res.status === 204 ? [] : res.json()
  }
  return {
    list: () => call('?select=*&order=created_at.asc'),
    create: async (p) => (await call('', { method: 'POST', body: JSON.stringify(p) }))[0],
    update: async (id, p) => (await call(`?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(p) }))[0],
    remove: async (id) => { await call(`?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }) },
  }
}

const env = import.meta.env
const useSupabase = env.VITE_USE_SUPABASE === 'true' && !!env.VITE_SUPABASE_URL && !!env.VITE_SUPABASE_ANON_KEY

export const dataService: DataService = useSupabase
  ? supabaseDataService(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
  : localDataService

// Virtual fields
export const timeSaved = (p: Project) => p.time_estimated_no_ai - p.time_spent_ai
export const timeSavingsRatio = (p: Project) =>
  p.time_estimated_no_ai > 0 ? timeSaved(p) / p.time_estimated_no_ai : 0
export const costEfficiency = (p: Project, rate: number) =>
  p.budget_spent > 0 ? (timeSaved(p) * rate) / p.budget_spent : 0
