/**
 * Integration tests for `tracegraph diagnose`
 *
 * Exit criterion (IMPLEMENTATION_PLAN.md M3, T3.7):
 *   `tracegraph diagnose` outputs actionable steps to reach a higher capture level.
 *
 * Tests:
 *   D1: diagnose with no trace data prints the "no traces found" message
 *   D2: diagnose on a capture-level-0 trace (plain run) recommends adding a reporter
 *   D3: diagnose on a capture-level-5 trace (vitest reporter) shows ✓ per-test isolation
 *   D4: diagnose --json outputs valid JSON with captureLevel, captured, notCaptured, recommendations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs   from 'fs';
import path from 'path';
import os   from 'os';

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

const _TSX_BIN = path.join(WORKSPACE_ROOT, 'node_modules/.bin');
const TSX = process.platform === 'win32'
  ? path.join(_TSX_BIN, 'tsx.CMD')
  : path.join(_TSX_BIN, 'tsx');

const CLI = path.resolve(WORKSPACE_ROOT, 'packages/cli/src/index.ts');

function runCli(args: string[], cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(TSX, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    timeout: 30_000,
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegraph-diagnose-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Minimal trace fixture builder ─────────────────────────────────────────────

function writeMinimalTrace(opts: {
  captureLevel: number;
  label: string;
  adapters?: Record<string, unknown>;
  eventTypes: string[];
  language?: string;
  framework?: string;
}): string {
  const traceId   = `trc_diag_${Date.now()}`;
  const tracesDir = path.join(tmpDir, '.tracegraph', 'traces');
  fs.mkdirSync(tracesDir, { recursive: true });

  const events = opts.eventTypes.map((type, i) => ({
    schemaVersion: 'tracegraph.event.v1',
    eventId: `evt_${i}`,
    traceId,
    parentEventId: i === 0 ? null : `evt_${i - 1}`,
    type,
    name: type,
    language: opts.language ?? 'javascript',
    framework: opts.framework,
    startTime: Date.now(),
  }));

  const session = {
    schemaVersion: 'tracegraph.trace.v1',
    traceId,
    sessionId: 'sess_test',
    runId: 'run_test',
    workspaceRoot: tmpDir,
    language: opts.language ?? 'javascript',
    ...(opts.framework ? { framework: opts.framework } : {}),
    entrypoint: { type: 'cli_command', command: 'npm test' },
    startedAt: Date.now(),
    endedAt: Date.now() + 1000,
    status: 'passed',
    captureLevel: {
      overall: opts.captureLevel,
      label: opts.label,
      adapters: opts.adapters ?? {},
    },
    events,
  };

  const traceFile = path.join(tracesDir, `${traceId}.trace.json`);
  fs.writeFileSync(traceFile, JSON.stringify(session, null, 2), 'utf8');

  // Write index
  const indexPath = path.join(tmpDir, '.tracegraph', 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify({
    schemaVersion: 'tracegraph.index.v1',
    traces: [{
      traceId,
      runId: 'run_test',
      file: path.relative(tmpDir, traceFile).replace(/\\/g, '/'),
      status: 'passed',
      createdAt: Date.now(),
      entrypoint: { type: 'cli_command', command: 'npm test' },
    }],
  }), 'utf8');

  return traceFile;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('tracegraph diagnose', () => {

  // D1: no traces ──────────────────────────────────────────────────────────────
  it('D1: prints "no traces found" message when .tracegraph/ does not exist', () => {
    const result = runCli(['diagnose'], tmpDir);

    expect(result.status, `diagnose exited non-zero: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('No traces found');
  });

  // D2: level-0 trace (plain run, no adapter) ───────────────────────────────
  it('D2: on a capture-level-0 trace, recommends adding vitest reporter', () => {
    writeMinimalTrace({
      captureLevel: 0,
      label: 'Runner metadata only',
      eventTypes: ['trace_start', 'trace_end'],
    });

    const result = runCli(['diagnose'], tmpDir);

    expect(result.status, `diagnose failed: ${result.stderr}`).toBe(0);

    const out = result.stdout;
    expect(out).toContain('Capture level:  0');
    expect(out).toContain('Recommendations:');
    // Should recommend adding vitest reporter
    expect(out.toLowerCase()).toMatch(/vitest|jest|reporter/);
  });

  // D3: level-5 trace (vitest reporter) ─────────────────────────────────────
  it('D3: on a capture-level-5 trace with test_run events, shows captured test lifecycle', () => {
    writeMinimalTrace({
      captureLevel: 5,
      label: 'Vitest reporter (per-test traces + test structure + results)',
      adapters: {
        vitest: { level: 5, mode: 'reporter', captured: ['test_file', 'test_suite', 'test_run'] },
      },
      eventTypes: ['test_file', 'test_suite', 'test_run'],
      framework: 'vitest',
    });

    const result = runCli(['diagnose'], tmpDir);

    expect(result.status, `diagnose failed: ${result.stderr}`).toBe(0);

    const out = result.stdout;
    expect(out).toContain('Capture level:  5');
    // Level 5 means per-test lifecycle IS captured
    expect(out).toContain('✓');
    // Per-test isolation is captured — should appear in "Captured" section
    expect(out.toLowerCase()).toContain('test');
  });

  // D4: --json output ─────────────────────────────────────────────────────────
  it('D4: --json flag outputs valid JSON with required fields', () => {
    writeMinimalTrace({
      captureLevel: 1,
      label: 'Framework-level tracing',
      eventTypes: ['trace_start', 'http_request', 'http_response', 'trace_end'],
      framework: 'express',
    });

    const result = runCli(['diagnose', '--json'], tmpDir);

    expect(result.status, `diagnose --json failed: ${result.stderr}`).toBe(0);

    let report: Record<string, unknown>;
    expect(() => {
      report = JSON.parse(result.stdout) as Record<string, unknown>;
    }, 'Output was not valid JSON').not.toThrow();

    report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(typeof report['traceId']).toBe('string');

    const captureLevel = report['captureLevel'] as Record<string, unknown>;
    expect(captureLevel['overall']).toBe(1);
    expect(typeof captureLevel['label']).toBe('string');

    expect(Array.isArray(report['captured'])).toBe(true);
    expect(Array.isArray(report['notCaptured'])).toBe(true);
    expect(Array.isArray(report['recommendations'])).toBe(true);

    // Level 1 (http only) should have HTTP in captured and recommendations for test reporter
    const captured = report['captured'] as string[];
    expect(captured.some((s) => s.toLowerCase().includes('http'))).toBe(true);
  });

  // D5: --trace <path> flag ─────────────────────────────────────────────────
  it('D5: --trace <path> loads a specific trace file', () => {
    const traceFile = writeMinimalTrace({
      captureLevel: 3,
      label: 'Custom level',
      eventTypes: ['trace_start', 'db_query', 'trace_end'],
    });

    const result = runCli(['diagnose', '--trace', traceFile], tmpDir);

    expect(result.status, `diagnose --trace failed: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Capture level:  3');
    // db_query event → should show DB captured
    expect(result.stdout.toLowerCase()).toContain('database');
  });
});
