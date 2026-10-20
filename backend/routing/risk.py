"""Weather risk rules from the assessment spec. Pure functions, no I/O."""

LEVELS = ["low", "moderate", "high", "severe", "no_travel"]
LOW, MODERATE, HIGH, SEVERE, NO_TRAVEL = range(5)

# Lower bound of moderate, high, severe, no_travel. The spec's no_travel for rain/snow
# is strictly greater-than (">1.00", ">3.0"); every other bound is inclusive.
WIND_BOUNDS = (25, 35, 45, 55)
RAIN_BOUNDS = (0.10, 0.25, 0.50, 1.00)
SNOW_BOUNDS = (0.5, 1.0, 2.0, 3.0)


def _level(value, bounds, strict_top=False):
    level = sum(value >= b for b in bounds[:3])
    if value > bounds[3] or (not strict_top and value >= bounds[3]):
        level = NO_TRAVEL
    return level


def wind_level(mph):
    return _level(mph, WIND_BOUNDS)


def rain_level(in_hr):
    return _level(in_hr, RAIN_BOUNDS, strict_top=True)


def snow_level(in_hr):
    return _level(in_hr, SNOW_BOUNDS, strict_top=True)


def assess(wind_mph, rain_in_hr, snow_in_hr, load_lbs):
    """Return (level index, driving factor, reason) for one checkpoint."""
    candidates = [
        (wind_level(wind_mph), "wind", f"Wind {wind_mph:.0f} mph"),
        (rain_level(rain_in_hr), "rain", f"Rain {rain_in_hr:.2f} in/hr"),
        (snow_level(snow_in_hr), "snow", f"Snow {snow_in_hr:.1f} in/hr"),
    ]
    if 45 <= wind_mph < 55 and load_lbs > 30_000:
        candidates.append((NO_TRAVEL, "load", f"Wind {wind_mph:.0f} mph with load >30,000 lb"))
    elif 35 <= wind_mph < 45 and load_lbs > 40_000:
        candidates.append((SEVERE, "load", f"Wind {wind_mph:.0f} mph with load >40,000 lb"))

    # max() keeps the first of equal levels, so a load rule only wins when it raises the level.
    level, factor, reason = max(candidates, key=lambda c: c[0])
    if level == LOW:
        return LOW, "none", f"Clear to drive: wind {wind_mph:.0f} mph, rain {rain_in_hr:.2f} in/hr"
    return level, factor, reason


def score(level):
    return level * 25


def summarize(miles, levels, total_miles):
    """Miles spent in each level. The stretch between two checkpoints takes the worse of the two."""
    per_level = [0.0] * len(LEVELS)
    weighted = 0.0
    for i in range(len(miles) - 1):
        span = miles[i + 1] - miles[i]
        lvl = max(levels[i], levels[i + 1])
        per_level[lvl] += span
        weighted += span * score(lvl)
    return {
        "level": LEVELS[max(levels)],
        "low_miles": round(per_level[LOW], 1),
        "moderate_miles": round(per_level[MODERATE], 1),
        "high_miles": round(per_level[HIGH], 1),
        "severe_miles": round(per_level[SEVERE], 1),
        "no_travel_miles": round(per_level[NO_TRAVEL], 1),
        "avg_score": round(weighted / total_miles, 1) if total_miles else 0.0,
    }


def rank_key(route):
    r = route["risk"]
    return (r["severe_miles"], r["high_miles"], r["avg_score"], route["duration_min"])


def recommend(routes):
    """Return (recommended route or None, reason). Blocked routes are never recommended."""
    candidates = sorted((r for r in routes if not r["blocked"]), key=rank_key)
    if not candidates:
        return None, "Every route hits a no-travel checkpoint. Delay departure or reduce load."
    best = candidates[0]
    if len(candidates) == 1:
        return best, f"{best['label']} is the only route without a no-travel checkpoint."

    other = candidates[1]
    b, o = best["risk"], other["risk"]
    if b["severe_miles"] != o["severe_miles"]:
        why = f"{b['severe_miles']:.0f} severe miles vs {o['severe_miles']:.0f} on {other['label']}"
    elif b["high_miles"] != o["high_miles"]:
        why = f"{b['high_miles']:.0f} high-risk miles vs {o['high_miles']:.0f} on {other['label']}"
    elif b["avg_score"] != o["avg_score"]:
        why = f"lower average risk ({b['avg_score']:.0f} vs {o['avg_score']:.0f}) than {other['label']}"
    else:
        why = f"same risk as {other['label']}"

    delta = best["duration_min"] - other["duration_min"]
    if delta > 0:
        why += f", for {delta:.0f} extra minutes"
    elif delta < 0:
        why += f", and {-delta:.0f} minutes faster"
    return best, f"{best['label']}: {why}."
