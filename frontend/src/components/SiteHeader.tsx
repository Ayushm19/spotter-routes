import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { InstrumentBar } from './InstrumentBar';

export function SiteHeader() {
  return (
    <>
      <InstrumentBar />
      <header className="top-nav">
        <Link to="/" className="brand" aria-label="Spotter Routes home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>spotter <i className="brand-slash">/</i> routes</span>
        </Link>
        <nav className="nav-links">
          <a href="/#how-it-works">How it works</a>
          <a href="/#risk-model">Risk model</a>
          <Link to="/plan" className="button-primary">Plan a route <ArrowUpRight size={15} /></Link>
        </nav>
      </header>
    </>
  );
}

