/**
 * M9A — TraceGraph Team Server
 *
 * Self-hosted REST API for team trace/baseline/finding management.
 * Serves a React dashboard at GET / when built assets are present.
 *
 * Environment variables:
 *   PORT                      — HTTP port (default: 3000)
 *   TRACEGRAPH_DATA_DIR       — Path to data directory (default: ./data)
 *   TRACEGRAPH_ADMIN_EMAIL    — Admin username (default: admin@localhost)
 *   TRACEGRAPH_ADMIN_PASSWORD — Admin password (default: changeme)
 *   TRACEGRAPH_CORS_ORIGINS   — Comma-separated allowed CORS origins
 */
import express from 'express';
import cors    from 'cors';
import helmet  from 'helmet';
import path    from 'path';
import fs      from 'fs';

import authRouter         from './api/auth';
import runsRouter         from './api/runs';
import baselinesRouter    from './api/baselines';
import findingsRouter     from './api/findings';
import suppressionsRouter from './api/suppressions';
import projectsRouter     from './api/projects';
import architectureRouter from './api/architecture';
import { closeDb }        from './db/database';

const app  = express();
const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

// ── Middleware ────────────────────────────────────────────────────────────────

const corsOrigins = process.env['TRACEGRAPH_CORS_ORIGINS']
  ? process.env['TRACEGRAPH_CORS_ORIGINS'].split(',').map(s => s.trim())
  : ['http://localhost:3000', 'http://localhost:5173'];

app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API routes ────────────────────────────────────────────────────────────────

app.use('/api/v1/auth',    authRouter);
app.use('/api/v1/runs',    runsRouter);
app.use('/api/v1/projects', projectsRouter);

// Nested routes: /api/v1/projects/:projectId/baselines|findings|suppressions|architecture
app.use('/api/v1/projects/:projectId/baselines',    baselinesRouter);
app.use('/api/v1/projects/:projectId/findings',     findingsRouter);
app.use('/api/v1/projects/:projectId/suppressions', suppressionsRouter);
app.use('/api/v1/projects/:projectId/architecture', architectureRouter);

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    version: '0.1.0',
    time:    new Date().toISOString(),
  });
});

// ── Static dashboard (served when build assets exist) ────────────────────────

const dashboardDist = path.join(__dirname, '..', 'dashboard', 'dist');
if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(dashboardDist, 'index.html'));
  });
} else {
  // Dev placeholder
  app.get('/', (_req, res) => {
    res.json({
      message: 'TraceGraph Team Server',
      version: '0.1.0',
      docs:    '/health',
      api:     '/api/v1',
    });
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(): void {
  console.log('\n[team-server] Shutting down...');
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[team-server] Listening on http://localhost:${PORT}`);
  console.log(`[team-server] Data directory: ${process.env['TRACEGRAPH_DATA_DIR'] ?? './data'}`);
  console.log(`[team-server] Health check:   http://localhost:${PORT}/health`);
});

export default app;
