/**
 * T8.7 — Timeline view
 *
 * Renders a horizontal Gantt-style timeline of all trace events ordered by
 * startTime.  Each row shows:
 *   - event label (displayName ?? name)
 *   - proportional duration bar
 *   - duration text
 *   - optional "↗ open in editor" button when VS Code source navigation is available
 */

import React, { useMemo } from 'react';
import type { TraceSession } from '@tracegraph/shared-types';

// ─── Type colours (consistent with DetailPanel) ───────────────────────────────
const TYPE_COLORS: Record<string, string> = {
  http_request:        '#3b82f6',
  http_response:       '#3b82f6',
  db_query:            '#f97316',
  authorization_check: '#ef4444',
  auth_check:          '#ef4444',
  external_http_call:  '#a855f7',
  function_call:       '#6b7280',
  method_call:         '#6b7280',
  error:               '#dc2626',
  queue_event:         '#14b8a6',
  trace_start:         '#94a3b8',
  trace_end:           '#94a3b8',
  test_run:            '#22d3ee',
  test_suite:          '#818cf8',
  test_file:           '#818cf8',
};

// ─── Component ────────────────────────────────────────────────────────────────

interface TimelineViewProps {
  trace:          TraceSession;
  onOpenSource?:  (file: string, line: number) => void;
}

function fmtDuration(ms: number | undefined): string {
  if (ms == null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1)    return `${ms.toFixed(0)}ms`;
  return `${ms.toFixed(2)}ms`;
}

export function TimelineView({ trace, onOpenSource }: TimelineViewProps): React.ReactElement {
  const events = useMemo(
    () =>
      trace.events
        .filter((e) => e.type !== 'trace_start' && e.type !== 'trace_end')
        .sort((a, b) => a.startTime - b.startTime),
    [trace],
  );

  if (events.length === 0) {
    return <div className="timeline-empty">No events to display in this trace.</div>;
  }

  const minTime      = events[0].startTime;
  const maxEndTime   = events.reduce((max, e) => {
    const end = e.endTime ?? (e.startTime + (e.durationMs ?? 0));
    return Math.max(max, end);
  }, minTime);
  const totalSpan    = Math.max(maxEndTime - minTime, 1);

  return (
    <div className="timeline-container">
      {/* Column headers */}
      <div className="timeline-header-row">
        <div className="timeline-col-label">Event</div>
        <div className="timeline-col-bars" />
        <div className="timeline-col-dur">Duration</div>
      </div>

      {/* Rows */}
      <div className="timeline-rows">
        {events.map((e, idx) => {
          const barStart  = (e.startTime - minTime) / totalSpan;
          const barWidth  = Math.max((e.durationMs ?? 0) / totalSpan, 0.002);
          const isError   = e.type === 'error' || !!e.error;
          const hasLoc    = !!(e.file && e.line != null);
          const barColor  = isError ? '#dc2626' : (TYPE_COLORS[e.type] ?? '#475569');

          return (
            <div
              key={e.eventId ?? idx}
              className={`timeline-row${isError ? ' timeline-row-error' : ''}`}
            >
              {/* Label */}
              <div className="timeline-col-label timeline-label" title={e.displayName ?? e.name}>
                <span className="timeline-event-name">
                  {e.displayName ?? e.name}
                </span>
                {hasLoc && onOpenSource && (
                  <button
                    className="open-source-btn"
                    onClick={() => onOpenSource(e.file!, e.line!)}
                    title={`Open ${e.file}:${e.line}`}
                    aria-label="Open in editor"
                  >
                    ↗
                  </button>
                )}
              </div>

              {/* Proportional bar */}
              <div className="timeline-col-bars timeline-bar-track">
                <div
                  className="timeline-bar"
                  style={{
                    marginLeft: `${barStart * 100}%`,
                    width:      `${barWidth * 100}%`,
                    background: barColor,
                  }}
                  title={e.durationMs != null ? `${e.durationMs.toFixed(2)}ms` : e.name}
                />
              </div>

              {/* Duration */}
              <div className="timeline-col-dur timeline-dur-text">
                {fmtDuration(e.durationMs)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
