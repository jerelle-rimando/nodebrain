import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { logToMain } from './utils/logToMain';
// Fonts ship with the app (latin subset only) rather than coming from a
// font service, so opening NodeBrain makes no network request.
import '@fontsource/inter/latin-300.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './index.css';

// ── Renderer global error capture ──────────────────────────────────────────
// Forward uncaught errors and unhandled promise rejections to the main process
// so they land in nodebrain-log.txt. Local logging only — no network. Falls
// back to a console warning when electronAPI is absent (plain browser dev).
window.addEventListener('error', (event) => {
  const source = event.filename
    ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
    : undefined;
  logToMain(
    'window.onerror',
    event.message || String(event.error ?? 'unknown error'),
    event.error instanceof Error ? event.error.stack : undefined,
    source,
  );
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  logToMain(
    'unhandledrejection',
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : undefined,
  );
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
