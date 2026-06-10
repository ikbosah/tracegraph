/**
 * G1 — Graphify → TraceGraph NormalizedGraph
 *
 * Translates the raw Graphify output schema into TraceGraph's internal
 * normalized representation. Only this file changes if Graphify's output
 * format changes — all consumers use NormalizedGraph.
 */
import type { GraphifyGraph, GraphifyNode, GraphifyProvenance } from './graphify-schema';
import type { StaticGraphConfig } from '@tracegraph/shared-types';


// ─── Internal normalized types (not re-exported via shared-types) ─────────────

export type NormalizedNodeType = 'function' | 'method' | 'class' | 'module' | 'other';

export type NormalizedNode = {
  /** Stable ID from Graphify (string-coerced). */
  nodeId: string;
  /** Fully qualified symbol name. Used as primary match key. */
  symbolName: string;
  /** Short display name (last segment of symbolName). */
  displayName: string;
  /** Source file relative to project root, forward slashes. */
  file?: string;
  line?: number;
  type: NormalizedNodeType;
  docstring?: string;
  rationale?: string[];
  communityId?: string;
  communityLabel?: string;
  /** Raw in+out edge count. */
  degree: number;
  /**
   * Percentile rank of this node's degree among all nodes in the graph.
   * 0 = lowest degree, 100 = highest degree.
   * A node at centralityPercentile 99 is in the top 1%.
   */
  centralityPercentile: number;
  /** True when centralityPercentile >= config.godNodeThresholdPercentile (default: 95). */
  isGodNode: boolean;
  provenance: GraphifyProvenance;
};

export type NormalizedEdge = {
  sourceId: string;
  targetId: string;
  /** Relationship type: "calls", "imports", "inherits", "uses", etc. */
  type: string;
  provenance: GraphifyProvenance;
};

export type NormalizedCommunity = {
  communityId: string;
  label: string;
  size: number;
  memberNodeIds: string[];
  /** True when the label matches one of config.sensitiveCommunities patterns. */
  isSensitive: boolean;
};

export type NormalizedGraph = {
  schemaVersion: 'tracegraph.static-graph.v1';
  nodes: NormalizedNode[];
  edges: NormalizedEdge[];
  communities: NormalizedCommunity[];
};

// ─── Normalizer ───────────────────────────────────────────────────────────────

export function normalizeGraphify(
  raw: GraphifyGraph,
  config: Pick<StaticGraphConfig,
    'godNodeThresholdPercentile' | 'sensitiveCommunities'
  >,
): NormalizedGraph {
  const godThreshold  = config.godNodeThresholdPercentile ?? 95;
  const sensitiveList = config.sensitiveCommunities ?? ['auth', 'billing', 'payments', 'identity'];

  // ── 1. Build community map ────────────────────────────────────────────────
  const communityMap = buildCommunityMap(raw);

  // ── 2. Compute degree for each node ──────────────────────────────────────
  // Use the degree from Graphify if provided; fall back to counting edges.
  const edgeDegrees = computeEdgeDegrees(raw);

  // ── 3. Normalize nodes ────────────────────────────────────────────────────
  const rawNodes = raw.nodes;
  const degrees  = rawNodes.map((n) => {
    const fromGraph = typeof n.degree === 'number' ? n.degree : 0;
    const fromEdges = edgeDegrees.get(n.id) ?? 0;
    return Math.max(fromGraph, fromEdges);
  });

  // Compute percentile ranks (0–100)
  const percentiles = computePercentiles(degrees);

  const nodes: NormalizedNode[] = rawNodes.map((raw, i) => {
    const degree              = degrees[i] ?? 0;
    const centralityPercentile = percentiles[i] ?? 0;
    const communityId         = raw.community_id != null ? String(raw.community_id) : undefined;
    const communityLabel      = communityId != null
      ? (communityMap.get(communityId)?.label ?? communityId)
      : raw.community_label ?? undefined;

    return {
      nodeId:               raw.id,
      symbolName:           raw.qualified_name ?? raw.name ?? raw.id ?? 'unknown',
      displayName:          extractDisplayName(raw.qualified_name ?? raw.name ?? raw.id ?? 'unknown'),
      file:                 raw.file ? normalizeFilePath(raw.file) : undefined,
      line:                 raw.line,
      type:                 normalizeNodeType(raw.type),
      docstring:            raw.docstring,
      rationale:            raw.rationale,
      communityId,
      communityLabel,
      degree,
      centralityPercentile,
      isGodNode:            centralityPercentile >= godThreshold,
      provenance:           raw.provenance ?? 'EXTRACTED',
    };
  });

  // ── 4. Normalize edges ────────────────────────────────────────────────────
  const edges: NormalizedEdge[] = (raw.edges ?? []).map((e) => ({
    sourceId:   e.source,
    targetId:   e.target,
    type:       e.type ?? 'calls',
    provenance: e.provenance ?? 'EXTRACTED',
  }));

  // ── 5. Normalize communities ──────────────────────────────────────────────
  const communities: NormalizedCommunity[] = (raw.communities ?? []).map((c) => {
    const id    = String(c.id);
    const label = c.label ?? `community_${id}`;
    return {
      communityId:   id,
      label,
      size:          c.size,
      memberNodeIds: c.members,
      isSensitive:   isSensitiveCommunity(label, sensitiveList),
    };
  });

  // If Graphify didn't provide community objects but nodes have community_id,
  // synthesise minimal community entries from the node data.
  if (communities.length === 0) {
    const synthetic = synthesiseCommunities(nodes, sensitiveList);
    communities.push(...synthetic);
  }

  return { schemaVersion: 'tracegraph.static-graph.v1', nodes, edges, communities };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildCommunityMap(raw: GraphifyGraph): Map<string, { label?: string }> {
  const map = new Map<string, { label?: string }>();
  for (const c of raw.communities ?? []) {
    map.set(String(c.id), { label: c.label });
  }
  return map;
}

/** Count how many edges each node participates in (in + out). */
function computeEdgeDegrees(raw: GraphifyGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of raw.edges ?? []) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  return counts;
}

/**
 * Given an array of degree values, compute the percentile rank (0–100) for each.
 * A node with rank 99 is in the top 1% by degree.
 *
 * Uses strictly-less-than rank: a node's percentile is the fraction of nodes
 * with a LOWER degree.  This means:
 *   • When all nodes have the same degree (e.g. 0 edges in a JS repo where
 *     graphify uses tree-sitter without call-graph extraction), every node
 *     gets percentile 0 — none become false god nodes.
 *   • A true god node (degree much higher than peers) gets percentile close to 100.
 */
function computePercentiles(degrees: number[]): number[] {
  if (degrees.length === 0) return [];
  const sorted = [...degrees].sort((a, b) => a - b);
  return degrees.map((d) => {
    // Count nodes with STRICTLY lower degree (not <=).
    // This avoids ranking all equal-degree nodes at 100th percentile.
    const rank  = sorted.filter((x) => x < d).length;
    return Math.round((rank / sorted.length) * 100);
  });
}

function normalizeNodeType(raw?: string): NormalizedNodeType {
  switch (raw) {
    case 'function': return 'function';
    case 'method':   return 'method';
    case 'class':    return 'class';
    case 'module':   return 'module';
    default:         return 'other';
  }
}

/** Extract the short display name from a fully qualified symbol name. */
function extractDisplayName(symbolName: string | undefined | null): string {
  if (!symbolName) return '';
  // Strip namespace prefix: "App\\Services\\PaymentProcessor::charge" → "PaymentProcessor::charge"
  const nsSep = symbolName.lastIndexOf('\\');
  const s = nsSep >= 0 ? symbolName.slice(nsSep + 1) : symbolName;
  // PHP/C++ class::method → method name only
  const colonColon = s.indexOf('::');
  if (colonColon >= 0) return s.slice(colonColon + 2);
  // Dot-style class.method → method name only
  const dotSep = s.lastIndexOf('.');
  if (dotSep > 0) return s.slice(dotSep + 1);
  return s;
}

/** Normalize file paths to forward slashes and relative form. */
function normalizeFilePath(filePath: string | undefined | null): string {
  if (!filePath) return '';
  return filePath.replace(/\\/g, '/');
}

/** Check if a community label matches any sensitive pattern (substring match). */
function isSensitiveCommunity(label: string, sensitiveList: string[]): boolean {
  const lower = label.toLowerCase();
  return sensitiveList.some((s) => lower.includes(s.toLowerCase()));
}

// ─── Runtime graph augmentation ───────────────────────────────────────────────

/**
 * Augment a NormalizedGraph with runtime-derived edges.
 *
 * Merges `runtimeEdges` (provenance='RUNTIME') into the graph, then
 * recomputes `degree`, `centralityPercentile`, and `isGodNode` for every
 * node using all edges (static + runtime combined).
 *
 * Idempotent: any pre-existing RUNTIME edges in `graph.edges` are stripped
 * first, so calling this function twice with the same runtime edges produces
 * the same result (no duplication).
 *
 * Does NOT mutate the input graph — returns a new NormalizedGraph.
 */
export function augmentNormalizedGraph(
  graph:        NormalizedGraph,
  runtimeEdges: NormalizedEdge[],
  config:       Pick<StaticGraphConfig, 'godNodeThresholdPercentile'>,
): NormalizedGraph {
  const godThreshold = config.godNodeThresholdPercentile ?? 95;

  // Strip any previously-derived runtime edges to ensure idempotency.
  const staticEdges = graph.edges.filter((e) => e.provenance !== 'RUNTIME');
  const allEdges    = [...staticEdges, ...runtimeEdges];

  // Recompute degree from all edges (in + out).
  const edgeDegrees = new Map<string, number>();
  for (const edge of allEdges) {
    edgeDegrees.set(edge.sourceId, (edgeDegrees.get(edge.sourceId) ?? 0) + 1);
    edgeDegrees.set(edge.targetId, (edgeDegrees.get(edge.targetId) ?? 0) + 1);
  }

  const degrees     = graph.nodes.map((n) => edgeDegrees.get(n.nodeId) ?? 0);
  const percentiles = computePercentiles(degrees);

  const nodes: NormalizedNode[] = graph.nodes.map((n, i) => ({
    ...n,
    degree:               degrees[i] ?? 0,
    centralityPercentile: percentiles[i] ?? 0,
    isGodNode:            (percentiles[i] ?? 0) >= godThreshold,
  }));

  return {
    schemaVersion: graph.schemaVersion,
    nodes,
    edges:         allEdges,
    communities:   graph.communities,
  };
}

/**
 * If Graphify didn't emit a `communities` array but nodes have community_id,
 * build synthetic community objects from node data.
 */
function synthesiseCommunities(
  nodes: NormalizedNode[],
  sensitiveList: string[],
): NormalizedCommunity[] {
  const byId = new Map<string, { label: string; members: string[] }>();
  for (const node of nodes) {
    if (!node.communityId) continue;
    let entry = byId.get(node.communityId);
    if (!entry) {
      entry = { label: node.communityLabel ?? node.communityId, members: [] };
      byId.set(node.communityId, entry);
    }
    entry.members.push(node.nodeId);
  }
  return [...byId.entries()].map(([id, { label, members }]) => ({
    communityId:   id,
    label,
    size:          members.length,
    memberNodeIds: members,
    isSensitive:   isSensitiveCommunity(label, sensitiveList),
  }));
}
