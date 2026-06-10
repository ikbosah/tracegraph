/**
 * G1 — Static graph artifact directory layout
 *
 * All paths are resolved from the project root (cwd).
 *
 * .tracegraph/static-graph/
 *   graphify/
 *     graph.json              ← raw Graphify output (gitignored)
 *     graph.html              ← Graphify HTML viewer
 *     GRAPH_REPORT.md
 *     .gitignore
 *   static-graph.normalized.json   ← TraceGraph normalized form
 *   graph_metadata.json             ← timestamp, commit, counts (commit this)
 *   graph_index.json                ← derived lookup tables (gitignored)
 *   architecture-baseline.json      ← cross-community edge snapshot (commit this)
 */
import * as path from 'path';

export const STATIC_GRAPH_SUBDIR   = path.join('.tracegraph', 'static-graph');
export const GRAPHIFY_SUBDIR       = path.join(STATIC_GRAPH_SUBDIR, 'graphify');

export function staticGraphDir(cwd: string): string {
  return path.join(cwd, STATIC_GRAPH_SUBDIR);
}

export function graphifyDir(cwd: string): string {
  return path.join(cwd, GRAPHIFY_SUBDIR);
}

export function rawGraphPath(cwd: string): string {
  return path.join(cwd, GRAPHIFY_SUBDIR, 'graph.json');
}

export function rawGraphHtmlPath(cwd: string): string {
  return path.join(cwd, GRAPHIFY_SUBDIR, 'graph.html');
}

export function rawGraphReportPath(cwd: string): string {
  return path.join(cwd, GRAPHIFY_SUBDIR, 'GRAPH_REPORT.md');
}

export function normalizedGraphPath(cwd: string): string {
  return path.join(cwd, STATIC_GRAPH_SUBDIR, 'static-graph.normalized.json');
}

export function graphMetadataPath(cwd: string): string {
  return path.join(cwd, STATIC_GRAPH_SUBDIR, 'graph_metadata.json');
}

export function graphIndexPath(cwd: string): string {
  return path.join(cwd, STATIC_GRAPH_SUBDIR, 'graph_index.json');
}

export function architectureBaselinePath(cwd: string): string {
  return path.join(cwd, STATIC_GRAPH_SUBDIR, 'architecture-baseline.json');
}

/**
 * Path for runtime call edges derived from PHP debug_backtrace() during audit runs.
 *
 * Written by the CLI after collecting `call_edges.json` from each test run directory.
 * Contains FQN-resolved NormalizedEdge objects (provenance: 'RUNTIME') that augment
 * the static graph when graphify finds 0 edges (common for PHP dynamic dispatch).
 *
 * Gitignored by default (large, derived, audit-run-specific).
 */
export function runtimeCallEdgesPath(cwd: string): string {
  return path.join(cwd, STATIC_GRAPH_SUBDIR, 'runtime_call_edges.json');
}

/** Written by tracegraph graph build to keep graph.json and graph_index.json out of git. */
export const GRAPHIFY_GITIGNORE_CONTENT = `# TraceGraph — static graph artifacts
# graph.json and graph_index.json are large derived files, gitignored by default.
# Commit graph_metadata.json and architecture-baseline.json for team use.
graph.json
graph.html
GRAPH_REPORT.md
../graph_index.json
../runtime_call_edges.json
`;
