import json
from functools import wraps
from datetime import datetime, timedelta, timezone

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from . import analysis, clients

MAX_LOAD_LBS = 80_000
INTERVALS = (10, 25, 50)


def _error(status, code, message):
    return JsonResponse({"error": {"code": code, "message": message}}, status=status)


def allow(method):
    """Like Django's require_GET/require_POST, but answers 405 in the JSON error shape."""
    def decorate(view):
        @wraps(view)
        def wrapper(request, *args, **kwargs):
            if request.method != method:
                response = _error(405, "method_not_allowed", f"Use {method}.")
                response["Allow"] = method
                return response
            return view(request, *args, **kwargs)
        return wrapper
    return decorate


# The trip itself can't be served (no road between the places): the client's input, not an outage.
UNSERVABLE = {"no_route"}


def _upstream_error(exc):
    return _error(422 if exc.code in UNSERVABLE else 502, exc.code, exc.message)


def _place(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object with label, lat and lng.")
    lat, lng = value.get("lat"), value.get("lng")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (lat, lng)):
        raise ValueError(f"{name}.lat and {name}.lng must be numbers.")
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise ValueError(f"{name} coordinates are out of range.")
    return {"label": str(value.get("label", "")), "lat": float(lat), "lng": float(lng)}


def _parse_request(body):
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object.")
    origin = _place(data.get("origin"), "origin")
    destination = _place(data.get("destination"), "destination")

    try:
        departure = datetime.fromisoformat(str(data.get("departure_time")))
    except ValueError:
        raise ValueError("departure_time must be an ISO 8601 timestamp.") from None
    if departure.tzinfo is None:
        raise ValueError("departure_time must include a UTC offset.")
    now = datetime.now(timezone.utc)
    # A few minutes of slack for clocks and the time the user spent on the form.
    if not (now - timedelta(minutes=15) <= departure <= now + timedelta(hours=48)):
        raise ValueError("departure_time must be within the next 48 hours.")

    load = data.get("load_lbs")
    if not isinstance(load, (int, float)) or isinstance(load, bool) or not 0 < load <= MAX_LOAD_LBS:
        raise ValueError(f"load_lbs must be a number between 1 and {MAX_LOAD_LBS:,}.")

    interval = data.get("sample_interval_miles")
    if interval not in INTERVALS:
        raise ValueError("sample_interval_miles must be 10, 25 or 50.")
    return origin, destination, departure, float(load), interval


@allow("GET")
def health(request):
    return JsonResponse({"ok": True})


@allow("GET")
def geocode(request):
    query = request.GET.get("q", "").strip()
    if len(query) < 2:
        return JsonResponse([], safe=False)
    try:
        return JsonResponse(clients.geocode(query[:120]), safe=False)
    except clients.UpstreamError as exc:
        return _upstream_error(exc)


@csrf_exempt
@allow("POST")
def analyze(request):
    try:
        origin, destination, departure, load, interval = _parse_request(request.body)
    except (ValueError, json.JSONDecodeError) as exc:
        return _error(400, "invalid_request", str(exc))
    try:
        return JsonResponse(analysis.analyze(origin, destination, departure, load, interval))
    except clients.UpstreamError as exc:
        return _upstream_error(exc)


@allow("GET")
def heatmap(request, analysis_id):
    try:
        hour = int(request.GET.get("hour", 0))
    except ValueError:
        return _error(400, "invalid_request", "hour must be an integer from 0 to 48.")
    layer = request.GET.get("layer", "risk")
    if not 0 <= hour <= analysis.HEATMAP_HOURS or layer not in analysis.LAYERS:
        return _error(400, "invalid_request", "hour must be 0-48 and layer one of risk, wind, rain, snow.")
    frame = analysis.heatmap(analysis_id, hour, layer)
    if frame is None:
        return _error(404, "analysis_expired", "This analysis has expired. Run it again.")
    response = JsonResponse(frame)
    response["Cache-Control"] = "public, max-age=600"  # frames for an analysis never change
    return response
