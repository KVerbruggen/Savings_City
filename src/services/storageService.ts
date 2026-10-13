export interface Project {
  id: string
  name: string
  description: string
  time_spent_ai: number
  time_estimated_no_ai: number
  budget_spent: number
  created_at: string
  /**
   * Integer grid tile of the footprint's min corner.
   * null/undefined = created but waiting for the user to place it.
   */
  gx?: number | null
  gy?: number | null
  /** Door side: 0 = -y, 1 = +x, 2 = +y, 3 = -x. Defaults to 2. */
  facing?: 0 | 1 | 2 | 3
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

/** Current save format version. Bump whenever the saved data shape changes. */
export const SAVE_VERSION = 1
/** Oldest save version this build can still load. Saves older than this (or unversioned) are discarded. */
export const MIN_COMPATIBLE_SAVE_VERSION = 1

const VERSION_KEY = 'savings_city_save_version'
const ROADS_KEY = 'savings_city_roads'
let saveChecked = false

function ensureCompatibleSave() {
  if (saveChecked) return
  saveChecked = true
  try {
    const raw = localStorage.getItem(VERSION_KEY)
    const version = raw === null ? NaN : Number((JSON.parse(raw) as { version?: unknown }).version)
    if (Number.isFinite(version) && version >= MIN_COMPATIBLE_SAVE_VERSION) return
    localStorage.removeItem(KEY)
    localStorage.removeItem(ROADS_KEY)
    localStorage.setItem(VERSION_KEY, JSON.stringify({ version: SAVE_VERSION, minCompatible: MIN_COMPATIBLE_SAVE_VERSION }))
  } catch { /* storage unavailable or corrupt version: treat as incompatible */
    try { localStorage.removeItem(KEY); localStorage.removeItem(ROADS_KEY); localStorage.setItem(VERSION_KEY, JSON.stringify({ version: SAVE_VERSION, minCompatible: MIN_COMPATIBLE_SAVE_VERSION })) } catch { /* ignore */ }
  }
}

function read(): Project[] {
  ensureCompatibleSave()
  try {
    const raw = localStorage.getItem(KEY)
    if (raw !== null) return JSON.parse(raw) as Project[]
  } catch {
    return []
  }
  return []
}
function write(p: Project[]) {
  try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* storage unavailable */ }
}

/** Local Storage implementation (default). A new city starts empty and grows from submitted projects. */
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

/** Roads are unit grid edge keys ("x,y,h" / "x,y,v"). */
export interface RoadService {
  list(): Promise<string[]>
  add(keys: string[]): Promise<string[]>
  remove(keys: string[]): Promise<string[]>
}

const localRoadService: RoadService = {
  async list() {
    ensureCompatibleSave()
    try {
      const raw = localStorage.getItem(ROADS_KEY)
      if (raw !== null) return JSON.parse(raw) as string[]
    } catch { /* ignore */ }
    return []
  },
  async add(keys) {
    const all = [...new Set([...(await this.list()), ...keys])]
    try { localStorage.setItem(ROADS_KEY, JSON.stringify(all)) } catch { /* storage unavailable */ }
    return all
  },
  async remove(keys) {
    const gone = new Set(keys)
    const all = (await this.list()).filter((k) => !gone.has(k))
    try { localStorage.setItem(ROADS_KEY, JSON.stringify(all)) } catch { /* storage unavailable */ }
    return all
  },
}

/** Supabase `roads` table with a unique text `key` column; duplicates are ignored on insert. */
function supabaseRoadService(url: string, key: string): RoadService {
  const base = `${url.replace(/\/$/, '')}/rest/v1/roads`
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  const list = async (): Promise<string[]> => {
    const res = await fetch(`${base}?select=key`, { headers })
    if (!res.ok) throw new Error(`Supabase error ${res.status}`)
    return ((await res.json()) as { key: string }[]).map((r) => r.key)
  }
  return {
    list,
    async add(keys) {
      if (keys.length) {
        const res = await fetch(`${base}?on_conflict=key`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify([...new Set(keys)].map((k) => ({ key: k }))),
        })
        if (!res.ok) throw new Error(`Supabase error ${res.status}`)
      }
      return list()
    },
    async remove(keys) {
      if (keys.length) {
        const res = await fetch(`${base}?key=in.(${keys.map((k) => `"${k}"`).join(',')})`, { method: 'DELETE', headers })
        if (!res.ok) throw new Error(`Supabase error ${res.status}`)
      }
      return list()
    },
  }
}

export const roadService: RoadService = useSupabase
  ? supabaseRoadService(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
  : localRoadService
// Virtual fields
export const timeSaved = (p: Project) => p.time_estimated_no_ai - p.time_spent_ai
export const timeSavingsRatio = (p: Project) =>
  p.time_estimated_no_ai > 0 ? timeSaved(p) / p.time_estimated_no_ai : 0
export const costEfficiency = (p: Project, rate: number) =>
  p.budget_spent > 0 ? (timeSaved(p) * rate) / p.budget_spent : 0
