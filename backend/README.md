# Spotter Routes: backend

Django API for weather-aware truck routing. It finds 3 routes, samples weather at each checkpoint at the truck's ETA, scores risk with the assessment rules and recommends a route.

## Run

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
.venv/Scripts/python manage.py runserver 8000
.venv/Scripts/python manage.py test routing
```

Env vars: `TOMTOM_API_KEY` and optionally `TOMTOM_API_KEY_FALLBACK` (free keys from developer.tomtom.com; copy `.env.example` to `backend/.env`, which git ignores; the fallback takes over on 401/403/429). Without it the app falls back to keyless OSRM + Photon. Optional: `DJANGO_SECRET_KEY`, `DJANGO_DEBUG` (`0` in production), `DJANGO_ALLOWED_HOSTS` (comma list), `CORS_ALLOWED_ORIGINS` (comma list; all origins allowed when empty).

Deploy (Render/Railway/Heroku style): build `pip install -r requirements.txt`, start from `Procfile`. Keep **one** worker: analyses are cached in process memory.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/geocode?q=` | `Place[]` (`{label, lat, lng}`) |
| POST | `/api/routes/analyze` | `{origin, destination, departure_time, load_lbs, sample_interval_miles}` → `{analysis_id, routes[3], recommended_route_id, recommendation_reason}` |
| GET | `/api/analyses/{id}/heatmap?hour=0..48&layer=risk\|wind\|rain\|snow` | `{hour, layer, points[{lat, lng, intensity}]}` |
| GET | `/api/health` | `{ok: true}` |

Errors are always `{"error": {"code", "message"}}` with 400 (bad input), 404 (expired analysis), 422 (no truck route between the places) or 502 (upstream API failed).

## How it works

1. **Routes**: TomTom Calculate Route with `travelMode=truck`, `vehicleCommercial=true`, `vehicleWeight` (33,000 lb tare + the load, in kg), `departAt` (the chosen departure, so traffic is predicted for that time) and `maxAlternatives=2`: three routes in one call. If fewer come back, detours via points offset to each side of the straight line fill the gap (kept only if travel time differs by more than 2%).
2. **Truck timing**: `extendedRouteRepresentation=travelTime` returns travel time at points along each route; between them time is spread by distance, as TomTom recommends. Each checkpoint's ETA comes from that. (On the OSRM fallback, car durations are slowed so no stretch averages over 65 mph.)
3. **Checkpoints**: every 10/25/50 miles plus the destination, each with its own ETA.
4. **Weather**: Open-Meteo hourly forecast, worldwide, requested in batches of 50 points (free, no key). If a batch fails, each point falls back to the NWS gridded forecast (inside the US) or MET Norway (anywhere). Points in the same 0.25° cell share one lookup and are cached for 30 minutes. The value at each checkpoint is interpolated to the hour of its ETA.
5. **Risk** (`routing/risk.py`): the worst of the wind, rain and snow levels, after the load rules. The stretch between two checkpoints takes the worse of their levels, which gives miles per level. Score = level × 25.
6. **Recommendation**: routes with any no-travel checkpoint are excluded. The rest are ranked by severe miles, then high miles, then average score, then duration.
7. **Heatmap**: at analyze time, the intensity of every weather cell along the 3 routes is computed for hours 0–48 for each layer and cached for 1 hour. The heatmap endpoint just slices that cache, so scrubbing is cheap.

## Trade-offs

- Fallback sources report liquid precipitation only: NWS hours with snowfall and MET Norway hours at or below freezing count it as snow (MET at a 10:1 snow ratio).
- Sustained wind speed is used, not gusts, to match the spec's thresholds.
- Third-party services: TomTom Routing and Search (free tier, key), Open-Meteo (weather, keyless). Fallbacks: OSRM demo (routing) and Photon (geocoding) when there is no key or TomTom refuses; NWS and MET Norway for weather. Requests retry on timeouts and 5xx/429; error messages never include request URLs, so the key cannot leak to clients.
- Autocomplete results are cached for a day per query to stay inside TomTom's free Search quota.
- The analyze response includes `providers`, naming which services answered.
