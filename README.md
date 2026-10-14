# Savings City

Savings City visualizes the value of AI-assisted projects as a growing city.
Each submitted project becomes one building, and the building's appearance is
determined by the project's original inputs.

## What the board means

### Buildings

- **Building footprint** (number of grid cells) depends only on the estimated
  effort without AI. Footprints, smallest to largest: 1×1, 1×2, 1×2+1×1
  (L-shape), 2×2, 2×3, 2×4, 3×3, 2×5, 2×4+2×2 (L-shape), 3×4, 3×5, 4×4, 4×5, 5×5.
- **Building height** (number of floors) depends on the percentage of time
  saved, `(estimated hours without AI - hours spent with AI) / estimated hours`.
  Every footprint has at least 1 floor; the maximum depends on its narrowest
  width: 1 = 3 floors, 2 = 10, 3 = 15, 4 = 30, 5 = 50.
- **Construction animation** represents the project being built. Projects that
  are loaded together start together, but each building takes a different
  amount of time to finish based on its estimated effort. A newly submitted
  project starts building when it is submitted.
- **Building style:** all buildings use the glass style.
- **Gold trim** indicates a project with more than $1,500 in budget used.
- **Helipad and neon detail** indicate a project with more than $5,000 in
  budget used. The budget also controls the brighter window lighting on these
  buildings.
- **Roof block:** buildings at least 3×3 have a crystal roof block in the back-right
  corner (as seen from the door).

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