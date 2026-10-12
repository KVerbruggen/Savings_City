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

function read(): Project[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Project[]) : []
  } catch {
    return []
  }
}
const write = (p: Project[]) => localStorage.setItem(KEY, JSON.stringify(p))

/** Local Storage implementation. Swap for a Supabase-backed DataService to go private. */
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

export const dataService: DataService = localDataService

// Virtual fields
export const timeSaved = (p: Project) => p.time_estimated_no_ai - p.time_spent_ai
export const timeSavingsRatio = (p: Project) =>
  p.time_estimated_no_ai > 0 ? timeSaved(p) / p.time_estimated_no_ai : 0
export const costEfficiency = (p: Project, rate: number) =>
  p.budget_spent > 0 ? (timeSaved(p) * rate) / p.budget_spent : 0
