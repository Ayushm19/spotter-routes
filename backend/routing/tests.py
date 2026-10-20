from unittest.mock import Mock, patch

from django.test import SimpleTestCase, override_settings

from . import clients, geo, risk
from .risk import HIGH, LOW, MODERATE, NO_TRAVEL, SEVERE


class ThresholdTests(SimpleTestCase):
    def test_wind_boundaries(self):
        for mph, lvl in [(24.9, LOW), (25, MODERATE), (34.9, MODERATE), (35, HIGH),
                         (44.9, HIGH), (45, SEVERE), (54.9, SEVERE), (55, NO_TRAVEL)]:
            self.assertEqual(risk.wind_level(mph), lvl, mph)

    def test_rain_boundaries(self):
        for v, lvl in [(0.09, LOW), (0.10, MODERATE), (0.25, HIGH), (0.50, SEVERE),
                       (1.00, SEVERE), (1.01, NO_TRAVEL)]:
            self.assertEqual(risk.rain_level(v), lvl, v)

    def test_snow_boundaries(self):
        for v, lvl in [(0.4, LOW), (0.5, MODERATE), (1.0, HIGH), (2.0, SEVERE),
                       (3.0, SEVERE), (3.1, NO_TRAVEL)]:
            self.assertEqual(risk.snow_level(v), lvl, v)


class LoadRuleTests(SimpleTestCase):
    def test_55_mph_is_no_travel_for_any_load(self):
        self.assertEqual(risk.assess(55, 0, 0, 1_000)[0], NO_TRAVEL)

    def test_severe_wind_heavy_load_is_no_travel(self):
        lvl, factor, reason = risk.assess(47, 0, 0, 30_001)
        self.assertEqual((lvl, factor), (NO_TRAVEL, "load"))
        self.assertIn(">30,000 lb", reason)
        self.assertEqual(risk.assess(47, 0, 0, 30_000)[0], SEVERE)

    def test_high_wind_very_heavy_load_is_severe(self):
        self.assertEqual(risk.assess(40, 0, 0, 40_001)[:2], (SEVERE, "load"))
        self.assertEqual(risk.assess(40, 0, 0, 40_000)[0], HIGH)

    def test_worst_condition_wins(self):
        self.assertEqual(risk.assess(10, 0.6, 0, 0)[:2], (SEVERE, "rain"))
        self.assertEqual(risk.assess(5, 0, 0, 0)[:2], (LOW, "none"))


def _route(label, levels, duration, step=10):
    miles = [i * step for i in range(len(levels))]
    return {
        "label": label,
        "duration_min": duration,
        "blocked": NO_TRAVEL in levels,
        "risk": risk.summarize(miles, levels, miles[-1]),
    }


class RecommendationTests(SimpleTestCase):
    def test_summary_takes_worse_endpoint(self):
        s = risk.summarize([0, 10, 20], [LOW, SEVERE, LOW], 20)
        self.assertEqual((s["severe_miles"], s["low_miles"]), (20, 0))

    def test_order_severe_then_high_then_avg_then_time(self):
        a = _route("A", [LOW, SEVERE, LOW], 600)
        b = _route("B", [LOW, HIGH, HIGH, LOW], 700)
        c = _route("C", [LOW, HIGH, LOW, LOW], 800)
        best, reason = risk.recommend([a, b, c])
        self.assertEqual(best["label"], "C")
        self.assertIn("high-risk miles", reason)

    def test_time_breaks_ties(self):
        best, _ = risk.recommend([_route("A", [LOW, LOW], 500), _route("B", [LOW, LOW], 400)])
        self.assertEqual(best["label"], "B")

    def test_single_route_says_so(self):
        best, reason = risk.recommend([_route("A", [LOW, HIGH], 300)])
        self.assertEqual(best["label"], "A")
        self.assertIn("only truck route", reason)

    def test_blocked_routes_never_recommended(self):
        best, _ = risk.recommend([_route("A", [LOW, NO_TRAVEL], 100), _route("B", [LOW, SEVERE], 900)])
        self.assertEqual(best["label"], "B")
        self.assertIsNone(risk.recommend([_route("A", [NO_TRAVEL, LOW], 100)])[0])


class NwsParsingTests(SimpleTestCase):
    def test_periods_expand_to_hours(self):
        start = 1_760_000_400  # 2025-10-09T09:00:00Z, on the hour
        layer = {"values": [
            {"validTime": "2025-10-09T08:00:00+00:00/PT2H", "value": 10},  # starts before `start`
            {"validTime": "2025-10-09T10:00:00+00:00/PT3H", "value": 6},
            {"validTime": "2025-10-09T13:00:00+00:00/P1DT1H", "value": None},
        ]}
        self.assertEqual(clients._hourly(layer, start, 5), [10, 6, 6, 6, 0])
        self.assertEqual(clients._hourly(layer, start, 5, per_hour=True), [5, 2, 2, 2, 0])


class WeatherSourceTests(SimpleTestCase):
    START = 1_760_000_400  # 2025-10-09T09:00:00Z

    def test_met_norway_hourly_then_six_hourly_and_snow_when_frozen(self):
        fake = {"properties": {"timeseries": [
            {"time": "2025-10-09T09:00:00Z", "data": {"instant": {"details": {"wind_speed": 10, "air_temperature": 5}},
                                                      "next_1_hours": {"details": {"precipitation_amount": 2.54}}}},
            {"time": "2025-10-09T10:00:00Z", "data": {"instant": {"details": {"wind_speed": 0, "air_temperature": -2}},
                                                      "next_6_hours": {"details": {"precipitation_amount": 6 * 2.54}}}},
        ]}}
        with patch.object(clients, "_get", return_value=fake):
            s = clients._met_series(60.0, 10.0, self.START, 8)
        self.assertAlmostEqual(s["wind"][0], 22.37, places=2)  # 10 m/s in mph
        self.assertAlmostEqual(s["rain"][0], 0.1)  # 2.54 mm in one hour
        self.assertEqual(s["rain"][1:7], [0.0] * 6)  # frozen hours are snow, not rain
        self.assertAlmostEqual(s["snow"][3], 1.0)  # 2.54 mm/h liquid at 10:1
        self.assertEqual(s["snow"][7], 0.0)  # beyond the 6-hour block

    def test_open_meteo_failure_falls_back_per_point(self):
        series = {"start": self.START, "wind": [1.0], "rain": [0.0], "snow": [0.0]}
        with patch.object(clients, "_open_meteo_chunk", side_effect=clients.UpstreamError("weather_unavailable", "down", 503)), \
             patch.object(clients, "_single_point", return_value=series) as single:
            out = clients.forecast([(48.8, 2.3), (52.5, 13.4)], hours=1)
        self.assertEqual(out, [series, series])
        self.assertEqual(single.call_count, 2)


@override_settings(TOMTOM_API_KEYS=["test-key"])
class TomTomRouteTests(SimpleTestCase):
    def test_progress_times_are_spread_by_distance(self):
        points = [{"latitude": 32.0, "longitude": -96.0 + i * .1} for i in range(5)]
        fake = {"routes": [{
            "summary": {"travelTimeInSeconds": 400},
            "legs": [{"points": points}],
            "progress": [{"pointIndex": 0, "travelTimeInSeconds": 0}, {"pointIndex": 2, "travelTimeInSeconds": 100},
                         {"pointIndex": 4, "travelTimeInSeconds": 400}],
        }]}
        with patch.object(clients, "_get", return_value=fake) as get:
            (r,) = clients.route([(-96.0, 32.0), (-95.6, 32.0)], load_lbs=40_000)
        self.assertEqual([round(s) for s in r["seconds"]], [0, 50, 100, 250, 400])
        params = get.call_args.args[1]
        self.assertEqual((params["travelMode"], params["vehicleWeight"]), ("truck", round(73_000 / 2.20462)))

    @override_settings(TOMTOM_API_KEYS=["spent", "spare"])
    def test_rejected_key_hands_over_to_the_fallback(self):
        def fake_get(url, params, code, **kwargs):
            if params["key"] == "spent":
                raise clients.UpstreamError(code, "quota", 429)
            return {"results": [{"address": {"freeformAddress": "Dallas, TX"}, "position": {"lat": 32.7, "lon": -96.8}}]}
        with patch.object(clients, "_get", side_effect=fake_get):
            self.assertEqual(clients._tomtom_geocode("dal", 5)[0]["label"], "Dallas, TX")

    def test_errors_never_echo_the_key(self):
        response = Mock(ok=False, status_code=403)
        with patch.object(clients._http, "get", return_value=response):
            with self.assertRaises(clients.UpstreamError) as ctx:
                clients._get("https://api.tomtom.com/x?key=test-key", {"key": "test-key"}, "routing_unavailable", attempts=1)
        self.assertNotIn("test-key", ctx.exception.message)
        self.assertEqual(ctx.exception.status, 403)


class GeoTests(SimpleTestCase):
    def test_point_at_interpolates(self):
        coords = [(-96.0, 32.0), (-95.0, 32.0)]
        cum = geo.cumulative_miles(coords)
        lng, lat, idx = geo.point_at(coords, cum, cum[-1] / 2)
        self.assertAlmostEqual(lng, -95.5, places=3)
        self.assertEqual(idx, 0)

    def test_sample_miles_includes_destination(self):
        self.assertEqual(geo.sample_miles(52, 25), [0, 25, 50, 52])
        self.assertEqual(geo.sample_miles(50, 25), [0, 25, 50])
