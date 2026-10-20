# Spotter Routes: frontend

React 19 + TypeScript + Vite. MapLibre GL renders the maps, TanStack Query handles API data, Zustand holds the planner's UI state, and Framer Motion plus Lenis drive the landing page motion.

## Run

```bash
npm install
cp .env.example .env.local    # points at the Django API on localhost:8000
npm run dev                   # http://localhost:5173
npm run build                 # typecheck + production build into dist/
```

## Environment

- `VITE_API_URL`: base URL of the Django API, e.g. `http://localhost:8000`.
- `VITE_USE_MOCK=true`: use the built-in mock API (`src/api/mock.ts`) even when `VITE_API_URL` is set. The mock is also used whenever `VITE_API_URL` is empty, so the UI runs without the backend.

## Layout

- `src/pages/Planner.tsx`: trip form, route results, checkpoint list and the 0–48 h forecast timeline.
- `src/components/RouteMap.tsx`: routes colored by risk, checkpoints, weather heatmap, fit-to-bounds.
- `src/pages/Landing.tsx`, `components/HeroScene.tsx`, `components/JourneySection.tsx`, `components/StoryMap.tsx`: the landing page. A scroll-driven trip story over real Dallas → Atlanta road geometry (`src/data/journey.json`).
- `src/api/`: typed client, contract types and the mock.
- `src/lib/risk.ts`: the same risk thresholds and recommendation order as the backend (used by the mock and the landing story).
- `src/lib/maplibreWorker.ts`: bundles MapLibre's web worker so production builds load it.
