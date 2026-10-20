import { create } from 'zustand';
import type { ForecastLayer } from '@/api/types';

interface PlannerState {
  selectedRouteId: string | null;
  hour: number;
  playing: boolean;
  layer: ForecastLayer;
  cursorLat: number;
  cursorLng: number;
  zoom: number;
  setSelectedRouteId: (id: string | null) => void;
  setHour: (hour: number) => void;
  setPlaying: (playing: boolean) => void;
  setLayer: (layer: ForecastLayer) => void;
  setMapMetrics: (lat: number, lng: number, zoom: number) => void;
}

export const usePlannerStore = create<PlannerState>(set => ({
  selectedRouteId: null,
  hour: 0,
  playing: false,
  layer: 'risk',
  cursorLat: 32.7767,
  cursorLng: -96.797,
  zoom: 5.4,
  setSelectedRouteId: selectedRouteId => set({ selectedRouteId }),
  setHour: hour => set({ hour: Math.max(0, Math.min(48, hour)) }),
  setPlaying: playing => set({ playing }),
  setLayer: layer => set({ layer }),
  setMapMetrics: (cursorLat, cursorLng, zoom) => set({ cursorLat, cursorLng, zoom }),
}));
