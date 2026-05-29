/**
 * T8.7 — Error Path view
 *
 * Traverses the causal chain from every error event backwards to the trace
 * root and renders each path as a vertical causal chain.  Uses
 * `causalParentEventId` first, then falls back to `parentEventId`.
 *
 * Shows an optional "↗ open in editor" button for events that have
 * file + line information when VS Code source navigation is available.
 */

import React, { useMemo } from 'react';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildErrorPaths(events: TraceEvent[]): TraceEvent[][] {
  const byId = new Map<string, TraceEvent>(
    events.filter((e) => e.eventId).map((e) => [e.eventId, e]),
  );

  const errorEvents = events.filter(
    (e) => e.type === 'error' || (e.error != null),
  );
  if (errorEvents.length === 0) return [];

  return errorEvents.map((errorEvent) => {
    const path: TraceEvent[] = [errorEvent];
    const seen = new Set<string>([errorEvent.eventId]);

    let current: TraceEvent = errorEvent;
    while (true) {
      const parentId = current.causalParentEventId ?? current.parentEventId;
      if (!parentId || seen.has(parentId)) break;
      const parent = byId.get(parentId);
      if (!parent) break;
      path.unshift(parent);
      seen.add(parentId);
      current = parent;
    }

    return path;
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

interface ErrorPathViewProps {
  trace:         TraceSession;
  onOpenSource?: (file: string, line: number) => void;
}

export function ErrorPathView({ trace, onOpenSource }: ErrorPathViewProps): React.ReactElement {
  const paths = useMemo(() => buildErrorPaths(trace.events), [trace]);

  if (paths.length === 0) {
    return (
      <div className="error-path-empty">
        <div className="error-path-empty-icon">✓</div>
        <p>No errors found in this trace.</p>
      </div>
    );
  }

  return (
    <div className="error-path-container">
      {paths.map((path, pi) => {
        const terminal = path[path.length - 1];
        const errMsg   = terminal?.error?.message ?? terminal?.error?.type;

        return (
          <div key={pi} className="error-path-block">
            <div className="error-path-heading">
              {paths.length > 1 ? `Error #${pi + 1}` : 'Error path'}
              {errMsg && (
                <span className="error-path-heading-msg">{errMsg}</span>
              )}
            </div>

            <div className="error-path-chain">
              {path.map((e, ei) => {
                const isError  = e.type === 'error' || !!e.error;
                const hasLoc   = !!(e.file && e.line != null);
                const basename = e.file ? e.file.replace(/^.*[/\\]/, '') : null;

                return (
                  <React.Fragment key={e.eventId ?? ei}>
                    {ei > 0 && (
                      <div className="error-path-connector">
                        <span className="error-path-arrow">↓</span>
                        <span className="error-path-causal-label">
                          {path[ei].causalParentEventId ? 'caused by' : 'called by'}
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
                          <span className="error-path-error-type">{e.error.type}</span>
                          <span className="error-path-error-msg">{e.error.message}</span>
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
