# Savings City

Savings City visualizes the value of AI-assisted projects as a growing city.
Each submitted project becomes one building, and the building's appearance is
determined by the project's original inputs.

## What the board means

### Buildings

- **Building footprint / size** represents the estimated effort without AI:
  - Less than 40 estimated hours: small, 1×1 footprint
  - 40–160 estimated hours: medium, 2×2 footprint
  - More than 160 estimated hours: large, 3×3 footprint
- **Building height** represents time saved through AI. It is calculated as
  `estimated hours without AI - hours spent with AI`; more saved time produces a
  taller building.
- **Construction animation** represents the project being built. Projects that
  are loaded together start together, but each building takes a different
  amount of time to finish based on its estimated effort. A newly submitted
  project starts building when it is submitted.
- **Building color and facade style** represent the savings ratio:
  - More than 70% saved: glass building
  - Less than 30% saved: brick building
  - Otherwise: mixed/concrete building
- **Gold trim** indicates a project with more than $1,500 in budget used.
- **Helipad and neon detail** indicate a project with more than $5,000 in
  budget used. The budget also controls the brighter window lighting on these
  buildings.
- **Roof structures** are decorative style details: glass buildings have a
  crystal crown, brick buildings have a brick cornice, and mixed buildings have
  a concrete rooftop structure.

### Streets and vehicles

- Buildings sit on whole grid tiles. Each building has a **door** side; the
  road along that front side is built with it. When placing, press `R` or
  right-click (or use **Rotate door**) to turn the door, and `Esc` to cancel.
- The first building can go anywhere. Every later building's door road must
  connect to an existing road (T-junctions are fine), and buildings may not
  overlap.
- Roads are stored independently of buildings, so deleting a building keeps its
  roads.
- The **🛣️ Roads** menu has a **Road tool** and a **Delete tool**. Click or drag
  along a grid edge next to a building to add roads (they must touch an existing
  road); right-click or right-drag deletes, as does the Delete tool. Middle-drag
  pans while a tool is active.
- **Cars** drive along the roads. They follow lanes, have different
  speeds, and slow down behind other cars instead of driving through them.

### Controls and project information

- Drag the board to pan and use the mouse wheel or `+`/`−` buttons to zoom.
- The rotate buttons change the map's compass viewpoint in 90-degree steps,
  allowing buildings hidden from one direction to be viewed from another.
- Click a finished building to see its project name, description, hours spent
  with AI, estimated hours without AI, hours saved, savings ratio, and budget.
- Use the edit button beside a project to change its original inputs. The
  building keeps its construction start time; changing its estimated hours
  recalculates its current progress using the time already elapsed.

## Development

```bash
npm install
npm run dev
```

Run a production build with `npm run build` and lint with `npm run lint`.

Projects are stored in browser Local Storage by default. The storage adapter
is in `src/services/storageService.ts`. To use Supabase, create the tables below and set `VITE_USE_SUPABASE=true`, `VITE_SUPABASE_URL`, and
`VITE_SUPABASE_ANON_KEY`.

```sql
create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  time_spent_ai double precision not null,
  time_estimated_no_ai double precision not null,
  budget_spent double precision not null default 0,
  created_at timestamptz not null default now(),
  gx integer,
  gy integer,
  facing smallint
);
create table roads (key text primary key);
```

Enable row level security policies that allow the anon key to select/insert/update/delete on `projects` and select/insert/delete on `roads`.