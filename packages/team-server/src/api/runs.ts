/**
 * M9A T9A.2 — Trace and report upload API
 *
 * Routes:
 *   POST /api/v1/runs                   — create a run
 *   POST /api/v1/runs/:runId/traces     — upload a .trace.json file
 *   POST /api/v1/runs/:runId/report     — upload a .report.json file
 *   GET  /api/v1/runs/:runId            — get run summary
 *   GET  /api/v1/runs                   — list runs for a project
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';
import { requireAuth } from './auth';
import type { TraceSession, TraceReport } from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';

const router = Router();

// ── Storage ───────────────────────────────────────────────────────────────────

const dataDir    = process.env['TRACEGRAPH_DATA_DIR'] ?? path.join(process.cwd(), 'data');
const tracesDir  = path.join(dataDir, 'traces');
const reportsDir = path.join(dataDir, 'reports');
fs.mkdirSync(tracesDir,  { recursive: true });
fs.mkdirSync(reportsDir, { recursive: true });

const upload = multer({ dest: path.join(dataDir, 'uploads') });

// ── POST /api/v1/runs ─────────────────────────────────────────────────────────

router.post('/', requireAuth, (req: Request, res: Response): void => {
  const { project_id, run_id, environment } = req.body as {
    project_id: string;
    run_id:     string;
    environment?: string;
  };

  if (!project_id || !run_id) {
    res.status(400).json({ error: 'project_id and run_id are required' });
    return;
  }

  const db  = getDb();
  const id  = `run_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

  // Create project if it does not exist yet
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id) as { id: string } | undefined;
  if (!existing) {
    db.prepare(
      'INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)',
    ).run(project_id, project_id);
  }

  db.prepare(
    'INSERT INTO runs (id, project_id, run_id, environment) VALUES (?, ?, ?, ?)',
  ).run(id, project_id, run_id, environment ?? 'dev');

  res.status(201).json({ id, project_id, run_id });
});

// ── POST /api/v1/runs/:runId/traces ───────────────────────────────────────────

router.post('/:runId/traces', requireAuth, upload.single('trace'), (req: Request, res: Response): void => {
  const { runId } = req.params as { runId: string };
  const db        = getDb();

  const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId) as { id: string } | undefined;
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }

  if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }

  let session: TraceSession;
  try {
    session = JSON.parse(fs.readFileSync(req.file.path, 'utf8')) as TraceSession;
  } catch {
    res.status(400).json({ error: 'Invalid JSON in uploaded trace file' });
    return;
  }

  if (session.schemaVersion !== SCHEMA_VERSIONS.trace) {
    res.status(422).json({ error: `Schema mismatch: expected ${SCHEMA_VERSIONS.trace}` });
    return;
  }

  // Move to permanent storage
  const destName = `${session.traceId}.trace.json`;
  const destPath = path.join(tracesDir, destName);
  fs.renameSync(req.file.path, destPath);

  const id = `trace_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    'INSERT INTO traces (id, run_id, trace_id, file_path, entrypoint, status) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, runId, session.traceId, destPath, JSON.stringify(session.entrypoint), session.status);

  res.status(201).json({ id, trace_id: session.traceId, file: destName });
});

// ── POST /api/v1/runs/:runId/report ──────────────────────────────────────────

router.post('/:runId/report', requireAuth, upload.single('report'), (req: Request, res: Response): void => {
  const { runId } = req.params as { runId: string };
  const db        = getDb();

  const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId) as { id: string } | undefined;
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }

  if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }

  let report: TraceReport;
  try {
    report = JSON.parse(fs.readFileSync(req.file.path, 'utf8')) as TraceReport;
  } catch {
    res.status(400).json({ error: 'Invalid JSON in uploaded report file' });
    return;
  }

  const destName = `${report.reportId}.report.json`;
  const destPath = path.join(reportsDir, destName);
  fs.renameSync(req.file.path, destPath);

  const openFindings = report.findings.filter(f => f.status === 'open').length;
  const hasCritical  = report.findings.some(f => f.status === 'open' && f.severity === 'critical') ? 1 : 0;

  const id = `rpt_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    'INSERT INTO reports (id, run_id, file_path, open_findings, has_critical) VALUES (?, ?, ?, ?, ?)',
  ).run(id, runId, destPath, openFindings, hasCritical);

  // Update run status
  db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('complete', runId);

  // Upsert findings into the findings table for the project
  const projectRow = db.prepare(
    'SELECT project_id FROM runs WHERE id = ?',
  ).get(runId) as { project_id: string } | undefined;
  const projectId = projectRow?.project_id;

  if (projectId) {
    for (const f of report.findings) {
      db.prepare(`
        INSERT INTO findings
          (id, project_id, fingerprint, rule_id, severity, status, title, description, evidence, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, fingerprint) DO UPDATE SET
          status = excluded.status,
          run_id = excluded.run_id
      `).run(
        `find_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
        projectId,
        f.fingerprint,
        f.ruleId,
        f.severity,
        f.status,
        f.title,
        f.description,
        JSON.stringify(f.evidence),
        runId,
      );
    }
  }

  res.status(201).json({ id, report_id: report.reportId, open_findings: openFindings });
});

// ── GET /api/v1/runs/:runId ───────────────────────────────────────────────────

router.get('/:runId', requireAuth, (req: Request, res: Response): void => {
  const { runId } = req.params as { runId: string };
  const db        = getDb();

  const run = db.prepare(`
    SELECT r.*, COUNT(t.id) AS trace_count, rpt.open_findings, rpt.has_critical
    FROM runs r
    LEFT JOIN traces t  ON t.run_id = r.id
    LEFT JOIN reports rpt ON rpt.run_id = r.id
    WHERE r.id = ?
    GROUP BY r.id
  `).get(runId) as Record<string, unknown> | undefined;

  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }

  res.json(run);
});

// ── GET /api/v1/runs (list) ───────────────────────────────────────────────────

router.get('/', requireAuth, (req: Request, res: Response): void => {
  const { project_id, limit = '20', offset = '0' } = req.query as {
    project_id?: string; limit?: string; offset?: string;
  };

  const db = getDb();

  let sql = `
    SELECT r.id, r.run_id, r.environment, r.status, r.created_at,
           COUNT(t.id) AS trace_count,
           MAX(rpt.open_findings) AS open_findings,
           MAX(rpt.has_critical) AS has_critical
    FROM runs r
    LEFT JOIN traces t  ON t.run_id = r.id
    LEFT JOIN reports rpt ON rpt.run_id = r.id
  `;
  const params: unknown[] = [];

  if (project_id) {
    sql += ' WHERE r.project_id = ?';
    params.push(project_id);
  }

  sql += ' GROUP BY r.id ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const rows = db.prepare(sql).all(...params);
  res.json({ runs: rows, limit: parseInt(limit), offset: parseInt(offset) });
});

export default router;
