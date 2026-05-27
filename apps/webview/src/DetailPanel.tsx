import React from 'react';
import type { GraphNode } from '@tracegraph/graph-engine';

interface DetailPanelProps {
  node: GraphNode | null;
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

export function DetailPanel({ node }: DetailPanelProps): React.ReactElement {
  if (!node) {
    return (
      <div className="detail-empty">
        <p>Click a node to inspect it</p>
      </div>
    );
  }

  const event  = node.data;
  const color  = TYPE_COLORS[node.type] ?? '#6b7280';
  const dur    = event.durationMs != null
    ? event.durationMs >= 1000
      ? `${(event.durationMs / 1000).toFixed(2)}s`
      : `${event.durationMs.toFixed(1)}ms`
    : null;

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
              <code style={{ fontSize: 10 }}>
                {event.file}{event.line != null ? `:${event.line}` : ''}
              </code>
            }
          />
        )}
        {event.className  && <KVRow k="Class"    v={event.className} />}
        {event.functionName && <KVRow k="Function" v={event.functionName} />}
      </div>

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
