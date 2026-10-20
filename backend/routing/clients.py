"""Thin wrappers around the third-party APIs.

Routing and geocoding use TomTom (truck profile, traffic and departure aware) when a
TomTom key is configured (a fallback key takes over if the first is rejected or out of quota), and fall back to the keyless OSRM demo server and Photon otherwise
or when TomTom refuses a request. Weather is always the US National Weather Service.
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
NWS_URL = "https://api.weather.gov"

LB_PER_KG = 2.20462
# TomTom's vehicleWeight is the whole vehicle. ponytail: assume a typical empty tractor-trailer
# (~33,000 lb) plus the load; take tare as an input if fleets need it per truck.
TRUCK_TARE_LBS = 33_000

_http = requests.Session()
_http.headers["User-Agent"] = "spotter-routes-assessment/1.0"


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
        "weather": "NWS gridded forecast",
    }


# ---- Geocoding ----

def _tomtom_geocode(query, limit):
    data = _tomtom_get(TOMTOM_SEARCH_URL.format(query=quote(query, safe="")), {
        "typeahead": "true", "limit": limit,
        "countrySet": "US,CA,MX", "idxSet": "Geo,PAD,Addr", "lat": 39.5, "lon": -98.35,
    }, "geocoder_unavailable", attempts=2)
    return [
        {"label": r["address"]["freeformAddress"], "lat": r["position"]["lat"], "lng": r["position"]["lon"]}
        for r in data.get("results", []) if r.get("address", {}).get("freeformAddress")
    ]


def _photon_geocode(query, limit):
    # Biased toward the continental US, where the routing and weather data are best.
    data = _get(PHOTON_URL, {"q": query, "limit": limit, "lang": "en", "lat": 39.5, "lon": -98.35}, "geocoder_unavailable")
    places = []
    for f in data.get("features", []):
        p = f["properties"]
        parts = [p.get("name"), p.get("city") if p.get("city") != p.get("name") else None, p.get("state"), p.get("countrycode")]
        lng, lat = f["geometry"]["coordinates"]
        places.append({"label": ", ".join(x for x in parts if x), "lat": lat, "lng": lng})
    return places


def geocode(query, limit=6):
    """Places matching a partial query. Cached for a day: autocomplete repeats prefixes a lot."""
    key = f"geo:{query.lower()}"
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
        point = _get(f"{NWS_URL}/points/{lat:.4f},{lng:.4f}", {}, "weather_unavailable")
        grid_url = point["properties"]["forecastGridData"]
        cache.set(point_key, grid_url, 24 * 3600)  # point -> grid cell mapping is static
    p = _get(grid_url, {}, "weather_unavailable", attempts=4)["properties"]

    snow = [mm / 25.4 for mm in _hourly(p["snowfallAmount"], start, hours, per_hour=True)]
    precip = [mm / 25.4 for mm in _hourly(p["quantitativePrecipitation"], start, hours, per_hour=True)]
    return {
        "start": start,
        "wind": [kmh * 0.621371 for kmh in _hourly(p["windSpeed"], start, hours)],
        # ponytail: NWS gives total liquid precip; hours with snowfall count it all as snow, not rain.
        "rain": [0.0 if s > 0 else r for r, s in zip(precip, snow)],
        "snow": snow,
    }


def forecast(points, hours=96):
    """Hourly wind (mph), rain and snow (in/hr) for (lat, lng) points, in input order.

    Source is the US National Weather Service gridded forecast (free, no key, US only).
    Each series is cached for 30 min, so callers should snap points to a grid.
    """
    start = int(time.time() // 3600 * 3600)
    keys = [f"wx:{lat:.3f},{lng:.3f}" for lat, lng in points]
    found = cache.get_many(keys)
    missing = [(k, p) for k, p in zip(keys, points) if k not in found]

    def fetch(item):
        key, (lat, lng) = item
        try:
            return key, _nws_series(lat, lng, start, hours)
        except UpstreamError as exc:
            if exc.status == 404:
                raise UpstreamError("outside_coverage", "Weather data covers the United States only.") from exc
            raise

    with ThreadPoolExecutor(max_workers=24) as pool:  # NWS is latency-bound; 24 measured ~25% faster than 12
        fresh = dict(pool.map(fetch, missing))
    cache.set_many(fresh, 30 * 60)
    found.update(fresh)
    return [found[k] for k in keys]
