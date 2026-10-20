"""Thin wrappers around the third-party APIs.

Routing and geocoding use TomTom (truck profile, traffic and departure aware) when a TomTom
key is configured (a fallback key takes over if the first is rejected or out of quota), and fall
back to the keyless OSRM demo server and Photon otherwise. Weather comes from Open-Meteo
worldwide, with NWS (US) and MET Norway (elsewhere) as per-point fallbacks.
"""

import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from urllib.parse import quote

import requests
from django.conf import settings
from django.core.cache import cache

from . import geo

TOMTOM_ROUTE_URL = "https://api.tomtom.com/routing/1/calculateRoute/{path}/json"
TOMTOM_SEARCH_URL = "https://api.tomtom.com/search/2/search/{query}.json"
PHOTON_URL = "https://photon.komoot.io/api/"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
NWS_URL = "https://api.weather.gov"
MET_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact"

LB_PER_KG = 2.20462
# TomTom's vehicleWeight is the whole vehicle. ponytail: assume a typical empty tractor-trailer
# (~33,000 lb) plus the load; take tare as an input if fleets need it per truck.
TRUCK_TARE_LBS = 33_000

_http = requests.Session()
# MET Norway and NWS ask callers to identify themselves.
_http.headers["User-Agent"] = "spotter-routes/1.0 github.com/Ayushm19/spotter-routes"


class UpstreamError(Exception):
    def __init__(self, code, message, status=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _get(url, params, code, attempts=3, timeout=30):
    """GET JSON, retrying timeouts and 5xx/429 with a short backoff (free APIs blip often).

    Error messages never include the URL: it can carry an API key.
    """
    label = code.replace("_", " ").capitalize()
    for attempt in range(attempts):
        try:
            resp = _http.get(url, params=params, timeout=timeout)
        except requests.Timeout as exc:
            if attempt == attempts - 1:
                raise UpstreamError(code, f"{label}: upstream timed out") from exc
            continue
        except requests.RequestException as exc:
            raise UpstreamError(code, f"{label}: network error") from exc
        if (resp.status_code >= 500 or resp.status_code == 429) and attempt < attempts - 1:
            time.sleep(1.5 * (attempt + 1))
            continue
        if not resp.ok:
            raise UpstreamError(code, f"{label}: upstream returned HTTP {resp.status_code}", resp.status_code)
        try:
            return resp.json()
        except ValueError as exc:
            raise UpstreamError(code, f"{label}: invalid response") from exc


# TomTom answers 403 for an invalid/disabled key and 429 when a key's quota is used up.
_KEY_EXHAUSTED = {401, 403, 429}


def _tomtom_get(url, params, code, **kwargs):
    """GET from TomTom, moving to the next configured key when one is rejected or exhausted."""
    error = None
    for key in settings.TOMTOM_API_KEYS:
        try:
            return _get(url, {**params, "key": key}, code, **kwargs)
        except UpstreamError as exc:
            if exc.status not in _KEY_EXHAUSTED:
                raise
            error = exc
    raise error or UpstreamError(code, "No TomTom key configured")


def providers():
    """Which services answer, reported in API responses for transparency."""
    keyed = bool(settings.TOMTOM_API_KEYS)
    return {
        "routing": "TomTom Routing (truck)" if keyed else "OSRM demo (car)",
        "geocoding": "TomTom Search" if keyed else "Photon",
        "weather": "Open-Meteo (NWS / MET Norway fallback)",
    }


# ---- Geocoding ----

def _tomtom_geocode(query, limit):
    data = _tomtom_get(TOMTOM_SEARCH_URL.format(query=quote(query, safe="")), {
        "typeahead": "true", "limit": limit,
        "idxSet": "Geo,PAD,Addr",
    }, "geocoder_unavailable", attempts=2)
    places = []
    for r in data.get("results", []):
        address = r.get("address", {})
        label = address.get("freeformAddress")
        if not label:
            continue
        # US labels already read "Paris, TX"; elsewhere add the country so "Paris" is unambiguous.
        country = address.get("country")
        if address.get("countryCode") != "US" and country and country not in label:
            label = f"{label}, {country}"
        lat, lng = r["position"]["lat"], r["position"]["lon"]
        box = r.get("boundingBox")
        if box and box["topLeftPoint"]["lat"] - box["btmRightPoint"]["lat"] > 1.0:
            lat, lng = _town_centre(label, box) or (lat, lng)
        places.append({"label": label, "lat": lat, "lng": lng})
    return places


def _town_centre(label, box):
    """TomTom gives some sparse areas (e.g. Tok or Haines, Alaska) the centroid of a census area
    hundreds of miles wide, far from any road. Ask OpenStreetMap for the town itself inside that box."""
    try:
        for lat, lng in ((p["lat"], p["lng"]) for p in _photon_geocode(label, 3)):
            if box["btmRightPoint"]["lat"] <= lat <= box["topLeftPoint"]["lat"] and box["topLeftPoint"]["lon"] <= lng <= box["btmRightPoint"]["lon"]:
                return lat, lng
    except UpstreamError:
        pass
    return None


def _photon_geocode(query, limit):
    data = _get(PHOTON_URL, {"q": query, "limit": limit, "lang": "en"}, "geocoder_unavailable")
    places = []
    for f in data.get("features", []):
        p = f["properties"]
        parts = [p.get("name"), p.get("city") if p.get("city") != p.get("name") else None, p.get("state"), p.get("countrycode")]
        lng, lat = f["geometry"]["coordinates"]
        places.append({"label": ", ".join(x for x in parts if x), "lat": lat, "lng": lng})
    return places


def geocode(query, limit=6):
    """Places matching a partial query. Cached for a day: autocomplete repeats prefixes a lot."""
    key = f"geo:{quote(query.lower(), safe='')}"  # encoded: cache backends reject spaces
    cached = cache.get(key)
    if cached is not None:
        return cached
    places = None
    if settings.TOMTOM_API_KEYS:
        try:
            places = _tomtom_geocode(query, limit)
        except UpstreamError:
            places = None  # quota or outage: Photon keeps autocomplete working
    if places is None:
        places = _photon_geocode(query, limit)
    seen, unique = set(), []
    for p in places:
        if p["label"] not in seen:
            seen.add(p["label"])
            unique.append(p)
    cache.set(key, unique, 24 * 3600)
    return unique


# ---- Routing ----
# Every router returns [{"coords": [(lng, lat)...], "seconds": [elapsed seconds per vertex]}].

def _tomtom_route(waypoints, alternatives, load_lbs, depart_at):
    path = ":".join(f"{lat:.5f},{lng:.5f}" for lng, lat in waypoints)
    future = depart_at is not None and depart_at.timestamp() > time.time() + 60
    params = {
        "travelMode": "truck", "vehicleCommercial": "true",
        "vehicleWeight": round((TRUCK_TARE_LBS + load_lbs) / LB_PER_KG),
        "traffic": "true", "routeType": "fastest",
        # TomTom rejects departures in the past, so "now" covers the last few minutes.
        "departAt": depart_at.replace(microsecond=0).isoformat() if future else "now",
        # Adds travel time at points along the line, so checkpoint ETAs come from TomTom's model.
        "extendedRouteRepresentation": "travelTime",
        "maxAlternatives": 2 if alternatives else 0,
    }
    data = _tomtom_get(TOMTOM_ROUTE_URL.format(path=path), params, "routing_unavailable", attempts=2, timeout=60)
    routes = []
    for r in data.get("routes", []):
        coords = [(p["longitude"], p["latitude"]) for leg in r["legs"] for p in leg["points"]]
        cum = geo.cumulative_miles(coords)
        progress = [p for p in r.get("progress", []) if "travelTimeInSeconds" in p]
        total = r["summary"]["travelTimeInSeconds"]
        if progress and progress[0]["pointIndex"] == 0 and progress[-1]["pointIndex"] == len(coords) - 1:
            # Between progress entries, spread time by distance, as TomTom's docs advise.
            seconds = [0.0] * len(coords)
            for a, b in zip(progress, progress[1:]):
                i0, i1 = a["pointIndex"], b["pointIndex"]
                t0, t1 = a["travelTimeInSeconds"], b["travelTimeInSeconds"]
                span = (cum[i1] - cum[i0]) or 1
                for k in range(i0, i1 + 1):
                    seconds[k] = t0 + (t1 - t0) * (cum[k] - cum[i0]) / span
        else:
            seconds = [total * m / (cum[-1] or 1) for m in cum]
        routes.append({"coords": coords, "seconds": seconds})
    if not routes:
        raise UpstreamError("no_route", "No truck route found between these places.")
    return routes


def _osrm_route(waypoints, alternatives):
    path = ";".join(f"{lng:.5f},{lat:.5f}" for lng, lat in waypoints)
    params = {"overview": "full", "geometries": "geojson", "annotations": "duration", "alternatives": "3" if alternatives else "false"}
    data = _get(OSRM_URL + path, params, "routing_unavailable")
    if data.get("code") != "Ok":
        raise UpstreamError("no_route", "No drivable route found between these places.")

    routes = []
    for r in data["routes"]:
        coords = [tuple(c) for c in r["geometry"]["coordinates"]]
        durations = [d for leg in r["legs"] for d in leg["annotation"]["duration"]]
        if len(durations) != len(coords) - 1:
            # Legs share their joining vertex; if counts ever disagree, spread time evenly instead.
            durations = [r["duration"] / (len(coords) - 1)] * (len(coords) - 1)
        elapsed = [0.0]
        for d in durations:
            elapsed.append(elapsed[-1] + d)
        routes.append({"coords": coords, "seconds": elapsed})
    return routes


def route(waypoints, alternatives=False, load_lbs=0, depart_at=None):
    """Driving routes through (lng, lat) waypoints: TomTom truck routing, else OSRM."""
    if settings.TOMTOM_API_KEYS:
        try:
            return _tomtom_route(waypoints, alternatives, load_lbs, depart_at)
        except UpstreamError as exc:
            # A 400 means TomTom understood the request and found no truck route; that answer stands.
            if exc.status == 400 or exc.code == "no_route":
                raise UpstreamError("no_route", "No truck route found between these places.") from exc
    return _osrm_route(waypoints, alternatives)


# ---- Weather ----
# Every source returns {"start": epoch of the first hour, "wind": mph, "rain": in/hr, "snow": in/hr}
# as hourly lists, so analysis code does not care where a forecast came from.

OPEN_METEO_CHUNK = 50  # locations per request; keeps URLs short and lets chunks run in parallel


def _open_meteo_chunk(points, hours):
    data = _get(OPEN_METEO_URL, {
        "latitude": ",".join(f"{lat:.3f}" for lat, _ in points),
        "longitude": ",".join(f"{lng:.3f}" for _, lng in points),
        "hourly": "wind_speed_10m,rain,snowfall",
        "wind_speed_unit": "mph", "precipitation_unit": "inch",
        "timeformat": "unixtime", "timezone": "UTC", "forecast_hours": hours,
    }, "weather_unavailable", attempts=2)
    locations = data if isinstance(data, list) else [data]
    if len(locations) != len(points):
        raise UpstreamError("weather_unavailable", "Weather unavailable: incomplete response")
    return [
        {"start": loc["hourly"]["time"][0], "wind": loc["hourly"]["wind_speed_10m"],
         "rain": loc["hourly"]["rain"], "snow": loc["hourly"]["snowfall"]}
        for loc in locations
    ]


_DURATION = re.compile(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?")


def _hourly(layer, start, hours, per_hour=False):
    """Expand NWS {validTime: "start/PT6H", value} periods into an hourly list from `start`.

    per_hour=True spreads accumulations (mm over the period) evenly across its hours.
    """
    out = [0.0] * hours
    for item in layer["values"]:
        if item["value"] is None:
            continue
        begin, duration = item["validTime"].split("/")
        days, hrs, mins = (int(x or 0) for x in _DURATION.fullmatch(duration).groups())
        length = max(days * 24 + hrs + (1 if mins else 0), 1)
        first = int((datetime.fromisoformat(begin).timestamp() - start) // 3600)
        value = item["value"] / length if per_hour else item["value"]
        for h in range(max(first, 0), min(first + length, hours)):
            out[h] = value
    return out


def _nws_series(lat, lng, start, hours):
    point_key = f"nws-point:{lat:.3f},{lng:.3f}"
    grid_url = cache.get(point_key)
    if grid_url is None:
        point = _get(f"{NWS_URL}/points/{lat:.4f},{lng:.4f}", {}, "weather_unavailable", attempts=2)
        grid_url = point["properties"]["forecastGridData"]
        cache.set(point_key, grid_url, 24 * 3600)  # point -> grid cell mapping is static
    p = _get(grid_url, {}, "weather_unavailable", attempts=3)["properties"]

    snow = [mm / 25.4 for mm in _hourly(p["snowfallAmount"], start, hours, per_hour=True)]
    precip = [mm / 25.4 for mm in _hourly(p["quantitativePrecipitation"], start, hours, per_hour=True)]
    return {
        "start": start,
        "wind": [kmh * 0.621371 for kmh in _hourly(p["windSpeed"], start, hours)],
        # ponytail: NWS gives total liquid precip; hours with snowfall count it all as snow, not rain.
        "rain": [0.0 if s > 0 else r for r, s in zip(precip, snow)],
        "snow": snow,
    }


def _met_series(lat, lng, start, hours):
    """MET Norway Locationforecast (global, keyless). Hourly for ~2.5 days, then 6-hour steps."""
    data = _get(MET_URL, {"lat": f"{lat:.3f}", "lon": f"{lng:.3f}"}, "weather_unavailable", attempts=2)
    wind, rain, snow = [0.0] * hours, [0.0] * hours, [0.0] * hours
    for step in data["properties"]["timeseries"]:
        h = int((datetime.fromisoformat(step["time"].replace("Z", "+00:00")).timestamp() - start) // 3600)
        block = step["data"].get("next_1_hours") or step["data"].get("next_6_hours")
        if block is None or h >= hours:
            continue
        length = 1 if "next_1_hours" in step["data"] else 6
        instant = step["data"]["instant"]["details"]
        mm_per_hour = block["details"].get("precipitation_amount", 0.0) / length
        # ponytail: MET gives liquid precip only; at or below freezing count it as snow at ~10:1.
        frozen = instant.get("air_temperature", 5.0) <= 0.5
        for k in range(max(h, 0), min(h + length, hours)):
            wind[k] = instant.get("wind_speed", 0.0) * 2.23694
            rain[k] = 0.0 if frozen else mm_per_hour / 25.4
            snow[k] = mm_per_hour * 10 / 25.4 if frozen else 0.0
    return {"start": start, "wind": wind, "rain": rain, "snow": snow}


def _single_point(lat, lng, start, hours):
    """Fallback for one point: NWS where it has coverage (the US), MET Norway everywhere else."""
    # Rough box around the US incl. Alaska and Hawaii; NWS answers 404 for border points it misses.
    if 18 <= lat <= 72 and -180 <= lng <= -64:
        try:
            return _nws_series(lat, lng, start, hours)
        except UpstreamError:
            pass
    return _met_series(lat, lng, start, hours)


def forecast(points, hours=96):
    """Hourly wind (mph), rain and snow (in/hr) for (lat, lng) points anywhere, in input order.

    Open-Meteo answers in a few batched requests. Chunks it fails on fall back point by point
    to NWS (US) or MET Norway (elsewhere). Each series is cached for 30 min, so callers should
    snap points to a grid.
    """
    start = int(time.time() // 3600 * 3600)
    keys = [f"wx:{lat:.3f},{lng:.3f}" for lat, lng in points]
    found = cache.get_many(keys)
    missing = [(k, p) for k, p in zip(keys, points) if k not in found]
    chunks = [missing[i:i + OPEN_METEO_CHUNK] for i in range(0, len(missing), OPEN_METEO_CHUNK)]

    def fetch_chunk(chunk):
        try:
            return dict(zip([k for k, _ in chunk], _open_meteo_chunk([p for _, p in chunk], hours)))
        except UpstreamError:
            with ThreadPoolExecutor(max_workers=16) as pool:  # MET Norway allows 20 requests/s per app
                return dict(pool.map(lambda item: (item[0], _single_point(*item[1], start, hours)), chunk))

    fresh = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for part in pool.map(fetch_chunk, chunks):
            fresh.update(part)
    cache.set_many(fresh, 30 * 60)
    found.update(fresh)
    return [found[k] for k in keys]
