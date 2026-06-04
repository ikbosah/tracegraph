/**
 * M9A T9A.6 — Project management API
 *
 * Routes:
 *   GET  /api/v1/projects              — list projects
 *   POST /api/v1/projects              — create a project
 *   GET  /api/v1/projects/:projectId   — get project + recent run summary
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { requireAuth } from './auth';

const router = Router();

// ── GET /projects ─────────────────────────────────────────────────────────────

router.get('/', requireAuth, (_req: Request, res: Response): void => {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT p.id, p.name, p.repo_url, p.default_branch, p.created_at,
           COUNT(r.id) AS run_count
    FROM projects p
    LEFT JOIN runs r ON r.project_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all();

  res.json({ projects: rows });
});

// ── POST /projects ────────────────────────────────────────────────────────────

router.post('/', requireAuth, (req: Request, res: Response): void => {
  const { name, repo_url, default_branch } = req.body as {
    name: string; repo_url?: string; default_branch?: string;
  };

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const db = getDb();
  const id = `proj_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

  db.prepare(`
    INSERT INTO projects (id, name, repo_url, default_branch)
    VALUES (?, ?, ?, ?)
  `).run(id, name, repo_url ?? null, default_branch ?? 'main');

  res.status(201).json({ id, name });
});

// ── GET /projects/:projectId ──────────────────────────────────────────────────

router.get('/:projectId', requireAuth, (req: Request, res: Response): void => {
  const { projectId } = req.params as { projectId: string };
  const db            = getDb();

  const project = db.prepare(
    'SELECT id, name, repo_url, default_branch, created_at FROM projects WHERE id = ?',
  ).get(projectId) as Record<string, unknown> | undefined;

  if (!project) {
    res.status(404).json({ error: `Project not found: ${projectId}` });
    return;
  }

  // Last 5 runs
  const recentRuns = db.prepare(`
    SELECT r.id, r.run_id, r.environment, r.status, r.created_at,
           rpt.open_findings, rpt.has_critical
    FROM runs r
    LEFT JOIN reports rpt ON rpt.run_id = r.id
    WHERE r.project_id = ?
    ORDER BY r.created_at DESC
    LIMIT 5
  `).all(projectId);

  // Open finding counts by severity
  const findingCounts = db.prepare(`
    SELECT severity, COUNT(*) AS count
    FROM findings
    WHERE project_id = ? AND status = 'open'
    GROUP BY severity
  `).all(projectId) as Array<{ severity: string; count: number }>;

  const bySeverity = Object.fromEntries(findingCounts.map(r => [r.severity, r.count]));

  res.json({ ...project, recentRuns, openFindings: bySeverity });
});

export default router;
