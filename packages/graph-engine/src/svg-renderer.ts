/**
 * IMP-4 T-IMP4.2 — Server-side SVG renderer
 *
 * Renders a TraceGraph as an SVG string suitable for embedding in Markdown
 * or writing to a file. Requires no browser, no React, no external deps.
 *
 * Node design and colours match the webview GraphCanvas renderer.
 *
 * Usage:
 *   import { renderGraphSvg } from '@tracegraph/graph-engine/svg';
 *   const svg = renderGraphSvg(traceSessionToGraph(session));
 */
import type { TraceGraph, GraphNode, GraphEdge } from './graph';
import {
  computeLayout,
  getGraphBounds,
  NODE_R,
  LABEL_OFFSET,
  H_SPACING,
  V_SPACING,
} from './layout';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SvgRenderOptions {
  /** Maximum number of nodes to render (default: 200). Larger graphs get a placeholder. */
  maxNodes?:  number;
  /** SVG width in px (default: auto-computed from bounds). */
  width?:     number;
  /** SVG height in px (default: auto-computed from bounds). */
  height?:    number;
  /** Include a legend below the graph (default: true). */
  legend?:    boolean;
  /** Extra padding around the graph bounds (px, default: 32). */
  padding?:   number;
}

/**
 * Render a `TraceGraph` as an SVG string.
 * Safe to embed directly in Markdown (`![](data:image/svg+xml;base64,…)`).
 */
export function renderGraphSvg(
  graph:    TraceGraph,
  options?: SvgRenderOptions,
): string {
  const {
    maxNodes = 200,
    width:   forceWidth,
    height:  forceHeight,
    legend = true,
    padding = 32,
  } = options ?? {};

  if (graph.nodes.length === 0) {
    return buildEmptySvg();
  }

  if (graph.nodes.length > maxNodes) {
    return buildTooLargeSvg(graph.nodes.length, maxNodes);
  }

  const positions = computeLayout(graph.nodes, graph.edges);
  const bounds    = getGraphBounds(positions);
  if (!bounds) return buildEmptySvg();

  const legendHeight = legend ? 48 : 0;
  const svgW = forceWidth  ?? (bounds.width  + padding * 2);
  const svgH = forceHeight ?? (bounds.height + padding * 2 + legendHeight);

  // Translate world coords → SVG viewport coords
  const tx = (wx: number) => wx - bounds.minX + padding;
  const ty = (wy: number) => wy - bounds.minY + padding;

  const lines: string[] = [];

  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    ` width="${svgW}" height="${svgH}"` +
    ` viewBox="0 0 ${svgW} ${svgH}">`,
  );

  // ── Defs ──────────────────────────────────────────────────────────────────
  lines.push(`<defs>`);
  lines.push(
    `<marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">` +
    `<polygon points="0 0, 8 3, 0 6" fill="#475569"/>` +
    `</marker>`,
  );
  lines.push(`</defs>`);

  // ── Background ────────────────────────────────────────────────────────────
  lines.push(
    `<rect width="${svgW}" height="${svgH}" fill="#0f172a" rx="8"/>`,
  );

  // ── Edges ─────────────────────────────────────────────────────────────────
  lines.push(`<g id="edges">`);
  for (const edge of graph.edges) {
    const sp = positions.get(edge.source);
    const tp = positions.get(edge.target);
    if (!sp || !tp) continue;

    const sx = tx(sp.x); const sy = ty(sp.y);
    const ex = tx(tp.x); const ey = ty(tp.y);

    const dx  = ex - sx; const dy = ey - sy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux  = dx / len; const uy = dy / len;

    const r = NODE_R;
    const x1 = sx + ux * r; const y1 = sy + uy * r;
    const x2 = ex - ux * r; const y2 = ey - uy * r;

    // Quadratic bezier control point (curves slightly right of straight line)
    const mx  = (sx + ex) / 2 - uy * 20;
    const my  = (sy + ey) / 2 + ux * 20;

    const isDashed = edge.type === 'parallel_branch';
    const strokeDash = isDashed ? ` stroke-dasharray="5 3"` : '';

    lines.push(
      `<path d="M${x1},${y1} Q${mx},${my} ${x2},${y2}"` +
      ` fill="none" stroke="#475569" stroke-width="1.5"${strokeDash}` +
      ` marker-end="url(#arrow)"/>`,
    );
  }
  lines.push(`</g>`);

  // ── Nodes ─────────────────────────────────────────────────────────────────
  lines.push(`<g id="nodes">`);
  for (const node of graph.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;

    const cx = tx(pos.x);
    const cy = ty(pos.y);
    const r  = NODE_R + (node.size - 1) * 2;

    const tooltipText = esc(node.displayName ?? node.label);

    const isCollapsed = (node.collapsedCount ?? 0) > 0;
    const strokeDash  = isCollapsed ? ` stroke-dasharray="4 2"` : '';

    lines.push(
      `<g>` +
      `<title>${tooltipText}</title>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}"` +
      ` fill="${node.color}" fill-opacity="0.85"` +
      ` stroke="rgba(255,255,255,0.2)" stroke-width="1"${strokeDash}/>`,
    );

    // Collapsed count badge
    if (isCollapsed) {
      lines.push(
        `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"` +
        ` font-size="${Math.max(10, r * 0.55)}" font-weight="700" fill="#fff"` +
        ` font-family="sans-serif" pointer-events="none">` +
        `×${node.collapsedCount}</text>`,
      );
    }

    // Label
    const label = esc(truncate(node.displayName ?? node.label, 20));
    lines.push(
      `<text x="${cx}" y="${cy + r + LABEL_OFFSET}"` +
      ` text-anchor="middle" font-size="11" fill="#e2e8f0"` +
      ` font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">` +
      `${label}</text>`,
    );

    lines.push(`</g>`);
  }
  lines.push(`</g>`);

  // ── Legend ────────────────────────────────────────────────────────────────
  if (legend) {
    const legendY = bounds.height + padding * 2;
    const legendItems: Array<[string, string]> = [
      ['#3b82f6', 'HTTP'],
      ['#f97316', 'DB Query'],
      ['#ef4444', 'Auth Check'],
      ['#a855f7', 'External HTTP'],
      ['#14b8a6', 'Queue'],
      ['#dc2626', 'Error'],
      ['#6b7280', 'Function'],
    ];
    let lx = padding;
    for (const [color, label] of legendItems) {
      lines.push(
        `<circle cx="${lx + 6}" cy="${legendY + 12}" r="5" fill="${color}" fill-opacity="0.85"/>`,
        `<text x="${lx + 14}" y="${legendY + 16}" font-size="9" fill="#94a3b8"` +
        ` font-family="sans-serif">${esc(label)}</text>`,
      );
      lx += label.length * 5.5 + 20;
    }
  }

  lines.push(`</svg>`);
  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function buildEmptySvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60">` +
    `<rect width="240" height="60" fill="#0f172a" rx="6"/>` +
    `<text x="120" y="35" text-anchor="middle" font-size="13" fill="#64748b"` +
    ` font-family="sans-serif">No events</text>` +
    `</svg>`
  );
}

function buildTooLargeSvg(nodeCount: number, max: number): string {
  const msg = `Graph too large (${nodeCount} nodes, max ${max})`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="60" viewBox="0 0 340 60">` +
    `<rect width="340" height="60" fill="#0f172a" rx="6"/>` +
    `<text x="170" y="35" text-anchor="middle" font-size="12" fill="#94a3b8"` +
    ` font-family="sans-serif">${esc(msg)}</text>` +
    `</svg>`
  );
}

// Satisfy unused-import warnings from layout constants used above
void H_SPACING;
void V_SPACING;
