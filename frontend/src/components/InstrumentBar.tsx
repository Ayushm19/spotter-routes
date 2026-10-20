import { useEffect, useState } from 'react';
import { isMockMode } from '@/api/client';
import { usePlannerStore } from '@/lib/store';

export function InstrumentBar() {
  const [time, setTime] = useState(() => new Date());
  const cursorLat = usePlannerStore(state => state.cursorLat);
  const cursorLng = usePlannerStore(state => state.cursorLng);
  const zoom = usePlannerStore(state => state.zoom);
  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="instrument-bar">
      <div className="instrument-group">
        <span className="coord">LAT <b>{Math.abs(cursorLat).toFixed(4)}° {cursorLat >= 0 ? 'N' : 'S'}</b></span>
        <span className="coord">LON <b>{Math.abs(cursorLng).toFixed(4)}° {cursorLng >= 0 ? 'E' : 'W'}</b></span>
        <span className="coord">ZOOM <b>{zoom.toFixed(1)}×</b></span>
      </div>
      <div className="instrument-group">
        <span><i className="live-dot" />LIVE FORECAST</span>
        <span>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} LOCAL</span>
        {isMockMode && <span className="mock-tag">MOCK DATA</span>}
      </div>
    </div>
  );
}
