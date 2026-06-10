/**
 * G9 — Team Server Architecture Dashboard API
 *
 * Routes:
 *   POST /api/v1/projects/:projectId/architecture
 *     Upload an architecture snapshot (ArchitectureBaseline JSON).
 *     Called by `tracegraph compare --upload` when a static graph is present,
 *     or by `tracegraph architecture baseline push --server`.
 *
 *   GET  /api/v1/projects/:projectId/architecture
 *     Latest snapshot: metadata, community list, god nodes, and debt score.
 *
 *   GET  /api/v1/projects/:projectId/architecture/drift
 *     Last 30 snapshots summarised for the drift chart (node/community/edge counts over time).
 *
 *   GET  /api/v1/projects/:projectId/architecture/nodes/:nodeId/traces
 *     Recent traces that exercised the given node (matched by symbolName or staticNodeId).
 */
import { Router, Request, Response } from 'express';
import path from 'path';
import fs   from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { requireAuth } from './auth';
import type { ArchitectureBaseline } from '@tracegraph/shared-types';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';

const router = Router({ mergeParams: true });

// ── Data directory (for reading stored trace files) ───────────────────────────

const dataDir   = process.env['TRACEGRAPH_DATA_DIR'] ?? path.join(process.cwd(), 'data');
const tracesDir = path.join(dataDir, 'traces');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute an architecture debt score (0–100).
 * Higher = more technical debt in the architecture shape.
 *
 * Components:
 *   - God node ratio: (godNodeCount / nodeCount) — centralisation
 *   - Cross-edge density: (crossEdgeCount / communities²) — coupling between modules
 */
function computeDebtScore(
  nodeCount:     number,
  godNodeCount:  number,
  communityCount: number,
  crossEdgeCount: number,
): number {
  if (nodeCount === 0) return 0;

  const godRatio       = godNodeCount  / nodeCount;
  const communityPairs = communityCount * (communityCount - 1);
  const crossRatio     = communityPairs > 0 ? crossEdgeCount / communityPairs : 0;

  // Weighted sum, capped at 100
  const raw = (godRatio * 60) + (crossRatio * 40) * 100;
  return Math.min(100, Math.round(raw * 10) / 10);
}

// ── POST /architecture ────────────────────────────────────────────────────────

router.post('/', requireAuth, (req: Request, res: Response): void => {
  const { projectId } = req.params as { projectId: string };
  const { run_id }    = req.query  as { run_id?: string };
  const db            = getDb();

  // Validate the project exists
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) {
    res.status(404).json({ error: `Project not found: ${projectId}` });
    return;
  }

  const baseline = req.body as ArchitectureBaseline;
  if (!baseline || baseline.schemaVersion !== 'tracegraph.architecture-baseline.v1') {
    res.status(400).json({ error: 'Body must be a valid ArchitectureBaseline JSON object' });
    return;
  }

  const godNodeCount   = baseline.godNodes?.length             ?? 0;
  const crossEdgeCount = baseline.crossCommunityEdges?.length  ?? 0;
  const debtScore      = computeDebtScore(
    baseline.nodeCount,
    godNodeCount,
    baseline.communityCount,
    crossEdgeCount,
  );

  const id = `arch_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

  db.prepare(`
    INSERT INTO architecture_snapshots
      (id, project_id, run_id, commit, graphify_version,
       node_count, edge_count, community_count, god_node_count, cross_edge_count,
       debt_score, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    run_id ?? null,
    baseline.commit ?? null,
    baseline.graphifyVersion ?? null,
    baseline.nodeCount        ?? 0,
    baseline.edgeCount        ?? 0,
    baseline.communityCount   ?? 0,
    godNodeCount,
    crossEdgeCount,
    debtScore,
    JSON.stringify(baseline),
  );

  res.status(201).json({ id, debtScore });
});

// ── GET /architecture ─────────────────────────────────────────────────────────

router.get('/', requireAuth, (req: Request, res: Response): void => {
  const { projectId } = req.params as { projectId: string };
  const db            = getDb();

  const row = db.prepare(`
    SELECT id, run_id, commit, graphify_version,
           node_count, edge_count, community_count,
           god_node_count, cross_edge_count, debt_score,
           content, created_at
    FROM architecture_snapshots
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId) as Record<string, unknown> | undefined;

  if (!row) {
    res.status(404).json({
      error: 'No architecture snapshot found for this project',
      hint:  'Run `tracegraph compare --upload <server-url>` with a static graph present, or `tracegraph architecture baseline push --server <url>`.',
    });
    return;
  }

  // Parse content to expose communities and god nodes (strip bulky cross-edge details)
  let communities: unknown[]    = [];
  let godNodes:    unknown[]    = [];
  let crossEdges:  unknown[]    = [];

  try {
    const parsed = JSON.parse(row['content'] as string) as ArchitectureBaseline;
    communities = parsed.communities              ?? [];
    godNodes    = parsed.godNodes                 ?? [];
    crossEdges  = parsed.crossCommunityEdges      ?? [];
  } catch { /* non-fatal: return summary-only if JSON is malformed */ }

  res.json({
    id:              row['id'],
    runId:           row['run_id'],
    commit:          row['commit'],
    graphifyVersion: row['graphify_version'],
    nodeCount:       row['node_count'],
    edgeCount:       row['edge_count'],
    communityCount:  row['community_count'],
    godNodeCount:    row['god_node_count'],
    crossEdgeCount:  row['cross_edge_count'],
    debtScore:       row['debt_score'],
    createdAt:       row['created_at'],
    communities,
    godNodes,
    crossCommunityEdges: crossEdges,
  });
});

// ── GET /architecture/drift ───────────────────────────────────────────────────

router.get('/drift', requireAuth, (req: Request, res: Response): void => {
  const { projectId } = req.params as { projectId: string };
  const { limit }     = req.query  as { limit?: string };
  const db            = getDb();
  const rowLimit      = Math.min(parseInt(limit ?? '30', 10), 100);

  const rows = db.prepare(`
    SELECT id, run_id, commit, node_count, edge_count, community_count,
           god_node_count, cross_edge_count, debt_score, created_at
    FROM architecture_snapshots
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(projectId, rowLimit) as Array<Record<string, unknown>>;

  // Return in ascending chronological order so charts render left-to-right
  const snapshots = rows.reverse().map(r => ({
    id:             r['id'],
    runId:          r['run_id'],
    commit:         r['commit'],
    nodeCount:      r['node_count'],
    edgeCount:      r['edge_count'],
    communityCount: r['community_count'],
    godNodeCount:   r['god_node_count'],
    crossEdgeCount: r['cross_edge_count'],
    debtScore:      r['debt_score'],
    createdAt:      r['created_at'],
  }));

  res.json({ snapshots, total: snapshots.length });
});

// ── GET /architecture/nodes/:nodeId/traces ────────────────────────────────────

router.get('/nodes/:nodeId/traces', requireAuth, (req: Request, res: Response): void => {
  const { projectId, nodeId } = req.params as { projectId: string; nodeId: string };
  const { limit }             = req.query  as { limit?: string };
  const db                    = getDb();
  const maxResults            = Math.min(parseInt(limit ?? '10', 10), 50);

  // Resolve the symbolName from the latest snapshot for this nodeId.
  // nodeId is the URL-decoded symbolName (e.g. "App\Http\Controllers\Foo::bar").
  const symbolName = decodeURIComponent(nodeId);

  // Find recent trace files for this project
  const recentTraces = db.prepare(`
    SELECT t.id, t.trace_id, t.file_path, t.entrypoint, t.status, t.created_at,
           r.run_id, r.environment
    FROM traces t
    JOIN runs r ON r.id = t.run_id
    WHERE r.project_id = ?
    ORDER BY t.created_at DESC
    LIMIT 100
  `).all(projectId) as Array<{
    id:         string;
    trace_id:   string;
    file_path:  string;
    entrypoint: string | null;
    status:     string;
    created_at: number;
    run_id:     string;
    environment: string;
  }>;

  const matchingTraces: Array<{
    traceId:      string;
    runId:        string;
    environment:  string;
    status:       string;
    entrypoint:   unknown;
    matchedEvents: number;
    createdAt:    number;
  }> = [];

  for (const trace of recentTraces) {
    if (matchingTraces.length >= maxResults) break;
    if (!fs.existsSync(trace.file_path)) continue;

    try {
      const raw     = fs.readFileSync(trace.file_path, 'utf8');
      const session = JSON.parse(raw) as TraceSession;
      const events  = session.events ?? [];

      // Match events by: staticNodeId, fqn in metadata, or symbolName in name/metadata
      const matched = events.filter((evt: TraceEvent) => {
        const m = (evt as Record<string, unknown>)['metadata'] as Record<string, unknown> | undefined;
        if (!m) return false;
        return (
          m['staticNodeId'] === symbolName ||
          m['fqn']          === symbolName ||
          (typeof m['symbolName'] === 'string' && m['symbolName'] === symbolName)
        );
      });

      if (matched.length > 0) {
        matchingTraces.push({
          traceId:      trace.trace_id,
          runId:        trace.run_id,
          environment:  trace.environment,
          status:       trace.status,
          entrypoint:   trace.entrypoint ? JSON.parse(trace.entrypoint) : null,
          matchedEvents: matched.length,
          createdAt:    trace.created_at,
        });
      }
    } catch { /* skip malformed trace files */ }
  }

  res.json({
    symbolName,
    traces: matchingTraces,
    total:  matchingTraces.length,
  });
});

export default router;
