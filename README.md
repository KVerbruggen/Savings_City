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

- The green **blocks** are available city plots, separated by gray roads.
- The city expands its block area as more projects are added.
- **Cars** use roads next to occupied blocks. They follow lanes, have different
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
is in `src/services/storageService.ts`. To use Supabase, create a `projects`
table and set `VITE_USE_SUPABASE=true`, `VITE_SUPABASE_URL`, and
`VITE_SUPABASE_ANON_KEY`.
