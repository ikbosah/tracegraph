/**
 * T1.6 — Graph engine
 *
 * Converts a finalised TraceSession into a TraceGraph suitable for rendering.
 *
 * Design decisions (ARCHITECTURE.md §9):
 *  - Events from node_modules / vendor directories are collapsed into a single
 *    node per package, keeping the graph focused on application code.
 *  - Edges are derived from the parentEventId chain.
 *  - asyncGroupId members are marked as parallel_branch edges.
 *  - tracegraph_xdebug_marker events are stripped.
 */
import type { TraceSession, TraceEvent, CaptureLevel } from '@tracegraph/shared-types';

// ─── Public types ─────────────────────────────────────────────────────────────

export type GraphNodeType =
  | 'http_request' | 'http_response'
  | 'function_call' | 'method_call' | 'return'
  | 'db_query'
  | 'external_http_call'
  | 'auth_check' | 'authorization_check'
  | 'error' | 'log'
  | 'queue_event'
  | 'trace_start' | 'trace_end'
  // ── Test runner nodes (M3) ────────────────────────────────────────────────
  | 'test_file' | 'test_suite' | 'test_run'
  | 'vendor'
  | 'other';

export type GraphNode = {
  /** Stable node ID (equals eventId, or 'vendor__<pkg>' for collapsed packages). */
  id:           string;
  label:        string;
  displayName?: string;
  type:         GraphNodeType;
  language:     string;
  framework?:   string;
  durationMs?:  number;
  file?:        string;
  line?:        number;
  /** Hex colour string for the node. */
  color:        string;
  /** Visual size (1–10 scale). */
  size:         number;
  /** The original TraceEvent that produced this node. */
  data:         TraceEvent;
  /**
   * Set when this node represents N collapsed siblings of the same type.
   * The label will already include the count; this field allows renderers
   * to display a badge or different visual treatment.
   */
  collapsedCount?: number;
};

export type GraphEdgeType = 'parent' | 'parallel_branch';

export type GraphEdge = {
  id:     string;
  source: string;
  target: string;
  label?: string;
  type:   GraphEdgeType;
};

export type TraceGraph = {
  nodes:         GraphNode[];
  edges:         GraphEdge[];
  captureLevel:  CaptureLevel;
};

// ─── Node colours (matching T1.7 spec) ───────────────────────────────────────

const NODE_COLORS: Partial<Record<string, string>> = {
  http_request:       '#3b82f6',   // blue
  http_response:      '#3b82f6',   // blue
  db_query:           '#f97316',   // orange
  authorization_check:'#ef4444',   // red
  auth_check:         '#ef4444',   // red
  external_http_call: '#a855f7',   // purple
  function_call:      '#6b7280',   // grey
  method_call:        '#6b7280',   // grey
  return:             '#9ca3af',   // light grey
  error:              '#dc2626',   // crimson
  queue_event:        '#14b8a6',   // teal
  trace_start:        '#94a3b8',   // slate
  trace_end:          '#94a3b8',   // slate
  log:                '#a3a3a3',   // neutral
  // Test runner nodes — green spectrum, dimmed for skips
  test_file:          '#4ade80',   // bright green
  test_suite:         '#86efac',   // medium green
  test_run:           '#bbf7d0',   // light green (pass colour; fail overridden in code)
  vendor:             '#cbd5e1',   // very light
};

const DEFAULT_COLOR = '#6b7280';

function getNodeColor(type: string): string {
  return NODE_COLORS[type] ?? DEFAULT_COLOR;
}

/**
 * Returns the correct color for a node, with special handling for test_run
 * nodes whose color depends on the test outcome (pass/fail/skip).
 */
function getTestAwareColor(event: TraceEvent): string {
  if (event.type === 'test_run') {
    const status = event.metadata?.['testStatus'] as string | undefined;
    if (status === 'fail')  return '#ef4444';   // red
    if (status === 'skip')  return '#d1d5db';   // light grey
    return NODE_COLORS.test_run ?? DEFAULT_COLOR; // green for pass
  }
  return getNodeColor(event.type);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VENDOR_PATH_RE = /(?:node_modules|\/vendor\/)[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/;

function isVendorEvent(event: TraceEvent): boolean {
  const f = event.file ?? '';
  return VENDOR_PATH_RE.test(f);
}

function extractPackageName(file: string): string {
  const m = file.match(VENDOR_PATH_RE);
  return m?.[1] ?? 'vendor';
}

function vendorNodeId(pkg: string): string {
  return `vendor__${pkg.replace(/[^a-z0-9@]/gi, '_')}`;
}

function computeNodeSize(event: TraceEvent): number {
  if (!event.durationMs) return 1;
  // Log scale: 1ms → 1, 10ms → 2, 100ms → 3, 1s → 4, 10s → 5
  return Math.max(1, Math.min(10, Math.ceil(Math.log10(event.durationMs + 1))));
}

// ─── Main conversion function ─────────────────────────────────────────────────

/**
 * Converts a TraceSession into a graph structure with nodes and edges.
 *
 * @returns A TraceGraph suitable for passing to the webview renderer.
 */
export function traceSessionToGraph(session: TraceSession): TraceGraph {
  const nodes: GraphNode[]  = [];
  const edges: GraphEdge[]  = [];

  /** eventId → nodeId (handles vendor collapse) */
  const eventToNodeId = new Map<string, string>();
  /** package name → vendor node (one per collapsed package) */
  const vendorNodes   = new Map<string, GraphNode>();

  // ── Pass 1: build nodes ────────────────────────────────────────────────────
  for (const event of session.events) {
    // Strip Xdebug marker events
    if (event.name?.includes('tracegraph_xdebug_marker')) continue;
    if (event.type === 'trace_start' || event.type === 'trace_end') {
      // Include but use a special lightweight node
    }

    if (isVendorEvent(event)) {
      const pkg    = extractPackageName(event.file!);
      const nodeId = vendorNodeId(pkg);

      if (!vendorNodes.has(nodeId)) {
        const vendorNode: GraphNode = {
          id:       nodeId,
          label:    pkg,
          type:     'vendor',
          language: event.language,
          color:    NODE_COLORS.vendor!,
          size:     1,
          data:     event,
        };
        vendorNodes.set(nodeId, vendorNode);
        nodes.push(vendorNode);
      }

      eventToNodeId.set(event.eventId, nodeId);
      continue;
    }

    const nodeType = event.type as GraphNodeType;
    const node: GraphNode = {
      id:          event.eventId,
      label:       event.displayName ?? event.name,
      displayName: event.displayName,
      type:        nodeType,
      language:    event.language,
      framework:   event.framework,
      durationMs:  event.durationMs,
      file:        event.file,
      line:        event.line,
      color:       getTestAwareColor(event),
      size:        computeNodeSize(event),
      data:        event,
    };

    nodes.push(node);
    eventToNodeId.set(event.eventId, event.eventId);
  }

  // ── Pass 2: build edges ────────────────────────────────────────────────────
  const asyncGroupSeen = new Map<string, string[]>(); // groupId → [nodeIds]

  for (const event of session.events) {
    if (!event.parentEventId) continue;

    const sourceNodeId = eventToNodeId.get(event.parentEventId);
    const targetNodeId = eventToNodeId.get(event.eventId);

    if (!sourceNodeId || !targetNodeId) continue;
    // Skip self-loops (vendor collapse can produce these)
    if (sourceNodeId === targetNodeId) continue;

    // Determine edge type
    let edgeType: GraphEdgeType = 'parent';
    if (event.asyncGroupId) {
      const group = asyncGroupSeen.get(event.asyncGroupId) ?? [];
      if (group.length > 0) edgeType = 'parallel_branch';
      group.push(targetNodeId);
      asyncGroupSeen.set(event.asyncGroupId, group);
    }

    const edgeId = `${sourceNodeId}→${targetNodeId}`;
    // Deduplicate edges (vendor collapse can create duplicates)
    if (!edges.some((e) => e.id === edgeId)) {
      edges.push({ id: edgeId, source: sourceNodeId, target: targetNodeId, type: edgeType });
    }
  }

  return collapseSiblings({ nodes, edges, captureLevel: session.captureLevel });
}

// ─── Sibling-collapse post-processing ────────────────────────────────────────

/**
 * When a parent node has more than SIBLING_COLLAPSE_THRESHOLD children of the
 * same type, replace them all with a single summary node.
 *
 * This prevents runaway graph widths when a trace captures hundreds of
 * repeated events (e.g. 1,225 db_query nodes from a full test-suite run).
 * The summary node's label is "db query ×1225" and its collapsedCount is set
 * so the renderer can style it differently.
 */
const SIBLING_COLLAPSE_THRESHOLD = 5;

function collapseSiblings(graph: TraceGraph): TraceGraph {
  const { nodes, edges, captureLevel } = graph;

  if (nodes.length <= SIBLING_COLLAPSE_THRESHOLD * 2) {
    return graph;
  }

  // ── Build: parentId → Map<type, nodeId[]> ─────────────────────────────────
  const nodeById         = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));
  const childrenByParent = new Map<string, Map<string, string[]>>();

  for (const edge of edges) {
    if (!childrenByParent.has(edge.source)) {
      childrenByParent.set(edge.source, new Map());
    }
    const target = nodeById.get(edge.target);
    if (!target) continue;
    const typeMap = childrenByParent.get(edge.source)!;
    if (!typeMap.has(target.type)) typeMap.set(target.type, []);
    typeMap.get(target.type)!.push(edge.target);
  }

  // ── Pass 1: identify which nodes will be collapsed ────────────────────────
  // We must know this BEFORE creating summary nodes so we can skip creating
  // summary children for parents that are themselves being collapsed (which
  // would produce orphaned summary nodes with no surviving parent).
  const willCollapse = new Set<string>();
  for (const typeMap of childrenByParent.values()) {
    for (const nodeIds of typeMap.values()) {
      if (nodeIds.length >= SIBLING_COLLAPSE_THRESHOLD) {
        for (const id of nodeIds) willCollapse.add(id);
      }
    }
  }

  if (willCollapse.size === 0) return graph;

  // ── Pass 2: create summary nodes only for non-collapsed parents ───────────
  const summaryNodes: GraphNode[] = [];
  const summaryEdges: GraphEdge[] = [];

  for (const [parentId, typeMap] of childrenByParent) {
    // Skip: if this parent is itself being collapsed its summary children would
    // be orphaned (parent no longer exists in the output graph).
    if (willCollapse.has(parentId)) continue;

    for (const [type, nodeIds] of typeMap) {
      if (nodeIds.length < SIBLING_COLLAPSE_THRESHOLD) continue;

      const first    = nodeById.get(nodeIds[0]!)!;
      const typeName = type.replace(/_/g, ' ');
      const summaryId = `summary__${parentId}__${type}`;

      summaryNodes.push({
        id:             summaryId,
        label:          `${typeName} ×${nodeIds.length}`,
        type:           type as GraphNodeType,
        language:       first.language,
        framework:      first.framework,
        color:          first.color,
        size:           Math.min(10, Math.ceil(Math.log10(nodeIds.length + 1)) + 3),
        collapsedCount: nodeIds.length,
        data:           first.data,
      });

      summaryEdges.push({
        id:     `${parentId}→${summaryId}`,
        source: parentId,
        target: summaryId,
        type:   'parent',
      });
    }
  }

  return {
    nodes: [
      ...nodes.filter((n) => !willCollapse.has(n.id)),
      ...summaryNodes,
    ],
    edges: [
      ...edges.filter((e) => !willCollapse.has(e.source) && !willCollapse.has(e.target)),
      ...summaryEdges,
    ],
    captureLevel,
  };
}
