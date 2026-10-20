import type { RiskLevel, Weather } from '@/api/types';

const order: RiskLevel[] = ['low', 'moderate', 'high', 'severe', 'no_travel'];

export function windRisk(mph: number): RiskLevel {
  if (mph >= 55) return 'no_travel';
  if (mph >= 45) return 'severe';
  if (mph >= 35) return 'high';
  if (mph >= 25) return 'moderate';
  return 'low';
}

export function rainRisk(inchesPerHour: number): RiskLevel {
  if (inchesPerHour > 1) return 'no_travel';
  if (inchesPerHour >= 0.5) return 'severe';
  if (inchesPerHour >= 0.25) return 'high';
  if (inchesPerHour >= 0.1) return 'moderate';
  return 'low';
}

export function snowRisk(inchesPerHour: number): RiskLevel {
  if (inchesPerHour > 3) return 'no_travel';
  if (inchesPerHour >= 2) return 'severe';
  if (inchesPerHour >= 1) return 'high';
  if (inchesPerHour >= 0.5) return 'moderate';
  return 'low';
}

export interface RiskAssessment {
  level: RiskLevel;
  factor: 'wind' | 'rain' | 'snow' | 'load' | 'none';
  reason: string;
  score: number;
}

export function assessRisk(weather: Weather, loadLbs: number): RiskAssessment {
  const checks: { level: RiskLevel; factor: RiskAssessment['factor']; reason: string }[] = [
    { level: windRisk(weather.wind_mph), factor: 'wind', reason: `${weather.wind_mph} mph crosswinds` },
    { level: rainRisk(weather.rain_in_hr), factor: 'rain', reason: `${weather.rain_in_hr.toFixed(2)} in/hr rainfall` },
    { level: snowRisk(weather.snow_in_hr), factor: 'snow', reason: `${weather.snow_in_hr.toFixed(1)} in/hr snowfall` },
  ];
  if (weather.wind_mph >= 45 && loadLbs > 30000) {
    checks.push({ level: 'no_travel', factor: 'load', reason: 'Heavy load in dangerous crosswinds' });
  } else if (weather.wind_mph >= 35 && loadLbs > 40000) {
    checks.push({ level: 'severe', factor: 'load', reason: 'Heavy load increases crosswind risk' });
  }
  checks.sort((a, b) => order.indexOf(b.level) - order.indexOf(a.level));
  const worst = checks[0];
  const score = [8, 27, 49, 76, 96][order.indexOf(worst.level)];
  return { ...worst, score };
}

export function routeRiskLevel(levels: RiskLevel[]): RiskLevel {
  return levels.reduce((worst, level) => order.indexOf(level) > order.indexOf(worst) ? level : worst, 'low');
}

export function riskColor(level: RiskLevel): string {
  return {
    low: '#2E9E6A', moderate: '#D9A520', high: '#E8742A', severe: '#D33F3A', no_travel: '#6E1830',
  }[level];
}

export function chooseRecommended<T extends { blocked: boolean; risk: { severe_miles: number; high_miles: number; avg_score: number }; duration_min: number }>(routes: T[]): T | null {
  const available = routes.filter(route => !route.blocked);
  available.sort((a, b) =>
    a.risk.severe_miles - b.risk.severe_miles ||
    a.risk.high_miles - b.risk.high_miles ||
    a.risk.avg_score - b.risk.avg_score ||
    a.duration_min - b.duration_min,
  );
  return available[0] ?? null;
}
