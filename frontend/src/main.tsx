import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

/** Last-resort fallback so a render error shows a way back instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="crash-screen" role="alert">
        <div className="eyebrow">Something went wrong</div>
        <h1>This view hit an error.</h1>
        <button type="button" className="button-primary" onClick={() => window.location.assign('/')}>Back to Spotter Routes</button>
      </main>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
