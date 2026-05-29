import React, { useState } from 'react';
import type { TraceSession, TraceReport } from '@tracegraph/shared-types';
import { traceSessionToGraph } from '@tracegraph/graph-engine';
import type { GraphNode } from '@tracegraph/graph-engine';
import { GraphCanvas } from './GraphCanvas';
import { DetailPanel } from './DetailPanel';
import { CaptureLevelBanner } from './CaptureLevelBanner';
import { FindingsPanel } from './FindingsPanel';

interface AppProps {
  trace:  TraceSession | null;
  report: TraceReport  | null;
}

export function App({ trace, report }: AppProps): React.ReactElement {
  const [selectedNode, setSelectedNode]     = useState<GraphNode | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [highlightedTraces, setHighlightedTraces] = useState<string[]>([]);
  const [showFindings, setShowFindings]     = useState(true);

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (!trace && !report) {
    return (
      <div className="layout">
        <div className="empty-state">
          <h2>No trace loaded</h2>
          <p>Open this file with <code>tracegraph open --html &lt;trace-file&gt;</code></p>
        </div>
      </div>
    );
  }

  // ── Report mode ─────────────────────────────────────────────────────────────
  if (report) {
    const openFindings  = report.findings.filter((f) => f.status === 'open');
    const hasCritical   = openFindings.some((f) => f.severity === 'critical');
    const hasHigh       = openFindings.some((f) => f.severity === 'high');

    const reportBadgeClass = hasCritical ? 'report-badge-critical'
      : hasHigh ? 'report-badge-high'
      : openFindings.length > 0 ? 'report-badge-warn'
      : 'report-badge-ok';

    return (
      <div className="layout">
        <header className="header">
          <span className="header-title">TraceGraph</span>
          <span className="header-subtitle">Report</span>
          <span className={`report-badge ${reportBadgeClass}`}>
            {openFindings.length > 0
              ? `${openFindings.length} open finding${openFindings.length !== 1 ? 's' : ''}`
              : 'No open findings'}
          </span>
          <span className="header-meta">
            {report.diffs.length} trace{report.diffs.length !== 1 ? 's' : ''} compared
          </span>
          <button
            className="header-toggle-btn"
            onClick={() => setShowFindings((v) => !v)}
          >
            {showFindings ? 'Hide findings' : 'Show findings'}
          </button>
        </header>

        <div className="main">
          {/* Diff summary table */}
          <div className="report-body">
            <DiffTable diffs={report.diffs} highlightedTraces={highlightedTraces} />
          </div>

          {/* Findings panel */}
          {showFindings && (
            <div className="findings-sidebar">
              <FindingsPanel
                findings={report.findings}
                diffs={report.diffs}
                onFindingHover={setHighlightedTraces}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Trace mode ──────────────────────────────────────────────────────────────
  const graph      = traceSessionToGraph(trace!);
  const showBanner = !bannerDismissed;

  return (
    <div className="layout">
      <header className="header">
        <span className="header-title">TraceGraph</span>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>
          {trace!.entrypoint.type === 'http_request'
            ? `${trace!.entrypoint.method} ${trace!.entrypoint.path}`
            : trace!.entrypoint.type === 'cli_command'
              ? trace!.entrypoint.command
              : trace!.entrypoint.type}
        </span>
        <span className="header-meta">
          {graph.nodes.length} nodes · {graph.edges.length} edges ·{' '}
          {trace!.status === 'passed' ? '✓' : trace!.status === 'failed' ? '✗' : '⚠'}{' '}
          {trace!.status}
        </span>
      </header>

      {showBanner && (
        <CaptureLevelBanner
          captureLevel={trace!.captureLevel}
          onDismiss={() => setBannerDismissed(true)}
        />
      )}

      <div className="main">
        <div className="graph-area">
          <GraphCanvas
            graph={graph}
            selectedNodeId={selectedNode?.id ?? null}
            onNodeClick={setSelectedNode}
          />
        </div>
        <div className="detail-panel">
          <DetailPanel node={selectedNode} allEvents={trace!.events} />
        </div>
      </div>
    </div>
  );
}

// ─── DiffTable ────────────────────────────────────────────────────────────────

import type { BehaviorDiff } from '@tracegraph/shared-types';

interface DiffTableProps {
  diffs:             BehaviorDiff[];
  highlightedTraces: string[];
}

function DiffTable({ diffs, highlightedTraces }: DiffTableProps): React.ReactElement {
  if (diffs.length === 0) {
    return (
      <div className="diff-empty">
        No behavioral differences detected — all traces match the baseline.
      </div>
    );
  }

  return (
    <div className="diff-table-wrap">
      <table className="diff-table">
        <thead>
          <tr>
            <th>Trace</th>
            <th>Added</th>
            <th>Removed</th>
            <th>Resources changed</th>
            <th>Response shape</th>
          </tr>
        </thead>
        <tbody>
          {diffs.map((diff) => {
            const isHighlighted = highlightedTraces.includes(diff.traceId);
            return (
              <tr
                key={diff.traceId}
                className={`diff-row${isHighlighted ? ' diff-row-highlighted' : ''}`}
              >
                <td className="diff-trace-id" title={diff.traceId}>
                  {diff.traceId.slice(0, 16)}…
                </td>
                <td>
                  {diff.addedSignatures.length > 0 ? (
                    <span className="diff-count diff-added">
                      +{diff.addedSignatures.length}
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {diff.removedSignatures.length > 0 ? (
                    <span className="diff-count diff-removed">
                      −{diff.removedSignatures.length}
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {diff.changedResources.length > 0 ? (
                    <span className="diff-count diff-changed">
                      {diff.changedResources.length}
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {diff.responseShapeChange
                    ? <span className="diff-shape-changed">changed</span>
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
