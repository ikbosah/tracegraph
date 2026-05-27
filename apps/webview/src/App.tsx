import React, { useState } from 'react';
import type { TraceSession } from '@tracegraph/shared-types';
import { traceSessionToGraph } from '@tracegraph/graph-engine';
import type { GraphNode } from '@tracegraph/graph-engine';
import { GraphCanvas } from './GraphCanvas';
import { DetailPanel } from './DetailPanel';
import { CaptureLevelBanner } from './CaptureLevelBanner';

interface AppProps {
  trace: TraceSession | null;
}

export function App({ trace }: AppProps): React.ReactElement {
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  if (!trace) {
    return (
      <div className="layout">
        <div className="empty-state">
          <h2>No trace loaded</h2>
          <p>Open this file with <code>tracegraph open --html &lt;trace-file&gt;</code></p>
        </div>
      </div>
    );
  }

  const graph = traceSessionToGraph(trace);
  const showBanner = !bannerDismissed && trace.captureLevel.overall < 2;

  return (
    <div className="layout">
      <header className="header">
        <span className="header-title">TraceGraph</span>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>
          {trace.entrypoint.type === 'http_request'
            ? `${trace.entrypoint.method} ${trace.entrypoint.path}`
            : trace.entrypoint.type === 'cli_command'
              ? trace.entrypoint.command
              : trace.entrypoint.type}
        </span>
        <span className="header-meta">
          {graph.nodes.length} nodes · {graph.edges.length} edges ·{' '}
          {trace.status === 'passed' ? '✓' : trace.status === 'failed' ? '✗' : '⚠'} {trace.status}
        </span>
      </header>

      {showBanner && (
        <CaptureLevelBanner
          captureLevel={trace.captureLevel}
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
          <DetailPanel node={selectedNode} />
        </div>
      </div>
    </div>
  );
}
