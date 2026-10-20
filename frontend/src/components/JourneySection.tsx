import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from 'framer-motion';
import {
  STORY_LOAD_LBS, along, clockLabel, emptyFrame, etaHours, fmtDuration, keyCheckpoint, routeById, storyPick, storyRoutes,
  type LngLat, type SceneFrame,
} from '@/lib/storyScene';

const StoryMap = lazy(() => import('@/components/StoryMap').then(m => ({ default: m.StoryMap })));

const A = routeById('a');
const PICK = routeById(storyPick.id);
const KEY_T = keyCheckpoint.mile / A.distance;
const KEY_HOUR = keyCheckpoint.eta;
const cpCount = A.checkpoints.length;

/** Chapter boundaries as fractions of the section's scroll. */
const CHAPTERS = [
  { at: 0, tag: 'Depart', kicker: '01 · Dallas, TX' },
  { at: .18, tag: 'Corridors', kicker: '02 · The options' },
  { at: .38, tag: 'Checkpoints', kicker: '03 · Sampling' },
  { at: .56, tag: 'Weather', kicker: '04 · At your ETA' },
  { at: .8, tag: 'The call', kicker: '05 · Recommendation' },
];

const COPY = [
  { title: <>06:00. {STORY_LOAD_LBS.toLocaleString()} lb on the trailer.</>, body: 'Every plan starts with where, when and how heavy. The weight matters more than most route planners admit.' },
  { title: <>Three ways east.</>, body: `The router offers ${storyRoutes.map(r => Math.round(r.distance)).join(', ')} miles. On a dry day the fastest one wins and nobody thinks twice.` },
  { title: <>A checkpoint every <span className="serif-italic">25 miles.</span></>, body: `${cpCount} on the fastest route alone. Each one carries the hour the truck will actually reach it, not the hour you leave the yard.` },
  { title: <>The squall reaches mile {keyCheckpoint.mile} at {clockLabel(KEY_HOUR).slice(4)}. <span className="serif-italic">So would you.</span></>, body: `Forecast gusts of ${keyCheckpoint.wind} mph near Vicksburg. With ${STORY_LOAD_LBS.toLocaleString()} lb behind the cab that is not "severe". It is no travel.` },
  { title: <>{PICK.name}. {PICK.durationMin - A.durationMin} minutes longer, <span className="serif-italic">zero</span> risky miles.</>, body: 'Fewest severe miles first, then high, then average risk, then drive time. The same rule every time, so dispatch can explain it.' },
];

const CAMERA: { p: number; center: LngLat; zoom: number }[] = [
  { p: 0, center: [-96.65, 32.8], zoom: 7.6 },
  { p: .16, center: [-96.2, 32.9], zoom: 7.1 },
  { p: .32, center: [-90.6, 33.55], zoom: 5.45 },
  { p: .58, center: [-90.6, 33.4], zoom: 5.5 },
  { p: .7, center: [-91.2, 32.6], zoom: 6.7 },
  { p: .82, center: [-90.4, 33.5], zoom: 5.55 },
  { p: 1, center: [-89.6, 33.6], zoom: 5.6 },
];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const span = (p: number, from: number, to: number) => clamp01((p - from) / (to - from));
const smooth = (x: number) => x * x * (3 - 2 * x);

function cameraAt(p: number, zoomOffset: number) {
  let i = 1;
  while (i < CAMERA.length - 1 && CAMERA[i].p < p) i++;
  const a = CAMERA[i - 1], b = CAMERA[i];
  const t = smooth(span(p, a.p, b.p));
  return {
    center: [a.center[0] + (b.center[0] - a.center[0]) * t, a.center[1] + (b.center[1] - a.center[1]) * t] as LngLat,
    zoom: a.zoom + (b.zoom - a.zoom) * t + zoomOffset,
  };
}

/** Scroll progress -> everything on the map. Pure, so scrubbing backwards just works. */
function frameAt(p: number, zoomOffset: number): SceneFrame & { clock: number; mile: number; route: string } {
  const weather = span(p, .58, .76);
  const call = span(p, .82, .99);
  const truckOnA = p < .8;
  const truck = truckOnA
    ? { route: 'a' as const, t: p < .58 ? 0 : weather * KEY_T }
    : { route: storyPick.id, t: call };
  const route = routeById(truck.route);
  const clock = truckOnA ? (p < .58 ? 0 : weather * KEY_HOUR) : etaHours(route, call * route.distance);
  return {
    ...emptyFrame(),
    reveal: span(p, .2, .36),
    checkpoints: span(p, .4, .54),
    resolved: p < .8 ? weather * (KEY_HOUR / 16) + (p > .74 ? span(p, .74, .8) * (1 - KEY_HOUR / 16) : 0) : 1,
    hour: p < .8 ? Math.max(1, clock) : 4 + call * 9,
    storm: span(p, .56, .63),
    focus: p >= .8 ? storyPick.id : null,
    blocked: p >= .72,
    truck,
    callout: p >= .66 && p < .86,
    camera: cameraAt(p, zoomOffset),
    clock,
    mile: truck.t * route.distance,
    route: route.name,
  };
}

export function JourneySection() {
  const reduced = !!useReducedMotion();
  const section = useRef<HTMLElement>(null);
  const frame = useRef<SceneFrame>(frameAt(0, 0));
  const hud = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLSpanElement>(null);
  const [chapter, setChapter] = useState(0);
  const { scrollYProgress } = useScroll({ target: section, offset: ['start start', 'end end'] });

  const update = (p: number) => {
    const width = section.current?.clientWidth ?? 1280;
    const zoomOffset = Math.max(-1.7, Math.min(.2, Math.log2(width / 1280)));
    const f = frameAt(p, zoomOffset);
    frame.current = f;
    const idx = CHAPTERS.reduce((acc, c, i) => (p >= c.at ? i : acc), 0);
    setChapter(idx);
    // HUD and rail update straight in the DOM: they change every scroll frame.
    if (hud.current) {
      const at = f.truck ? along(routeById(f.truck.route), f.truck.t).at : A.line[0];
      hud.current.querySelector('[data-k=clock]')!.textContent = `${clockLabel(f.clock)} · +${f.clock.toFixed(1)}H`;
      hud.current.querySelector('[data-k=mile]')!.textContent = `MI ${String(Math.round(f.mile)).padStart(3, '0')} · ${f.route.toUpperCase()}`;
      hud.current.querySelector('[data-k=pos]')!.textContent = `${at[1].toFixed(3)}°N ${Math.abs(at[0]).toFixed(3)}°W`;
    }
    if (rail.current) rail.current.style.top = `${p * 100}%`;
  };
  useMotionValueEvent(scrollYProgress, 'change', update);
  // Apply once on mount so the camera fits narrow screens before the first scroll.
  useEffect(() => update(scrollYProgress.get()), []); // eslint-disable-line react-hooks/exhaustive-deps

  const jumpTo = (i: number) => {
    const el = section.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + (CHAPTERS[i].at + .04) * (el.offsetHeight - window.innerHeight), behavior: reduced ? 'auto' : 'smooth' });
  };

  return (
    <section className="journey" id="how-it-works" ref={section} aria-label="One trip, step by step">
      <div className="journey-sticky">
        <Suspense fallback={<div className="story-map story-map-loading" />}>
          <StoryMap frame={frame} initial={CAMERA[0]} className="journey-map" label="Scroll-driven map of a truck trip from Dallas to Atlanta" />
        </Suspense>
        <div className="journey-veil" aria-hidden="true" />

        <div className="journey-hud" ref={hud} aria-hidden="true">
          <span data-k="clock">TUE 06:00 · +0.0H</span>
          <span data-k="mile">MI 000 · ROUTE A</span>
          <span data-k="pos">32.776°N 96.797°W</span>
        </div>

        <div className="journey-copy" aria-live="polite">
          {/* Enter-only keyed animation: exit-then-enter stalls when fast scrolling skips chapters. */}
            <motion.div key={chapter} initial={reduced ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .45, ease: [0.16, 1, 0.3, 1] }}>
              <div className="eyebrow journey-kicker">{CHAPTERS[chapter].kicker}</div>
              <h2>{COPY[chapter].title}</h2>
              <p>{COPY[chapter].body}</p>
              {chapter === 4 && <div className="journey-result">
                <div><span>DRIVE</span><b className="mono">{fmtDuration(PICK.durationMin)}</b></div>
                <div><span>SEVERE MI</span><b className="mono">{storyPick.miles.severe}</b></div>
                <div><span>vs {A.name.toUpperCase()}</span><b className="mono">BLOCKED</b></div>
                <Link to="/plan" className="button-primary">Plan your own lane <ArrowRight size={15} /></Link>
              </div>}
            </motion.div>
        </div>

        <nav className="journey-rail" aria-label="Trip chapters">
          <span className="rail-line" aria-hidden="true"><span ref={rail} className="rail-truck" /></span>
          {CHAPTERS.map((c, i) => (
            <button key={c.tag} type="button" className={i === chapter ? 'is-active' : i < chapter ? 'is-done' : ''} style={{ top: `${c.at * 100}%` }} onClick={() => jumpTo(i)} aria-current={i === chapter ? 'step' : undefined}>
              <i aria-hidden="true" /><span>{String(i + 1).padStart(2, '0')} {c.tag}</span>
            </button>
          ))}
        </nav>
      </div>
    </section>
  );
}
