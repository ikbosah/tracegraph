/**
 * M9A T9A.4 — Finding management API
 *
 * Routes:
 *   GET  /api/v1/projects/:projectId/findings                    — list findings
 *   POST /api/v1/projects/:projectId/findings/:fingerprint/approve  — approve
 *   POST /api/v1/projects/:projectId/findings/:fingerprint/suppress — suppress
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { requireAuth } from './auth';

const router = Router({ mergeParams: true });

// ── GET /findings ─────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req: Request, res: Response): void => {
  const { projectId } = req.params as { projectId: string };
  const { status, severity, rule_id, limit = '50', offset = '0' } = req.query as {
    status?: string; severity?: string; rule_id?: string;
    limit?: string; offset?: string;
  };

  const db = getDb();
  const conditions: string[] = ['project_id = ?'];
  const params: unknown[] = [projectId];

  if (status)   { conditions.push('status = ?');   params.push(status); }
  if (severity) { conditions.push('severity = ?'); params.push(severity); }
  if (rule_id)  { conditions.push('rule_id = ?');  params.push(rule_id); }

  const where = conditions.join(' AND ');
  const sql = `
    SELECT id, fingerprint, rule_id, severity, status, title, approved_by, created_at
    FROM findings
    WHERE ${where}
    ORDER BY
      CASE severity
        WHEN 'critical' THEN 1 WHEN 'high' THEN 2
        WHEN 'medium'   THEN 3 WHEN 'low'  THEN 4 ELSE 5
      END,
      created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(parseInt(limit), parseInt(offset));

  const rows = db.prepare(sql).all(...params);
  res.json({ findings: rows, limit: parseInt(limit), offset: parseInt(offset) });
});

// ── POST /findings/:fingerprint/approve ───────────────────────────────────────

router.post('/:fingerprint/approve', requireAuth, (req: Request, res: Response): void => {
  const { projectId, fingerprint } = req.params as { projectId: string; fingerprint: string };
  const { reason, approved_by, expires_at } = req.body as {
    reason?: string; approved_by?: string; expires_at?: string;
  };

  const db = getDb();

  // Update the finding status
  const result = db.prepare(`
    UPDATE findings SET status = 'approved', approved_by = ?, approved_reason = ?
    WHERE project_id = ? AND fingerprint = ?
  `).run(
    approved_by ?? 'unknown',
    reason ?? 'Approved via Team Server',
    projectId,
    fingerprint,
  );

  if (result.changes === 0) {
    res.status(404).json({ error: `Finding not found: ${fingerprint}` });
    return;
  }

  // Store the approval record
  const approvalId = `appr_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const defaultExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO approvals (id, project_id, finding_fingerprint, rule_id, approved_by, reason, expires_at)
    SELECT ?, ?, fingerprint, rule_id, ?, ?, ?
    FROM findings WHERE project_id = ? AND fingerprint = ?
  `).run(
    approvalId, projectId,
    approved_by ?? 'unknown',
    reason ?? 'Approved via Team Server',
    expires_at ?? defaultExpiry,
    projectId, fingerprint,
  );

  res.json({ fingerprint, status: 'approved', approvalId });
});

// ── POST /findings/:fingerprint/suppress ──────────────────────────────────────

router.post('/:fingerprint/suppress', requireAuth, (req: Request, res: Response): void => {
  const { projectId, fingerprint } = req.params as { projectId: string; fingerprint: string };
  const { reason, approved_by, expires_at, requires_evidence } = req.body as {
    reason?: string; approved_by?: string; expires_at?: string;
    requires_evidence?: Array<{ type: string; name: string }>;
  };

  const db = getDb();

  // Update the finding status
  const findingRow = db.prepare(
    'SELECT rule_id FROM findings WHERE project_id = ? AND fingerprint = ?',
  ).get(projectId, fingerprint) as { rule_id: string } | undefined;

  if (!findingRow) {
    res.status(404).json({ error: `Finding not found: ${fingerprint}` });
    return;
  }

  db.prepare(
    'UPDATE findings SET status = \'suppressed\' WHERE project_id = ? AND fingerprint = ?',
  ).run(projectId, fingerprint);

  const suppressionId = `sup_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const defaultExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO suppressions
      (id, project_id, rule_id, reason, requires_evidence, expires_at, approved_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    suppressionId, projectId, findingRow.rule_id,
    reason ?? null,
    requires_evidence ? JSON.stringify(requires_evidence) : null,
    expires_at ?? defaultExpiry,
    approved_by ?? 'unknown',
  );

  res.json({ fingerprint, status: 'suppressed', suppressionId });
});

export default router;
