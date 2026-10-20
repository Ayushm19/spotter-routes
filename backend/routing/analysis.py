"""Route analysis: 3 routes -> checkpoints at the truck's ETA -> weather -> risk -> recommendation."""

import base64
import math
import struct
import zlib
from datetime import datetime, timedelta, timezone

from . import clients, geo, risk

ROUTE_COUNT = 3
TRUCK_MAX_MPH = 65  # guards the OSRM fallback, whose car profile is faster than a loaded truck
DETOUR_OFFSETS = (0.15, -0.15, 0.3, -0.3)  # fraction of the straight-line distance
HEATMAP_HOURS = 48
# ponytail: points in the same 0.25° cell (~17 mi, about a global weather model grid cell) share
# one forecast lookup, so a long trip stays near 100 Open-Meteo locations of its 10k/day free quota.
WEATHER_GRID_DEG = 0.25
ANALYSIS_TTL_SECONDS = 3 * 60 * 60  # heatmaps for older analyses read as expired
ID_VERSION = 1
MAX_ID_BYTES = 9 + 4 * 2000  # header + up to 2000 cells
LAYERS = ("risk", "wind", "rain", "snow")


def _find_routes(origin, destination, load_lbs, departure):
    """Router alternatives, topped up to 3 with detours via points off the straight line.

    Where the road network has fewer distinct options (one highway through a region), fewer
    than 3 routes come back; that is the honest answer.
    """
    opts = {"load_lbs": load_lbs, "depart_at": departure}
    found = clients.route([origin, destination], alternatives=True, **opts)[:ROUTE_COUNT]
    if len(found) < ROUTE_COUNT:
        mid_lng, mid_lat = (origin[0] + destination[0]) / 2, (origin[1] + destination[1]) / 2
        kx = math.cos(math.radians(mid_lat))  # degrees of lng shrink with latitude
        dx, dy = (destination[0] - origin[0]) * kx, destination[1] - origin[1]
        for offset in DETOUR_OFFSETS:
            via = (mid_lng - dy * offset / kx, mid_lat + dx * offset)
            try:
                candidate = clients.route([origin, via, destination], **opts)[0]
            except clients.UpstreamError:
                continue  # via point off any road (e.g. Alaskan wilderness): try the next detour
            length = candidate["seconds"][-1]
            # ponytail: distinct = >2% different travel time; a geometry-overlap check would be stricter
            if all(abs(length - r["seconds"][-1]) / r["seconds"][-1] > 0.02 for r in found):
                found.append(candidate)
            if len(found) == ROUTE_COUNT:
                break
    return found


def _truck_seconds(cum, seconds):
    """Re-time each step so the truck never averages more than TRUCK_MAX_MPH."""
    out = [0.0]
    for i in range(1, len(cum)):
        step = max(seconds[i] - seconds[i - 1], (cum[i] - cum[i - 1]) / TRUCK_MAX_MPH * 3600)
        out.append(out[-1] + step)
    return out


def _grid_key(lat, lng):
    return round(lat / WEATHER_GRID_DEG), round(lng / WEATHER_GRID_DEG)


def _weather_at(series, epoch):
    """Linear interpolation between hourly forecast values; clamped to the forecast range."""
    pos = min(max((epoch - series["start"]) / 3600, 0), len(series["wind"]) - 1)
    i = min(int(pos), len(series["wind"]) - 2)
    t = pos - i

    def lerp(values):
        a, b = values[i] or 0.0, values[i + 1] or 0.0
        return a + (b - a) * t

    return lerp(series["wind"]), lerp(series["rain"]), lerp(series["snow"])


def _summary(wind, rain, snow):
    parts = [f"Wind {wind:.0f} mph"]
    for amount, name, heavy, moderate in ((rain, "rain", 0.5, 0.1), (snow, "snow", 2.0, 0.5)):
        if amount >= heavy:
            parts.append(f"heavy {name}")
        elif amount >= moderate:
            parts.append(f"moderate {name}")
        elif amount >= 0.01:
            parts.append(f"light {name}")
    return " · ".join(parts) if len(parts) > 1 else f"Dry · wind {wind:.0f} mph"


def _intensity(layer, wind, rain, snow, load_lbs):
    if layer == "wind":
        return min(wind / 55, 1.0)
    if layer == "rain":
        return min(rain / 1.0, 1.0)
    if layer == "snow":
        return min(snow / 3.0, 1.0)
    return risk.assess(wind, rain, snow, load_lbs)[0] / risk.NO_TRAVEL


def analyze(origin, destination, departure, load_lbs, interval_mi):
    now = datetime.now(timezone.utc)
    raw_routes = _find_routes((origin["lng"], origin["lat"]), (destination["lng"], destination["lat"]), load_lbs, departure)

    # 1. Geometry, truck timing and checkpoint positions/ETAs per route.
    prepared = []
    for raw in raw_routes:
        coords = raw["coords"]
        cum = geo.cumulative_miles(coords)
        seconds = _truck_seconds(cum, raw["seconds"])
        miles = geo.sample_miles(cum[-1], interval_mi)
        cps = []
        for m in miles:
            lng, lat, _ = geo.point_at(coords, cum, m)
            cps.append({"mile": m, "lat": lat, "lng": lng, "eta": departure + timedelta(seconds=geo.value_at(cum, seconds, m))})
        prepared.append({"coords": coords, "cum": cum, "seconds": seconds, "checkpoints": cps})

    # 2. One forecast per grid cell the routes pass through. Checkpoints read their cell at
    #    their own ETA; the heatmap draws every cell, which traces the trip corridor.
    cells = {_grid_key(cp["lat"], cp["lng"]) for p in prepared for cp in p["checkpoints"]}
    for p in prepared:
        for m in geo.sample_miles(p["cum"][-1], 10):
            lng, lat, _ = geo.point_at(p["coords"], p["cum"], m)
            cells.add(_grid_key(lat, lng))
    keys = sorted(cells)
    grid = [(round(k[0] * WEATHER_GRID_DEG, 3), round(k[1] * WEATHER_GRID_DEG, 3)) for k in keys]
    series = dict(zip(keys, clients.forecast(grid)))

    # 3. Risk per checkpoint, segments and route summaries.
    routes = []
    for p in sorted(prepared, key=lambda p: p["seconds"][-1]):
        checkpoints, levels = [], []
        for cp in p["checkpoints"]:
            wind, rain, snow = _weather_at(series[_grid_key(cp["lat"], cp["lng"])], cp["eta"].timestamp())
            level, factor, reason = risk.assess(wind, rain, snow, load_lbs)
            levels.append(level)
            checkpoints.append({
                "mile": round(cp["mile"], 1),
                "lat": round(cp["lat"], 5),
                "lng": round(cp["lng"], 5),
                "eta": cp["eta"].isoformat(),
                "forecast_hour": round((cp["eta"] - now).total_seconds() / 3600, 1),
                "weather": {"wind_mph": round(wind, 1), "rain_in_hr": round(rain, 3), "snow_in_hr": round(snow, 2), "summary": _summary(wind, rain, snow)},
                "risk_level": risk.LEVELS[level],
                "risk_score": risk.score(level),
                "driving_factor": factor,
                "reason": reason,
            })

        segments = []
        miles = [cp["mile"] for cp in p["checkpoints"]]
        for i in range(len(miles) - 1):
            lvl = risk.LEVELS[max(levels[i], levels[i + 1])]
            line = geo.slice_line(p["coords"], p["cum"], miles[i], miles[i + 1])
            if segments and segments[-1]["risk_level"] == lvl:
                segments[-1]["coordinates"].extend(line[1:])
            else:
                segments.append({"risk_level": lvl, "coordinates": line})
        for s in segments:
            s["coordinates"] = [[round(x, 5), round(y, 5)] for x, y in geo.thin(s["coordinates"])]

        letter = "ABC"[len(routes)]
        total_mi = p["cum"][-1]
        routes.append({
            "id": letter.lower(),
            "label": f"Route {letter}",
            "distance_mi": round(total_mi, 1),
            "duration_min": round(p["seconds"][-1] / 60),
            "eta": (departure + timedelta(seconds=p["seconds"][-1])).isoformat(),
            "geometry": [[round(x, 5), round(y, 5)] for x, y in geo.thin(p["coords"])],
            "segments": segments,
            "risk": risk.summarize(miles, levels, total_mi),
            "checkpoints": checkpoints,
            "blocked": risk.NO_TRAVEL in levels,
        })

    best, reason = risk.recommend(routes)

    # 4. The heatmap endpoint recomputes frames on demand from this id, so no server state is
    #    needed between requests (serverless instances don't share memory).
    hour0 = now.replace(minute=0, second=0, microsecond=0).timestamp()
    analysis_id = encode_analysis_id(hour0, load_lbs, keys)

    return {
        "analysis_id": analysis_id,
        "routes": routes,
        "recommended_route_id": best["id"] if best else None,
        "recommendation_reason": reason,
        "providers": clients.providers(),
    }


def encode_analysis_id(hour0, load_lbs, cells):
    """Pack what the heatmap needs (base hour, load, weather cells) into a URL-safe token."""
    raw = struct.pack(f">BII{2 * len(cells)}h", ID_VERSION, int(hour0), int(load_lbs), *(v for cell in cells for v in cell))
    return base64.urlsafe_b64encode(zlib.compress(raw, 9)).rstrip(b"=").decode()


def decode_analysis_id(analysis_id):
    """Inverse of encode_analysis_id; None for anything malformed (the id comes from clients)."""
    try:
        data = base64.urlsafe_b64decode(analysis_id + "=" * (-len(analysis_id) % 4))
        raw = zlib.decompressobj().decompress(data, MAX_ID_BYTES)  # bounded: no zip bombs
        version, hour0, load_lbs = struct.unpack(">BII", raw[:9])
        values = struct.unpack(f">{(len(raw) - 9) // 2}h", raw[9:])
    except (ValueError, struct.error, zlib.error):
        return None
    if version != ID_VERSION or not values or len(values) % 2:
        return None
    return hour0, load_lbs, list(zip(values[::2], values[1::2]))


def heatmap(analysis_id, hour, layer):
    decoded = decode_analysis_id(analysis_id)
    if decoded is None:
        return None
    hour0, load_lbs, cells = decoded
    if hour0 < datetime.now(timezone.utc).timestamp() - ANALYSIS_TTL_SECONDS:
        return None
    grid = [(round(lat * WEATHER_GRID_DEG, 3), round(lng * WEATHER_GRID_DEG, 3)) for lat, lng in cells]
    points = []
    for (lat, lng), series in zip(grid, clients.forecast(grid)):
        wind, rain, snow = _weather_at(series, hour0 + hour * 3600)
        value = _intensity(layer, wind, rain, snow, load_lbs)
        if value > 0.02:  # zero-weight points draw nothing; skip them to keep frames small
            points.append({"lat": lat, "lng": lng, "intensity": round(value, 3)})
    return {"hour": hour, "layer": layer, "points": points}
