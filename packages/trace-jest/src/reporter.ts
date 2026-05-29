/**
 * TraceGraphJestReporter — Jest reporter that captures one trace per test case.
 *
 * Each `it()` / `test()` call produces its own `.events.jsonl.tmp` file:
 *   test_file → test_suite(s) → test_run
 *
 * All per-test trace files are written to:
 *   {TRACEGRAPH_RUN_DIR}/tests/{traceId}.events.jsonl.tmp
 *
 * The CLI picks up all files in the `tests/` subdirectory after jest exits
 * and calls finaliseTrace() on each one.
 *
 * Usage in jest.config.js:
 *   module.exports = {
 *     reporters: ['default', '@tracegraph/jest'],
 *   };
 *
 * Capture level: 5 (reporter integration — full test structure + per-test isolation).
 */
import fs   from 'fs';
import path from 'path';
import type {
  Reporter,
  ReporterOnStartOptions,
} from '@jest/reporters';
import type { AggregatedResult, TestResult, AssertionResult } from '@jest/test-result';
import type { Test } from '@jest/test-result';
import { createEventId, createTraceId } from '@tracegraph/trace-core';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceEvent, CaptureLevel } from '@tracegraph/shared-types';

// ─── Internal state ────────────────────────────────────────────────────────────

type WriterState = {
  runDir:    string;
  testsDir:  string;   // {runDir}/tests — one JSONL per test case
  startedAt: number;
};

// ─── Public class ──────────────────────────────────────────────────────────────

export class TraceGraphJestReporter implements Reporter {
  private state: WriterState | null = null;

  // ── Jest lifecycle ────────────────────────────────────────────────────────────

  onRunStart(_results: AggregatedResult, _options: ReporterOnStartOptions): void {
    const runDir = process.env['TRACEGRAPH_RUN_DIR'];

    if (process.env['TRACEGRAPH_ENABLED'] !== '1' || !runDir) {
      return;
    }

    const testsDir = path.join(runDir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });

    this.state = {
      runDir,
      testsDir,
      startedAt: Date.now(),
    };
  }

  /**
   * Called after each test *file* completes. We write one JSONL file per
   * individual test case found in the file's results.
   */
  onTestResult(_test: Test, testResult: TestResult, _aggregatedResult: AggregatedResult): void {
    if (this.state === null) return;

    const workspaceRoot = process.cwd();

    for (const assertionResult of testResult.testResults) {
      this.writeTestCaseTrace(testResult, assertionResult, workspaceRoot);
    }
  }

  /**
   * Called once after all test files have finished.
   * Writes the capture-level and summary JSON files.
   */
  onRunComplete(_contexts: Set<unknown>, results: AggregatedResult): void {
    if (this.state === null) return;

    const total = results.numTotalTests;
    const pass  = results.numPassedTests;
    const fail  = results.numFailedTests;
    const skip  = results.numPendingTests + results.numTodoTests;

    this.writeCaptureLevel(total, pass, fail, skip);
  }

  /** Required by Jest's Reporter interface. */
  getLastError(): void { /* no-op */ }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Writes a single per-test-case JSONL file.
   *
   * File layout (all events share the same testTraceId):
   *   test_file  (parentEventId: null  — root of this trace)
   *   test_suite (parentEventId: test_file.eventId)   ← 0..N nested suites
   *   test_run   (parentEventId: innermost suite or test_file)
   */
  private writeTestCaseTrace(
    fileResult:      TestResult,
    assertionResult: AssertionResult,
    workspaceRoot:   string,
  ): void {
    if (this.state === null) return;

    const testTraceId = createTraceId();
    const jsonlPath   = path.join(this.state.testsDir, `${testTraceId}.events.jsonl.tmp`);
    const relPath     = path
      .relative(workspaceRoot, fileResult.testFilePath)
      .replace(/\\/g, '/');

    const events: TraceEvent[] = [];

    // ── test_file event (root of this per-test trace) ─────────────────────────
    const fileEventId = createEventId();
    const fileStart   = fileResult.perfStats?.start ?? this.state.startedAt;
    const fileEnd     = fileResult.perfStats?.end   ?? fileStart;

    events.push({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId:       fileEventId,
      traceId:       testTraceId,
      parentEventId: null,
      type:          'test_file',
      language:      'javascript',
      framework:     'jest',
      name:          relPath,
      file:          relPath,
      startTime:     fileStart,
      endTime:       fileEnd,
      durationMs:    fileEnd - fileStart,
      metadata: {
        filepath: fileResult.testFilePath,
      },
    });

    // ── test_suite events (one per ancestorTitle) ─────────────────────────────
    let parentEventId: string = fileEventId;

    for (const suiteName of assertionResult.ancestorTitles) {
      const suiteEventId = createEventId();

      events.push({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       suiteEventId,
        traceId:       testTraceId,
        parentEventId,
        type:          'test_suite',
        language:      'javascript',
        framework:     'jest',
        name:          suiteName,
        startTime:     fileStart,
        durationMs:    0,   // Jest doesn't provide per-suite timing
      });

      parentEventId = suiteEventId;
    }

    // ── test_run event ─────────────────────────────────────────────────────────
    const testStatus = normaliseStatus(assertionResult.status);
    const durationMs = assertionResult.duration ?? 0;
    const startTime  = fileStart;
    const endTime    = fileStart + durationMs;

    const firstFailure = assertionResult.failureMessages?.[0];

    events.push({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId:       createEventId(),
      traceId:       testTraceId,
      parentEventId,
      type:          'test_run',
      language:      'javascript',
      framework:     'jest',
      name:          assertionResult.title,
      startTime,
      endTime,
      durationMs,
      metadata: {
        testStatus,
        fullName:  assertionResult.fullName,
        suiteName: assertionResult.ancestorTitles.at(-1),
      },
      ...(firstFailure ? {
        error: {
          type:    'AssertionError',
          message: stripAnsi(firstFailure),
          stack:   stripAnsi(firstFailure),
        },
      } : {}),
    });

    // ── Write JSONL file ───────────────────────────────────────────────────────
    try {
      const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(jsonlPath, content, 'utf8');
    } catch {
      // Best-effort: never let tracing errors affect the test run
    }
  }

  private writeCaptureLevel(
    total: number,
    pass:  number,
    fail:  number,
    skip:  number,
  ): void {
    if (this.state === null) return;

    const captureLevel: CaptureLevel = {
      overall: 5,
      label:   'Jest reporter (per-test traces + test structure + results)',
      adapters: {
        jest: {
          level:        5,
          mode:         'reporter',
          captured:     ['test_file', 'test_suite', 'test_run', 'pass/fail/skip status', 'error messages', 'timing'],
          notCaptured:  ['function calls within tests', 'DB queries within tests (use traceFunction for level 2)'],
          recommendation: total > 0
            ? undefined
            : 'No tests were collected — ensure the jest reporter is loaded correctly',
        },
      },
    };

    const meta = { total, pass, fail, skip };

    try {
      fs.writeFileSync(
        path.join(this.state.runDir, 'capture-level.json'),
        JSON.stringify(captureLevel, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(this.state.runDir, 'jest-summary.json'),
        JSON.stringify(meta, null, 2) + '\n',
        'utf8',
      );
    } catch {
      // Best-effort
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Maps Jest's assertion status to our canonical test status. */
function normaliseStatus(
  status: AssertionResult['status'],
): 'pass' | 'fail' | 'skip' {
  if (status === 'passed')  return 'pass';
  if (status === 'failed')  return 'fail';
  return 'skip'; // 'pending', 'todo', 'skipped', 'disabled', 'focused'
}

/**
 * Strips ANSI colour escape sequences from a string.
 * Jest failure messages include ANSI codes for terminal colouring.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}
