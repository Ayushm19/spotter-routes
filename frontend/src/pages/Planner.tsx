import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Popover from '@radix-ui/react-popover';
import * as Slider from '@radix-ui/react-slider';
import { addHours, format } from 'date-fns';
import { ArrowDownUp, ArrowLeft, ArrowRight, Check, LoaderCircle, MapPin, Pause, Play, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { analyzeRoute, geocode, getHeatmap, ApiRequestError } from '@/api/client';
import type { AnalyzeRequest, AnalyzeResponse, Checkpoint, ForecastLayer, HeatmapResponse, HeatmapPoint, Place, RiskLevel, Route, SampleInterval } from '@/api/types';
import { InstrumentBar } from '@/components/InstrumentBar';
import { RouteMap } from '@/components/RouteMap';
import { usePlannerStore } from '@/lib/store';
import { riskColor } from '@/lib/risk';

const levelNames: Record<RiskLevel, string> = { low: 'Low', moderate: 'Moderate', high: 'High', severe: 'Severe', no_travel: 'No travel' };
const intervals: SampleInterval[] = [10, 25, 50];
const layerNames: { key: ForecastLayer; label: string }[] = [{ key: 'risk', label: 'Risk' }, { key: 'wind', label: 'Wind' }, { key: 'rain', label: 'Rain' }, { key: 'snow', label: 'Snow' }];

/**
 * Cross-fade two hourly heatmap frames. API frames are fixed grid cells (matched by
 * position; a cell missing from one frame has intensity 0 there). Frames whose cells
 * don't line up, like the mock's drifting storm, are paired by index instead.
 */
function blendFrames(a: HeatmapPoint[], b: HeatmapPoint[], t: number): HeatmapPoint[] {
  const key = (p: HeatmapPoint) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
  const inB = new Map(b.map(p => [key(p), p]));
  const shared = a.filter(p => inB.has(key(p))).length;
  if (a.length && shared / a.length < .5 && a.length === b.length) {
    return a.map((p, i) => ({ lat: p.lat + (b[i].lat - p.lat) * t, lng: p.lng + (b[i].lng - p.lng) * t, intensity: p.intensity + (b[i].intensity - p.intensity) * t }));
  }
  const inA = new Set(a.map(key));
  return [
    ...a.map(p => ({ ...p, intensity: p.intensity + ((inB.get(key(p))?.intensity ?? 0) - p.intensity) * t })),
    ...b.filter(p => !inA.has(key(p))).map(p => ({ ...p, intensity: p.intensity * t })),
  ];
}

function localDateInput() {
  const date = new Date();
  const nextQuarterHour = Math.ceil(date.getTime() / (15 * 60_000)) * 15 * 60_000;
  return toLocalInput(new Date(nextQuarterHour));
}

function toLocalInput(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function toOffsetISOString(date: Date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${toLocalInput(date)}:00${sign}${hours}:${minutes}`;
}

function LocationField({ label, value, onChange, onSelect, selected }: {
  label: string; value: string; onChange: (value: string) => void; onSelect: (place: Place) => void; selected: boolean;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(value), 250);
    return () => window.clearTimeout(timer);
  }, [value]);
  const { data: suggestions = [], isFetching } = useQuery({
    queryKey: ['geocode', query],
    queryFn: () => geocode(query),
    enabled: !selected && query.trim().length >= 2,
    staleTime: 60_000,
  });
  const open = focused && !selected && value.trim().length >= 2 && suggestions.length > 0;
  const choose = (place: Place) => {
    onSelect(place);
    setActive(0);
  };
  return (
    <div style={{ marginTop: 12 }}>
      <label className="field-label">{label}</label>
      <Popover.Root open={open}>
        <Popover.Anchor asChild>
          <div style={{ position: 'relative' }}>
            <MapPin size={13} color="var(--muted)" style={{ position: 'absolute', top: 13, left: 10 }} />
            <input
              ref={inputRef} className="field-input" style={{ paddingLeft: 31, paddingRight: 28 }} value={value}
              onChange={event => { onChange(event.target.value); setActive(0); }}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' && suggestions.length) { event.preventDefault(); setActive(index => (index + 1) % suggestions.length); }
                if (event.key === 'ArrowUp' && suggestions.length) { event.preventDefault(); setActive(index => (index - 1 + suggestions.length) % suggestions.length); }
                if (event.key === 'Enter' && suggestions[active]) { event.preventDefault(); choose(suggestions[active]); }
                if (event.key === 'Escape') inputRef.current?.blur();
              }}
              onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
              aria-label={label} autoComplete="off"
            />
            {isFetching && <LoaderCircle size={13} className="spin" style={{ position: 'absolute', right: 9, top: 13 }} />}
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content className="suggestion-popover" sideOffset={4} align="start" onOpenAutoFocus={event => event.preventDefault()}>
            {suggestions.map((place, index) => (
              <button key={`${place.label}-${place.lat}`} type="button" className={index === active ? 'suggestion active' : 'suggestion'} onMouseDown={event => event.preventDefault()} onClick={() => choose(place)}>
                <MapPin size={13} /><span>{place.label}</span><small>{place.lat.toFixed(3)} / {place.lng.toFixed(3)}</small>
              </button>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function RiskBar({ route }: { route: Route }) {
  const total = Math.max(1, route.risk.low_miles + route.risk.moderate_miles + route.risk.high_miles + route.risk.severe_miles + route.risk.no_travel_miles);
  const values: Record<RiskLevel, number> = {
    low: route.risk.low_miles, moderate: route.risk.moderate_miles, high: route.risk.high_miles,
    severe: route.risk.severe_miles, no_travel: route.risk.no_travel_miles,
  };
  return (
    <div className="route-risk-line" role="img" aria-label="Route risk miles by severity">
      {(['low', 'moderate', 'high', 'severe', 'no_travel'] as RiskLevel[]).map(level => {
        const miles = values[level];
        return miles > 0 ? <i key={level} title={`${levelNames[level]}: ${miles} miles`} style={{ width: `${(miles / total) * 100}%`, background: level === 'no_travel' ? `repeating-linear-gradient(135deg,${riskColor(level)} 0 3px,#fff 3px 5px)` : riskColor(level) }} /> : null;
      })}
    </div>
  );
}

function CheckpointRow({ checkpoint, highlighted, onHighlight, onActivate }: {
  checkpoint: Checkpoint;
  highlighted: boolean;
  onHighlight: (mile: number | null) => void;
  onActivate: (checkpoint: Checkpoint) => void;
}) {
  return (
    <button
      type="button"
      className={`checkpoint-item${highlighted ? ' is-highlighted' : ''}`}
      onMouseEnter={() => onHighlight(checkpoint.mile)}
      onMouseLeave={() => onHighlight(null)}
      onFocus={() => onHighlight(checkpoint.mile)}
      onBlur={() => onHighlight(null)}
      onClick={event => { event.stopPropagation(); onActivate(checkpoint); }}
      onKeyDown={event => event.stopPropagation()}
      aria-label={`Mile ${checkpoint.mile}, ${format(new Date(checkpoint.eta), 'h:mm a')}, ${levelNames[checkpoint.risk_level]}, wind ${checkpoint.weather.wind_mph} miles per hour, rain ${checkpoint.weather.rain_in_hr.toFixed(2)} inches per hour, snow ${checkpoint.weather.snow_in_hr.toFixed(1)} inches per hour`}
    >
      <span className="mile">M{checkpoint.mile}</span>
      <span className="checkpoint-data">
        <strong>{format(new Date(checkpoint.eta), 'EEE h:mm a')} · {checkpoint.weather.wind_mph} mph wind</strong>
        <small>Rain {checkpoint.weather.rain_in_hr.toFixed(2)} · Snow {checkpoint.weather.snow_in_hr.toFixed(1)} in/hr · {checkpoint.reason}</small>
      </span>
      <span className={`risk-text risk-${checkpoint.risk_level}`}>{levelNames[checkpoint.risk_level]}</span>
    </button>
  );
}

function CheckpointList({ checkpoints, highlightedMile, onHighlight, onActivate }: {
  checkpoints: Checkpoint[];
  highlightedMile: number | null;
  onHighlight: (mile: number | null) => void;
  onActivate: (checkpoint: Checkpoint) => void;
}) {
  const rowHeight = 62;
  const viewportHeight = 220;
  const [scrollTop, setScrollTop] = useState(0);
  const virtualized = checkpoints.length > 40;
  const start = virtualized ? Math.max(0, Math.floor(scrollTop / rowHeight) - 2) : 0;
  const end = virtualized ? Math.min(checkpoints.length, start + Math.ceil(viewportHeight / rowHeight) + 5) : checkpoints.length;
  return (
    <div className="checkpoint-scroll" style={{ height: virtualized ? viewportHeight : 'auto', maxHeight: viewportHeight }} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {virtualized && <div style={{ height: start * rowHeight }} aria-hidden="true" />}
      {checkpoints.slice(start, end).map(checkpoint => <CheckpointRow key={checkpoint.mile} checkpoint={checkpoint} highlighted={highlightedMile === checkpoint.mile} onHighlight={onHighlight} onActivate={onActivate} />)}
      {virtualized && <div style={{ height: Math.max(0, (checkpoints.length - end) * rowHeight) }} aria-hidden="true" />}
    </div>
  );
}

function RouteCard({ route, selected, recommended, onClick, highlightedMile, onHighlight, onCheckpoint }: {
  route: Route;
  selected: boolean;
  recommended: boolean;
  onClick: () => void;
  highlightedMile: number | null;
  onHighlight: (mile: number | null) => void;
  onCheckpoint: (checkpoint: Checkpoint) => void;
}) {
  return (
    <motion.article layout className={`route-card${selected ? ' selected' : ''}`} role="button" aria-pressed={selected} tabIndex={0} onClick={onClick} onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }}>
      {selected && <motion.i className="selected-route-rule" layoutId="selected-route-rule" aria-hidden="true" />}
      <div className="route-top"><span className="route-name">{route.label}</span>{recommended && <span className="recommend-tag">Recommended</span>}</div>
      <div className="route-stats"><span>{route.distance_mi} mi</span><span>{Math.floor(route.duration_min / 60)}h {String(route.duration_min % 60).padStart(2, '0')}m</span><span>ETA {format(new Date(route.eta), 'h:mm a')}</span></div>
      <RiskBar route={route} />
      <div className="route-bottom">
        <span><b style={{ color: riskColor(route.risk.level) }}>{levelNames[route.risk.level]}</b> · {route.risk.severe_miles} severe mi · avg {route.risk.avg_score}</span>
        {route.blocked && <span className="blocked-label">NO TRAVEL</span>}
      </div>
      {selected && route.checkpoints.length > 0 && (
        <div className="checkpoint-list">
          <h4>All checkpoints · {route.checkpoints.length}</h4>
          <CheckpointList checkpoints={route.checkpoints} highlightedMile={highlightedMile} onHighlight={onHighlight} onActivate={onCheckpoint} />
        </div>
      )}
    </motion.article>
  );
}

export default function Planner() {
  const reduceMotion = useReducedMotion();
  const queryClient = useQueryClient();
  const [origin, setOrigin] = useState<Place>({ label: 'Dallas, TX', lat: 32.7767, lng: -96.797 });
  const [destination, setDestination] = useState<Place>({ label: 'Atlanta, GA', lat: 33.749, lng: -84.388 });
  const [departure, setDeparture] = useState(localDateInput);
  const [load, setLoad] = useState(38000);
  const [sampleInterval, setSampleInterval] = useState<SampleInterval>(25);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [sheetSnap, setSheetSnap] = useState<'low' | 'mid' | 'high'>('mid');
  const [highlightedMile, setHighlightedMile] = useState<number | null>(null);
  const selectedRouteId = usePlannerStore(state => state.selectedRouteId);
  const setSelectedRouteId = usePlannerStore(state => state.setSelectedRouteId);
  const hour = usePlannerStore(state => state.hour);
  const setHour = usePlannerStore(state => state.setHour);
  const playing = usePlannerStore(state => state.playing);
  const setPlaying = usePlannerStore(state => state.setPlaying);
  const layer = usePlannerStore(state => state.layer);
  const setLayer = usePlannerStore(state => state.setLayer);
  const touchStart = useRef(0);
  const mutation = useMutation({ mutationFn: analyzeRoute, onSuccess: result => {
    setAnalysis(result);
    setSelectedRouteId(result.recommended_route_id ?? result.routes[0]?.id ?? null);
    setHour(0);
    setHighlightedMile(null);
  } });

  const departureDate = new Date(departure);
  const now = new Date();
  const validDeparture = Number.isFinite(departureDate.getTime()) && departureDate.getTime() >= now.getTime() && departureDate.getTime() <= addHours(now, 48).getTime();
  const request = (): AnalyzeRequest => ({
    origin, destination,
    departure_time: toOffsetISOString(departureDate),
    load_lbs: Number(load),
    sample_interval_miles: sampleInterval,
  });
  const validPlaces = Number.isFinite(origin.lat) && Number.isFinite(origin.lng) && Number.isFinite(destination.lat) && Number.isFinite(destination.lng);
  const closeEnoughToLoad = Number(load) > 0 && Number(load) <= 80000;
  const readyToAnalyze = closeEnoughToLoad && validPlaces && validDeparture;
  const runAnalysis = () => {
    if (!readyToAnalyze) return;
    mutation.mutate(request());
  };

  const selectedRoute = analysis?.routes.find(route => route.id === selectedRouteId) ?? null;
  const roundedHour = Math.max(0, Math.min(48, Math.round(hour)));
  const heatQuery = useQuery({
    queryKey: ['heatmap', analysis?.analysis_id, roundedHour, layer],
    queryFn: () => getHeatmap(analysis?.analysis_id ?? '', roundedHour, layer),
    enabled: !!analysis,
    staleTime: 45_000,
    gcTime: 10 * 60_000,
  });
  useEffect(() => {
    if (!analysis) return;
    const analysisId = analysis.analysis_id;
    const layerAtStart = layer;
    const keyFor = (targetHour: number) => ['heatmap', analysisId, targetHour, layerAtStart] as const;
    for (let delta = -3; delta <= 3; delta++) {
      const targetHour = roundedHour + delta;
      if (targetHour < 0 || targetHour > 48) continue;
      void queryClient.prefetchQuery({
        queryKey: keyFor(targetHour),
        queryFn: () => getHeatmap(analysisId, targetHour, layerAtStart),
        staleTime: 45_000,
      });
    }
    if (playing) return;
    let targetHour = 0;
    let timer = 0;
    const remaining = Array.from({ length: 49 }, (_, index) => index).filter(target => Math.abs(target - roundedHour) > 3);
    const prefetchWhenIdle = () => {
      timer = window.setTimeout(() => {
        const nextHour = remaining[targetHour];
        if (nextHour === undefined) return;
        targetHour++;
        void queryClient.prefetchQuery({
          queryKey: keyFor(nextHour),
          queryFn: () => getHeatmap(analysisId, nextHour, layerAtStart),
          staleTime: 45_000,
        });
        prefetchWhenIdle();
      }, 300);
    };
    timer = window.setTimeout(prefetchWhenIdle, 1200);
    return () => window.clearTimeout(timer);
  }, [analysis?.analysis_id, layer, roundedHour, playing, queryClient]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setHour(hour >= 48 ? 0 : Math.min(48, hour + 1)), 350);
    return () => window.clearInterval(timer);
  }, [playing, hour, setHour]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, button, [contenteditable="true"]')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setPlaying(!playing);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        setHour(hour + direction * (event.shiftKey ? 6 : 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hour, playing, setHour, setPlaying]);
  const setCheckpointHour = useCallback((mile: number) => {
    const checkpoint = selectedRoute?.checkpoints.find(item => item.mile === mile);
    if (checkpoint) {
      setHighlightedMile(checkpoint.mile);
      setHour(checkpoint.forecast_hour);
      setPlaying(false);
    }
  }, [selectedRoute, setHour, setPlaying]);
  const selectCheckpoint = useCallback((checkpoint: Checkpoint) => {
    setHighlightedMile(checkpoint.mile);
    setHour(checkpoint.forecast_hour);
    setPlaying(false);
  }, [setHour, setPlaying]);
  const heatmap = useMemo<HeatmapResponse | undefined>(() => {
    if (!analysis) return undefined;
    const lowerHour = Math.floor(hour);
    const upperHour = Math.ceil(hour);
    const lower = queryClient.getQueryData<HeatmapResponse>(['heatmap', analysis.analysis_id, lowerHour, layer]);
    const upper = queryClient.getQueryData<HeatmapResponse>(['heatmap', analysis.analysis_id, upperHour, layer]);
    if (!lower) return heatQuery.data;
    if (!upper || lowerHour === upperHour) return lower;
    return { hour, layer, points: blendFrames(lower.points, upper.points, hour - lowerHour) };
  }, [analysis, layer, hour, heatQuery.data, queryClient]);
  const recommendedRoute = analysis?.routes.find(route => route.id === analysis.recommended_route_id) ?? null;
  const forecastTime = addHours(new Date(), hour);
  const hourLabel = `${format(forecastTime, 'EEE HH:mm')} · +${Math.round(hour)}H`;
  const unitLabel = layer === 'wind' ? 'MPH' : layer === 'risk' ? 'SCORE' : 'IN/HR';

  return (
    <>
      <InstrumentBar />
      <div className="planner-shell">
        <motion.section className="map-stage" layoutId="route-map-transition" aria-label="Route map and weather timeline">
          <RouteMap routes={analysis?.routes ?? []} selectedRoute={selectedRoute} heatmap={heatmap} layer={layer} highlightedMile={highlightedMile} onCheckpoint={setCheckpointHour} onCheckpointHover={setHighlightedMile} />
          <div className="map-overlay map-legend">
            <h3>Weather exposure</h3>
            {(['low', 'moderate', 'high', 'severe', 'no_travel'] as RiskLevel[]).map(level => <div key={level} className="legend-entry"><i className={level === 'no_travel' ? 'hatch' : ''} style={{ '--risk-color': riskColor(level), background: level === 'no_travel' ? undefined : riskColor(level) } as CSSProperties} /><span>{levelNames[level]}</span></div>)}
          </div>
          <div className="map-overlay forecast-legend">
            <strong>{layer === 'risk' ? 'ROUTE RISK' : `${layer.toUpperCase()} · ${unitLabel}`}</strong>
            {layer === 'risk' ? <span>LOW — MODERATE — HIGH — SEVERE</span> : <><i className={`forecast-ramp ramp-${layer}`} /><span>{layer === 'wind' ? '0 — 30 — 60+' : '0 — 0.5 — 1.0+'} {unitLabel}</span></>}
            {analysis && heatmap && heatmap.points.length === 0 && <span className="forecast-empty">Nothing elevated at this hour along the corridor.</span>}
          </div>
          <div className="map-overlay layer-control" aria-label="Weather layer">
            {layerNames.map(item => <button type="button" key={item.key} onClick={() => setLayer(item.key)} className={layer === item.key ? 'active' : ''}>{item.label}</button>)}
          </div>
          <div className="map-overlay timeline-overlay">
            <div className="timeline-head"><strong>Forecast timeline</strong><span>HOUR {String(Math.round(hour)).padStart(2, '0')} / 48 · {layer.toUpperCase()}</span></div>
            <div className="timeline-row">
              <button type="button" className="play-button" aria-label={playing ? 'Pause timeline' : 'Play timeline'} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={13} /> : <Play size={13} />}</button>
              <div className="timeline-control">
                <div className="timeline-bubble" style={{ left: `${(hour / 48) * 100}%`, transform: `translateX(-${(hour / 48) * 100}%)` }}>{hourLabel}</div>
                <div className="timeline-mark departure-marker" style={{ left: `${Math.max(0, Math.min(100, ((departureDate.getTime() - now.getTime()) / 3600000 / 48) * 100))}%` }} title="Departure time" />
                {selectedRoute && <div className="timeline-mark eta-marker" style={{ left: `${Math.max(0, Math.min(100, ((new Date(selectedRoute.eta).getTime() - now.getTime()) / 3600000 / 48) * 100))}%` }} title="Selected route ETA" />}
                <Slider.Root
                  className="timeline-range"
                  min={0}
                  max={48}
                  step={0.25}
                  value={[hour]}
                  onValueChange={values => { setPlaying(false); setHour(values[0] ?? 0); }}
                  onKeyDown={event => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                      event.preventDefault();
                      const direction = event.key === 'ArrowRight' ? 1 : -1;
                      setHour(hour + direction * (event.shiftKey ? 6 : 1));
                    } else if (event.code === 'Space') {
                      event.preventDefault();
                      setPlaying(!playing);
                    }
                  }}
                  aria-label="Forecast hour"
                >
                  <Slider.Track className="slider-track"><Slider.Range className="slider-range" /></Slider.Track>
                  <Slider.Thumb className="slider-thumb" aria-label="Forecast hour" />
                </Slider.Root>
              </div>
              <span className="mono" style={{ fontSize: 10, width: 29 }}>{String(Math.round(hour)).padStart(2, '0')}h</span>
            </div>
            <div className="timeline-marks"><span>{format(now, 'EEE HH:mm')}</span><span>{format(addHours(now, 12), 'EEE HH:mm')}</span><span>{format(addHours(now, 24), 'EEE HH:mm')}</span><span>{format(addHours(now, 36), 'EEE HH:mm')}</span><span>{format(addHours(now, 48), 'EEE HH:mm')}</span></div>
            <div className="timeline-flags"><span><i className="departure-key" />DEPART · {format(departureDate, 'h:mm a')}</span>{selectedRoute && <span><i className="eta-key" />ETA · {format(new Date(selectedRoute.eta), 'EEE h:mm a')}</span>}</div>
          </div>
        </motion.section>

        <motion.aside initial={reduceMotion ? false : { x: -16, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ duration: reduceMotion ? 0 : .48, ease: [0.16, 1, 0.3, 1] }} className={`planner-panel${mutation.isPending ? ' is-loading' : ''}`} data-snap={sheetSnap}>
          <div className="panel-progress" aria-hidden="true" />
          <div className="mobile-sheet-grip" onTouchStart={event => { touchStart.current = event.touches[0]?.clientY ?? 0; }} onTouchEnd={event => {
            const delta = (event.changedTouches[0]?.clientY ?? touchStart.current) - touchStart.current;
            setSheetSnap(delta < -45 ? (sheetSnap === 'low' ? 'mid' : 'high') : delta > 45 ? (sheetSnap === 'high' ? 'mid' : 'low') : sheetSnap);
          }} onKeyDown={event => {
            if (event.key === 'ArrowUp') setSheetSnap(sheetSnap === 'low' ? 'mid' : 'high');
            if (event.key === 'ArrowDown') setSheetSnap(sheetSnap === 'high' ? 'mid' : 'low');
          }} role="button" tabIndex={0} aria-label="Drag to resize route planner" />
          <div className="panel-head">
            <Link to="/" className="back-link"><ArrowLeft size={14} /> Spotter Routes</Link>
            <div className="eyebrow" style={{ color: 'var(--muted)', marginTop: 11 }}>DISPATCH / ROUTE ANALYSIS</div>
            <h1>Plan a truck <span className="serif-italic">route</span></h1>
            <p>Compare conditions along three corridor options.</p>
          </div>
          <div className="form-block">
            <LocationField label="Origin" value={origin.label} onChange={value => setOrigin({ ...origin, label: value, lat: Number.NaN, lng: Number.NaN })} onSelect={setOrigin} selected={Number.isFinite(origin.lat) && Number.isFinite(origin.lng)} />
            <button type="button" className="swap-locations" aria-label="Swap origin and destination" onClick={() => { setOrigin(destination); setDestination(origin); }}><ArrowDownUp size={13} /> Swap locations</button>
            <LocationField label="Destination" value={destination.label} onChange={value => setDestination({ ...destination, label: value, lat: Number.NaN, lng: Number.NaN })} onSelect={setDestination} selected={Number.isFinite(destination.lat) && Number.isFinite(destination.lng)} />
            <div className="field-row">
              <div><label className="field-label" htmlFor="departure-input">Departure</label><input id="departure-input" type="datetime-local" min={toLocalInput(now)} max={toLocalInput(addHours(now, 48))} className="field-input" value={departure} onChange={event => setDeparture(event.target.value)} /></div>
              <div><label className="field-label" htmlFor="load-input">Load weight</label><div className="load-control"><input id="load-input" type="number" min={1} max={80000} step={500} value={load} onChange={event => setLoad(Number(event.target.value))} /><span>LB</span></div></div>
            </div>
            <input type="range" min="0" max="80000" step="500" value={load} className="load-range" aria-label="Load weight adjustment" onChange={event => setLoad(Number(event.target.value))} />
            <div className="tick-row"><span>0</span><span>30K</span><span>40K</span><span>80K MAX</span></div>
            <div style={{ marginTop: 13 }}>
              <div className="field-label">Checkpoint spacing</div>
              <div className="spacing-options">{intervals.map(interval => <button type="button" key={interval} className={sampleInterval === interval ? 'active' : ''} onClick={() => setSampleInterval(interval)}>{interval} MI</button>)}</div>
            </div>
            {!closeEnoughToLoad && <div className="load-error" role="alert">Enter a load from 1 to 80,000 lb.</div>}
            {!validDeparture && <div className="load-error" role="alert">Choose a departure time within the next 48 hours.</div>}
            <button type="button" className="analyze-button" onClick={runAnalysis} disabled={mutation.isPending || !readyToAnalyze}>
              {mutation.isPending ? <><LoaderCircle size={14} className="spin" /> Reading the forecast…</> : <>Analyze route <ArrowRight size={14} /></>}
            </button>
            {mutation.isError && <div className="inline-error" role="alert"><span>{mutation.error instanceof ApiRequestError ? `${mutation.error.code} · ${mutation.error.message}` : mutation.error.message || 'Route analysis could not load.'}</span><button type="button" onClick={runAnalysis}><RefreshCw size={12} /> Retry</button></div>}
          </div>
          <div className="route-results" aria-live="polite">
            <div className="results-header"><h2>Route options</h2><span>{analysis ? '3 CORRIDORS' : 'READY WHEN YOU ARE'}</span></div>
            {mutation.isPending && <div className="route-skeleton"><i /><i /><i /></div>}
            {!analysis && !mutation.isPending && <div className="empty-results">Set the trip details, then analyze to compare weather exposure on three truck-friendly routes.</div>}
            {recommendedRoute && <div className="recommended-summary">
              <div className="eyebrow">RECOMMENDED CORRIDOR</div>
              <h3>{recommendedRoute.label} · {Math.floor(recommendedRoute.duration_min / 60)}h {String(recommendedRoute.duration_min % 60).padStart(2, '0')}m</h3>
              <p>{analysis?.recommendation_reason}</p>
              <RiskBar route={recommendedRoute} />
              <span className="summary-meta">{recommendedRoute.distance_mi} MI · {recommendedRoute.risk.severe_miles} SEVERE MI · AVG RISK {recommendedRoute.risk.avg_score}</span>
            </div>}
            {analysis?.routes.map(route => <RouteCard
              key={route.id}
              route={route}
              selected={route.id === selectedRouteId}
              recommended={route.id === analysis.recommended_route_id}
              onClick={() => setSelectedRouteId(route.id)}
              highlightedMile={highlightedMile}
              onHighlight={setHighlightedMile}
              onCheckpoint={selectCheckpoint}
            />)}
            {analysis && <div className="recommendation-note"><Check size={13} /><span>{analysis.recommendation_reason}</span></div>}
            {analysis && heatQuery.isError && <div className="heat-error" role="status">Weather layer unavailable. <button type="button" onClick={() => void heatQuery.refetch()}>Retry layer</button></div>}
          </div>
        </motion.aside>
      </div>
    </>
  );
}
