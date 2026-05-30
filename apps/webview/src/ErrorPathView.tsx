/**
 * T8.7 — Error Path view
 *
 * Traverses the causal chain from every error event backwards to the trace
 * root and renders each path as a vertical causal chain.  Uses
 * `causalParentEventId` first, then falls back to `parentEventId`.
 *
 * Improvements vs. initial implementation:
 *  - `trace_start` / `trace_end` events are stripped from the displayed chain
 *    (they add visual noise but no useful context).
 *  - Identical error paths (same error message + same ancestor chain) are
 *    grouped so the view doesn't show 17 near-identical blocks when a test
 *    suite fires the same error repeatedly.
 *  - A summary bar at the top shows total error count and unique types.
 *  - Shows an optional "↗ open in editor" button for events that have
 *    file + line information when VS Code source navigation is available.
 */

import React, { useMemo } from 'react';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';

// ─── Types ────────────────────────────────────────────────────────────────────

/** An error path with a de-dup count (how many identical paths were folded in). */
type ErrorPath = {
  chain:  TraceEvent[];   // from nearest meaningful ancestor → error event
  count:  number;         // how many identical paths were merged
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Event types that add no meaningful context in an error chain. */
const NOISE_TYPES = new Set(['trace_start', 'trace_end']);

function buildErrorPaths(events: TraceEvent[]): ErrorPath[] {
  const byId = new Map<string, TraceEvent>(
    events.filter((e) => e.eventId).map((e) => [e.eventId, e]),
  );

  const errorEvents = events.filter(
    (e) => e.type === 'error' || e.error != null,
  );
  if (errorEvents.length === 0) return [];

  // ── Build raw chains ───────────────────────────────────────────────────────
  const rawChains: TraceEvent[][] = errorEvents.map((errorEvent) => {
    const chain: TraceEvent[] = [errorEvent];
    const seen = new Set<string>([errorEvent.eventId]);

    let current: TraceEvent = errorEvent;
    while (true) {
      const parentId = current.causalParentEventId ?? current.parentEventId;
      if (!parentId || seen.has(parentId)) break;
      const parent = byId.get(parentId);
      if (!parent) break;
      chain.unshift(parent);
      seen.add(parentId);
      current = parent;
    }

    // Strip pure-noise events (trace_start / trace_end) from both ends.
    // Keep at least the error event itself.
    const filtered = chain.filter((e) => !NOISE_TYPES.has(e.type));
    return filtered.length > 0 ? filtered : chain;
  });

  // ── Group identical chains ─────────────────────────────────────────────────
  // Key = sequence of "type:name" tuples (ignores eventId which varies per run).
  function chainKey(chain: TraceEvent[]): string {
    return chain
      .map((e) => `${e.type}:${e.displayName ?? e.name}:${e.error?.type ?? ''}:${e.error?.message ?? ''}`)
      .join('||');
  }

  const grouped = new Map<string, { chain: TraceEvent[]; count: number }>();
  for (const chain of rawChains) {
    const key = chainKey(chain);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, { chain, count: 1 });
    }
  }

  // Sort: higher-count (most repeated) paths last; unique paths first.
  return [...grouped.values()].sort((a, b) => a.count - b.count);
}

// ─── Component ────────────────────────────────────────────────────────────────

interface ErrorPathViewProps {
  trace:         TraceSession;
  onOpenSource?: (file: string, line: number) => void;
}

export function ErrorPathView({ trace, onOpenSource }: ErrorPathViewProps): React.ReactElement {
  const paths = useMemo(() => buildErrorPaths(trace.events), [trace]);

  // ── Empty state ──────────────────────────────────────────────────────────────
  if (paths.length === 0) {
    return (
      <div className="error-path-empty">
        <div className="error-path-empty-icon">✓</div>
        <p>No errors found in this trace.</p>
      </div>
    );
  }

  const totalErrors  = paths.reduce((n, p) => n + p.count, 0);
  const uniqueErrors = paths.length;

  // ── Content ──────────────────────────────────────────────────────────────────
  return (
    <div className="error-path-container">

      {/* Summary bar */}
      <div className="error-path-summary">
        <span className="error-path-summary-count">{totalErrors}</span>
        <span className="error-path-summary-label">
          {totalErrors === 1 ? 'error' : 'errors'}
          {uniqueErrors < totalErrors && (
            <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
              ({uniqueErrors} unique {uniqueErrors === 1 ? 'pattern' : 'patterns'})
            </span>
          )}
        </span>
      </div>

      {paths.map(({ chain, count }, pi) => {
        const terminal = chain[chain.length - 1];
        const errMsg   = terminal?.error?.message ?? terminal?.error?.type;

        return (
          <div key={pi} className="error-path-block">
            <div className="error-path-heading">
              <span>
                {uniqueErrors > 1 ? `Error #${pi + 1}` : 'Error path'}
              </span>
              {errMsg && (
                <span className="error-path-heading-msg">{errMsg}</span>
              )}
              {count > 1 && (
                <span className="error-path-repeat-badge">×{count}</span>
              )}
            </div>

            <div className="error-path-chain">
              {chain.map((e, ei) => {
                const isError  = e.type === 'error' || !!e.error;
                const hasLoc   = !!(e.file && e.line != null);
                const basename = e.file ? e.file.replace(/^.*[/\\]/, '') : null;

                return (
                  <React.Fragment key={e.eventId ?? ei}>
                    {ei > 0 && (
                      <div className="error-path-connector">
                        <span className="error-path-arrow">↓</span>
                        <span className="error-path-causal-label">
                          {e.causalParentEventId ? 'caused by' : 'called by'}
                        </span>
                      </div>
                    )}

                    <div className={`error-path-step${isError ? ' error-path-step-error' : ''}`}>
                      <div className="error-path-step-inner">
                        <span className="error-path-type-badge">
                          {e.type.replace(/_/g, ' ')}
                        </span>
                        <span className="error-path-name">{e.displayName ?? e.name}</span>

                        {hasLoc && (
                          <span className="error-path-loc">
                            {basename}:{e.line}
                            {onOpenSource && (
                              <button
                                className="open-source-btn"
                                onClick={() => onOpenSource(e.file!, e.line!)}
                                title={`Open ${e.file}:${e.line}`}
                                aria-label="Open in editor"
                              >
                                ↗
                              </button>
                            )}
                          </span>
                        )}
                      </div>

                      {isError && e.error && (
                        <div className="error-path-error-box">
                          {e.error.type && (
                            <span className="error-path-error-type">{e.error.type}</span>
                          )}
                          {e.error.message && (
                            <span className="error-path-error-msg">{e.error.message}</span>
                          )}
                          {e.error.stack && (
                            <pre className="error-path-error-stack">{e.error.stack}</pre>
                          )}
                        </div>
                      )}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
