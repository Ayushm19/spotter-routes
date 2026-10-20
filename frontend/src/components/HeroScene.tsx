import { lazy, Suspense, useEffect, useRef, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUpRight, Search } from 'lucide-react';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import { clockLabel, emptyFrame, type SceneFrame, fmtDuration, keyCheckpoint, routeById, storyPick, storyRoutes, storySummary } from '@/lib/storyScene';
import { riskColor } from '@/lib/risk';
import type { RiskLevel } from '@/api/types';

const StoryMap = lazy(() => import('@/components/StoryMap').then(m => ({ default: m.StoryMap })));

const HERO_VIEW = { center: [-90.6, 33.55] as [number, number], zoom: 5.35 };
const LEVELS: RiskLevel[] = ['low', 'moderate', 'high', 'severe', 'no_travel'];
const pick = routeById(storyPick.id);
const fastest = storyRoutes.reduce((a, b) => (a.durationMin < b.durationMin ? a : b));

/** Time-driven loop for the hero map: draw in once, then the storm drifts and the truck rolls. */
function heroFrame(t: number, reduced: boolean): SceneFrame {
  if (reduced) t = 6;
  const intro = (from: number, to: number) => Math.max(0, Math.min(1, (t - from) / (to - from)));
  const cycle = reduced ? .42 : ((t - 3.6) / 26 % 1 + 1) % 1;
  return {
    ...emptyFrame(),
    reveal: intro(.5, 2.2),
    checkpoints: intro(1.9, 3.1),
    resolved: intro(2.8, 4.4),
    storm: intro(2.8, 4.4),
    hour: 3 + 9 * (.5 - .5 * Math.cos(t / 9)),
    focus: t > 4.4 ? storyPick.id : null,
    blocked: t > 4,
    truck: t > 3.6 ? { route: storyPick.id, t: cycle } : null,
  };
}

export function HeroScene() {
  const reduced = !!useReducedMotion();
  const frame = useRef<SceneFrame>(heroFrame(0, reduced));
  const section = useRef<HTMLElement>(null);
  const eta = useRef<HTMLSpanElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);

  // Scroll flattens the tilted product window, like setting a device down on the desk.
  const { scrollYProgress } = useScroll({ target: section, offset: ['start start', 'end start'] });
  const rotateX = useTransform(scrollYProgress, [0, .45], [reduced ? 0 : 14, 0]);
  const scale = useTransform(scrollYProgress, [0, .45], [reduced ? 1 : .93, 1]);
  const y = useTransform(scrollYProgress, [0, .45], [0, -40]);

  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      const t = (now - start) / 1000;
      const f = heroFrame(t, reduced);
      frame.current = f;
      // The window's chrome follows the same clock as the map: countdown, forecast hour, scrubber.
      if (eta.current) {
        const left = pick.durationMin * 60 * (1 - (f.truck?.t ?? 0));
        eta.current.textContent = `${String(Math.floor(left / 3600)).padStart(2, '0')}:${String(Math.floor(left / 60) % 60).padStart(2, '0')}:${String(Math.floor(left) % 60).padStart(2, '0')}`;
      }
      if (clock.current) clock.current.textContent = `${clockLabel(f.hour)} · +${String(Math.round(f.hour)).padStart(2, '0')}H`;
      if (thumb.current) thumb.current.style.left = `${(f.hour / 16) * 100}%`;
      if (!reduced) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  const reveal = (delay: number) => ({ initial: reduced ? false : { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: .8, delay, ease: [0.16, 1, 0.3, 1] as const } });

  return (
    <section className="hero-scene" ref={section}>
      <div className="hero-atmosphere" aria-hidden="true">
        <svg className="hero-contours" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
          {Array.from({ length: 9 }, (_, i) => <path key={i} d={`M-40 ${180 + i * 70} C 300 ${120 + i * 66}, 520 ${300 + i * 58}, 820 ${230 + i * 64} S 1300 ${150 + i * 72}, 1500 ${240 + i * 62}`} />)}
        </svg>
        <div className="hero-hexgrid" />
        <i className="cloud c1" /><i className="cloud c2" /><i className="cloud c3" />
      </div>

      <div className="hero-copy-center">
        <motion.div className="hero-pill" {...reveal(0)}><i className="live-dot" />Live forecast<span className="pill-more"> · NWS gridded data · 48 h window</span></motion.div>
        <h1 className="hero-title">
          {[<>Route around the <span className="serif-italic">weather,</span></>, <>not into it.</>].map((line, i) => (
            <span className="headline-line" key={i}><motion.span initial={reduced ? false : { y: '105%' }} animate={{ y: 0 }} transition={{ duration: 1, delay: .08 + i * .09, ease: [0.16, 1, 0.3, 1] }}>{line}</motion.span></span>
          ))}
        </h1>
        <motion.p {...reveal(.25)}>Three routes, a checkpoint every few miles, and the forecast for the hour your truck is actually there. Then one clear call.</motion.p>
        <motion.div className="hero-actions" {...reveal(.35)}>
          <Link to="/plan" className="button-primary">Plan a route <ArrowUpRight size={16} /></Link>
          <a href="#how-it-works" className="button-ghost">Follow one trip <ArrowDown size={14} /></a>
        </motion.div>
      </div>

      <div className="app-stage">
        <motion.div className="app-window" style={{ rotateX, scale, y }} initial={reduced ? false : { opacity: 0, y: 60 }} animate={{ opacity: 1 }} transition={{ duration: 1.1, delay: .3, ease: [0.16, 1, 0.3, 1] }}>
          <div className="app-chrome">
            <span className="traffic" aria-hidden="true"><i /><i /><i /></span>
            <span className="app-brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>routes</span>
            <span className="app-tabs"><b>Map</b><span>Dispatch</span><span>Fleet</span></span>
            <span className="app-search"><Search size={12} />Search a lane<kbd>⌘K</kbd></span>
            <span className="app-status"><i className="live-dot" />NWS · 2 min ago</span>
          </div>
          <div className="app-body">
            <Suspense fallback={<div className="story-map story-map-loading" />}>
              <StoryMap frame={frame} initial={HERO_VIEW} label={`Map of three routes from Dallas to Atlanta; ${pick.name} is recommended`} />
            </Suspense>

            <aside className="app-lanes" aria-label="Route options">
              <div className="app-label">LANES · DAL → ATL</div>
              {storySummary.map(s => {
                const route = routeById(s.id);
                const total = route.distance;
                return (
                  <div key={s.id} className={`lane${s.id === storyPick.id ? ' is-pick' : ''}`}>
                    <div className="lane-top"><b>{route.name}</b><span>{fmtDuration(route.durationMin)}</span></div>
                    <div className="lane-via">{route.via}</div>
                    <div className="lane-bar">{LEVELS.map(l => s.miles[l] > 0 && <i key={l} className={l === 'no_travel' ? 'hatch' : ''} style={{ width: `${(s.miles[l] / total) * 100}%`, background: l === 'no_travel' ? undefined : riskColor(l), '--risk-color': riskColor(l) } as CSSProperties} />)}</div>
                    <div className="lane-tag">{s.blocked ? <em className="tag-block">NO TRAVEL · MI {s.worst.mile}</em> : s.id === storyPick.id ? <em className="tag-pick">RECOMMENDED</em> : <span>{Math.round(s.miles.moderate)} MODERATE MI</span>}</div>
                  </div>
                );
              })}
            </aside>

            <div className="app-card">
              <div className="app-card-head"><span className="app-label">RECOMMENDED</span><span className="eta-chip">ETA IN <span ref={eta} className="mono">--:--:--</span></span></div>
              <h3>{pick.name}</h3>
              <p>{pick.via}</p>
              <dl>
                <div><dt>Drive</dt><dd className="mono">{fmtDuration(pick.durationMin)}</dd></div>
                <div><dt>Distance</dt><dd className="mono">{Math.round(pick.distance)} mi</dd></div>
                <div><dt>Severe mi</dt><dd className="mono">{storyPick.miles.severe}</dd></div>
              </dl>
              <div className="app-card-note">Avoids gusts of {keyCheckpoint.wind} mph on {fastest.name} at MI {keyCheckpoint.mile}. +{pick.durationMin - fastest.durationMin} min.</div>
              <Link to="/plan" className="app-card-cta">Plan this lane <ArrowUpRight size={13} /></Link>
            </div>

            <div className="app-timeline" aria-hidden="true">
              <span className="app-label">FORECAST</span>
              <span className="app-track"><span ref={thumb} className="app-thumb" /></span>
              <span ref={clock} className="mono app-clock">TUE 06:00 · +00H</span>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
