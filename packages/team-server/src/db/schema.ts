/**
 * M9A T9A.1 — Data model and SQLite schema
 *
 * All tables use TEXT primary keys (UUIDs) for portability.
 * SQLite is the default storage engine for self-hosted deployments.
 * The schema is PostgreSQL-compatible (no SQLite-specific syntax in DDL).
 */

export const SCHEMA_SQL = `
-- ── Tokens (authentication) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tokens (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  hash        TEXT NOT NULL,             -- bcrypt hash of the raw token
  project_id  TEXT,                      -- NULL = global access
  expires_at  INTEGER NOT NULL,          -- Unix epoch ms
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS tokens_email ON tokens(email);

-- ── Projects ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  repo_url    TEXT,
  default_branch TEXT DEFAULT 'main',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ── Trace runs ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  run_id       TEXT NOT NULL,            -- the TRACEGRAPH_RUN_ID from the CLI
  environment  TEXT DEFAULT 'dev',
  status       TEXT DEFAULT 'pending',   -- pending | complete | error
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, created_at DESC);

-- ── Traces (individual trace files) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS traces (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  trace_id     TEXT NOT NULL,
  file_path    TEXT NOT NULL,            -- absolute path on the server filesystem
  entrypoint   TEXT,                     -- JSON string of TraceEntrypoint
  status       TEXT DEFAULT 'passed',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS traces_run ON traces(run_id);

-- ── Reports ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  file_path    TEXT NOT NULL,
  open_findings INTEGER DEFAULT 0,
  has_critical  INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ── Baselines ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS baselines (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  test_id      TEXT NOT NULL,
  approved_by  TEXT NOT NULL,
  reason       TEXT,
  schema_version TEXT NOT NULL,
  content      TEXT NOT NULL,            -- full JSON of CompactBaseline
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(project_id, test_id)
);

-- ── Findings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS findings (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  fingerprint  TEXT NOT NULL,
  rule_id      TEXT NOT NULL,
  severity     TEXT NOT NULL,
  status       TEXT DEFAULT 'open',      -- open | approved | suppressed
  title        TEXT NOT NULL,
  description  TEXT,
  evidence     TEXT,                     -- JSON
  run_id       TEXT REFERENCES runs(id),
  approved_by  TEXT,
  approved_reason TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS findings_project_status ON findings(project_id, status);

-- ── Approvals ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id),
  finding_fingerprint  TEXT NOT NULL,
  rule_id              TEXT NOT NULL,
  approved_by          TEXT NOT NULL,
  reason               TEXT,
  expires_at           TEXT NOT NULL,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ── Suppressions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppressions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  rule_id       TEXT NOT NULL,
  semantic_target TEXT,                  -- JSON of Partial<SemanticSignature>
  reason        TEXT,
  requires_evidence TEXT,               -- JSON
  expires_at    TEXT NOT NULL,
  approved_by   TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
`;
