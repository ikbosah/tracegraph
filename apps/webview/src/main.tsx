import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import type { TraceSession, TraceReport } from '@tracegraph/shared-types';
import './styles.css';

/**
 * Read the data injected by `tracegraph open --html` or `tracegraph report`.
 *
 * The CLI writes a <script id="tracegraph-data" type="application/json"> tag
 * containing either:
 *   - A TraceSession  (schemaVersion: 'tracegraph.session.v1')
 *   - A TraceReport   (schemaVersion: 'tracegraph.report.v1')
 */
type AppData =
  | { kind: 'trace';  data: TraceSession }
  | { kind: 'report'; data: TraceReport  }
  | { kind: 'empty' };

function readAppData(): AppData {
  try {
    const el = document.getElementById('tracegraph-data');
    if (!el) return { kind: 'empty' };
    const raw    = el.textContent ?? '';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.__dev) return { kind: 'empty' };   // dev placeholder

    if (parsed.schemaVersion === 'tracegraph.report.v1') {
      return { kind: 'report', data: parsed as unknown as TraceReport };
    }
    return { kind: 'trace', data: parsed as unknown as TraceSession };
  } catch {
    return { kind: 'empty' };
  }
}

const appData = readAppData();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App
      trace={appData.kind === 'trace'  ? appData.data : null}
      report={appData.kind === 'report' ? appData.data : null}
    />
  </React.StrictMode>,
);
