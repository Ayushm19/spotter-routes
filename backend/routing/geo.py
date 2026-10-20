"""Polyline helpers. Coordinates are (lng, lat) like GeoJSON."""

import bisect
import math

EARTH_RADIUS_MI = 3958.8


def haversine_mi(a, b):
    lng1, lat1, lng2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(h))


def cumulative_miles(coords):
    cum = [0.0]
    for a, b in zip(coords, coords[1:]):
        cum.append(cum[-1] + haversine_mi(a, b))
    return cum


def point_at(coords, cum, mile):
    """Interpolated (lng, lat, segment index) at a distance along the line."""
    i = min(max(bisect.bisect_right(cum, mile) - 1, 0), len(coords) - 2)
    span = cum[i + 1] - cum[i]
    t = (mile - cum[i]) / span if span else 0.0
    a, b = coords[i], coords[i + 1]
    return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, i


def value_at(cum, values, mile):
    """Linear interpolation of a per-vertex value (e.g. elapsed seconds) at a distance."""
    i = min(max(bisect.bisect_right(cum, mile) - 1, 0), len(cum) - 2)
    span = cum[i + 1] - cum[i]
    t = (mile - cum[i]) / span if span else 0.0
    return values[i] + (values[i + 1] - values[i]) * t


def sample_miles(total, step):
    miles = [float(m) for m in range(0, int(total) + 1, step)]
    if total - miles[-1] > 0.5:
        miles.append(total)
    return miles


def slice_line(coords, cum, start, end):
    """Sub-line between two distances, with interpolated endpoints."""
    a = point_at(coords, cum, start)
    b = point_at(coords, cum, end)
    return [[a[0], a[1]], *[list(c) for c in coords[a[2] + 1:b[2] + 1]], [b[0], b[1]]]


def thin(coords, min_gap_mi=0.5):
    """Drop vertices closer than min_gap_mi to the last kept one; keeps payloads small."""
    kept = [coords[0]]
    for c in coords[1:-1]:
        if haversine_mi(kept[-1], c) >= min_gap_mi:
            kept.append(c)
    kept.append(coords[-1])
    return kept
