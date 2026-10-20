export type RiskLevel = 'low' | 'moderate' | 'high' | 'severe' | 'no_travel';
export type WeatherLayer = 'wind' | 'rain' | 'snow';
export type ForecastLayer = 'risk' | WeatherLayer;
export type SampleInterval = 10 | 25 | 50;

export interface Place {
  label: string;
  lat: number;
  lng: number;
}

export interface Weather {
  wind_mph: number;
  rain_in_hr: number;
  snow_in_hr: number;
  summary: string;
}

export interface Checkpoint {
  mile: number;
  lat: number;
  lng: number;
  eta: string;
  forecast_hour: number;
  weather: Weather;
  risk_level: RiskLevel;
  risk_score: number;
  driving_factor: 'wind' | 'rain' | 'snow' | 'load' | 'none';
  reason: string;
}

export interface RouteRisk {
  level: RiskLevel;
  severe_miles: number;
  high_miles: number;
  moderate_miles: number;
  low_miles: number;
  no_travel_miles: number;
  avg_score: number;
}

export interface RouteSegment {
  risk_level: RiskLevel;
  coordinates: [number, number][];
}

export interface Route {
  id: string;
  label: string;
  distance_mi: number;
  duration_min: number;
  eta: string;
  geometry: [number, number][];
  segments: RouteSegment[];
  risk: RouteRisk;
  checkpoints: Checkpoint[];
  blocked: boolean;
}

export interface AnalyzeRequest {
  origin: Place;
  destination: Place;
  departure_time: string;
  load_lbs: number;
  sample_interval_miles: SampleInterval;
}

export interface AnalyzeResponse {
  analysis_id: string;
  routes: Route[]; // usually 3; fewer where the road network has no distinct alternatives
  recommended_route_id: string | null;
  recommendation_reason: string;
}

export interface HeatmapPoint {
  lat: number;
  lng: number;
  intensity: number;
}

export interface HeatmapResponse {
  hour: number;
  layer: ForecastLayer;
  points: HeatmapPoint[];
}
