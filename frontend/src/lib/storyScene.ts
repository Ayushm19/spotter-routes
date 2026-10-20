/**
 * Data and pure helpers for the landing-page story: real Dallas -> Atlanta road geometry
 * (baked from the backend's OSRM routes), a scripted squall line, and checkpoint risk at
 * each checkpoint's ETA scored with the app's real rules.
 */
import journey from '@/data/journey.json';
import type { RiskLevel } from '@/api/types';
import { assessRisk, riskColor } from '@/lib/risk';

export type LngLat = [number, number];
export const STORY_LOAD_LBS = 38_000;
export const DEPART_HOUR = 6; // story departs 06:00 local

export interface StoryRoute {
  id: 'a' | 'b' | 'c';
  name: string;
  via: string;
  distance: number;
  durationMin: number;
  line: LngLat[];
  cum: number[]; // cumulative miles per vertex
  checkpoints: { at: LngLat; mile: number }[];
}

const names: Record<string, [string, string]> = {
  a: ['Route A', 'I-20 · Shreveport · Jackson'],
  b: ['Route B', 'I-30 · Little Rock · Memphis'],
  c: ['Route C', 'I-40 · Memphis · Tupelo'],
};

function milesBetween(a: LngLat, b: LngLat) {
  const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * 69.05;
}

export const storyRoutes: StoryRoute[] = journey.routes.map(r => {
  const line = r.geometry as LngLat[];
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + milesBetween(line[i - 1], line[i]));
  const scale = r.distance_mi / cum[cum.length - 1]; // align with the router's road distance
  return {
    id: r.id as StoryRoute['id'],
    name: names[r.id][0],
    via: names[r.id][1],
    distance: r.distance_mi,
    durationMin: r.duration_min,
    line,
    cum: cum.map(m => m * scale),
    checkpoints: r.checkpoints.map(([lng, lat, mile]) => ({ at: [lng, lat] as LngLat, mile })),
  };
});

export const routeById = (id: StoryRoute['id']) => storyRoutes.find(r => r.id === id)!;

/** Point and heading at fraction t (0..1) of a route's length. */
export function along(route: StoryRoute, t: number): { at: LngLat; bearing: number } {
  const target = Math.max(0, Math.min(1, t)) * route.distance;
  let i = 1;
  while (i < route.cum.length - 1 && route.cum[i] < target) i++;
  const a = route.line[i - 1], b = route.line[i];
  const span = route.cum[i] - route.cum[i - 1] || 1;
  const f = Math.max(0, Math.min(1, (target - route.cum[i - 1]) / span));
  const at: LngLat = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const bearing = Math.atan2((b[0] - a[0]) * Math.cos(at[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI;
  return { at, bearing };
}

/** Hours after departure the truck reaches a mile marker (constant average speed per route). */
export const etaHours = (route: StoryRoute, mile: number) => (mile / route.distance) * (route.durationMin / 60);

export type RouteId = StoryRoute['id'];

/** Everything the story map shows, as plain numbers, so scroll or time can drive it. */
export interface SceneFrame {
  reveal: number; // 0..1 routes drawn (staggered A, B, C)
  checkpoints: number; // 0..1 hex checkpoints popped in
  resolved: number; // 0..1 forecast sweep along ETA; unresolved checkpoints stay dashed
  hour: number; // storm hour after departure
  storm: number; // 0..1 heatmap opacity
  focus: RouteId | null; // emphasised route; others dim
  blocked: boolean; // draw Route A as blocked
  truck: { route: RouteId; t: number } | null;
  callout: boolean; // pin the key checkpoint card
  camera?: { center: LngLat; zoom: number };
}

export const emptyFrame = (): SceneFrame => ({ reveal: 0, checkpoints: 0, resolved: 0, hour: 0, storm: 0, focus: null, blocked: false, truck: null, callout: false });

/* ---- Scripted weather: a squall line sliding north-east across central Mississippi ---- */

const STORM_PATH: [LngLat, LngLat] = [[-92.2, 31.1], [-88.3, 33.7]];
const STORM_HOURS = 16;

export function stormCenter(hour: number): LngLat {
  const t = Math.max(0, Math.min(1, hour / STORM_HOURS));
  return [STORM_PATH[0][0] + (STORM_PATH[1][0] - STORM_PATH[0][0]) * t, STORM_PATH[0][1] + (STORM_PATH[1][1] - STORM_PATH[0][1]) * t];
}

/** 0..1 storm strength at a point and hour: an elongated cell, strongest mid-journey. */
export function stormStrength(at: LngLat, hour: number) {
  const c = stormCenter(hour);
  const dx = (at[0] - c[0]) * Math.cos(c[1] * Math.PI / 180);
  const dy = at[1] - c[1];
  // Rotate into the squall line's axis (NE-SW) so the cell reads as a line, not a blob.
  const u = dx * .8 + dy * .6, v = -dx * .6 + dy * .8;
  const life = Math.sin(Math.min(1, Math.max(0, hour / STORM_HOURS)) * Math.PI) * .35 + .65;
  return Math.exp(-(u * u) / (2 * 1.15 ** 2) - (v * v) / (2 * .55 ** 2)) * life;
}

export function weatherAt(at: LngLat, hour: number) {
  const s = stormStrength(at, hour);
  return {
    wind_mph: Math.round(14 + 40 * s),
    rain_in_hr: Math.round((0.02 + 0.62 * s * s) * 100) / 100,
    snow_in_hr: 0,
    summary: s > .7 ? 'Squall line, damaging gusts' : s > .35 ? 'Gusty showers' : 'Partly cloudy',
  };
}

export interface ScoredCheckpoint {
  routeId: StoryRoute['id'];
  index: number;
  at: LngLat;
  mile: number;
  eta: number; // hours after departure
  level: RiskLevel;
  wind: number;
  reason: string;
}

export const scoredCheckpoints: ScoredCheckpoint[] = storyRoutes.flatMap(route =>
  route.checkpoints.map((cp, index) => {
    const eta = etaHours(route, cp.mile);
    const weather = weatherAt(cp.at, eta);
    const risk = assessRisk(weather, STORY_LOAD_LBS);
    return { routeId: route.id, index, at: cp.at, mile: cp.mile, eta, level: risk.level, wind: weather.wind_mph, reason: risk.reason };
  }),
);

const rank: RiskLevel[] = ['low', 'moderate', 'high', 'severe', 'no_travel'];

export const storySummary = storyRoutes.map(route => {
  const cps = scoredCheckpoints.filter(c => c.routeId === route.id);
  const miles = { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0 } as Record<RiskLevel, number>;
  for (let i = 0; i < cps.length - 1; i++) {
    const level = rank[Math.max(rank.indexOf(cps[i].level), rank.indexOf(cps[i + 1].level))];
    miles[level] += cps[i + 1].mile - cps[i].mile;
  }
  const worst = cps.reduce((w, c) => (rank.indexOf(c.level) > rank.indexOf(w.level) ? c : w), cps[0]);
  return { id: route.id, miles, blocked: miles.no_travel > 0 || worst.level === 'no_travel', worst };
});

/** The checkpoint that tells the story: the worst one on the fastest route. */
export const keyCheckpoint = storySummary.find(s => s.id === 'a')!.worst;

/** Recommended per the spec's ordering, among routes that are not blocked. */
export const storyPick = storySummary
  .filter(s => !s.blocked)
  .sort((x, y) => x.miles.severe - y.miles.severe || x.miles.high - y.miles.high || routeById(x.id).durationMin - routeById(y.id).durationMin)[0];

/* ---- Heatmap grid over the corridor ---- */

const GRID: LngLat[] = [];
for (let lng = -97.6; lng <= -83.8; lng += .3) for (let lat = 30.4; lat <= 36.4; lat += .3) GRID.push([lng, lat]);

export function stormFeatures(hour: number, opacity = 1) {
  const features = [];
  for (const p of GRID) {
    const s = stormStrength(p, hour) * opacity;
    if (s > .04) features.push({ type: 'Feature' as const, properties: { w: s }, geometry: { type: 'Point' as const, coordinates: p } });
  }
  return { type: 'FeatureCollection' as const, features };
}

/* ---- Formatting ---- */

export function clockLabel(hoursAfterDeparture: number) {
  const total = DEPART_HOUR * 60 + Math.round(hoursAfterDeparture * 60);
  const day = Math.floor(total / 1440);
  const mins = ((total % 1440) + 1440) % 1440;
  return `${['TUE', 'WED', 'THU'][day] ?? 'TUE'} ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export const fmtDuration = (min: number) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;

/* ---- Map styling: a light, desaturated Positron with pale water ---- */

export const LIGHT_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

/** Soften CARTO Positron toward the brand: icy water, paper land, quieter roads and labels. */
export function tintLightMap(map: import('maplibre-gl').Map) {
  for (const layer of map.getStyle().layers ?? []) {
    const id = layer.id;
    try {
      if (layer.type === 'background') map.setPaintProperty(id, 'background-color', '#F4F7F6');
      else if (layer.type === 'fill' && /water/.test(id)) map.setPaintProperty(id, 'fill-color', '#CFE3EA');
      else if (layer.type === 'line' && /water|river/.test(id)) map.setPaintProperty(id, 'line-color', '#BFD8E1');
      else if (layer.type === 'fill' && /landcover|park|wood|forest/.test(id)) map.setPaintProperty(id, 'fill-color', '#EAF0EC');
      else if (layer.type === 'line' && /boundary|admin/.test(id)) map.setPaintProperty(id, 'line-color', 'rgba(6,58,75,.18)');
      else if (layer.type === 'symbol' && /place|label/.test(id)) {
        map.setPaintProperty(id, 'text-color', '#5B6B73');
        map.setPaintProperty(id, 'text-halo-color', 'rgba(244,247,246,.9)');
      }
    } catch {
      // Some layers use expressions we leave alone; tinting is cosmetic.
    }
  }
}

/* ---- Hexagon marker icons, drawn once on a canvas and registered with the map ---- */

export type HexKind = RiskLevel | 'pending' | 'origin' | 'truck';

export function hexImage(kind: HexKind, size = 30): ImageData {
  const ratio = 2;
  const px = size * ratio;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d')!;
  const r = px * .42;
  const cx = px / 2, cy = px / 2;
  const hex = () => {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + i * Math.PI / 3;
      ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    ctx.closePath();
  };
  ctx.lineJoin = 'round';
  if (kind === 'pending') {
    hex();
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.fill();
    ctx.setLineDash([4 * ratio, 3 * ratio]);
    ctx.strokeStyle = 'rgba(6,58,75,.55)';
    ctx.lineWidth = 1.4 * ratio;
    ctx.stroke();
    return ctx.getImageData(0, 0, px, px);
  }
  const fill = kind === 'origin' ? '#063A4B' : kind === 'truck' ? '#F2705E' : riskColor(kind);
  ctx.shadowColor = 'rgba(14,30,37,.28)';
  ctx.shadowBlur = 5 * ratio;
  ctx.shadowOffsetY = 1.5 * ratio;
  hex();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(.78, .78);
  ctx.translate(-cx, -cy);
  hex();
  ctx.fillStyle = fill;
  ctx.fill();
  if (kind === 'no_travel') {
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 2 * ratio;
    for (let x = -px; x < px * 2; x += 6 * ratio) {
      ctx.beginPath();
      ctx.moveTo(x, px);
      ctx.lineTo(x + px, 0);
      ctx.stroke();
    }
  }
  ctx.restore();
  // Glyph: chevron for the truck, dot for everything else.
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  if (kind === 'truck') {
    ctx.lineWidth = 2.2 * ratio;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 5 * ratio, cy + 3 * ratio);
    ctx.lineTo(cx, cy - 3.5 * ratio);
    ctx.lineTo(cx + 5 * ratio, cy + 3 * ratio);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, (kind === 'origin' ? 2.6 : 2) * ratio, 0, Math.PI * 2);
    ctx.fill();
  }
  return ctx.getImageData(0, 0, px, px);
}

export const HEX_KINDS: HexKind[] = ['pending', 'origin', 'truck', 'low', 'moderate', 'high', 'severe', 'no_travel'];
