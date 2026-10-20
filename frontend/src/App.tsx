import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LayoutGroup } from 'framer-motion';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import Landing from '@/pages/Landing';

const Planner = lazy(() => import('@/pages/Planner'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

function NotFound() {
  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24 }}>
      <div><div className="eyebrow" style={{ color: 'var(--muted)' }}>404 / OFF ROUTE</div><h1 style={{ font: '700 42px var(--font-heading)', letterSpacing: '-.07em' }}>This road ends here.</h1><Link className="button-primary" to="/">Back to Spotter Routes</Link></div>
    </main>
  );
}

function PlannerLoading() {
  return <main className="planner-loading" aria-busy="true"><div className="eyebrow">LOADING ROUTE DESK</div><div className="loading-rule" /><div className="loading-rule short" /><div className="loading-map">Preparing forecast map</div></main>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <LayoutGroup>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/plan" element={<Suspense fallback={<PlannerLoading />}><Planner /></Suspense>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </LayoutGroup>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
