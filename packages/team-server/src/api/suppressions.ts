/**
 * M9A T9A.5 — Suppression storage and sync API
 *
 * Routes:
 *   GET  /api/v1/projects/:projectId/suppressions   — get all suppressions
 *   POST /api/v1/projects/:projectId/suppressions   — add/update a suppression
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { requireAuth } from './auth';

const router = Router({ mergeParams: true });

// ── GET /suppressions ─────────────────────────────────────────────────────────

router.get('/', requireAuth, (req: Request, res: Response): void => {
  const { projectId } = req.params as { projectId: string };
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, rule_id, semantic_target, reason, requires_evidence, expires_at, approved_by, created_at
    FROM suppressions
    WHERE project_id = ? AND datetime(expires_at) > datetime('now')
    ORDER BY created_at DESC
  `).all(projectId) as Array<{
    id: string; rule_id: string; semantic_target: string | null;
    reason: string | null; requires_evidence: string | null;
    expires_at: string; approved_by: string; created_at: number;
  }>;

  // Parse JSON columns
  const parsed = rows.map((r) => ({
    ...r,
    semantic_target:    r.semantic_target    ? JSON.parse(r.semantic_target)    : {},
    requires_evidence:  r.requires_evidence  ? JSON.parse(r.requires_evidence)  : undefined,
  }));

  res.json({ suppressions: parsed });
});

// ── POST /suppressions ────────────────────────────────────────────────────────

router.post('/', requireAuth, (req: Request, res: Response): void => {
  const { projectId } = req.params as { projectId: string };
  const {
    rule_id,
    semantic_target,
    reason,
    requires_evidence,
    expires_at,
    approved_by,
  } = req.body as {
    rule_id:            string;
    semantic_target?:   Record<string, unknown>;
    reason?:            string;
    requires_evidence?: Array<{ type: string; name: string }>;
    expires_at?:        string;
    approved_by?:       string;
  };

  if (!rule_id) {
    res.status(400).json({ error: 'rule_id is required' });
    return;
  }

  const db             = getDb();
  const suppressionId  = `sup_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const defaultExpiry  = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO suppressions
      (id, project_id, rule_id, semantic_target, reason, requires_evidence, expires_at, approved_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    suppressionId, projectId, rule_id,
    semantic_target ? JSON.stringify(semantic_target) : null,
    reason ?? null,
    requires_evidence ? JSON.stringify(requires_evidence) : null,
    expires_at ?? defaultExpiry,
    approved_by ?? 'unknown',
  );

  res.status(201).json({ id: suppressionId, projectId, ruleId: rule_id });
});

export default router;
