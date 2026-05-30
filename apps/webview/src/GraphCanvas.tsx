/**
 * SVG-based call graph renderer.
 *
 * Uses a simple hierarchical layout:
 *  - Root nodes at the top
 *  - Each level is laid out horizontally, evenly spaced
 *  - Pan + scroll zoom via pointer events
 *
 * This is intentionally simple for M1. A force-directed or auto-layout
 * library (ELK, Dagre, Reagraph) can be plugged in during M2.
 */
import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { TraceGraph, GraphNode, GraphEdge } from '@tracegraph/graph-engine';

interface GraphCanvasProps {
  graph:          TraceGraph;
  selectedNodeId: string | null;
  onNodeClick:    (node: GraphNode) => void;
}

interface LayoutNode {
  node: GraphNode;
  x:    number;
  y:    number;
}

// ─── Layout algorithm: simple topological BFS levels ─────────────────────────

function computeLayout(
  nodes:  GraphNode[],
  edges:  GraphEdge[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  // Build adjacency
  const children = new Map<string, string[]>();
  const parentCount = new Map<string, number>();

  for (const n of nodes) {
    children.set(n.id, []);
    parentCount.set(n.id, 0);
  }
  for (const e of edges) {
    children.get(e.source)?.push(e.target);
    parentCount.set(e.target, (parentCount.get(e.target) ?? 0) + 1);
  }

  // BFS from roots (nodes with no parents)
  const roots = nodes.filter((n) => (parentCount.get(n.id) ?? 0) === 0);
  const levels: string[][] = [];
  const visited = new Set<string>();

  let queue = roots.map((n) => n.id);
  while (queue.length > 0) {
    const level: string[] = [];
    const next: string[]  = [];
    for (const id of queue) {
      if (visited.has(id)) continue;
      visited.add(id);
      level.push(id);
      const kids = children.get(id) ?? [];
      next.push(...kids.filter((k) => !visited.has(k)));
    }
    if (level.length > 0) levels.push(level);
    queue = next;
  }

  // Add any unvisited nodes at the end (disconnected)
  const unvisited = nodes.filter((n) => !visited.has(n.id));
  if (unvisited.length > 0) levels.push(unvisited.map((n) => n.id));

  const NODE_W   = 160;
  const NODE_H   = 60;
  const H_GAP    = 40;
  const V_GAP    = 80;

  for (let lvl = 0; lvl < levels.length; lvl++) {
    const ids = levels[lvl]!;
    const rowWidth = ids.length * NODE_W + (ids.length - 1) * H_GAP;
    const startX   = -rowWidth / 2 + NODE_W / 2;

    for (let i = 0; i < ids.length; i++) {
      positions.set(ids[i]!, {
        x: startX + i * (NODE_W + H_GAP),
        y: lvl * (NODE_H + V_GAP),
      });
    }
  }

  return positions;
}

// ─── Component ────────────────────────────────────────────────────────────────

const NODE_R = 28; // circle radius

/** Hard ceiling: if the graph still has more nodes after collapsing, refuse to
 *  render the SVG and prompt the user to use Timeline view instead. */
const MAX_RENDERABLE_NODES = 250;

export function GraphCanvas({
  graph,
  selectedNodeId,
  onNodeClick,
}: GraphCanvasProps): React.ReactElement {
  const svgRef  = useRef<SVGSVGElement>(null);
  const [pan,   setPan]   = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const dragging = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  // Recompute layout when graph changes
  const positions = computeLayout(graph.nodes, graph.edges);

  // Centre the graph initially
  useEffect(() => {
    if (!svgRef.current || graph.nodes.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    setPan({ x: rect.width / 2, y: 80 });
    setScale(1);
  }, [graph.nodes.length]);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest('.graph-node')) return;
    dragging.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
  }, [pan]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    setPan({
      x: dragging.current.panX + (e.clientX - dragging.current.startX),
      y: dragging.current.panY + (e.clientY - dragging.current.startY),
    });
  }, []);

  const onPointerUp = useCallback(() => { dragging.current = null; }, []);

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    setScale((s) => Math.max(0.2, Math.min(3, s - e.deltaY * 0.001)));
  }, []);

  if (graph.nodes.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <p>No events to display</p>
      </div>
    );
  }

  if (graph.nodes.length > MAX_RENDERABLE_NODES) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <p style={{ fontWeight: 600 }}>Graph too large to render</p>
        <p style={{ fontSize: 13, color: '#94a3b8', marginTop: 8 }}>
          {graph.nodes.length} nodes — switch to <strong>Timeline</strong> view for large traces.
        </p>
      </div>
    );
  }

  return (
    <svg
      ref={svgRef}
      className="graph-svg"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    >
      <defs>
        <marker
          id="arrow"
          markerWidth="8" markerHeight="6"
          refX="8" refY="3"
          orient="auto"
        >
          <polygon points="0 0, 8 3, 0 6" fill="#475569" />
        </marker>
      </defs>

      <g transform={`translate(${pan.x},${pan.y}) scale(${scale})`}>
        {/* Edges first (behind nodes) */}
        {graph.edges.map((edge) => {
          const sp = positions.get(edge.source);
          const tp = positions.get(edge.target);
          if (!sp || !tp) return null;

          // Simple curve between centres, with node radius offset
          const dx   = tp.x - sp.x;
          const dy   = tp.y - sp.y;
          const len  = Math.sqrt(dx * dx + dy * dy) || 1;
          const ux   = dx / len;
          const uy   = dy / len;
          const sx   = sp.x + ux * NODE_R;
          const sy   = sp.y + uy * NODE_R;
          const ex   = tp.x - ux * NODE_R;
          const ey   = tp.y - uy * NODE_R;
          const mx   = (sp.x + tp.x) / 2 - uy * 30;
          const my   = (sp.y + tp.y) / 2 + ux * 30;

          return (
            <path
              key={edge.id}
              className={`graph-edge ${edge.type}`}
              d={`M${sx},${sy} Q${mx},${my} ${ex},${ey}`}
              markerEnd="url(#arrow)"
            />
          );
        })}

        {/* Nodes */}
        {graph.nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          const isSelected = node.id === selectedNodeId;
          const r = NODE_R + (node.size - 1) * 2;
          const isCollapsed = (node.collapsedCount ?? 0) > 0;

          return (
            <g
              key={node.id}
              className={`graph-node${isSelected ? ' selected' : ''}`}
              transform={`translate(${pos.x},${pos.y})`}
              onClick={() => onNodeClick(node)}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onNodeClick(node); }}
            >
              <circle
                r={r}
                fill={node.color}
                fillOpacity={0.85}
                stroke={isSelected ? '#fff' : isCollapsed ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.15)'}
                strokeWidth={isSelected ? 2.5 : isCollapsed ? 2 : 1}
                strokeDasharray={isCollapsed ? '4 2' : undefined}
              />
              {isCollapsed && (
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  style={{ fontSize: Math.max(10, r * 0.55), fontWeight: 700, fill: '#fff', pointerEvents: 'none' }}
                >
                  ×{node.collapsedCount}
                </text>
              )}
              <text className="graph-node-label" y={r + 14}>
                {truncate(node.label, 22)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}
