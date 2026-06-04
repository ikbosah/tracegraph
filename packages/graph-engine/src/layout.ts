/**
 * IMP-4 T-IMP4.1 — Shared graph layout engine
 *
 * Extracted from `apps/webview/src/GraphCanvas.tsx` so the same algorithm
 * is available in Node.js (for server-side SVG rendering) and the browser.
 *
 * The original GraphCanvas.tsx keeps its local copy for now; the webview
 * will be updated to import from here after the next build cycle.
 *
 * Algorithm: Reingold-Tilford style subtree-width-aware layout.
 *   1. Topological sort → compute depth (y) via longest-path from roots.
 *   2. DFS post-order: assign sequential x-slots to leaf nodes.
 *   3. Bottom-up: assign x to internal nodes as the midpoint of their children.
 *   4. Centre the full layout around x = 0.
 */
import type { GraphNode, GraphEdge } from './graph';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Horizontal space reserved per leaf node (px). */
export const H_SPACING = 180;
/** Vertical gap between depth levels (px). */
export const V_SPACING = 120;
/** Circle radius for a size-1 node. */
export const NODE_R = 28;
/** Vertical offset from circle bottom to label baseline. */
export const LABEL_OFFSET = 14;
/** Extra padding around each node when computing graph bounds. */
export const BOUNDS_PAD = NODE_R + LABEL_OFFSET + 8;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NodePosition {
  x: number;
  y: number;
}

export interface GraphBounds {
  minX:   number;
  maxX:   number;
  minY:   number;
  maxY:   number;
  width:  number;
  height: number;
}

// ─── Topological sort ─────────────────────────────────────────────────────────

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

// ─── Layout ───────────────────────────────────────────────────────────────────

/**
 * Compute (x, y) positions for all nodes using a subtree-width-aware layout.
 * Returns a `Map<nodeId, NodePosition>`.
 */
export function computeLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();
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
  for (const n of nodes) {
    if (!xPos.has(n.id) && (childrenOf.get(n.id) ?? []).length === 0) {
      xPos.set(n.id, leafSlot++ * H_SPACING);
    }
  }

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

// ─── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Compute the bounding box of all node positions (with padding).
 * Returns null for empty graphs.
 */
export function getGraphBounds(
  positions: Map<string, NodePosition>,
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
