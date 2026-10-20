# Spotter Routes: weather-aware truck routing

A React + Django app that helps a truck driver pick the safest of three routes based on **weather, load weight and travel time**. Built for the Spotter full-stack assessment.

- **Frontend:** `frontend/`. Vite, React 19, TypeScript, MapLibre GL, TanStack Query, Framer Motion.
- **Backend:** `backend/`. Django, plain JSON views, no database and no server state (serverless-friendly).

## What it does

1. **Input:** origin and destination (autocomplete), departure date/time (next 48 h) and load weight (lb).
2. **Three routes** come from TomTom's truck routing, using the truck's weight, the departure time and traffic.
3. **Checkpoints** every 10, 25 or 50 miles (user's choice). Each one carries the truck's **ETA**, taken from TomTom's travel time along the route.
4. **Weather at that ETA** comes from Open-Meteo's hourly forecast at each checkpoint, worldwide: wind mph, rain in/hr, snow in/hr.
5. **Risk** follows the spec's thresholds; the worst condition wins, and the load rules apply on top.
6. **Recommendation:** routes with a no-travel checkpoint are excluded. The rest are ranked by fewest severe miles, then fewest high miles, then lowest average risk, then shortest time. The reason is shown in plain words.
7. **Map:** all three routes are colored by risk. Route chips show the summary. Checkpoints show ETA, weather and risk on click. A **weather heatmap along the corridor** has a **0–48 h forecast slider** (Risk, Wind, Rain and Snow layers, with play and keyboard scrubbing).

## Third-party APIs

| Need | Service | Notes |
|---|---|---|
| Routing | TomTom Routing API | `travelMode=truck`, `vehicleWeight`, `departAt`, `maxAlternatives=2`, `extendedRouteRepresentation=travelTime`. Free tier, key required. |
| Geocoding | TomTom Search API | typeahead, worldwide; cached per query for a day |
| Weather | Open-Meteo | free, keyless, global hourly forecast; ~100 points per trip in a few batched requests |
| Weather fallback | NWS (US) / MET Norway (elsewhere) | used point by point if Open-Meteo fails |
| Basemap | CARTO Positron / OpenStreetMap | free vector tiles, attribution shown |

Two TomTom keys can be configured: the second takes over automatically if the first is rejected or runs out of quota. Without any key the backend falls back to keyless OSRM (routing) and Photon (geocoding), so the app still runs.

## Run locally

Backend (Python 3.12):

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # macOS/Linux: .venv/bin/pip
cp .env.example .env                              # add TomTom key(s); optional, see above
.venv/Scripts/python manage.py runserver 8000
.venv/Scripts/python manage.py test routing       # risk rules, recommendation, parsers
```

Frontend (Node 20+):

```bash
cd frontend
npm install
cp .env.example .env.local    # VITE_API_URL=http://localhost:8000; omit to use the built-in mock API
npm run dev                   # http://localhost:5173
```

The frontend has a full mock of the API (Dallas → Atlanta with a scripted storm). It runs without the backend whenever `VITE_API_URL` is unset.

## Where things live

- `backend/routing/risk.py`: thresholds, load rules, miles-per-level summary and recommendation. Pure functions with unit tests.
- `backend/routing/analysis.py`: the pipeline (routes → checkpoints with ETAs → weather → risk → heatmap frames).
- `backend/routing/clients.py`: TomTom, Open-Meteo, NWS, MET Norway and fallback clients, with retries. Error messages never include request URLs (no key leaks).
- `frontend/src/pages/Planner.tsx`: the planner UI. `components/RouteMap.tsx` is the map.
- `frontend/src/pages/Landing.tsx`: landing page with a scroll-driven trip story over real route geometry.
- `backend/README.md`: API reference, design notes and trade-offs.

## Trade-offs

- Points in the same 0.25° cell (about a global weather-model grid cell) share one forecast lookup, so a long trip uses about 100 of Open-Meteo's 10,000 free daily locations. Each checkpoint still reads the hour of its own ETA. A typical cold analysis takes 2–7 s.
- Open-Meteo's free tier is for non-commercial use; production would use its paid endpoint (same API).
- `vehicleWeight` assumes a 33,000 lb empty tractor-trailer plus the entered load.
- Sustained wind (not gusts) is compared against the spec's wind bands.
- The API keeps no state between requests: the analysis id encodes what the heatmap needs, and forecasts are only cached per instance. It deploys as serverless functions (both apps are on Vercel; see `vercel.json` in each folder).
