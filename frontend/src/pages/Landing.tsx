import { useEffect, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useReducedMotion } from 'framer-motion';
import Lenis from 'lenis';
import { SiteHeader } from '@/components/SiteHeader';
import { HeroScene } from '@/components/HeroScene';
import { JourneySection } from '@/components/JourneySection';
import '@/landing.css';

export default function Landing() {
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (reduceMotion) return;
    const lenis = new Lenis({ duration: 1.05, smoothWheel: true });
    let frame = 0;
    const tick = (time: number) => { lenis.raf(time); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); lenis.destroy(); };
  }, [reduceMotion]);

  return (
    <>
      <SiteHeader />
      <main>
        <HeroScene />
        <JourneySection />

        <section className="spec-section" id="risk-model">
          <div className="spec-layout">
            <div>
              <div className="eyebrow section-kicker">The thresholds, out in the open</div>
              <h2 className="section-title">Risk should be <span className="serif-italic">legible.</span></h2>
              <p style={{ color: 'var(--muted)', lineHeight: 1.75, fontSize: 13, maxWidth: 370, marginTop: 20 }}>Every checkpoint is scored against truck-specific weather bands. The most restrictive condition sets the level.</p>
              <div className="load-note"><ShieldCheck size={16} color="var(--petrol)" style={{ verticalAlign: 'middle', marginRight: 8 }} />Heavy loads tighten the wind threshold. At 45+ mph, loads over 30,000 lb are flagged no travel. At 35–44 mph, loads over 40,000 lb are severe.</div>
            </div>
            <div className="spec-sheet" aria-label="Weather risk thresholds">
              <div className="spec-row"><span>LOW</span><span className="risk-pill low" style={{ '--risk-color': 'var(--low)' } as CSSProperties}>Wind &lt;25 mph · Rain &lt;0.10 in/hr</span></div>
              <div className="spec-row"><span>MODERATE</span><span className="risk-pill moderate" style={{ '--risk-color': 'var(--moderate)' } as CSSProperties}>Wind 25–34 · Rain .10–.24</span></div>
              <div className="spec-row"><span>HIGH</span><span className="risk-pill high" style={{ '--risk-color': 'var(--high)' } as CSSProperties}>Wind 35–44 · Rain .25–.49</span></div>
              <div className="spec-row"><span>SEVERE</span><span className="risk-pill severe" style={{ '--risk-color': 'var(--severe)' } as CSSProperties}>Wind 45–54 · Rain .50–1.00</span></div>
              <div className="spec-row"><span>NO TRAVEL</span><span className="risk-pill no_travel" style={{ '--risk-color': 'var(--no-travel)' } as CSSProperties}>Wind ≥55 · Rain &gt;1.00</span></div>
              <div className="spec-row"><span>SNOW / HOUR</span><span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>&lt;.5 low · .5–1 moderate · 1–2 high · 2–3 severe · &gt;3 no travel</span></div>
            </div>
          </div>
        </section>
        <section className="cta-band">
          <div><div className="eyebrow" style={{ color: '#9ec5c9' }}>The next dispatch starts here</div><h2>Know the road<br /><span className="serif-italic">before</span> you roll.</h2></div>
          <Link to="/plan" className="button-primary">Open route planner <ArrowRight size={16} /></Link>
        </section>
      </main>
      <footer className="footer"><Link to="/" className="brand"><span className="brand-mark"><i /><i /><i /></span>SPOTTER ROUTES</Link><span>Forecast-aware decisions for the road ahead.</span><span className="mono">32°46′36″N / 96°47′49″W</span></footer>
    </>
  );
}
