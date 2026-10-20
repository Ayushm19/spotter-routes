import type { AnalyzeRequest, AnalyzeResponse, ForecastLayer, HeatmapResponse, Place } from './types';
import { mockAnalyze, mockGeocode, mockHeatmap } from './mock';

const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, '') ?? '';
export const isMockMode = import.meta.env.VITE_USE_MOCK === 'true' || !apiUrl;

export class ApiRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    let message = `Request failed (${response.status}). Please try again.`;
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const error = body.error;
        if (typeof error === 'object' && error !== null) {
          if ('code' in error && typeof error.code === 'string') code = error.code;
          if ('message' in error && typeof error.message === 'string') message = error.message;
        }
      }
    } catch {
      // Preserve the HTTP status message when the response body is not JSON.
    }
    throw new ApiRequestError(code, message);
  }
  return response.json() as Promise<T>;
}

export function analyzeRoute(payload: AnalyzeRequest): Promise<AnalyzeResponse> {
  return isMockMode
    ? mockAnalyze(payload)
    : request('/api/routes/analyze', { method: 'POST', body: JSON.stringify(payload) });
}

export function geocode(query: string): Promise<Place[]> {
  return isMockMode
    ? mockGeocode(query)
    : request(`/api/geocode?q=${encodeURIComponent(query)}`);
}

export function getHeatmap(analysisId: string, hour: number, layer: ForecastLayer): Promise<HeatmapResponse> {
  return isMockMode
    ? mockHeatmap(hour, layer)
    : request(`/api/analyses/${encodeURIComponent(analysisId)}/heatmap?hour=${hour}&layer=${layer}`);
}
