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

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum rows rendered in the timeline. For larger traces we show the longest
 * events first (most interesting for perf/debug) and display a truncation notice.
 */
const MAX_TIMELINE_ROWS = 500;

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
  const { events, truncated } = useMemo(() => {
    const all = trace.events
      .filter((e) => e.type !== 'trace_start' && e.type !== 'trace_end')
      .sort((a, b) => a.startTime - b.startTime);

    if (all.length <= MAX_TIMELINE_ROWS) {
      return { events: all, truncated: 0 };
    }

    // For large traces show the longest-running events first (most actionable),
    // then pad with the remaining events in time order up to the cap.
    const byDuration = [...all].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
    const topIds     = new Set(byDuration.slice(0, MAX_TIMELINE_ROWS).map((e) => e.eventId));
    const visible    = all.filter((e) => topIds.has(e.eventId));
    return { events: visible, truncated: all.length - visible.length };
  }, [trace]);

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
      {truncated > 0 && (
        <div className="timeline-truncation-notice">
          Showing longest {MAX_TIMELINE_ROWS} of {MAX_TIMELINE_ROWS + truncated} events.{' '}
          <span style={{ opacity: 0.7 }}>
            Use <code>tracegraph report</code> for a full diff.
          </span>
        </div>
      )}

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
