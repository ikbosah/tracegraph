import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import type { TraceSession } from '@tracegraph/shared-types';
import './styles.css';

/**
 * Read the trace data injected by `tracegraph open --html`.
 * The CLI writes a <script id="tracegraph-data" type="application/json"> tag
 * containing the full TraceSession JSON.
 */
function readTraceData(): TraceSession | null {
  try {
    const el = document.getElementById('tracegraph-data');
    if (!el) return null;
    const raw = el.textContent ?? '';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.__dev) return null;   // development placeholder
    return parsed as unknown as TraceSession;
  } catch {
    return null;
  }
}

const trace = readTraceData();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App trace={trace} />
  </React.StrictMode>,
);
