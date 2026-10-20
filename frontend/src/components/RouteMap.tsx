import { useEffect, useRef, useState } from 'react';
import { LngLatBounds, Map as MapInstance, NavigationControl, Popup, type GeoJSONSource } from 'maplibre-gl';
import { format } from 'date-fns';
import type { Checkpoint, ForecastLayer, HeatmapResponse, Route } from '@/api/types';
import { riskColor } from '@/lib/risk';
import { usePlannerStore } from '@/lib/store';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@/lib/maplibreWorker';

interface RouteMapProps {
  routes: Route[];
  selectedRoute: Route | null;
  heatmap: HeatmapResponse | undefined;
  layer: ForecastLayer;
  highlightedMile: number | null;
  onCheckpoint?: (mile: number) => void;
  onCheckpointHover?: (mile: number | null) => void;
}

const mapStyle = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const routeCollection = (route: Route | null, all: Route[]) => ({
  type: 'FeatureCollection' as const,
  features: [
    ...all.filter(r => r.id !== route?.id).map(r => ({
      type: 'Feature' as const, properties: { id: r.id, color: '#72909A', risk_level: 'low', selected: false, width: 2.5, opacity: .52 },
      geometry: { type: 'LineString' as const, coordinates: r.geometry },
    })),
    ...(route ? route.segments.map((segment, i) => ({
      type: 'Feature' as const, properties: { id: `${route.id}-${i}`, color: riskColor(segment.risk_level), risk_level: segment.risk_level, selected: true, width: 5, opacity: 1 },
      geometry: { type: 'LineString' as const, coordinates: segment.coordinates },
    })) : []),
  ],
});

const checkpointFeatures = (points: Checkpoint[], highlightedMile: number | null) => points.map(p => ({
  type: 'Feature' as const,
  properties: {
    mile: p.mile, color: riskColor(p.risk_level), selected: p.mile === highlightedMile, riskLabel: p.risk_level.replace('_', ' '),
    wind: Math.round(p.weather.wind_mph), rain: p.weather.rain_in_hr.toFixed(2), snow: p.weather.snow_in_hr.toFixed(1),
    eta: format(new Date(p.eta), 'EEE HH:mm'), hour: Math.round(p.forecast_hour),
  },
  geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
}));

/** Route chips on the map carry the summary: letter, drive time and distance. */
const labelFeatures = (routes: Route[]) => routes.map((route, index) => ({
  type: 'Feature' as const,
  properties: { label: `${String.fromCharCode(65 + index)} · ${Math.floor(route.duration_min / 60)}h ${String(route.duration_min % 60).padStart(2, '0')}m · ${Math.round(route.distance_mi)} mi${route.blocked ? ' · NO TRAVEL' : ''}` },
  geometry: { type: 'Point' as const, coordinates: route.geometry[Math.floor(route.geometry.length * (.3 + .2 * index))] },
}));

/**
 * Map padding that keeps routes clear of the floating overlays (top chips, bottom timeline,
 * and on mobile the bottom sheet), scaled down when the map is too small to honour it.
 */
function fitPadding(container: HTMLElement) {
  const box = container.getBoundingClientRect();
  const stage = container.parentElement;
  const timeline = stage?.querySelector('.timeline-overlay')?.getBoundingClientRect();
  const padding = { top: 84, right: 56, left: 56, bottom: timeline ? Math.max(48, box.bottom - timeline.top + 28) : 48 };
  const shrinkX = Math.min(1, (box.width * .5) / (padding.left + padding.right));
  const shrinkY = Math.min(1, (box.height * .6) / (padding.top + padding.bottom));
  return { top: padding.top * shrinkY, bottom: padding.bottom * shrinkY, left: padding.left * shrinkX, right: padding.right * shrinkX };
}

export function RouteMap({ routes, selectedRoute, heatmap, layer, highlightedMile, onCheckpoint, onCheckpointHover }: RouteMapProps) {
  const mapHost = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const onCheckpointRef = useRef(onCheckpoint);
  onCheckpointRef.current = onCheckpoint;
  const onCheckpointHoverRef = useRef(onCheckpointHover);
  onCheckpointHoverRef.current = onCheckpointHover;
  const latestData = useRef({ routes, selectedRoute, heatmap, layer, highlightedMile });
  latestData.current = { routes, selectedRoute, heatmap, layer, highlightedMile };
  const setMapMetrics = usePlannerStore(state => state.setMapMetrics);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!mapHost.current) return;
    let map: MapInstance;
    try {
      const canvas = document.createElement('canvas');
      if (!canvas.getContext('webgl') && !canvas.getContext('experimental-webgl')) { setFallback(true); return; }
      map = new MapInstance({
        container: mapHost.current,
        style: mapStyle,
        center: [-91.1, 33.1],
        zoom: 5.2,
        minZoom: 3,
        maxZoom: 11,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      map.on('load', () => {
        map.addSource('weather', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        // Under the routes so lines and checkpoints stay readable. Radius doubles per zoom level,
        // matching how far apart the ~0.25° forecast cells are on screen.
        map.addLayer({ id: 'weather-heatmap', type: 'heatmap', source: 'weather', paint: {
          'heatmap-weight': ['get', 'intensity'],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, .9, 9, 1.6],
          'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 3, 9, 6, 72, 9, 576],
          'heatmap-opacity': .78,
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(34,184,166,0)', .12, 'rgba(34,184,166,.35)', .35, '#22B8A6', .55, '#D9A520', .75, '#E8742A', 1, '#C8312B'],
        } });
        map.addSource('routes', { type: 'geojson', data: routeCollection(null, []) });
        map.addLayer({ id: 'route-casing', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': .94 } });
        map.addLayer({ id: 'route-lines', type: 'line', source: 'routes', filter: ['!=', ['get', 'risk_level'], 'no_travel'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'] } });
        map.addLayer({ id: 'route-no-travel', type: 'line', source: 'routes', filter: ['==', ['get', 'risk_level'], 'no_travel'], layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'], 'line-dasharray': [1.3, 1.8] } });
        map.addSource('route-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: 'route-labels', type: 'symbol', source: 'route-labels', layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Bold'], 'text-size': 10.5, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#063A4B', 'text-halo-color': '#ffffff', 'text-halo-width': 4 } });
        map.addSource('endpoints', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: 'endpoint-pins', type: 'circle', source: 'endpoints', paint: { 'circle-radius': 7, 'circle-color': '#F2705E', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
        map.addSource('checkpoints', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: 'checkpoint-dots', type: 'circle', source: 'checkpoints', paint: { 'circle-radius': ['case', ['get', 'selected'], 8, 5], 'circle-color': ['get', 'color'], 'circle-stroke-width': ['case', ['get', 'selected'], 3, 2], 'circle-stroke-color': ['case', ['get', 'selected'], '#22B8A6', '#fff'] } });
        map.moveLayer('route-labels'); // route summaries stay readable above checkpoint dots
        map.on('click', 'checkpoint-dots', event => {
          const mile = event.features?.[0]?.properties?.mile;
          const feature = event.features?.[0];
          if (typeof mile === 'number' && feature) {
            onCheckpointRef.current?.(mile);
            const props = feature.properties ?? {};
            const content = document.createElement('div');
            content.className = 'map-popup';
            const title = document.createElement('strong');
            title.textContent = `Mile ${mile}`;
            const detail = document.createElement('span');
            detail.textContent = `ETA ${String(props.eta)} (forecast +${String(props.hour)}h) · ${String(props.riskLabel)} · Wind ${String(props.wind)} mph · Rain ${String(props.rain)} in/hr · Snow ${String(props.snow)} in/hr`;
            content.append(title, detail);
            new Popup({ closeButton: true, maxWidth: '250px' }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
          }
        });
        map.on('mousemove', 'checkpoint-dots', event => {
          map.getCanvas().style.cursor = 'pointer';
          const mile = event.features?.[0]?.properties?.mile;
          onCheckpointHoverRef.current?.(typeof mile === 'number' ? mile : null);
        });
        map.on('mouseleave', 'checkpoint-dots', () => {
          map.getCanvas().style.cursor = '';
          onCheckpointHoverRef.current?.(null);
        });
        map.on('mousemove', event => setMapMetrics(event.lngLat.lat, event.lngLat.lng, map.getZoom()));
        map.on('zoom', () => {
          const center = map.getCenter();
          setMapMetrics(center.lat, center.lng, map.getZoom());
        });
        const current = latestData.current;
        (map.getSource('routes') as GeoJSONSource).setData(routeCollection(current.selectedRoute, current.routes));
        (map.getSource('checkpoints') as GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: checkpointFeatures(current.selectedRoute?.checkpoints ?? [], current.highlightedMile),
        });
        (map.getSource('route-labels') as GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: labelFeatures(current.routes),
        });
        (map.getSource('endpoints') as GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: current.selectedRoute ? [current.selectedRoute.geometry[0], current.selectedRoute.geometry[current.selectedRoute.geometry.length - 1]].map((point, index) => ({ type: 'Feature', properties: { end: index }, geometry: { type: 'Point', coordinates: point } })) : [],
        });
        (map.getSource('weather') as GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: (current.heatmap?.points ?? []).map(p => ({ type: 'Feature', properties: { intensity: p.intensity }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })),
        });
        setMapMetrics(map.getCenter().lat, map.getCenter().lng, map.getZoom());
        map.resize();
      });
      const resizeObserver = new ResizeObserver(() => map.resize());
      resizeObserver.observe(mapHost.current);
      const kick = window.setTimeout(() => map.resize(), 200);
      return () => {
        window.clearTimeout(kick);
        resizeObserver.disconnect();
        map.remove();
        mapRef.current = null;
      };
    } catch {
      setFallback(true);
      return;
    }
  }, [setMapMetrics]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    let frame = 0;
    frame = window.requestAnimationFrame(() => {
      (map.getSource('routes') as GeoJSONSource | undefined)?.setData(routeCollection(selectedRoute, routes));
      const points = selectedRoute?.checkpoints ?? [];
      (map.getSource('checkpoints') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: checkpointFeatures(points, highlightedMile),
      });
      (map.getSource('route-labels') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: labelFeatures(routes),
      });
      (map.getSource('endpoints') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: selectedRoute ? [selectedRoute.geometry[0], selectedRoute.geometry[selectedRoute.geometry.length - 1]].map((point, index) => ({ type: 'Feature', properties: { end: index }, geometry: { type: 'Point', coordinates: point } })) : [],
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [routes, selectedRoute, highlightedMile]);

  // Only re-fit when the result or the selected route changes, never on checkpoint hover.
  const lastFit = useRef('');
  useEffect(() => {
    const map = mapRef.current;
    const lines = selectedRoute ? [selectedRoute.geometry] : routes.map(route => route.geometry);
    const points = lines.flat();
    const fitKey = `${routes.map(route => route.id + route.distance_mi).join()}|${selectedRoute?.id ?? ''}`;
    if (!map || !points.length || fitKey === lastFit.current) return;
    lastFit.current = fitKey;
    const bounds = points.reduce((b, point) => b.extend(point), new LngLatBounds(points[0], points[0]));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    map.fitBounds(bounds, { padding: fitPadding(map.getContainer()), duration: reduced ? 0 : 900, maxZoom: 7.5 });
  }, [routes, selectedRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const frame = window.requestAnimationFrame(() => {
      (map.getSource('weather') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: (heatmap?.points ?? []).map(p => ({ type: 'Feature', properties: { intensity: p.intensity }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [heatmap, layer]);

  return (
    <div className="map-container" ref={mapHost}>
      {fallback && <div className="static-map" aria-label="Static Dallas to Atlanta route map">
        <svg viewBox="0 0 1000 650" preserveAspectRatio="xMidYMid slice">
          <defs><pattern id="grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M 36 0 L 0 0 0 36" fill="none" stroke="#cedbd8" strokeWidth="1" /></pattern></defs>
          <rect width="1000" height="650" fill="#eaf1ef" /><rect width="1000" height="650" fill="url(#grid)" />
          <path d="M100 458 C280 430 420 280 590 310 S800 196 920 130" stroke="#91aaa9" />
          {routes.map((route, i) => <path key={route.id} d={i === 0 ? 'M190 446 C360 395 480 330 628 270 S810 184 900 126' : i === 1 ? 'M190 446 C320 505 480 330 625 353 S790 196 900 126' : 'M190 446 C370 460 505 430 638 390 S810 245 900 126'} stroke={route.id === selectedRoute?.id ? '#063A4B' : '#91aaa9'} opacity={route.id === selectedRoute?.id ? 1 : .55} />)}
          <circle cx="190" cy="446" r="8" fill="#F2705E" /><circle cx="900" cy="126" r="8" fill="#F2705E" />
          <text x="155" y="478" fill="#063A4B" fontSize="14" fontFamily="monospace">DALLAS</text><text x="870" y="107" fill="#063A4B" fontSize="14" fontFamily="monospace">ATLANTA</text>
        </svg>
      </div>}
    </div>
  );
}
