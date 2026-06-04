/**
 * SVG-based call graph renderer.
 *
 * Improvements over the original M1 implementation:
 *  - Subtree-width-aware layout (Reingold-Tilford style): each node is centred
 *    over its descendants. Wide levels caused by many same-depth siblings are
 *    gone — the x-span is determined by leaf count, not the widest BFS level.
 *  - useMemo for layout and bounds — no recompute on pan/zoom state changes.
 *  - Fit-to-view on load, on graph change, via ⊡ button, and F key.
 *  - Viewport culling — off-screen nodes and edges are not rendered.
 *  - Minimap — small overview with a viewport indicator rectangle (≥ 16 nodes).
 *  - Zoom controls — +/−/⊡ buttons in the bottom-left corner.
 *  - Zoom-to-cursor on wheel (scale towards the pointer, not the origin).
 *  - ResizeObserver — re-fits when the panel is resized.
 *  - Keyboard: F = fit, + / = = zoom in, - = zoom out.
 *  - SVG <title> tooltips on all nodes.
 */
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import type { GraphEdge, GraphNode, TraceGraph } from '@tracegraph/graph-engine';

// ─── Layout constants ─────────────────────────────────────────────────────────

/** Horizontal space reserved per leaf node (px). */
const H_SPACING = 180;
/** Vertical gap between depth levels (px). */
const V_SPACING = 120;
/** Circle radius for a size-1 node. */
const NODE_R = 28;
/** Vertical offset from circle bottom to label baseline. */
const LABEL_OFFSET = 14;
/** Extra padding around each node when computing graph bounds. */
const BOUNDS_PAD = NODE_R + LABEL_OFFSET + 8;

// ─── Types ────────────────────────────────────────────────────────────────────

interface GraphBounds {
  minX: number; maxX: number;
  minY: number; maxY: number;
  width: number; height: number;
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

/**
 * Topological sort via iterative DFS (Kahn-free).
 * Handles cycles safely (nodes in a cycle are silently deferred).
 */
function topoSort(
  nodeIds:    string[],
  childrenOf: Map<string, string[]>,
): string[] {
  const result: string[] = [];
  const perm = new Set<string>();
  const temp = new Set<string>();

  function visit(id: string): void {
    if (perm.has(id)) return;
    if (temp.has(id)) return; // cycle — skip
    temp.add(id);
    for (const k of childrenOf.get(id) ?? []) visit(k);
    temp.delete(id);
    perm.add(id);
    result.push(id);
  }

  for (const id of nodeIds) visit(id);
  return result.reverse();
}

/**
 * Converts a graph into (x, y) positions using a subtree-width-aware layout.
 *
 * Algorithm:
 *  1. Topological sort → compute depth (y) via longest-path from roots.
 *  2. DFS post-order from roots: assign sequential x-slots to leaf nodes
 *     (nodes with no children in the DFS traversal).
 *  3. Bottom-up (reverse-topo): assign x to internal nodes as the midpoint
 *     of their children's x range.
 *  4. Centre the full layout around x = 0.
 *
 * Result: each node is horizontally centred over its subtree — much more
 * compact than a flat BFS level layout for typical trace shapes.
 */
function computeLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  // ── Build adjacency ────────────────────────────────────────────────────────
  const childrenOf = new Map<string, string[]>(nodes.map(n => [n.id, []]));
  const parentsOf  = new Map<string, string[]>(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    childrenOf.get(e.source)?.push(e.target);
    parentsOf.get(e.target)?.push(e.source);
  }

  const nodeIds = nodes.map(n => n.id);
  const topo    = topoSort(nodeIds, childrenOf);

  // ── Depth (y) ─────────────────────────────────────────────────────────────
  const depth = new Map<string, number>();
  for (const id of topo) {
    const pars = parentsOf.get(id) ?? [];
    depth.set(
      id,
      pars.length === 0
        ? 0
        : 1 + Math.max(0, ...pars.map(p => depth.get(p) ?? 0)),
    );
  }

  // ── X positions ───────────────────────────────────────────────────────────
  const xPos   = new Map<string, number>();
  let leafSlot = 0;

  /** Phase 1: DFS post-order — assigns sequential slots to leaf nodes. */
  const dfsVis = new Set<string>();
  function dfsLeaves(id: string): void {
    if (dfsVis.has(id)) return;
    dfsVis.add(id);
    const kids = childrenOf.get(id) ?? [];
    if (kids.length === 0) { xPos.set(id, leafSlot++ * H_SPACING); return; }
    for (const k of kids) dfsLeaves(k);
  }
  const roots = nodes.filter(n => (parentsOf.get(n.id) ?? []).length === 0);
  for (const r of roots) dfsLeaves(r.id);
  // Disconnected leaf nodes
  for (const n of nodes) {
    if (!xPos.has(n.id) && (childrenOf.get(n.id) ?? []).length === 0) {
      xPos.set(n.id, leafSlot++ * H_SPACING);
    }
  }

  /** Phase 2: reverse-topo (bottom-up) — internal nodes centred over children. */
  for (const id of [...topo].reverse()) {
    if (xPos.has(id)) continue;
    const kxs = (childrenOf.get(id) ?? [])
      .map(k => xPos.get(k))
      .filter((x): x is number => x !== undefined);
    xPos.set(id,
      kxs.length > 0
        ? (Math.min(...kxs) + Math.max(...kxs)) / 2
        : leafSlot++ * H_SPACING,
    );
  }
  // Any remaining (e.g. nodes in cycles)
  for (const n of nodes) {
    if (!xPos.has(n.id)) xPos.set(n.id, leafSlot++ * H_SPACING);
  }

  // ── Centre around x = 0 ───────────────────────────────────────────────────
  const allX = [...xPos.values()];
  const midX = (Math.min(...allX) + Math.max(...allX)) / 2;

  for (const n of nodes) {
    positions.set(n.id, {
      x: (xPos.get(n.id) ?? 0) - midX,
      y: (depth.get(n.id) ?? 0) * V_SPACING,
    });
  }
  return positions;
}

/** Computes the bounding box of all node positions (with padding). */
function getGraphBounds(
  positions: Map<string, { x: number; y: number }>,
): GraphBounds | null {
  if (positions.size === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { x, y } of positions.values()) {
    minX = Math.min(minX, x - BOUNDS_PAD);
    maxX = Math.max(maxX, x + BOUNDS_PAD);
    minY = Math.min(minY, y - BOUNDS_PAD);
    maxY = Math.max(maxY, y + BOUNDS_PAD);
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/** Returns pan + scale values that fit the full graph inside the viewport. */
function computeFit(
  bounds:  GraphBounds,
  viewW:   number,
  viewH:   number,
  padding = 56,
): { pan: { x: number; y: number }; scale: number } {
  const scaleX = (viewW - padding * 2) / Math.max(bounds.width,  1);
  const scaleY = (viewH - padding * 2) / Math.max(bounds.height, 1);
  const scale  = Math.max(0.1, Math.min(2.0, Math.min(scaleX, scaleY)));
  return {
    pan: {
      x: viewW / 2 - (bounds.minX + bounds.width  / 2) * scale,
      y: viewH / 2 - (bounds.minY + bounds.height / 2) * scale,
    },
    scale,
  };
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

// ─── Minimap ──────────────────────────────────────────────────────────────────

const MM_W = 178;
const MM_H = 112;
const MM_PAD = 8;

interface MinimapProps {
  positions: Map<string, { x: number; y: number }>;
  nodes:     GraphNode[];
  bounds:    GraphBounds;
  pan:       { x: number; y: number };
  scale:     number;
  viewW:     number;
  viewH:     number;
}

function Minimap({
  positions, nodes, bounds, pan, scale, viewW, viewH,
}: MinimapProps): React.ReactElement {
  const bW      = Math.max(bounds.width,  1);
  const bH      = Math.max(bounds.height, 1);
  const mmScale = Math.min(
    (MM_W - MM_PAD * 2) / bW,
    (MM_H - MM_PAD * 2) / bH,
  );

  /** Map a world-space point to minimap pixel coordinates. */
  const toMM = (wx: number, wy: number) => ({
    x: MM_PAD + (wx - bounds.minX) * mmScale,
    y: MM_PAD + (wy - bounds.minY) * mmScale,
  });

  // Current viewport rect expressed in world coordinates
  const vpL  = -pan.x / scale;
  const vpT  = -pan.y / scale;
  const vpR  = (viewW - pan.x) / scale;
  const vpB  = (viewH - pan.y) / scale;

  const { x: vpMX, y: vpMY } = toMM(vpL, vpT);
  const vpMW = Math.max(4, (vpR - vpL) * mmScale);
  const vpMH = Math.max(4, (vpB - vpT) * mmScale);

  return (
    <svg className="graph-minimap" width={MM_W} height={MM_H}>
      {/* Background */}
      <rect x={0} y={0} width={MM_W} height={MM_H}
        fill="rgba(15,23,42,0.92)" rx={6} />
      {/* Node dots */}
      {nodes.map(node => {
        const pos = positions.get(node.id);
        if (!pos) return null;
        const mm = toMM(pos.x, pos.y);
        return (
          <circle key={node.id}
            cx={mm.x} cy={mm.y} r={2.5}
            fill={node.color} opacity={0.78}
          />
        );
      })}
      {/* Viewport rectangle */}
      <rect
        x={vpMX} y={vpMY} width={vpMW} height={vpMH}
        fill="rgba(255,255,255,0.06)"
        stroke="rgba(255,255,255,0.65)"
        strokeWidth={1.5}
        rx={1}
      />
    </svg>
  );
}

// ─── GraphCanvas ──────────────────────────────────────────────────────────────

interface GraphCanvasProps {
  graph:          TraceGraph;
  selectedNodeId: string | null;
  onNodeClick:    (node: GraphNode) => void;
  /** IMP-4.3: When set, non-matching nodes are dimmed. */
  searchQuery?:   string;
}

/** Hard ceiling — refuse to render SVG beyond this node count. */
const MAX_RENDERABLE_NODES = 400;

/** Minimap is shown when the graph has at least this many nodes. */
const MINIMAP_THRESHOLD = 16;

/** Returns true when an event's name/type/file contains the search query. */
function nodeMatchesSearch(node: GraphNode, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    node.label.toLowerCase().includes(q) ||
    node.type.toLowerCase().includes(q) ||
    (node.displayName ?? '').toLowerCase().includes(q) ||
    (node.file ?? '').toLowerCase().includes(q)
  );
}

export function GraphCanvas({
  graph,
  selectedNodeId,
  onNodeClick,
  searchQuery = '',
}: GraphCanvasProps): React.ReactElement {
  const svgRef = useRef<SVGSVGElement>(null);
  const [pan,     setPan    ] = useState({ x: 0, y: 0 });
  const [scale,   setScale  ] = useState(1);
  const [svgSize, setSvgSize] = useState({ width: 800, height: 600 });
  const dragging = useRef<{
    startX: number; startY: number; panX: number; panY: number;
  } | null>(null);

  // ── Memoised layout ─────────────────────────────────────────────────────────
  const positions = useMemo(
    () => computeLayout(graph.nodes, graph.edges),
    // Stable identity: graph.nodes / graph.edges come from traceSessionToGraph
    // which is itself memoised in App.tsx on the trace reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.nodes, graph.edges],
  );

  const bounds = useMemo(() => getGraphBounds(positions), [positions]);

  // ── Fit-to-view ─────────────────────────────────────────────────────────────
  const doFit = useCallback(() => {
    if (!bounds) return;
    const el   = svgRef.current;
    const { width: w, height: h } = el
      ? el.getBoundingClientRect()
      : svgSize;
    const fit = computeFit(bounds, w, h);
    setPan(fit.pan);
    setScale(fit.scale);
  }, [bounds, svgSize]);

  // Fit whenever the graph layout changes (new trace loaded)
  useEffect(() => { doFit(); }, [doFit]);

  // ── ResizeObserver — re-fit when the panel is resized ───────────────────────
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0]!.contentRect;
      setSvgSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) return;
      if (e.key === 'f' || e.key === 'F')         doFit();
      if (e.key === '+' || e.key === '=')          setScale(s => Math.min(3, s * 1.25));
      if (e.key === '-' || e.key === '_')          setScale(s => Math.max(0.1, s * 0.8));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doFit]);

  // ── Pan & zoom handlers ──────────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest('.graph-node')) return;
    dragging.current = {
      startX: e.clientX, startY: e.clientY,
      panX: pan.x, panY: pan.y,
    };
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

  /** Zoom towards the cursor position, not the SVG origin. */
  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const rect   = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.909;
    const next   = Math.max(0.1, Math.min(3, scale * factor));
    const ratio  = next / scale;
    setScale(next);
    setPan({ x: cx - (cx - pan.x) * ratio, y: cy - (cy - pan.y) * ratio });
  }, [scale, pan]);

  // ── Guards ───────────────────────────────────────────────────────────────────
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
        <p style={{ fontWeight: 600 }}>
          Graph too large to render ({graph.nodes.length} nodes)
        </p>
        <p style={{ fontSize: 13, color: '#94a3b8', marginTop: 8 }}>
          Switch to <strong>Timeline</strong> or <strong>Error Path</strong>{' '}
          view for large traces.
        </p>
      </div>
    );
  }

  // ── Viewport culling ─────────────────────────────────────────────────────────
  // Nodes more than one viewport-width outside the visible area are not rendered.
  const CULL_PAD = 120; // world-space buffer (px) around the visible rect
  const visMinX = (-pan.x)            / scale - CULL_PAD;
  const visMaxX = (svgSize.width  - pan.x) / scale + CULL_PAD;
  const visMinY = (-pan.y)            / scale - CULL_PAD;
  const visMaxY = (svgSize.height - pan.y) / scale + CULL_PAD;

  const visNodeIds = new Set<string>(
    graph.nodes
      .filter(n => {
        const p = positions.get(n.id);
        return p &&
          p.x >= visMinX && p.x <= visMaxX &&
          p.y >= visMinY && p.y <= visMaxY;
      })
      .map(n => n.id),
  );

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="graph-wrapper">

      {/* ── Main canvas ───────────────────────────────────────────────────── */}
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

          {/* Edges — rendered behind nodes */}
          {graph.edges.map(edge => {
            // Skip if both endpoints are off-screen
            if (!visNodeIds.has(edge.source) && !visNodeIds.has(edge.target)) {
              return null;
            }
            const sp = positions.get(edge.source);
            const tp = positions.get(edge.target);
            if (!sp || !tp) return null;

            const dx  = tp.x - sp.x;
            const dy  = tp.y - sp.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const ux  = dx / len;
            const uy  = dy / len;
            const sx  = sp.x + ux * NODE_R;
            const sy  = sp.y + uy * NODE_R;
            const ex  = tp.x - ux * NODE_R;
            const ey  = tp.y - uy * NODE_R;
            // Control point offset — curves to the right of the straight line
            const mx  = (sp.x + tp.x) / 2 - uy * 30;
            const my  = (sp.y + tp.y) / 2 + ux * 30;

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
          {graph.nodes.map(node => {
            if (!visNodeIds.has(node.id)) return null;
            const pos = positions.get(node.id);
            if (!pos) return null;

            const isSelected  = node.id === selectedNodeId;
            const isCollapsed = (node.collapsedCount ?? 0) > 0;
            // IMP-4.3: dim non-matching nodes when search is active
            const isSearchDimmed = searchQuery !== '' && !nodeMatchesSearch(node, searchQuery);
            const r = NODE_R + (node.size - 1) * 2;

            const tooltipText = [
              node.displayName ?? node.label,
              node.data.durationMs != null
                ? `${Math.round(node.data.durationMs)}ms`
                : null,
              node.data.file
                ? `${node.data.file}${node.data.line != null ? `:${node.data.line}` : ''}`
                : null,
            ].filter(Boolean).join('\n');

            return (
              <g
                key={node.id}
                className={`graph-node${isSelected ? ' selected' : ''}${isSearchDimmed ? ' search-dimmed' : ''}`}
                transform={`translate(${pos.x},${pos.y})`}
                onClick={() => onNodeClick(node)}
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter') onNodeClick(node); }}
                style={isSearchDimmed ? { opacity: 0.2 } : undefined}
              >
                <title>{tooltipText}</title>
                <circle
                  r={r}
                  fill={node.color}
                  fillOpacity={0.85}
                  stroke={
                    isSelected  ? '#fff' :
                    isCollapsed ? 'rgba(255,255,255,0.5)' :
                                  'rgba(255,255,255,0.15)'
                  }
                  strokeWidth={isSelected ? 2.5 : isCollapsed ? 2 : 1}
                  strokeDasharray={isCollapsed ? '4 2' : undefined}
                />
                {isCollapsed && (
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    style={{
                      fontSize: Math.max(10, r * 0.55),
                      fontWeight: 700,
                      fill: '#fff',
                      pointerEvents: 'none',
                    }}
                  >
                    ×{node.collapsedCount}
                  </text>
                )}
                <text className="graph-node-label" y={r + LABEL_OFFSET}>
                  {truncate(node.label, 22)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* ── Zoom controls ─────────────────────────────────────────────────── */}
      <div className="graph-controls" role="group" aria-label="Zoom controls">
        <button
          className="graph-ctrl-btn"
          onClick={() => setScale(s => Math.min(3, s * 1.25))}
          title="Zoom in (+)"
          aria-label="Zoom in"
        >+</button>
        <button
          className="graph-ctrl-btn"
          onClick={doFit}
          title="Fit to view (F)"
          aria-label="Fit to view"
        >⊡</button>
        <button
          className="graph-ctrl-btn"
          onClick={() => setScale(s => Math.max(0.1, s * 0.8))}
          title="Zoom out (−)"
          aria-label="Zoom out"
        >−</button>
      </div>

      {/* ── Minimap ─────────────────────────────────────────────────────────── */}
      {graph.nodes.length >= MINIMAP_THRESHOLD && bounds && (
        <Minimap
          positions={positions}
          nodes={graph.nodes}
          bounds={bounds}
          pan={pan}
          scale={scale}
          viewW={svgSize.width}
          viewH={svgSize.height}
        />
      )}
    </div>
  );
}
