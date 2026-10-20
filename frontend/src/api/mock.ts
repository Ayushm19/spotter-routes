import type { AnalyzeRequest, AnalyzeResponse, Checkpoint, ForecastLayer, HeatmapResponse, Place, Route, RouteSegment } from './types';
import { assessRisk, chooseRecommended, routeRiskLevel } from '@/lib/risk';

export const dallas: Place = { label: 'Dallas, TX', lat: 32.7767, lng: -96.797 };
export const atlanta: Place = { label: 'Atlanta, GA', lat: 33.749, lng: -84.388 };

const mid = (a: [number, number], b: [number, number], curve: number): [number, number] => [
  (a[0] + b[0]) / 2 + curve, (a[1] + b[1]) / 2 + Math.abs(curve) * 0.28,
];
const routePoints = (curve: number, origin: Place, destination: Place): [number, number][] => {
  const start: [number, number] = [origin.lng, origin.lat];
  const end: [number, number] = [destination.lng, destination.lat];
  const m = mid(start, end, curve);
  return [start, [start[0] + (m[0] - start[0]) * .48, start[1] + (m[1] - start[1]) * .5], m,
    [m[0] + (end[0] - m[0]) * .55, m[1] + (end[1] - m[1]) * .5], end];
};

function interpolate(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function createRoute(request: AnalyzeRequest, id: string, label: string, distance: number, duration: number, curve: number, kind: 'rain' | 'wind' | 'clear'): Route {
  const geometry = routePoints(curve, request.origin, request.destination);
  const checkpointCount = Math.ceil(distance / request.sample_interval_miles) + 1;
  const checkpoints: Checkpoint[] = Array.from({ length: checkpointCount }, (_, index) => {
    const t = index / (checkpointCount - 1);
    const segment = Math.min(geometry.length - 2, Math.floor(t * (geometry.length - 1)));
    const local = t === 1 ? 1 : t * (geometry.length - 1) - segment;
    const [lng, lat] = interpolate(geometry[segment], geometry[segment + 1], local);
    const storm = kind === 'rain' && t > .34 && t < .75;
    const gusts = kind === 'wind' && t > .38 && t < .72;
    const weather = {
      wind_mph: gusts ? 48 + (index % 3) * 3 : 18 + (index % 4) * 3,
      rain_in_hr: storm ? .22 + (index % 3) * .12 : .02 + (index % 2) * .03,
      snow_in_hr: 0,
      summary: gusts ? 'Strong crosswinds' : storm ? 'Scattered thunderstorms' : 'Partly cloudy',
    };
    const risk = assessRisk(weather, request.load_lbs);
    const eta = new Date(new Date(request.departure_time).getTime() + duration * 60000 * t).toISOString();
    return {
      mile: Math.round(distance * t), lat, lng, eta,
      forecast_hour: Math.max(0, Math.min(48, Math.round((new Date(request.departure_time).getTime() - Date.now()) / 3_600_000 + duration * t / 60))),
      weather, risk_level: risk.level, risk_score: risk.score, driving_factor: risk.factor, reason: risk.reason,
    };
  });
  const counts = { severe: 0, high: 0, moderate: 0, low: 0, no_travel: 0 };
  const segments: RouteSegment[] = checkpoints.slice(0, -1).map((checkpoint, i) => {
    const end = checkpoints[i + 1];
    const level = routeRiskLevel([checkpoint.risk_level, end.risk_level]);
    const miles = end.mile - checkpoint.mile;
    counts[level] += miles;
    return { risk_level: level, coordinates: [[checkpoint.lng, checkpoint.lat], [end.lng, end.lat]] };
  });
  const avg = checkpoints.reduce((sum, c) => sum + c.risk_score, 0) / checkpoints.length;
  const levels = checkpoints.map(c => c.risk_level);
  const blocked = counts.no_travel > 0;
  return {
    id, label, distance_mi: distance, duration_min: duration,
    eta: new Date(new Date(request.departure_time).getTime() + duration * 60000).toISOString(),
    geometry, segments,
    risk: { level: routeRiskLevel(levels), severe_miles: Math.round(counts.severe), high_miles: Math.round(counts.high), moderate_miles: Math.round(counts.moderate), low_miles: Math.round(counts.low), no_travel_miles: Math.round(counts.no_travel), avg_score: Math.round(avg * 10) / 10 },
    checkpoints, blocked,
  };
}

export async function mockAnalyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  await new Promise(resolve => window.setTimeout(resolve, 450));
  const routes: [Route, Route, Route] = [
    createRoute(request, 'route-a', 'Route A · I-20', 781, 740, .75, 'rain'),
    createRoute(request, 'route-b', 'Route B · I-30 / I-20', 812, 760, -1.05, 'wind'),
    createRoute(request, 'route-c', 'Route C · I-10 / I-65', 846, 785, 2.35, 'clear'),
  ];
  const recommended = chooseRecommended(routes);
  return { analysis_id: `sr-${Date.now().toString(36)}`, routes, recommended_route_id: recommended?.id ?? null, recommendation_reason: recommended ? 'Fewest severe miles, then overall exposure and drive time.' : 'All routes are blocked by forecast conditions.' };
}

export async function mockGeocode(q: string): Promise<Place[]> {
  await new Promise(resolve => window.setTimeout(resolve, 160));
  if (!q.trim()) return [];
  const places: Place[] = [
    dallas, atlanta,
    { label: 'Fort Worth, TX', lat: 32.7555, lng: -97.3308 },
    { label: 'Shreveport, LA', lat: 32.5252, lng: -93.7502 },
    { label: 'Birmingham, AL', lat: 33.5186, lng: -86.8104 },
    { label: 'Jackson, MS', lat: 32.2988, lng: -90.1848 },
    { label: 'Memphis, TN', lat: 35.1495, lng: -90.049 },
    { label: 'Little Rock, AR', lat: 34.7465, lng: -92.2896 },
    { label: 'Houston, TX', lat: 29.7604, lng: -95.3698 },
  ];
  const query = q.toLowerCase();
  return places.filter(p => p.label.toLowerCase().includes(query)).slice(0, 5);
}

export async function mockHeatmap(hour: number, layer: ForecastLayer): Promise<HeatmapResponse> {
  const points: HeatmapResponse['points'] = [];
  const corridor = routePoints(-1.05, dallas, atlanta);
  const centerT = .48 + .24 * Math.sin((hour / 48) * Math.PI * 2);
  const spread = layer === 'wind' ? .12 : .09;
  const centerIndex = Math.min(corridor.length - 2, Math.floor(centerT * (corridor.length - 1)));
  const centerLocal = centerT * (corridor.length - 1) - centerIndex;
  const [centerLng, centerLat] = interpolate(corridor[centerIndex], corridor[centerIndex + 1], centerLocal);
  const intensityScale = layer === 'wind' || layer === 'risk' ? .92 : layer === 'rain' ? .82 : .38;
  for (let i = 0; i < 42; i++) {
    const angle = i * 2.399963229728653;
    const radius = .035 + ((i * 17) % 100) / 100 * spread;
    const lng = centerLng + Math.cos(angle) * radius * 2.7;
    const lat = centerLat + Math.sin(angle) * radius * .85;
    const distance = Math.sqrt(((lng - centerLng) / 2.7) ** 2 + ((lat - centerLat) / .85) ** 2);
    const intensity = Math.max(.02, Math.min(1, intensityScale * Math.exp(-(distance * distance) / (2 * spread * spread))));
    points.push({ lat, lng, intensity });
  }
  return { hour, layer, points };
}
