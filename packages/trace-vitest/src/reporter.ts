/**
 * TraceGraphReporter — Vitest reporter that captures one trace per test case.
 *
 * Each `it()` / `test()` call produces its own `.trace.json` file containing:
 *   test_file  → test_suite(s) → test_run
 *
 * All per-test trace files are written to:
 *   {TRACEGRAPH_RUN_DIR}/tests/{traceId}.events.jsonl.tmp
 *
 * The CLI picks up all files in the `tests/` subdirectory after vitest exits
 * and calls finaliseTrace() on each one.
 *
 * Usage in vitest.config.ts:
 *   import { TraceGraphReporter } from '@tracegraph/vitest';
 *   export default defineConfig({
 *     test: { reporters: ['verbose', new TraceGraphReporter()] },
 *   });
 *
 * Capture level: 5 (reporter integration — full test structure + per-test isolation).
 */
import fs   from 'fs';
import path from 'path';
import type { Reporter, File as VitestFile, Task, TaskResultPack } from 'vitest';
import { createEventId, createTraceId } from '@tracegraph/trace-core';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceEvent, CaptureLevel } from '@tracegraph/shared-types';

// ─── Internal state ────────────────────────────────────────────────────────────

type WriterState = {
  runDir:    string;
  testsDir:  string;   // {runDir}/tests — one JSONL per test case
  startedAt: number;
};

// A resolved test case: all the info needed to write one trace file
type TestCase = {
  file:       VitestFile;
  suiteChain: Task[];   // ordered outer-to-inner
  test:       Task;
};

// ─── Public class ──────────────────────────────────────────────────────────────

export class TraceGraphReporter implements Reporter {
  private state: WriterState | null = null;

  // ── Vitest lifecycle ──────────────────────────────────────────────────────────

  onInit(): void {
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
   * Called after all test files have finished executing.
   * Writes one JSONL trace file per test case into {runDir}/tests/.
   */
  onFinished(files: VitestFile[] = []): void {
    if (this.state === null) return;

    const workspaceRoot = process.cwd();
    let total = 0, pass = 0, fail = 0, skip = 0;

    for (const file of files) {
      // Collect all leaf test cases with their full suite ancestry
      const cases = collectTestCases(file);

      for (const tc of cases) {
        this.writeTestCaseTrace(tc, workspaceRoot);
        total++;
        const status = normaliseStatus(tc.test.result?.state);
        if (status === 'pass') pass++;
        else if (status === 'fail') fail++;
        else skip++;
      }
    }

    this.writeCaptureLevel(total, pass, fail, skip);
  }

  // ── Not needed for M3 but satisfies the interface ─────────────────────────────
  onTaskUpdate(_packs: TaskResultPack[]): void { /* no-op */ }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Writes a single per-test-case JSONL file.
   *
   * File layout (all events share the same testTraceId):
   *   test_file  (parentEventId: null  — root of this trace)
   *   test_suite (parentEventId: test_file.eventId)   ← 0..N nested suites
   *   test_run   (parentEventId: innermost suite or test_file)
   */
  private writeTestCaseTrace(tc: TestCase, workspaceRoot: string): void {
    if (this.state === null) return;

    const testTraceId  = createTraceId();
    const jsonlPath    = path.join(this.state.testsDir, `${testTraceId}.events.jsonl.tmp`);
    const relPath      = path.relative(workspaceRoot, tc.file.filepath).replace(/\\/g, '/');
    const events: TraceEvent[] = [];

    // ── test_file event (root of this per-test trace) ─────────────────────────
    const fileEventId = createEventId();
    events.push({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId:       fileEventId,
      traceId:       testTraceId,
      parentEventId: null,           // root — no parent within this trace
      type:          'test_file',
      language:      'javascript',
      framework:     'vitest',
      name:          relPath,
      file:          relPath,
      startTime:     tc.file.result?.startTime ?? this.state.startedAt,
      endTime:       (tc.file.result?.startTime ?? this.state.startedAt) + (tc.file.result?.duration ?? 0),
      durationMs:    tc.file.result?.duration ?? 0,
      metadata: {
        filepath: tc.file.filepath,
      },
    });

    // ── test_suite events (one per describe() in the ancestry chain) ──────────
    let parentEventId: string = fileEventId;
    for (const suite of tc.suiteChain) {
      const suiteEventId = createEventId();
      const suiteResult  = suite.result;

      events.push({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       suiteEventId,
        traceId:       testTraceId,
        parentEventId,
        type:          'test_suite',
        language:      'javascript',
        framework:     'vitest',
        name:          suite.name,
        startTime:     suiteResult?.startTime ?? this.state.startedAt,
        durationMs:    suiteResult?.duration ?? 0,
      });

      parentEventId = suiteEventId;
    }

    // ── test_run event ─────────────────────────────────────────────────────────
    const result     = tc.test.result;
    const testStatus = normaliseStatus(result?.state);
    const firstError = result?.errors?.[0];

    events.push({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId:       createEventId(),
      traceId:       testTraceId,
      parentEventId,
      type:          'test_run',
      language:      'javascript',
      framework:     'vitest',
      name:          tc.test.name,
      startTime:     result?.startTime ?? this.state.startedAt,
      endTime:       result?.startTime
        ? result.startTime + (result.duration ?? 0)
        : undefined,
      durationMs:    result?.duration ?? 0,
      metadata: {
        testStatus,
        suiteName: tc.suiteChain.length > 0
          ? tc.suiteChain[tc.suiteChain.length - 1]!.name
          : undefined,
      },
      ...(firstError ? {
        error: {
          type:    firstError.name ?? 'AssertionError',
          message: firstError.message ?? String(firstError),
          stack:   firstError.stack,
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
      label:   'Vitest reporter (per-test traces + test structure + results)',
      adapters: {
        vitest: {
          level:        5,
          mode:         'reporter',
          captured:     ['test_file', 'test_suite', 'test_run', 'pass/fail/skip status', 'error messages', 'timing'],
          notCaptured:  ['function calls within tests', 'DB queries within tests (use traceFunction for level 2)'],
          recommendation: total > 0
            ? undefined
            : 'No tests were collected — ensure the vitest reporter is loaded correctly',
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
        path.join(this.state.runDir, 'vitest-summary.json'),
        JSON.stringify(meta, null, 2) + '\n',
        'utf8',
      );
    } catch {
      // Best-effort
    }
  }
}

// ─── Tree traversal ───────────────────────────────────────────────────────────

/**
 * Recursively collects all leaf test cases from a VitestFile.
 * Returns one TestCase per it()/test() call with full suite ancestry.
 */
function collectTestCases(file: VitestFile): TestCase[] {
  const cases: TestCase[] = [];

  function walk(tasks: Task[], suiteChain: Task[]): void {
    for (const task of tasks) {
      if (task.type === 'suite') {
        walk(task.tasks ?? [], [...suiteChain, task]);
      } else if (task.type === 'test') {
        cases.push({ file, suiteChain, test: task });
      }
    }
  }

  walk(file.tasks ?? [], []);
  return cases;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Maps Vitest's internal TaskState to our canonical test status string. */
function normaliseStatus(state: string | undefined): 'pass' | 'fail' | 'skip' {
  if (state === 'pass')                   return 'pass';
  if (state === 'fail')                   return 'fail';
  if (state === 'skip' || state === 'todo') return 'skip';
  return 'skip'; // 'run', undefined — shouldn't happen in onFinished
}
