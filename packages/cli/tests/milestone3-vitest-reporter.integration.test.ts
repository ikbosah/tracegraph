/**
 * Milestone 3 — Vitest Reporter integration tests
 *
 * Exit criteria (IMPLEMENTATION_PLAN.md M3):
 *   T3.1: tracegraph run -- vitest run <fixture> produces one .trace.json per
 *         test case (not one per suite). Each trace contains test_file,
 *         test_suite, and test_run event types.
 *   T3.2: Within each trace, test_suite events are parented to test_file and
 *         test_run events are parented to test_suite.
 *   T3.3: testStatus in test_run metadata reflects the actual pass/fail/skip outcome.
 *   T3.4: Failed test_run events include an error field with type, message, stack.
 *   T3.5: captureLevel.overall = 5 and adapters.vitest.mode = 'reporter' in every trace.
 *
 * Fixture structure (m3-vitest-fixture.vitest.ts):
 *   describe('Calculator')  → 3 tests, all pass
 *   describe('StringUtils') → 2 tests (1 pass, 1 intentional fail) + 1 skip
 *   Total: 6 tests | 4 pass | 1 fail | 1 skip → 6 trace files
 *
 * Architecture notes:
 *   - tracegraph run sets TRACEGRAPH_* env vars and spawns vitest.
 *   - vitest loads TraceGraphReporter from @tracegraph/vitest (compiled dist/index.cjs).
 *   - The reporter writes one {traceId}.events.jsonl.tmp per test into {runDir}/tests/.
 *   - CLI finalises all test traces then finalises the main run trace.
 *   - vitest exits 1 (intentional failing test) — tracegraph run propagates it;
 *     we tolerate status=0 or 1 and check the traces were written regardless.
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

const VITEST_BIN = process.platform === 'win32'
  ? path.join(WORKSPACE_ROOT, 'node_modules/.bin/vitest.CMD')
  : path.join(WORKSPACE_ROOT, 'node_modules/.bin/vitest');

const CLI     = path.resolve(WORKSPACE_ROOT, 'packages/cli/src/index.ts');
const FIXTURE = path.resolve(__dirname, 'fixtures/m3-vitest-fixture.vitest.ts');
const VITEST_CONFIG = path.resolve(WORKSPACE_ROOT, 'packages/trace-vitest/vitest.m3-integration.config.ts');

type CliLine = {
  protocol:      string;
  type:          string;
  runId:         string;
  timestamp:     number;
  [k: string]:   unknown;
};

type SpawnResult = ReturnType<typeof spawnSync> & { stdoutLines: CliLine[] };

function runCli(args: string[], cwd: string): SpawnResult {
  const result = spawnSync(TSX, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    timeout: 90_000,
  });

  const stdoutLines: CliLine[] = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { stdoutLines.push(JSON.parse(t) as CliLine); } catch { /* passthrough */ }
  }

  return Object.assign(result, { stdoutLines });
}

function findFiles(dir: string, suffix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) results.push(full);
  }
  return results;
}

type TraceEvent = {
  eventId:       string;
  parentEventId?: string | null;
  type:          string;
  name:          string;
  language:      string;
  framework?:    string;
  durationMs?:   number;
  metadata?:     Record<string, unknown>;
  error?:        { type: string; message: string; stack?: string };
};

type TraceJson = {
  traceId:      string;
  events:       TraceEvent[];
  captureLevel: { overall: number; label: string; adapters: Record<string, unknown> };
};

type FixtureResult = {
  /** All trace files that contain at least one test_run event (the per-test traces). */
  testTraces: TraceJson[];
  stderr:     string;
  stdout:     string;
  status:     number | null;
};

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegraph-m3-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Fixture runner ────────────────────────────────────────────────────────────

/**
 * Runs the fixture via `tracegraph run -- vitest run ...` and returns all
 * per-test-case trace files (those containing a test_run event).
 * vitest exits 1 due to the intentional failing test; we tolerate that.
 */
function runFixtureAndGetTraces(): FixtureResult {
  const result = runCli(
    [
      'run', '--',
      VITEST_BIN,
      'run',
      '--root', WORKSPACE_ROOT,
      '--config', VITEST_CONFIG,
      FIXTURE,
    ],
    tmpDir,
  );

  const diag = `status=${result.status ?? 'null'}\nstderr=${result.stderr}\nstdout=${result.stdout}`;

  // vitest exits 1 because of the intentional failing test — that is expected
  expect(
    result.status === 0 || result.status === 1,
    `CLI exited unexpectedly\n${diag}`,
  ).toBe(true);

  const traceDir   = path.join(tmpDir, '.tracegraph', 'traces');
  const traceFiles = findFiles(traceDir, '.trace.json');

  expect(
    traceFiles.length,
    `Expected at least one .trace.json in ${traceDir}\n${diag}`,
  ).toBeGreaterThanOrEqual(1);

  // Parse all trace files and keep only those with test_run events (per-test traces)
  const testTraces: TraceJson[] = [];
  for (const tf of traceFiles) {
    try {
      const trace = JSON.parse(fs.readFileSync(tf, 'utf8')) as TraceJson;
      if (trace.events.some((e) => e.type === 'test_run')) {
        testTraces.push(trace);
      }
    } catch { /* skip malformed files */ }
  }

  return { testTraces, stderr: result.stderr ?? '', stdout: result.stdout ?? '', status: result.status ?? null };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Milestone 3 — Vitest Reporter', () => {

  // ── T3.1: one trace per test case ────────────────────────────────────────
  it('T3.1: produces 6 per-test trace files (one per it() call)', () => {
    const { testTraces, stderr } = runFixtureAndGetTraces();

    const diag = `found ${testTraces.length} test traces\nstderr: ${stderr.slice(0, 400)}`;

    // Fixture has 6 tests: 3 in Calculator + 2 in StringUtils + 1 skip
    expect(testTraces.length, `Expected 6 per-test traces\n${diag}`).toBe(6);

    // Every per-test trace must have test_file, test_suite, and test_run events
    for (const trace of testTraces) {
      const types = new Set(trace.events.map((e) => e.type));
      expect(types.has('test_file'),  `Trace missing test_file event`).toBe(true);
      expect(types.has('test_suite'), `Trace missing test_suite event`).toBe(true);
      expect(types.has('test_run'),   `Trace missing test_run event`).toBe(true);
    }

    // All events use vitest framework + javascript language
    for (const trace of testTraces) {
      for (const ev of trace.events.filter((e) => e.type !== 'trace_start' && e.type !== 'trace_end')) {
        expect(ev.language,  `${ev.name} should have language=javascript`).toBe('javascript');
        expect(ev.framework, `${ev.name} should have framework=vitest`).toBe('vitest');
      }
    }
  });

  // ── T3.2: parent-child chain ───────────────────────────────────────────────
  it('T3.2: within each trace, test_suite parents to test_file; test_run parents to test_suite', () => {
    const { testTraces } = runFixtureAndGetTraces();

    for (const trace of testTraces) {
      const fileEvt   = trace.events.find((e) => e.type === 'test_file');
      const suiteEvts = trace.events.filter((e) => e.type === 'test_suite');
      const testEvts  = trace.events.filter((e) => e.type === 'test_run');

      expect(fileEvt, 'test_file event missing from trace').toBeDefined();

      // test_file is the root of each per-test trace
      expect(
        fileEvt!.parentEventId ?? null,
        `test_file.parentEventId should be null (it is the trace root)`,
      ).toBeNull();

      // Every test_suite must be parented to the test_file
      for (const suite of suiteEvts) {
        expect(
          suite.parentEventId,
          `suite "${suite.name}" parentEventId should be the test_file eventId`,
        ).toBe(fileEvt!.eventId);
      }

      // Every test_run must be parented to a test_suite (or test_file if no suite)
      for (const test of testEvts) {
        const parentIsSuite = suiteEvts.some((s) => s.eventId === test.parentEventId);
        const parentIsFile  = test.parentEventId === fileEvt!.eventId;
        expect(
          parentIsSuite || parentIsFile,
          `test "${test.name}" parentEventId must point to a test_suite or test_file`,
        ).toBe(true);
      }
    }
  });

  // ── T3.3: pass / fail / skip statuses ─────────────────────────────────────
  it('T3.3: testStatus in metadata reflects actual pass/fail/skip outcome', () => {
    const { testTraces } = runFixtureAndGetTraces();

    const testEvts = testTraces.map((t) => t.events.find((e) => e.type === 'test_run')!);

    // All must have a testStatus in metadata
    for (const t of testEvts) {
      expect(
        t.metadata?.['testStatus'],
        `test "${t.name}" is missing metadata.testStatus`,
      ).toBeDefined();
    }

    // Count by status
    const byStatus = { pass: 0, fail: 0, skip: 0 };
    for (const t of testEvts) {
      const s = t.metadata?.['testStatus'] as string;
      if (s === 'pass') byStatus.pass++;
      else if (s === 'fail') byStatus.fail++;
      else byStatus.skip++;
    }

    // Fixture: 4 pass, 1 intentional fail, 1 skip
    expect(byStatus.pass, 'Expected 4 passing tests').toBe(4);
    expect(byStatus.fail, 'Expected 1 failing test').toBe(1);
    expect(byStatus.skip, 'Expected 1 skipped test').toBe(1);

    // The intentionally failing test is "fails intentionally"
    const failTest = testEvts.find((t) => t.metadata?.['testStatus'] === 'fail');
    expect(failTest?.name).toBe('fails intentionally');
  });

  // ── T3.4: failed tests have error field ───────────────────────────────────
  it('T3.4: failed test_run trace includes a structured error field', () => {
    const { testTraces } = runFixtureAndGetTraces();

    // Find the trace that contains the failing test
    const failTrace = testTraces.find((trace) =>
      trace.events.some((e) => e.type === 'test_run' && e.metadata?.['testStatus'] === 'fail'),
    );

    expect(failTrace, 'No failing test trace found').toBeDefined();

    const failTest = failTrace!.events.find(
      (e) => e.type === 'test_run' && e.metadata?.['testStatus'] === 'fail',
    )!;

    expect(failTest.error, 'error field missing on failing test').toBeDefined();

    const { type: errType, message, stack } = failTest.error!;
    expect(typeof errType,   'error.type must be a string').toBe('string');
    expect(errType.length,   'error.type must be non-empty').toBeGreaterThan(0);
    expect(typeof message,   'error.message must be a string').toBe('string');
    expect(message.length,   'error.message must be non-empty').toBeGreaterThan(0);

    if (stack !== undefined) {
      expect(typeof stack, 'error.stack must be a string when present').toBe('string');
    }

    // Passing-test traces must NOT have an error field on their test_run event
    const passTraces = testTraces.filter((trace) =>
      trace.events.some((e) => e.type === 'test_run' && e.metadata?.['testStatus'] === 'pass'),
    );
    for (const t of passTraces) {
      const testEvt = t.events.find((e) => e.type === 'test_run')!;
      expect(testEvt.error, `passing test "${testEvt.name}" should not have an error field`).toBeUndefined();
    }
  });

  // ── T3.5: capture-level in all test traces ────────────────────────────────
  it('T3.5: every test trace has captureLevel.overall=5 and adapters.vitest.mode=reporter', () => {
    const { testTraces } = runFixtureAndGetTraces();

    for (const trace of testTraces) {
      expect(
        trace.captureLevel.overall,
        `captureLevel.overall should be 5 in trace ${trace.traceId}`,
      ).toBe(5);

      expect(typeof trace.captureLevel.label, 'captureLevel.label must be a string').toBe('string');

      const vitestAdapter = trace.captureLevel.adapters['vitest'] as {
        level: number;
        mode: string;
        captured: string[];
      } | undefined;

      expect(vitestAdapter, 'adapters.vitest entry missing').toBeDefined();
      expect(vitestAdapter!.level, 'adapters.vitest.level should be 5').toBe(5);
      expect(vitestAdapter!.mode,  'adapters.vitest.mode should be reporter').toBe('reporter');
      expect(Array.isArray(vitestAdapter!.captured), 'adapters.vitest.captured should be an array').toBe(true);
      expect(vitestAdapter!.captured.length).toBeGreaterThan(0);
    }
  });
});
