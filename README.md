# Savings_City
Display AI-based savings by rendering a city based on the savings

## Development

`npm install && npm run dev`. Data is stored in Local Storage via `src/data_service.ts` (swap `dataService` for a Supabase implementation of `DataService` for private mode).

### Storage & deployment

Projects live in Local Storage and 4 demo projects are seeded on first load. To use Supabase, create a `projects` table and set `VITE_USE_SUPABASE=true`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Pushes to `main` deploy `dist` to the `gh-pages` branch (enable Pages from that branch in repo settings).
