/**
 * Unit tests for TraceGraphJestReporter.
 *
 * Tests:
 *   JR1: onRunStart creates testsDir when TRACEGRAPH_ENABLED=1
 *   JR2: onRunStart is a no-op when TRACEGRAPH_ENABLED is not set
 *   JR3: onTestResult writes one JSONL file per test case
 *   JR4: JSONL events contain test_file → test_suite → test_run structure
 *   JR5: test_run event captures pass/fail/skip status
 *   JR6: test_run event includes error when test fails
 *   JR7: onRunComplete writes capture-level.json and jest-summary.json
 */
import { test, expect } from 'vitest';
import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { TraceGraphJestReporter } from '../src/reporter';
import type { AggregatedResult, TestResult, AssertionResult } from '@jest/test-result';
import type { ReporterOnStartOptions } from '@jest/reporters';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRunDir(): string {
  const dir = path.join(os.tmpdir(), 'tg-jest-test-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAggregatedResult(overrides: Partial<AggregatedResult> = {}): AggregatedResult {
  return {
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: 0,
    numPassedTests: 1,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numRuntimeErrorTestSuites: 0,
    numTodoTests: 0,
    numTotalTestSuites: 1,
    numTotalTests: 1,
    openHandles: [],
    snapshot: {} as AggregatedResult['snapshot'],
    startTime: Date.now(),
    success: true,
    testResults: [],
    wasInterrupted: false,
    ...overrides,
  } as AggregatedResult;
}

function makeTestResult(
  filePath: string,
  assertions: Partial<AssertionResult>[],
): TestResult {
  const now = Date.now();
  return {
    testFilePath: filePath,
    testResults:  assertions.map((a) => ({
      ancestorTitles:  [],
      duration:        10,
      failureMessages: [],
      failureDetails:  [],
      fullName:        a.title ?? 'test',
      numPassingAsserts: 1,
      status:          'passed',
      title:           a.title ?? 'test',
      ...a,
    })) as AssertionResult[],
    perfStats: { start: now, end: now + 100, slow: false, runtime: 100 },
    numFailingTests:  0,
    numPassingTests:  assertions.length,
    numPendingTests:  0,
    numTodoTests:     0,
    skipped:          false,
    failureMessage:   null,
    openHandles:      [],
    snapshot:         {} as TestResult['snapshot'],
    memoryUsage:      0,
    leaks:            false,
    testExecError:    null,
    coverage:         undefined,
    displayName:      undefined,
    console:          undefined,
  } as unknown as TestResult;
}

// ─── JR1 — creates testsDir ───────────────────────────────────────────────────

test('JR1: onRunStart creates testsDir when TRACEGRAPH_ENABLED=1', () => {
  const runDir = makeRunDir();

  try {
    process.env['TRACEGRAPH_ENABLED']  = '1';
    process.env['TRACEGRAPH_RUN_DIR']  = runDir;

    const reporter = new TraceGraphJestReporter();
    reporter.onRunStart(makeAggregatedResult(), {} as ReporterOnStartOptions);

    expect(fs.existsSync(path.join(runDir, 'tests'))).toBe(true);
  } finally {
    delete process.env['TRACEGRAPH_ENABLED'];
    delete process.env['TRACEGRAPH_RUN_DIR'];
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── JR2 — no-op when disabled ───────────────────────────────────────────────

test('JR2: onRunStart is a no-op when TRACEGRAPH_ENABLED is not set', () => {
  const runDir = makeRunDir();

  try {
    delete process.env['TRACEGRAPH_ENABLED'];
    process.env['TRACEGRAPH_RUN_DIR'] = runDir;

    const reporter = new TraceGraphJestReporter();
    reporter.onRunStart(makeAggregatedResult(), {} as ReporterOnStartOptions);

    // testsDir should NOT be created
    expect(fs.existsSync(path.join(runDir, 'tests'))).toBe(false);
  } finally {
    delete process.env['TRACEGRAPH_RUN_DIR'];
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── JR3 — writes one JSONL per test ─────────────────────────────────────────

test('JR3: onTestResult writes one JSONL file per test case', () => {
  const runDir = makeRunDir();

  try {
    process.env['TRACEGRAPH_ENABLED'] = '1';
    process.env['TRACEGRAPH_RUN_DIR'] = runDir;

    const reporter = new TraceGraphJestReporter();
    reporter.onRunStart(makeAggregatedResult(), {} as ReporterOnStartOptions);

    const filePath = path.join(process.cwd(), 'src', 'myModule.test.ts');
    reporter.onTestResult(
      {} as any,
      makeTestResult(filePath, [{ title: 'test A' }, { title: 'test B' }]),
      makeAggregatedResult(),
    );

    const files = fs.readdirSync(path.join(runDir, 'tests'));
    expect(files).toHaveLength(2);
    files.forEach((f) => expect(f).toMatch(/\.events\.jsonl\.tmp$/));
  } finally {
    delete process.env['TRACEGRAPH_ENABLED'];
    delete process.env['TRACEGRAPH_RUN_DIR'];
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── JR4 — event structure ────────────────────────────────────────────────────

test('JR4: JSONL events contain test_file → test_suite → test_run structure', () => {
  const runDir = makeRunDir();

  try {
    process.env['TRACEGRAPH_ENABLED'] = '1';
    process.env['TRACEGRAPH_RUN_DIR'] = runDir;

    const reporter = new TraceGraphJestReporter();
    reporter.onRunStart(makeAggregatedResult(), {} as ReporterOnStartOptions);

    const filePath = path.join(process.cwd(), 'src', 'invoiceService.test.ts');
    reporter.onTestResult(
      {} as any,
      makeTestResult(filePath, [{
        title:          'creates invoice',
        ancestorTitles: ['InvoiceService', 'create()'],
      }]),
      makeAggregatedResult(),
    );

    const testsDir = path.join(runDir, 'tests');
    const [file]   = fs.readdirSync(testsDir);
    const content  = fs.readFileSync(path.join(testsDir, file!), 'utf8');
    const events   = content.trim().split('\n').map((l) => JSON.parse(l));

    // Should be: test_file, test_suite (InvoiceService), test_suite (create()), test_run
    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('test_file');
    expect(events[1].type).toBe('test_suite');
    expect(events[1].name).toBe('InvoiceService');
    expect(events[2].type).toBe('test_suite');
    expect(events[2].name).toBe('create()');
    expect(events[3].type).toBe('test_run');
    expect(events[3].name).toBe('creates invoice');
    expect(events[3].framework).toBe('jest');

    // Parent chain
    expect(events[1].parentEventId).toBe(events[0].eventId);
    expect(events[2].parentEventId).toBe(events[1].eventId);
    expect(events[3].parentEventId).toBe(events[2].eventId);
  } finally {
    delete process.env['TRACEGRAPH_ENABLED'];
    delete process.env['TRACEGRAPH_RUN_DIR'];
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── JR5 — test status ───────────────────────────────────────────────────────

test('JR5: test_run event captures pass/fail/skip status correctly', () => {
  const runDir = makeRunDir();

  try {
    process.env['TRACEGRAPH_ENABLED'] = '1';
    process.env['TRACEGRAPH_RUN_DIR'] = runDir;

    const reporter = new TraceGraphJestReporter();
    reporter.onRunStart(makeAggregatedResult(), {} as ReporterOnStartOptions);

    const filePath = path.join(process.cwd(), 'src', 'status.test.ts');
    reporter.onTestResult(
      {} as any,
      makeTestResult(filePath, [
        { title: 'pass test', status: 'passed' },
        { title: 'fail test', status: 'failed' },
        { title: 'skip test', status: 'pending' },
      ]),
      makeAggregatedResult(),
    );

    const testsDir = path.join(runDir, 'tests');
    const files    = fs.readdirSync(testsDir).sort();
    expect(files).toHaveLength(3);

    const statuses = files.map((f) => {
      const content = fs.readFileSync(path.join(testsDir, f), 'utf8');
      const events  = content.trim().split('\n').map((l) => JSON.parse(l));
      return events.find((e: any) => e.type === 'test_run')?.metadata?.testStatus;
    });

    expect(statuses).toContain('pass');
    expect(statuses).toContain('fail');
    expect(statuses).toContain('skip');
  } finally {
    delete process.env['TRACEGRAPH_ENABLED'];
    delete process.env['TRACEGRAPH_RUN_DIR'];
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── JR6 — error capture ─────────────────────────────────────────────────────

test('JR6: test_run event includes error payload when test fails', () => {
  const runDir = makeRunDir();

  try {
    process.env['TRACEGRAPH_ENABLED'] = '1';
    process.env['TRACEGRAPH_RUN_DIR'] = runDir;

    const reporter = new TraceGraphJestReporter();
    reporter.onRunStart(makeAggregatedResult(), {} as ReporterOnStartOptions);

    const filePath = path.join(process.cwd(), 'src', 'err.test.ts');
    reporter.onTestResult(
      {} as any,
      makeTestResult(filePath, [{
        title:           'failing test',
        status:          'failed',
        failureMessages: ['expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1'],
      }]),
      makeAggregatedResult(),
    );

    const testsDir = path.join(runDir, 'tests');
    const [file]   = fs.readdirSync(testsDir);
    const content  = fs.readFileSync(path.join(testsDir, file!), 'utf8');
    const events   = content.trim().split('\n').map((l) => JSON.parse(l));
    const testRun  = events.find((e: any) => e.type === 'test_run');

    expect(testRun.error).toBeDefined();
    expect(testRun.error.type).toBe('AssertionError');
    expect(testRun.error.message).toContain('Expected: 2');
  } finally {
    delete process.env['TRACEGRAPH_ENABLED'];
    delete process.env['TRACEGRAPH_RUN_DIR'];
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

// ─── JR7 — capture level file ────────────────────────────────────────────────

test('JR7: onRunComplete writes capture-level.json and jest-summary.json', () => {
  const runDir = makeRunDir();

  try {
    process.env['TRACEGRAPH_ENABLED'] = '1';
    process.env['TRACEGRAPH_RUN_DIR'] = runDir;

    const reporter = new TraceGraphJestReporter();
    reporter.onRunStart(makeAggregatedResult(), {} as ReporterOnStartOptions);
    reporter.onRunComplete(
      new Set(),
      makeAggregatedResult({
        numTotalTests:   10,
        numPassedTests:  8,
        numFailedTests:  1,
        numPendingTests: 1,
      }),
    );

    const captureLevelPath = path.join(runDir, 'capture-level.json');
    const summaryPath      = path.join(runDir, 'jest-summary.json');

    expect(fs.existsSync(captureLevelPath)).toBe(true);
    expect(fs.existsSync(summaryPath)).toBe(true);

    const captureLevel = JSON.parse(fs.readFileSync(captureLevelPath, 'utf8'));
    expect(captureLevel.overall).toBe(5);
    expect(captureLevel.adapters.jest.mode).toBe('reporter');

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(summary.total).toBe(10);
    expect(summary.pass).toBe(8);
    expect(summary.fail).toBe(1);
    expect(summary.skip).toBe(1);
  } finally {
    delete process.env['TRACEGRAPH_ENABLED'];
    delete process.env['TRACEGRAPH_RUN_DIR'];
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
