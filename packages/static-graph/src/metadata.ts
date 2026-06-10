/**
 * G1 — graph_metadata.json writer / reader / staleness checker
 *
 * graph_metadata.json is a lightweight file committed alongside
 * architecture-baseline.json. It records when the graph was built,
 * which commit it represents, and high-level counts.
 *
 * graph_index.json is derived and gitignored; it is rebuilt from
 * static-graph.normalized.json whenever it is missing or stale.
 */
import * as fs           from 'fs';
import * as path         from 'path';
import { spawnSync }     from 'child_process';
import type { GraphMetadata } from '@tracegraph/shared-types';
import { graphMetadataPath, normalizedGraphPath, graphIndexPath } from './graph-dir';
import type { NormalizedGraph } from './normalizer';
import type { GraphIndex } from './indexer';
import { buildIndex, serializeIndex, deserializeIndex } from './indexer';

// ─── Metadata ─────────────────────────────────────────────────────────────────

export function writeGraphMetadata(
  cwd: string,
  meta: GraphMetadata,
): void {
  fs.writeFileSync(graphMetadataPath(cwd), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

export function loadGraphMetadata(cwd: string): GraphMetadata | null {
  const p = graphMetadataPath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as GraphMetadata;
  } catch {
    return null;
  }
}

export type GraphStaleness = 'fresh' | 'stale' | 'unknown' | 'missing';

/**
 * Compare the commit recorded in graph_metadata.json against the current HEAD.
 * Returns:
 *  'missing'  — no metadata file exists
 *  'unknown'  — cannot determine HEAD (not a git repo or git unavailable)
 *  'fresh'    — metadata commit matches current HEAD
 *  'stale'    — metadata commit differs from current HEAD
 */
export function checkGraphStaleness(meta: GraphMetadata | null): {
  staleness: GraphStaleness;
  currentHead: string | null;
} {
  if (!meta) return { staleness: 'missing', currentHead: null };

  const currentHead = getCurrentGitHead();
  if (!currentHead) return { staleness: 'unknown', currentHead: null };

  const staleness = meta.commit === currentHead ? 'fresh' : 'stale';
  return { staleness, currentHead };
}

// ─── Normalized graph persistence ─────────────────────────────────────────────

export function writeNormalizedGraph(cwd: string, graph: NormalizedGraph): void {
  fs.writeFileSync(normalizedGraphPath(cwd), JSON.stringify(graph, null, 2) + '\n', 'utf8');
}

export function loadNormalizedGraph(cwd: string): NormalizedGraph | null {
  const p = normalizedGraphPath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as NormalizedGraph;
  } catch {
    return null;
  }
}

// ─── Graph index persistence ───────────────────────────────────────────────────

export function writeGraphIndex(cwd: string, index: GraphIndex): void {
  fs.writeFileSync(graphIndexPath(cwd), serializeIndex(index), 'utf8');
}

/**
 * Load the graph index from disk.
 * If the index file is missing but the normalized graph exists, rebuild it.
 * Returns null only when neither file exists.
 */
export function loadOrRebuildGraphIndex(cwd: string): GraphIndex | null {
  const indexPath = graphIndexPath(cwd);
  if (fs.existsSync(indexPath)) {
    try {
      return deserializeIndex(fs.readFileSync(indexPath, 'utf8'));
    } catch {
      // Fall through to rebuild
    }
  }

  // Try to rebuild from normalized graph
  const graph = loadNormalizedGraph(cwd);
  if (!graph) return null;

  const index = buildIndex(graph);
  try {
    writeGraphIndex(cwd, index);
  } catch {
    // Non-fatal: return the rebuilt index even if we couldn't persist it
  }
  return index;
}

// ─── Helper: current git HEAD ─────────────────────────────────────────────────

/**
 * Returns the current git HEAD SHA for the repo at `cwd` (or `process.cwd()`
 * if `cwd` is omitted).  Returns null when git is unavailable or the directory
 * is not inside a git repo.
 */
export function getCurrentGitHead(cwd?: string): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio:    'pipe',
      timeout:  5000,
      ...(cwd ? { cwd } : {}),
    });
    if (result.status === 0) {
      const sha = (result.stdout ?? '').trim();
      return sha || null;
    }
  } catch { /* not a git repo or git unavailable */ }
  return null;
}

// ─── Build graph metadata from a normalized graph ────────────────────────────

export function buildGraphMetadata(
  cwd: string,
  graph: NormalizedGraph,
  graphifyVersion: string,
): GraphMetadata {
  const commit    = getCurrentGitHead(cwd) ?? 'unknown';
  const godNodes  = graph.nodes.filter((n) => n.isGodNode);
  return {
    provider:        'graphify',
    graphifyVersion,
    builtAt:         Date.now(),
    commit,
    nodeCount:       graph.nodes.length,
    edgeCount:       graph.edges.length,
    communityCount:  graph.communities.length,
    godNodeCount:    godNodes.length,
    graphDir:        path.relative(cwd, path.join(cwd, '.tracegraph', 'static-graph')),
  };
}
