import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { AttributionControl, Map as MapInstance, Marker, ScaleControl, type ExpressionSpecification, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@/lib/maplibreWorker';
import {
  HEX_KINDS, LIGHT_STYLE, along, hexImage, keyCheckpoint, scoredCheckpoints, stormFeatures, storyRoutes, tintLightMap,
  type LngLat, type RouteId, type SceneFrame,
} from '@/lib/storyScene';

export type { SceneFrame };

const RESOLVE_HOURS = 16;
const ease = (x: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);

function routeColor(id: RouteId, f: SceneFrame) {
  if (f.blocked && id === 'a') return '#8E2B3F';
  if (f.focus === id) return '#063A4B';
  return f.focus ? '#A9BCC2' : '#3F6E7C';
}

/** Reveal gradient: drawn part in colour, the rest transparent. */
function revealGradient(color: string, p: number): ExpressionSpecification {
  if (p <= 0.001) return ['step', ['line-progress'], 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,0)'];
  if (p >= 0.999) return ['step', ['line-progress'], color, 1, color];
  return ['step', ['line-progress'], color, p, 'rgba(0,0,0,0)'];
}

const routeReveal = (f: SceneFrame, index: number) => ease(f.reveal * 1.5 - index * .25);

export function StoryMap({ frame, initial, className, label }: {
  frame: MutableRefObject<SceneFrame>;
  initial: { center: LngLat; zoom: number };
  className?: string;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (!document.createElement('canvas').getContext('webgl')) { setFailed(true); return; }
    let map: MapInstance;
    try {
      map = new MapInstance({
        container: el, style: LIGHT_STYLE, center: initial.center, zoom: initial.zoom,
        interactive: false, attributionControl: false, fadeDuration: 0,
      });
    } catch {
      setFailed(true);
      return;
    }
    map.addControl(new ScaleControl({ unit: 'imperial', maxWidth: 88 }), 'bottom-left');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');

    // The key-checkpoint card is DOM, so it gets real typography; MapLibre keeps it pinned.
    const card = document.createElement('div');
    card.className = 'story-callout';
    card.innerHTML = `<i class="story-callout-dot"></i><div><b>MI ${keyCheckpoint.mile} · near Vicksburg, MS</b><span>Gusts ${keyCheckpoint.wind} mph + 38,000 lb</span><em>No travel</em></div>`;
    // Beside the ring on wide maps; below it on phones so the card never runs off-screen.
    const narrow = el.clientWidth < 640;
    const marker = new Marker({ element: card, anchor: narrow ? 'top' : 'left', offset: narrow ? [0, 16] : [14, 0] }).setLngLat(keyCheckpoint.at);

    let raf = 0;
    let visible = true;
    let primed = false; // first frame is applied even off-screen, so scrolling in doesn't pay for it
    let last = '';
    const applied: Record<string, string> = {};
    const changed = (key: string, value: unknown) => {
      const s = JSON.stringify(value);
      if (applied[key] === s) return false;
      applied[key] = s;
      return true;
    };

    map.on('load', () => {
      tintLightMap(map);
      for (const kind of HEX_KINDS) map.addImage(`hex-${kind}`, hexImage(kind), { pixelRatio: 2 });

      map.addSource('storm', { type: 'geojson', data: stormFeatures(0, 0) });
      map.addLayer({ id: 'storm', type: 'heatmap', source: 'storm', paint: {
        'heatmap-weight': ['get', 'w'],
        'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 4, 18, 7, 144],
        'heatmap-intensity': .75,
        'heatmap-opacity': 0,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(34,184,166,0)', .12, 'rgba(34,184,166,.16)', .3, 'rgba(34,184,166,.32)', .5, 'rgba(217,165,32,.42)', .72, 'rgba(232,116,42,.55)', .9, 'rgba(211,63,58,.62)', 1, 'rgba(160,40,60,.68)'],
      } });

      for (const route of storyRoutes) {
        const src = `route-${route.id}`;
        map.addSource(src, { type: 'geojson', lineMetrics: true, data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.line } } });
        map.addLayer({ id: `${src}-casing`, type: 'line', source: src, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 5, 8, 10], 'line-gradient': revealGradient('#ffffff', 0) } });
        map.addLayer({ id: src, type: 'line', source: src, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.2, 8, 4.5], 'line-gradient': revealGradient('#3F6E7C', 0) } });
      }

      map.addSource('callout-ring', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: keyCheckpoint.at } } });
      map.addLayer({ id: 'callout-ring', type: 'circle', source: 'callout-ring', paint: { 'circle-radius': 0, 'circle-color': 'rgba(110,24,48,0)', 'circle-stroke-color': '#6E1830', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0 } });

      map.addSource('cps', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'cps', type: 'symbol', source: 'cps', layout: {
        'icon-image': ['get', 'icon'], 'icon-size': ['get', 's'], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'z'],
      }, paint: { 'icon-opacity': ['get', 'o'] } });

      map.addSource('ends', { type: 'geojson', data: { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { name: 'DALLAS, TX' }, geometry: { type: 'Point', coordinates: storyRoutes[0].line[0] } },
        { type: 'Feature', properties: { name: 'ATLANTA, GA' }, geometry: { type: 'Point', coordinates: storyRoutes[0].line[storyRoutes[0].line.length - 1] } },
      ] } });
      map.addLayer({ id: 'ends', type: 'symbol', source: 'ends', layout: {
        'icon-image': 'hex-origin', 'icon-size': .9, 'icon-allow-overlap': true, 'text-field': ['get', 'name'], 'text-font': ['Open Sans Bold'], 'text-size': 10, 'text-letter-spacing': .12, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-allow-overlap': true,
      }, paint: { 'text-color': '#063A4B', 'text-halo-color': 'rgba(244,247,246,.95)', 'text-halo-width': 2 } });

      map.addSource('truck', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'truck', type: 'symbol', source: 'truck', layout: {
        'icon-image': 'hex-truck', 'icon-size': 1.05, 'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      } });

      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        if (!visible && primed) return;
        primed = true;
        const f = frame.current;
        const key = JSON.stringify(f);
        // The callout ring pulses on its own clock, so keep drawing while it shows.
        if (key === last && !f.callout) return;
        last = key;

        if (f.camera && changed('camera', f.camera)) map.jumpTo(f.camera);

        storyRoutes.forEach((route, index) => {
          const p = routeReveal(f, index);
          const color = routeColor(route.id, f);
          if (changed(`r-${route.id}`, [p, color])) {
            map.setPaintProperty(`route-${route.id}`, 'line-gradient', revealGradient(color, p));
            map.setPaintProperty(`route-${route.id}-casing`, 'line-gradient', revealGradient('#ffffff', p));
            // line-dasharray would disable line-gradient, so a blocked route reads through colour and opacity.
            map.setPaintProperty(`route-${route.id}`, 'line-opacity', f.blocked && route.id === 'a' ? .7 : 1);
          }
        });

        // Quarter-hour steps: the storm moves ~0.06° per step (invisible) and its ~1000-point
        // GeoJSON is re-sent to the map worker 4x per forecast hour instead of every frame.
        const stormKey = [Math.round(f.hour * 4) / 4, Math.round(f.storm * 20) / 20];
        if (changed('storm', stormKey)) {
          (map.getSource('storm') as GeoJSONSource).setData(stormFeatures(f.hour));
          map.setPaintProperty('storm', 'heatmap-opacity', f.storm);
        }

        const cpKey = [Math.round(f.checkpoints * 200), Math.round(f.resolved * 200), f.focus, f.blocked];
        if (changed('cps', cpKey)) {
          const features = scoredCheckpoints.map(cp => {
            const route = storyRoutes.find(r => r.id === cp.routeId)!;
            const order = cp.index / (route.checkpoints.length - 1);
            const pop = ease((f.checkpoints - order * .85) * 8);
            const resolved = f.resolved > 0 && cp.eta / RESOLVE_HOURS <= f.resolved;
            const dim = f.focus && cp.routeId !== f.focus && !(cp.routeId === 'a' && f.blocked && cp.level === 'no_travel');
            return {
              type: 'Feature' as const,
              properties: {
                icon: resolved ? `hex-${cp.level}` : 'hex-pending',
                s: pop * (cp.level === 'no_travel' && resolved ? .82 : .58),
                o: pop <= 0 ? 0 : dim ? .28 : 1,
                z: (resolved ? ['low', 'moderate', 'high', 'severe', 'no_travel'].indexOf(cp.level) : 0) + (cp.routeId === f.focus ? 10 : 0),
              },
              geometry: { type: 'Point' as const, coordinates: cp.at },
            };
          });
          (map.getSource('cps') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
        }

        if (changed('truck', f.truck && [f.truck.route, Math.round(f.truck.t * 600)])) { // ~1.4 mi steps
          const truck = f.truck ? along(storyRoutes.find(r => r.id === f.truck!.route)!, f.truck.t) : null;
          (map.getSource('truck') as GeoJSONSource).setData({ type: 'FeatureCollection', features: truck ? [{ type: 'Feature', properties: { b: truck.bearing }, geometry: { type: 'Point', coordinates: truck.at } }] : [] });
        }

        if (changed('callout', f.callout)) {
          if (f.callout) marker.addTo(map); else marker.remove();
        }
        const pulse = f.callout ? (now / 1400) % 1 : 0;
        map.setPaintProperty('callout-ring', 'circle-radius', f.callout ? 10 + pulse * 26 : 0);
        map.setPaintProperty('callout-ring', 'circle-stroke-opacity', f.callout ? (1 - pulse) * .8 : 0);
      };
      raf = requestAnimationFrame(tick);
    });

    // Stop drawing while scrolled out of view; the map is decorative there.
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; last = ''; }, { rootMargin: '120px' });
    io.observe(el);
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      marker.remove();
      map.remove();
    };
  }, [frame, initial.center, initial.zoom]);

  return (
    <div ref={host} className={`story-map ${className ?? ''}`} role="img" aria-label={label}>
      {failed && <div className="story-map-fallback">Interactive map needs WebGL. The route story still reads below.</div>}
    </div>
  );
}
