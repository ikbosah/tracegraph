/**
 * Milestone 2 — Behaviour Diff and Baseline integration test
 *
 * Exit criteria (IMPLEMENTATION_PLAN.md M2):
 *   T2.1: tracegraph baseline create produces .baseline.json files
 *   T2.2: tracegraph compare detects removed validateCouponExpiry → High finding
 *   T2.3: File move → fingerprint unchanged (no spurious diff)
 *   T2.4: Suppression with requiresEvidence → suppressed when present, open when absent
 *   T2.5: finding approve → finding shows as approved on next compare
 *   T2.6: Volatile IDs (INV-001 vs INV-523) in http_response → no diff
 *   T2.7: tracegraph report --format markdown → readable markdown
 *   T2.8: Exit code 1 on critical finding with --fail-on-critical
 *
 * Architecture notes:
 *   - Trace files are written programmatically (no tracegraph run needed here).
 *     The tracing instrumentation is already covered by M1 tests; these tests
 *     focus exclusively on the diff / baseline / compare / report pipeline.
 *   - ENTRYPOINT_CMD is a fixed string so all sessions share the same testId
 *     (derived from the entrypoint command), allowing compare to match candidates
 *     against the same baseline file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceSession, TraceReport } from '@tracegraph/shared-types';

// ── Constants ─────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

const _TSX_BIN = path.join(WORKSPACE_ROOT, 'node_modules/.bin');
const TSX = process.platform === 'win32'
  ? path.join(_TSX_BIN, 'tsx.CMD')
  : path.join(_TSX_BIN, 'tsx');

const CLI = path.resolve(WORKSPACE_ROOT, 'packages/cli/src/index.ts');

/** Fixed entrypoint command so all sessions share the same testId. */
const ENTRYPOINT_CMD = 'node test-invoice-flow.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

type SpawnResult = ReturnType<typeof spawnSync>;

function runCli(args: string[], cwd: string, extraEnv: Record<string, string> = {}): SpawnResult {
  return spawnSync(TSX, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      ...extraEnv,
    },
    timeout: 30_000,
  });
}

type EventDef = {
  name:          string;
  type?:         string;
  functionName?: string;
  file?:         string;
  line?:         number;
  output?:       Record<string, unknown>;
};

/** Build a minimal valid TraceSession with the shared entrypoint command. */
function makeSession(
  id: string,
  eventDefs: EventDef[],
  command = ENTRYPOINT_CMD,
): TraceSession {
  const traceId = `trace_${id}`;
  return {
    schemaVersion: SCHEMA_VERSIONS.trace,
    traceId,
    sessionId:     `sess_${id}`,
    runId:         `run_${id}`,
    workspaceRoot: '/workspace',
    language:      'javascript',
    entrypoint:    { type: 'cli_command', command },
    startedAt:     1_000_000,
    status:        'passed',
    captureLevel:  { overall: 1, label: 'test', adapters: {} },
    events: eventDefs.map((e, i) => ({
      schemaVersion:  SCHEMA_VERSIONS.event,
      eventId:        `evt_${id}_${i}`,
      traceId,
      parentEventId:  null,
      type:           (e.type ?? 'function_call') as 'function_call',
      language:       'javascript' as const,
      name:           e.name,
      startTime:      1_000_000 + i * 100,
      ...(e.functionName !== undefined ? { functionName: e.functionName } : {}),
      ...(e.file         !== undefined ? { file:         e.file }         : {}),
      ...(e.line         !== undefined ? { line:         e.line }         : {}),
      ...(e.output       !== undefined ? { output:       e.output }       : {}),
    })),
  };
}

/** Write a TraceSession to .tracegraph/traces/ and return the absolute file path. */
function writeTrace(tmpDir: string, session: TraceSession): string {
  const tracesDir = path.join(tmpDir, '.tracegraph', 'traces');
  fs.mkdirSync(tracesDir, { recursive: true });
  const filePath = path.join(tracesDir, `${session.traceId}.trace.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
  return filePath;
}

/** Return the most recently modified .report.json from .tracegraph/reports/. */
function readLatestReport(tmpDir: string): TraceReport {
  const reportsDir = path.join(tmpDir, '.tracegraph', 'reports');
  expect(fs.existsSync(reportsDir), `reports dir missing: ${reportsDir}`).toBe(true);
  const files = fs.readdirSync(reportsDir)
    .filter((f) => f.endsWith('.report.json'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  expect(files.length, 'No .report.json found').toBeGreaterThan(0);
  return JSON.parse(
    fs.readFileSync(path.join(reportsDir, files[0]!.name), 'utf8'),
  ) as TraceReport;
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegraph-m2-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Milestone 2 — Behaviour Diff and Baseline', () => {

  // ── T2.1: baseline create ─────────────────────────────────────────────────
  it('T2.1: baseline create produces a .baseline.json with correct schema and metadata', () => {
    writeTrace(tmpDir, makeSession('base', [
      { name: 'validateCouponExpiry', functionName: 'validateCouponExpiry' },
      { name: 'processPayment',       functionName: 'processPayment' },
    ]));

    const result = runCli(
      ['baseline', 'create', '--reason', 'initial baseline', '--approved-by', 'alice'],
      tmpDir,
    );

    expect(
      result.status,
      `baseline create failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain('[ok] Baseline created');

    const baselinesDir = path.join(tmpDir, '.tracegraph', 'baselines');
    expect(fs.existsSync(baselinesDir), 'baselines dir missing').toBe(true);

    const files = fs.readdirSync(baselinesDir).filter((f) => f.endsWith('.baseline.json'));
    expect(files.length, 'Expected exactly 1 baseline file').toBe(1);

    const baseline = JSON.parse(
      fs.readFileSync(path.join(baselinesDir, files[0]!), 'utf8'),
    ) as { schemaVersion: string; approvedBy: string; testId: string; events: unknown[] };

    expect(baseline.schemaVersion).toBe(SCHEMA_VERSIONS.baseline);
    expect(baseline.approvedBy).toBe('alice');
    expect(typeof baseline.testId).toBe('string');
    // Both validateCouponExpiry and processPayment in the baseline
    expect(baseline.events.length).toBe(2);
  });

  // ── T2.2: compare detects removed validation ──────────────────────────────
  it('T2.2: compare detects removed validateCouponExpiry as a High finding', () => {
    // Create baseline
    writeTrace(tmpDir, makeSession('base', [
      { name: 'validateCouponExpiry', functionName: 'validateCouponExpiry' },
      { name: 'processPayment',       functionName: 'processPayment' },
    ]));
    const bcResult = runCli(
      ['baseline', 'create', '--reason', 'test', '--approved-by', 'alice'],
      tmpDir,
    );
    expect(bcResult.status, `baseline create failed: ${bcResult.stderr}`).toBe(0);

    // Candidate: validateCouponExpiry removed
    const candidateFile = writeTrace(tmpDir, makeSession('cand', [
      { name: 'processPayment', functionName: 'processPayment' },
    ]));

    const compareResult = runCli(
      ['compare', '--candidate', candidateFile],
      tmpDir,
    );

    expect(
      compareResult.status,
      `compare failed\nstdout: ${compareResult.stdout}\nstderr: ${compareResult.stderr}`,
    ).toBe(0);

    const report = readLatestReport(tmpDir);

    const openFindings = report.findings.filter((f) => f.status === 'open');
    expect(openFindings.length, 'Expected exactly 1 open finding').toBe(1);
    expect(openFindings[0]!.severity).toBe('high');
    expect(openFindings[0]!.ruleId).toBe('behavior.validation.removed');
    expect(openFindings[0]!.title).toContain('validateCouponExpiry');
    expect(report.summary.findingsBySeverity.high).toBe(1);
    expect(report.summary.tracesCompared).toBe(1);

    // Stdout mentions the finding count
    expect(compareResult.stdout).toContain('1 open finding');
  });

  // ── T2.3: file move → no spurious diff ────────────────────────────────────
  it('T2.3: moving processPayment to a different file produces no findings', () => {
    // Baseline: processPayment in services/payment.ts:42
    writeTrace(tmpDir, makeSession('base', [
      { name: 'processPayment', functionName: 'processPayment', file: 'services/payment.ts', line: 42 },
    ]));
    runCli(['baseline', 'create', '--reason', 'test', '--approved-by', 'alice'], tmpDir);

    // Candidate: same function moved to payments/processor.ts:99 (different file, different line)
    const candidateFile = writeTrace(tmpDir, makeSession('cand', [
      { name: 'processPayment', functionName: 'processPayment', file: 'payments/processor.ts', line: 99 },
    ]));

    runCli(['compare', '--candidate', candidateFile], tmpDir);

    const report = readLatestReport(tmpDir);
    expect(
      report.findings.filter((f) => f.status === 'open').length,
      'Expected 0 open findings for a file-move refactor',
    ).toBe(0);
    expect(compareResult_stdout_open_free(report), 'No open findings summary expected').toBe(true);
  });

  // ── T2.4: suppression with requiresEvidence ───────────────────────────────
  describe('T2.4: suppression with requiresEvidence', () => {

    it('suppresses finding when required evidence is present in the candidate', () => {
      // Baseline: validateCouponExpiry + processPayment
      writeTrace(tmpDir, makeSession('base', [
        { name: 'validateCouponExpiry', functionName: 'validateCouponExpiry' },
        { name: 'processPayment',       functionName: 'processPayment' },
      ]));
      runCli(['baseline', 'create', '--reason', 'test', '--approved-by', 'alice'], tmpDir);

      // Candidate with compensating evidence: processPayment + checkAuth
      const candidateFile = writeTrace(tmpDir, makeSession('cand', [
        { name: 'processPayment', functionName: 'processPayment' },
        { name: 'checkAuth',      functionName: 'checkAuth' },
      ]));

      // First compare → finding is open, get fingerprint
      runCli(['compare', '--candidate', candidateFile], tmpDir);
      const report1 = readLatestReport(tmpDir);
      const finding1 = report1.findings.find((f) => f.ruleId === 'behavior.validation.removed');
      expect(finding1, 'Expected validateCouponExpiry finding').toBeDefined();
      expect(finding1!.status).toBe('open');

      const fingerprint = finding1!.fingerprint;

      // Suppress: only active while checkAuth is present
      const suppressResult = runCli([
        'finding', 'suppress', fingerprint,
        '--reason',             'Compensated by checkAuth',
        '--requires-evidence',  'function_call:checkAuth',
      ], tmpDir);
      expect(suppressResult.status, `suppress failed: ${suppressResult.stderr}`).toBe(0);
      expect(suppressResult.stdout).toContain('requiresEvidence');

      // Second compare with same candidate (checkAuth still present) → suppressed
      runCli(['compare', '--candidate', candidateFile], tmpDir);
      const report2 = readLatestReport(tmpDir);
      const finding2 = report2.findings.find((f) => f.ruleId === 'behavior.validation.removed');
      expect(finding2!.status).toBe('suppressed');
      expect(report2.summary.findingsBySeverity.high).toBe(0);
    });

    it('finding surfaces as open when required evidence is absent from the candidate', () => {
      // Baseline: validateCouponExpiry + processPayment
      writeTrace(tmpDir, makeSession('base', [
        { name: 'validateCouponExpiry', functionName: 'validateCouponExpiry' },
        { name: 'processPayment',       functionName: 'processPayment' },
      ]));
      runCli(['baseline', 'create', '--reason', 'test', '--approved-by', 'alice'], tmpDir);

      // Candidate WITH checkAuth (needed to get fingerprint via first compare)
      const candWithAuth = writeTrace(tmpDir, makeSession('cand_auth', [
        { name: 'processPayment', functionName: 'processPayment' },
        { name: 'checkAuth',      functionName: 'checkAuth' },
      ]));

      runCli(['compare', '--candidate', candWithAuth], tmpDir);
      const report1    = readLatestReport(tmpDir);
      const fingerprint = report1.findings
        .find((f) => f.ruleId === 'behavior.validation.removed')!
        .fingerprint;

      // Add suppression with requiresEvidence
      runCli([
        'finding', 'suppress', fingerprint,
        '--reason',             'Compensated by checkAuth',
        '--requires-evidence',  'function_call:checkAuth',
      ], tmpDir);

      // New candidate WITHOUT checkAuth → evidence gone → suppression self-invalidates
      const candNoAuth = writeTrace(tmpDir, makeSession('cand_noauth', [
        { name: 'processPayment', functionName: 'processPayment' },
        // checkAuth deliberately absent
      ]));

      runCli(['compare', '--candidate', candNoAuth], tmpDir);
      const report2 = readLatestReport(tmpDir);
      const finding2 = report2.findings.find((f) => f.ruleId === 'behavior.validation.removed');
      expect(finding2, 'Expected validateCouponExpiry finding').toBeDefined();
      expect(finding2!.status).toBe('open');
      expect(report2.summary.findingsBySeverity.high).toBe(1);
    });
  });

  // ── T2.5: finding approve ─────────────────────────────────────────────────
  it('T2.5: finding approve → finding shows as approved on the next compare', () => {
    writeTrace(tmpDir, makeSession('base', [
      { name: 'validateCouponExpiry', functionName: 'validateCouponExpiry' },
      { name: 'processPayment',       functionName: 'processPayment' },
    ]));
    runCli(['baseline', 'create', '--reason', 'test', '--approved-by', 'alice'], tmpDir);

    const candidateFile = writeTrace(tmpDir, makeSession('cand', [
      { name: 'processPayment', functionName: 'processPayment' },
    ]));

    // First compare → 1 open finding
    runCli(['compare', '--candidate', candidateFile], tmpDir);
    const report1     = readLatestReport(tmpDir);
    const fingerprint = report1.findings[0]!.fingerprint;
    expect(report1.findings[0]!.status).toBe('open');

    // Approve the finding
    const approveResult = runCli([
      'finding', 'approve', fingerprint,
      '--reason',      'Accepted regression — validateCouponExpiry will be restored in v3',
      '--approved-by', 'alice',
    ], tmpDir);
    expect(approveResult.status, `approve failed: ${approveResult.stderr}`).toBe(0);
    expect(approveResult.stdout).toContain(fingerprint);

    // Second compare → same candidate → finding now approved
    runCli(['compare', '--candidate', candidateFile], tmpDir);
    const report2 = readLatestReport(tmpDir);
    const finding2 = report2.findings.find((f) => f.fingerprint === fingerprint);
    expect(finding2!.status).toBe('approved');
    expect(finding2!.approvedBy).toBe('alice');
    // Open finding count drops to 0
    expect(report2.summary.findingsBySeverity.high).toBe(0);
  });

  // ── T2.6: volatile IDs → no shape diff ────────────────────────────────────
  it('T2.6: different invoice IDs (INV-001 vs INV-523) in http_response do not produce a diff', () => {
    const makeInvoiceSession = (invoiceId: string, id: string): TraceSession =>
      makeSession(id, [{
        name:   'http_response',
        type:   'http_response',
        output: { invoiceId, status: 'draft', amount: 100 },
      }]);

    writeTrace(tmpDir, makeInvoiceSession('INV-001', 'base'));
    runCli(['baseline', 'create', '--reason', 'test', '--approved-by', 'alice'], tmpDir);

    const candidateFile = writeTrace(tmpDir, makeInvoiceSession('INV-523', 'cand'));
    runCli(['compare', '--candidate', candidateFile], tmpDir);

    const report = readLatestReport(tmpDir);
    // Same structural shape (both are objects with string fields) → no shape findings
    expect(
      report.findings.filter((f) => f.status === 'open').length,
      'Expected 0 open findings for same-shape response with different IDs',
    ).toBe(0);
    expect(report.summary.tracesCompared).toBe(1);
  });

  // ── T2.7: report --format markdown ────────────────────────────────────────
  it('T2.7: report --format markdown produces human-readable markdown with finding details', () => {
    writeTrace(tmpDir, makeSession('base', [
      { name: 'validateCouponExpiry', functionName: 'validateCouponExpiry' },
      { name: 'processPayment',       functionName: 'processPayment' },
    ]));
    runCli(['baseline', 'create', '--reason', 'test', '--approved-by', 'alice'], tmpDir);

    const candidateFile = writeTrace(tmpDir, makeSession('cand', [
      { name: 'processPayment', functionName: 'processPayment' },
    ]));
    runCli(['compare', '--candidate', candidateFile], tmpDir);

    const reportResult = runCli(
      ['report', '--format', 'markdown', '--project-name', 'InvoiceApp'],
      tmpDir,
    );

    expect(
      reportResult.status,
      `report failed\nstdout: ${reportResult.stdout}\nstderr: ${reportResult.stderr}`,
    ).toBe(0);

    const md = reportResult.stdout;
    expect(md).toContain('InvoiceApp — Behaviour Diff Report');
    expect(md).toContain('validateCouponExpiry');
    expect(md).toContain('🟠');                              // high severity emoji
    expect(md).toContain('behavior.validation.removed');
    expect(md).not.toContain('Do not merge');                // only appears for critical
  });

  // ── T2.8: exit code 1 on critical finding ─────────────────────────────────
  it('T2.8: compare --fail-on-critical exits 1 when an auth_check event is removed', () => {
    // Baseline: has an auth_check event (critical → authorization role)
    const baselineSession = makeSession('base', [
      { name: 'RolePolicy.update', type: 'auth_check' },
    ]);
    writeTrace(tmpDir, baselineSession);
    runCli(['baseline', 'create', '--reason', 'test', '--approved-by', 'alice'], tmpDir);

    // Candidate: auth_check removed
    const candidateFile = writeTrace(tmpDir, makeSession('cand', []));

    const compareResult = runCli(
      ['compare', '--candidate', candidateFile, '--fail-on-critical'],
      tmpDir,
    );

    expect(
      compareResult.status,
      `Expected exit 1 for critical finding, got ${compareResult.status ?? 'null'}\n` +
      `stdout: ${compareResult.stdout}\nstderr: ${compareResult.stderr}`,
    ).toBe(1);

    const report = readLatestReport(tmpDir);
    expect(report.summary.hasOpenCritical).toBe(true);
    expect(report.summary.findingsBySeverity.critical).toBe(1);

    const criticalFinding = report.findings.find((f) => f.severity === 'critical');
    expect(criticalFinding).toBeDefined();
    expect(criticalFinding!.ruleId).toBe('behavior.authorization.removed');
    expect(criticalFinding!.title).toContain('RolePolicy.update');
  });
});

// ── Assertion helpers ─────────────────────────────────────────────────────────

function compareResult_stdout_open_free(report: TraceReport): boolean {
  return report.findings.every((f) => f.status !== 'open');
}
