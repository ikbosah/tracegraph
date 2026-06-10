/**
 * G3D — Architecture Baseline
 *
 * Creates, loads, and diffs the static architecture baseline.
 * Written to .tracegraph/static-graph/architecture-baseline.json.
 *
 * Separate from runtime baselines (.tracegraph/baselines/).
 * Commit this file for team-wide architecture drift detection.
 */
import * as fs          from 'fs';
import * as path        from 'path';
import { execSync }     from 'child_process';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type {
  ArchitectureBaseline,
  ArchitectureBaselineGodNode,
  ArchitectureBaselineCommunity,
  ArchitectureBaselineCrossEdge,
} from '@tracegraph/shared-types';
import type { NormalizedGraph, NormalizedNode } from './normalizer';
import type { GraphIndex } from './indexer';
import { architectureBaselinePath } from './graph-dir';
import { getCurrentGitHead, loadGraphMetadata } from './metadata';

// ─── Diff result type ─────────────────────────────────────────────────────────

export type ArchitectureBaselineDiff = {
  newGodNodes:               ArchitectureBaselineGodNode[];
  removedGodNodes:           ArchitectureBaselineGodNode[];
  newCommunities:            ArchitectureBaselineCommunity[];
  removedCommunities:        ArchitectureBaselineCommunity[];
  newCrossCommunityEdges:    ArchitectureBaselineCrossEdge[];
  removedCrossCommunityEdges: ArchitectureBaselineCrossEdge[];
  /** Communities with the same ID but a different member count. */
  changedCommunities: Array<{
    communityId:  string;
    label:        string;
    baselineSize: number;
    currentSize:  number;
  }>;
  totalChanges:      number;
  /** True when new cross-community edges point INTO a sensitive community. */
  hasCriticalChanges: boolean;
};

export type CreateArchitectureBaselineOptions = {
  createdBy?: string;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build an ArchitectureBaseline from the current normalized graph + index.
 * Does not write to disk — call writeArchitectureBaseline() after.
 */
export function createArchitectureBaseline(
  graph:   NormalizedGraph,
  index:   GraphIndex,
  cwd:     string,
  options: CreateArchitectureBaselineOptions = {},
): ArchitectureBaseline {
  const commit      = getCurrentGitHead(cwd) ?? 'unknown';
  const createdBy   = options.createdBy ?? resolveCurrentUser();
  const graphMeta   = loadGraphMetadata(cwd);
  const graphifyVer = graphMeta?.graphifyVersion ?? 'unknown';

  const godNodes:            ArchitectureBaselineGodNode[]    = extractGodNodes(index);
  const communities:         ArchitectureBaselineCommunity[]  = extractCommunities(graph);
  const crossCommunityEdges: ArchitectureBaselineCrossEdge[]  = extractCrossCommunityEdges(graph);

  return {
    schemaVersion:       SCHEMA_VERSIONS.architectureBaseline,
    createdAt:           Date.now(),
    createdBy,
    commit,
    provider:            'graphify',
    graphifyVersion:     graphifyVer,
    nodeCount:           graph.nodes.length,
    edgeCount:           graph.edges.length,
    communityCount:      graph.communities.length,
    godNodes,
    communities,
    crossCommunityEdges,
  };
}

/** Write an ArchitectureBaseline to disk atomically (.tmp → rename). */
export function writeArchitectureBaseline(baseline: ArchitectureBaseline, cwd: string): void {
  const outPath = architectureBaselinePath(cwd);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, outPath);
}

/** Load a stored ArchitectureBaseline from disk. Returns null when absent or unreadable. */
export function loadArchitectureBaseline(cwd: string): ArchitectureBaseline | null {
  const p = architectureBaselinePath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ArchitectureBaseline;
  } catch {
    return null;
  }
}

/**
 * Diff the current graph + index against a stored architecture baseline.
 *
 * Returns new/removed god nodes, communities, and cross-community edges,
 * plus a `hasCriticalChanges` flag for CI gating.
 */
export function diffArchitectureBaseline(
  graph:    NormalizedGraph,
  index:    GraphIndex,
  baseline: ArchitectureBaseline,
): ArchitectureBaselineDiff {
  // ── God node diff ─────────────────────────────────────────────────────────
  const currentGodSymbols  = new Set([...index.godNodes.values()].map((n) => n.symbolName));
  const baselineGodSymbols = new Set(baseline.godNodes.map((n) => n.symbolName));

  const newGodNodes: ArchitectureBaselineGodNode[] = [];
  for (const node of index.godNodes.values()) {
    if (!baselineGodSymbols.has(node.symbolName)) {
      newGodNodes.push({
        symbolName:           node.symbolName,
        communityId:          node.communityId  ?? '',
        communityLabel:       node.communityLabel ?? '',
        centralityPercentile: node.centralityPercentile,
        file:                 node.file,
      });
    }
  }
  const removedGodNodes = baseline.godNodes.filter((n) => !currentGodSymbols.has(n.symbolName));

  // ── Community diff ────────────────────────────────────────────────────────
  const currentCommunityIds = new Set(graph.communities.map((c) => c.communityId));
  const baselineCommunityIds = new Set(baseline.communities.map((c) => c.communityId));

  const newCommunities: ArchitectureBaselineCommunity[] = graph.communities
    .filter((c) => !baselineCommunityIds.has(c.communityId))
    .map((c) => ({ communityId: c.communityId, label: c.label, size: c.size, isSensitive: c.isSensitive }));

  const removedCommunities = baseline.communities.filter(
    (c) => !currentCommunityIds.has(c.communityId),
  );

  const changedCommunities: ArchitectureBaselineDiff['changedCommunities'] = [];
  for (const current of graph.communities) {
    const base = baseline.communities.find((c) => c.communityId === current.communityId);
    if (base && base.size !== current.size) {
      changedCommunities.push({
        communityId:  current.communityId,
        label:        current.label,
        baselineSize: base.size,
        currentSize:  current.size,
      });
    }
  }

  // ── Cross-community edge diff ─────────────────────────────────────────────
  const currentEdges  = extractCrossCommunityEdges(graph);
  const currentEdgeKeys  = new Set(currentEdges.map(edgeKey));
  const baselineEdgeKeys = new Set(baseline.crossCommunityEdges.map(edgeKey));

  const newCrossCommunityEdges    = currentEdges.filter((e) => !baselineEdgeKeys.has(edgeKey(e)));
  const removedCrossCommunityEdges = baseline.crossCommunityEdges.filter(
    (e) => !currentEdgeKeys.has(edgeKey(e)),
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalChanges =
    newGodNodes.length +
    removedGodNodes.length +
    newCommunities.length +
    removedCommunities.length +
    newCrossCommunityEdges.length +
    removedCrossCommunityEdges.length;

  const sensitiveIds = new Set(
    [...graph.communities, ...baseline.communities]
      .filter((c) => c.isSensitive)
      .map((c) => c.communityId),
  );
  const hasCriticalChanges = newCrossCommunityEdges.some((e) => sensitiveIds.has(e.toCommunityId));

  return {
    newGodNodes,
    removedGodNodes,
    newCommunities,
    removedCommunities,
    newCrossCommunityEdges,
    removedCrossCommunityEdges,
    changedCommunities,
    totalChanges,
    hasCriticalChanges,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function extractGodNodes(index: GraphIndex): ArchitectureBaselineGodNode[] {
  return [...index.godNodes.values()].map((node) => ({
    symbolName:           node.symbolName,
    communityId:          node.communityId  ?? '',
    communityLabel:       node.communityLabel ?? '',
    centralityPercentile: node.centralityPercentile,
    file:                 node.file,
  }));
}

function extractCommunities(graph: NormalizedGraph): ArchitectureBaselineCommunity[] {
  return graph.communities.map((c) => ({
    communityId:  c.communityId,
    label:        c.label,
    size:         c.size,
    isSensitive:  c.isSensitive,
  }));
}

/**
 * Extract all cross-community edges from the normalized graph.
 * A cross-community edge connects nodes in two different communities.
 */
export function extractCrossCommunityEdges(graph: NormalizedGraph): ArchitectureBaselineCrossEdge[] {
  // Build nodeId → communityId and communityId → community maps
  const nodeCommunity = new Map<string, string>();
  for (const community of graph.communities) {
    for (const nodeId of community.memberNodeIds) {
      nodeCommunity.set(nodeId, community.communityId);
    }
  }

  const nodeById = new Map<string, NormalizedNode>();
  for (const node of graph.nodes) {
    nodeById.set(node.nodeId, node);
  }

  const communityMeta = new Map<string, { label: string; isSensitive: boolean }>();
  for (const c of graph.communities) {
    communityMeta.set(c.communityId, { label: c.label, isSensitive: c.isSensitive });
  }

  const result: ArchitectureBaselineCrossEdge[] = [];
  const seen    = new Set<string>();

  for (const edge of graph.edges) {
    const fromCommunityId = nodeCommunity.get(edge.sourceId);
    const toCommunityId   = nodeCommunity.get(edge.targetId);

    if (!fromCommunityId || !toCommunityId || fromCommunityId === toCommunityId) continue;

    const fromNode = nodeById.get(edge.sourceId);
    const toNode   = nodeById.get(edge.targetId);
    if (!fromNode || !toNode) continue;

    const key = `${fromNode.symbolName}→${toNode.symbolName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const fromComm = communityMeta.get(fromCommunityId);
    const toComm   = communityMeta.get(toCommunityId);

    result.push({
      fromCommunityId,
      fromCommunityLabel: fromComm?.label ?? fromCommunityId,
      toCommunityId,
      toCommunityLabel:   toComm?.label   ?? toCommunityId,
      callerSymbol:       fromNode.symbolName,
      calleeSymbol:       toNode.symbolName,
      traceCount:         0,
      staticOnly:         true,
    });
  }

  return result;
}

function edgeKey(e: ArchitectureBaselineCrossEdge): string {
  return `${e.callerSymbol}→${e.calleeSymbol}`;
}

function resolveCurrentUser(): string {
  try {
    const name = execSync('git config user.name', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return name || 'unknown';
  } catch {
    return process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown';
  }
}
