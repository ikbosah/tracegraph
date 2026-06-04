/**
 * M9A T9A.3 — Baseline storage and sync API
 *
 * Routes:
 *   GET  /api/v1/projects/:projectId/baselines            — list all baselines
 *   PUT  /api/v1/projects/:projectId/baselines/:testId    — create or replace
 *   GET  /api/v1/projects/:projectId/baselines/:testId    — download a baseline
 *   DELETE /api/v1/projects/:projectId/baselines/:testId  — remove a baseline
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { requireAuth } from './auth';
import type { CompactBaseline } from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';

const router = Router({ mergeParams: true });

// ── GET /baselines ────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req: Request, res: Response): void => {
  const { projectId } = req.params as { projectId: string };
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, test_id, approved_by, reason, schema_version, created_at
    FROM baselines WHERE project_id = ? ORDER BY created_at DESC
  `).all(projectId) as Array<{
    id: string; test_id: string; approved_by: string; reason: string | null;
    schema_version: string; created_at: number;
  }>;

  res.json({ baselines: rows });
});

// ── PUT /baselines/:testId ────────────────────────────────────────────────────

router.put('/:testId', requireAuth, (req: Request, res: Response): void => {
  const { projectId, testId } = req.params as { projectId: string; testId: string };
  const body = req.body as CompactBaseline;

  if (!body || body.schemaVersion !== SCHEMA_VERSIONS.baseline) {
    res.status(422).json({ error: `Expected schemaVersion: ${SCHEMA_VERSIONS.baseline}` });
    return;
  }

  const db = getDb();

  // Ensure project exists
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);

  const id = `bl_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(`
    INSERT INTO baselines (id, project_id, test_id, approved_by, reason, schema_version, content)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, test_id) DO UPDATE SET
      approved_by    = excluded.approved_by,
      reason         = excluded.reason,
      schema_version = excluded.schema_version,
      content        = excluded.content,
      created_at     = unixepoch() * 1000
  `).run(
    id,
    projectId,
    testId,
    body.approvedBy,
    body.reason ?? null,
    body.schemaVersion,
    JSON.stringify(body),
  );

  res.status(200).json({ testId, projectId });
});

// ── GET /baselines/:testId ────────────────────────────────────────────────────

router.get('/:testId', requireAuth, (req: Request, res: Response): void => {
  const { projectId, testId } = req.params as { projectId: string; testId: string };
  const db = getDb();

  const row = db.prepare(
    'SELECT content FROM baselines WHERE project_id = ? AND test_id = ?',
  ).get(projectId, testId) as { content: string } | undefined;

  if (!row) {
    res.status(404).json({ error: `Baseline not found: ${testId}` });
    return;
  }

  try {
    res.json(JSON.parse(row.content));
  } catch {
    res.status(500).json({ error: 'Corrupted baseline content' });
  }
});

// ── DELETE /baselines/:testId ─────────────────────────────────────────────────

router.delete('/:testId', requireAuth, (req: Request, res: Response): void => {
  const { projectId, testId } = req.params as { projectId: string; testId: string };
  const db = getDb();

  const result = db.prepare(
    'DELETE FROM baselines WHERE project_id = ? AND test_id = ?',
  ).run(projectId, testId);

  if (result.changes === 0) {
    res.status(404).json({ error: `Baseline not found: ${testId}` });
    return;
  }

  res.status(204).end();
});

export default router;
