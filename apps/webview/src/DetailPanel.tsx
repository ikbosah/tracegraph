import React, { useState } from 'react';
import type { GraphNode } from '@tracegraph/graph-engine';
import type { TraceEvent } from '@tracegraph/shared-types';

interface DetailPanelProps {
  node:          GraphNode   | null;
  allEvents?:    TraceEvent[];
  /** VS Code source navigation callback — absent when running standalone. */
  onOpenSource?: (file: string, line: number) => void;
}

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
};

function KVRow({ k, v }: { k: string; v: React.ReactNode }): React.ReactElement {
  return (
    <div className="kv-row">
      <span className="kv-key">{k}</span>
      <span className="kv-val">{v}</span>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }): React.ReactElement {
  return (
    <pre className="detail-json">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// ─── Xdebug call stack ────────────────────────────────────────────────────────

interface XdebugStackProps {
  xdebugEvents: TraceEvent[];
}

function XdebugCallStack({ xdebugEvents }: XdebugStackProps): React.ReactElement {
  const [open, setOpen] = useState(true);

  // Compute base depth so indentation is relative
  const depths = xdebugEvents.map(
    (e) => ((e.metadata as Record<string, unknown> | undefined)?.xdebugDepth as number) ?? 0,
  );
  const minDepth = depths.length > 0 ? Math.min(...depths) : 0;

  return (
    <div className="detail-section xdebug-section">
      <button
        className="xdebug-stack-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="detail-section-title" style={{ marginBottom: 0 }}>
          Xdebug Call Stack
        </span>
        <span className="xdebug-count">{xdebugEvents.length} calls</span>
        <span className="xdebug-chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="xdebug-stack">
          {xdebugEvents.map((e, i) => {
            const meta   = (e.metadata as Record<string, unknown> | undefined) ?? {};
            const depth  = ((meta.xdebugDepth as number) ?? minDepth) - minDepth;
            const score  = meta.correlationScore as number | undefined;
            const indent = depth * 14; // 14px per depth level

            // Short filename
            const filePart = e.file
              ? e.file.replace(/^.*[/\\]/, '')  // basename only
              : null;
            const location = filePart
              ? `${filePart}${e.line != null ? `:${e.line}` : ''}`
              : null;

            return (
              <div
                key={e.eventId ?? i}
                className="xdebug-call"
                style={{ paddingLeft: 8 + indent }}
              >
                <span className="xdebug-fn">{e.name}</span>
                {location && (
                  <span className="xdebug-loc" title={e.file ?? ''}>
                    {location}
                  </span>
                )}
                {score != null && score < 1.0 && (
                  <span
                    className="xdebug-confidence"
                    title={`Correlation confidence: ${(score * 100).toFixed(0)}%`}
                  >
                    ~{(score * 100).toFixed(0)}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function DetailPanel({ node, allEvents, onOpenSource }: DetailPanelProps): React.ReactElement {
  if (!node) {
    return (
      <div className="detail-empty">
        <p>Click a node to inspect it</p>
      </div>
    );
  }

  const event = node.data;
  const color = TYPE_COLORS[node.type] ?? '#6b7280';
  const dur   = event.durationMs != null
    ? event.durationMs >= 1000
      ? `${(event.durationMs / 1000).toFixed(2)}s`
      : `${event.durationMs.toFixed(1)}ms`
    : null;

  // Collect Xdebug child events for this node
  const xdebugChildren: TraceEvent[] = allEvents
    ? allEvents
        .filter(
          (e) =>
            (e as unknown as { framework: string }).framework === 'xdebug' &&
            e.parentEventId === event.eventId,
        )
        .sort((a, b) => a.startTime - b.startTime)
    : [];

  return (
    <>
      <div className="detail-header">
        <span
          className="detail-type-badge"
          style={{ background: `${color}30`, color }}
        >
          {event.type.replace(/_/g, ' ')}
        </span>
        <div className="detail-name">{node.label}</div>
        {node.displayName && node.displayName !== node.label && (
          <div className="detail-meta">{node.displayName}</div>
        )}
      </div>

      {/* Core fields */}
      <div className="detail-section">
        <div className="detail-section-title">Details</div>
        <KVRow k="Event ID"  v={<code style={{ fontSize: 10 }}>{event.eventId}</code>} />
        <KVRow k="Language"  v={event.language} />
        {event.framework  && <KVRow k="Framework" v={event.framework} />}
        {dur              && <KVRow k="Duration"  v={dur} />}
        {event.file       && (
          <KVRow
            k="Location"
            v={
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <code style={{ fontSize: 10 }}>
                  {event.file}{event.line != null ? `:${event.line}` : ''}
                </code>
                {event.line != null && onOpenSource && (
                  <button
                    className="open-source-btn"
                    onClick={() => onOpenSource(event.file!, event.line!)}
                    title={`Open ${event.file}:${event.line} in editor`}
                    aria-label="Open in editor"
                  >
                    ↗
                  </button>
                )}
              </span>
            }
          />
        )}
        {event.className    && <KVRow k="Class"    v={event.className} />}
        {event.functionName && <KVRow k="Function" v={event.functionName} />}
      </div>

      {/* Xdebug call stack — shown when Xdebug child events exist */}
      {xdebugChildren.length > 0 && (
        <XdebugCallStack xdebugEvents={xdebugChildren} />
      )}

      {/* Error */}
      {event.error && (
        <div className="detail-section">
          <div className="detail-section-title">Error</div>
          <div className="error-box">
            <div className="error-type">{event.error.type}</div>
            <div className="error-message">{event.error.message}</div>
            {event.error.stack && (
              <div className="error-stack">{event.error.stack}</div>
            )}
          </div>
        </div>
      )}

      {/* Input */}
      {event.input != null && (
        <div className="detail-section">
          <div className="detail-section-title">Input</div>
          <JsonBlock value={event.input} />
        </div>
      )}

      {/* Output */}
      {event.output != null && (
        <div className="detail-section">
          <div className="detail-section-title">Output</div>
          <JsonBlock value={event.output} />
        </div>
      )}

      {/* Static Architecture (G2) */}
      {event.static && (
        <div className="detail-section detail-section--static">
          <div className="detail-section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Static Architecture
            {event.static.isGodNode && (
              <span
                className="god-node-badge"
                title="God node: top centrality in the static call graph"
                style={{
                  fontSize: 10,
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: '#f59e0b30',
                  color: '#f59e0b',
                  fontWeight: 600,
                }}
              >
                ⚡ God node
              </span>
            )}
          </div>
          {event.static.communityLabel && (
            <KVRow k="Community" v={event.static.communityLabel} />
          )}
          {event.static.centralityPercentile != null && (
            <KVRow
              k="Centrality"
              v={`top ${100 - event.static.centralityPercentile}%`}
            />
          )}
          {event.static.degree != null && (
            <KVRow k="Degree" v={String(event.static.degree)} />
          )}
          {event.static.docstring && (
            <KVRow
              k="Docstring"
              v={
                <span style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
                  {event.static.docstring}
                </span>
              }
            />
          )}
          {event.static.symbolName && event.static.symbolName !== event.name && (
            <KVRow
              k="Symbol"
              v={<code style={{ fontSize: 10 }}>{event.static.symbolName}</code>}
            />
          )}
          {event.static.matchConfidence != null && (
            <KVRow
              k="Match confidence"
              v={`${(event.static.matchConfidence * 100).toFixed(0)}%`}
            />
          )}
        </div>
      )}

      {/* Metadata */}
      {event.metadata && Object.keys(event.metadata).length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Metadata</div>
          <JsonBlock value={event.metadata} />
        </div>
      )}

      {/* Security */}
      {event.security && (
        <div className="detail-section">
          <div className="detail-section-title">Security</div>
          <JsonBlock value={event.security} />
        </div>
      )}
    </>
  );
}
