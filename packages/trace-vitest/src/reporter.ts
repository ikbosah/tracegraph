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
 *
 * Vitest compatibility: v1, v2, v3, v4.
 * We intentionally avoid importing types from 'vitest' so the reporter compiles
 * and loads correctly regardless of which major version is installed. Vitest 2+
 * moved types to 'vitest/node' and switched to ESM-first reporter loading, while
 * v1 used CJS require(). Our duck-typed interfaces work with all versions.
 */
import fs   from 'fs';
import path from 'path';
import { createEventId, createTraceId } from '@tracegraph/trace-core';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceEvent, CaptureLevel } from '@tracegraph/shared-types';

// ─── Minimal duck-typed Vitest interfaces ──────────────────────────────────────
//
// We do NOT import from 'vitest' here.  Vitest changed import locations between
// major versions (v1: 'vitest', v2+: 'vitest/node' for Reporter) and switched
// the reporter-loading mechanism (v1: CJS require, v2+: ESM import).
// Using our own minimal structural types makes the reporter portable across all
// supported major versions (1–4) without needing conditional imports.
//
// v1–v3: Task-tree model.  onFinished(files: VFile[]) fires after all tests.
// v4:    Module/Suite/Case graph.  onTestRunEnd(modules: V4TestModule[]) fires
//        instead — onFinished is never called by the v4 runner.

// ── v1–v3 types ───────────────────────────────────────────────────────────────

interface VTaskError {
  name?:    string;
  message?: string;
  stack?:   string;
}

interface VTaskResult {
  state?:     string;       // 'pass' | 'fail' | 'skip' | 'todo' | 'run'
  startTime?: number;
  duration?:  number;
  errors?:    VTaskError[];
}

/** Minimal shape of a Vitest Task (test or suite). */
interface VTask {
  id:      string;
  name:    string;
  type:    string;          // 'test' | 'suite' | 'custom'
  mode?:   string;
  tasks?:  VTask[];
  result?: VTaskResult;
}

/** Minimal shape of a Vitest File (top-level suite with a filepath). */
interface VFile {
  id:       string;
  name:     string;
  filepath: string;
  tasks?:   VTask[];
  result?:  VTaskResult;
}

// ── v4 types ──────────────────────────────────────────────────────────────────
//
// v4 replaced Task trees with a Module/Suite/Case graph.
// Timing moved from result.{startTime,duration} into diagnostic().
// Both result() and diagnostic() are methods, not plain properties.

interface V4Error {
  name?:    string;
  message?: string;
  stack?:   string;
}

interface V4Result {
  state?:   string;     // 'pass' | 'fail' | 'skip' | 'todo'
  errors?:  V4Error[];
}

interface V4Diagnostic {
  duration?:  number;
  startTime?: number;
}

interface V4Node {
  id:            string;
  name:          string;
  parent?:       V4Node;
  result?():     V4Result | undefined;
  diagnostic?(): V4Diagnostic;
}

interface V4TestCase extends V4Node {
  fullName?: string;
}

interface V4TestModule extends V4Node {
  /** Absolute UNIX file path (vitest v4: moduleId). Replaces the v1–3 filepath property. */
  moduleId?:         string;
  /** Path relative to project root (vitest v4). */
  relativeModuleId?: string;
  /** v1–v3 compat: some builds still expose filepath. */
  filepath?:         string;
  children?: {
    allTests(): Iterable<V4TestCase>;
  };
}

// ─── Internal state ────────────────────────────────────────────────────────────

type WriterState = {
  runDir:    string;
  testsDir:  string;   // {runDir}/tests — one JSONL per test case
  startedAt: number;
};

// A resolved test case: all the info needed to write one trace file
type TestCase = {
  file:       VFile;
  suiteChain: VTask[];   // ordered outer-to-inner
  test:       VTask;
};

// ─── Public class ──────────────────────────────────────────────────────────────

export class TraceGraphReporter {
  private state: WriterState | null = null;

  // ── Vitest lifecycle ──────────────────────────────────────────────────────────
  //
  // Method signatures are intentionally broader than Vitest's typed interface:
  //
  //  • onInit(_ctx?: unknown)              — Vitest 2+ passes a Vitest context; we
  //                                          ignore it and read env vars instead.
  //  • onFinished(files, _errors?)         — v1–v3: fires after all tests; v4 never
  //                                          calls this (replaced by onTestRunEnd).
  //  • onTestRunEnd(mods, _errs?, _rsn?)   — v4 replacement for onFinished; receives
  //                                          TestModule[] with the new graph API.
  //  • onTaskUpdate(_packs: unknown[])     — We don't use incremental updates.
  //
  // Using `unknown` args means this class satisfies the Reporter interface of
  // every Vitest major version without importing its types.

  onInit(_ctx?: unknown): void {
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
   *
   * @param files  - Vitest file results (VFile[] duck-typed; compatible v1–4)
   * @param _errors - Vitest 2+ passes an errors array; unused here
   */
  onFinished(files: VFile[] = [], _errors?: unknown[]): void {
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

  // No-op incremental update — we process everything in onFinished / onTestRunEnd.
  onTaskUpdate(_packs: unknown[]): void { /* no-op */ }

  /**
   * Vitest v4 replacement for onFinished.
   * Called once after all test modules have finished.
   * Uses the new Module/Suite/Case graph instead of the old Task tree.
   */
  onTestRunEnd(testModules: unknown[] = [], _errors?: unknown, _reason?: unknown): void {
    if (this.state === null) return;

    const workspaceRoot = process.cwd();
    let total = 0, pass = 0, fail = 0, skip = 0;

    for (const raw of testModules) {
      const mod = raw as V4TestModule;
      if (typeof mod.children?.allTests !== 'function') continue;

      for (const rawCase of mod.children.allTests()) {
        const tc = rawCase as V4TestCase;
        this.writeTestCaseTraceV4(tc, mod, workspaceRoot);
        total++;
        const status = normaliseStatus(tc.result?.()?.state);
        if (status === 'pass') pass++;
        else if (status === 'fail') fail++;
        else skip++;
      }
    }

    this.writeCaptureLevel(total, pass, fail, skip);
  }

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

  /**
   * Vitest v4 variant: builds trace events from the Module/Suite/Case graph.
   * Suite ancestry is reconstructed by walking tc.parent up to the module node.
   */
  private writeTestCaseTraceV4(
    tc: V4TestCase,
    mod: V4TestModule,
    workspaceRoot: string,
  ): void {
    if (this.state === null) return;

    // v4: moduleId is the absolute path; v1-3 used filepath
    const filepath = mod.moduleId ?? mod.filepath ?? '';
    const relPath  = mod.relativeModuleId
      ?? (filepath ? path.relative(workspaceRoot, filepath).replace(/\\/g, '/') : (mod.name ?? 'unknown'));

    // Walk parent chain up to (but not including) the module to get suite ancestry.
    const suiteChain: V4Node[] = [];
    let node: V4Node | undefined = tc.parent;
    while (node && node.id !== mod.id) {
      suiteChain.unshift(node);
      node = node.parent;
    }

    const testTraceId = createTraceId();
    const jsonlPath   = path.join(this.state.testsDir, `${testTraceId}.events.jsonl.tmp`);
    const events: TraceEvent[] = [];

    // ── test_file ─────────────────────────────────────────────────────────────
    const fileEventId = createEventId();
    const modDiag     = mod.diagnostic?.() ?? {};
    events.push({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId:       fileEventId,
      traceId:       testTraceId,
      parentEventId: null,
      type:          'test_file',
      language:      'javascript',
      framework:     'vitest',
      name:          relPath,
      file:          relPath,
      startTime:     modDiag.startTime ?? this.state.startedAt,
      endTime:       (modDiag.startTime ?? this.state.startedAt) + (modDiag.duration ?? 0),
      durationMs:    modDiag.duration ?? 0,
      metadata:      { filepath: filepath || relPath },
    });

    // ── test_suite events ─────────────────────────────────────────────────────
    let parentEventId: string = fileEventId;
    for (const suite of suiteChain) {
      const suiteEventId = createEventId();
      const suiteDiag    = suite.diagnostic?.() ?? {};
      events.push({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       suiteEventId,
        traceId:       testTraceId,
        parentEventId,
        type:          'test_suite',
        language:      'javascript',
        framework:     'vitest',
        name:          suite.name,
        startTime:     suiteDiag.startTime ?? this.state.startedAt,
        durationMs:    suiteDiag.duration ?? 0,
      });
      parentEventId = suiteEventId;
    }

    // ── test_run event ────────────────────────────────────────────────────────
    const result     = tc.result?.() ?? {};
    const tcDiag     = tc.diagnostic?.() ?? {};
    const testStatus = normaliseStatus(result.state);
    const firstError = result.errors?.[0];

    events.push({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId:       createEventId(),
      traceId:       testTraceId,
      parentEventId,
      type:          'test_run',
      language:      'javascript',
      framework:     'vitest',
      name:          tc.name,
      startTime:     tcDiag.startTime ?? this.state.startedAt,
      endTime:       tcDiag.startTime
        ? tcDiag.startTime + (tcDiag.duration ?? 0)
        : undefined,
      durationMs:    tcDiag.duration ?? 0,
      metadata: {
        testStatus,
        suiteName: suiteChain.length > 0
          ? suiteChain[suiteChain.length - 1]!.name
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
 * Recursively collects all leaf test cases from a VFile.
 * Returns one TestCase per it()/test() call with full suite ancestry.
 *
 * Handles both Vitest v1 (type: 'test' | 'suite') and v4 (adds type: 'custom').
 * We treat anything that is not 'suite' and has no child tasks as a test leaf.
 */
function collectTestCases(file: VFile): TestCase[] {
  const cases: TestCase[] = [];

  function walk(tasks: VTask[], suiteChain: VTask[]): void {
    for (const task of tasks) {
      const childTasks = task.tasks ?? [];
      if (task.type === 'suite' && childTasks.length > 0) {
        // Descend into suites (describe blocks)
        walk(childTasks, [...suiteChain, task]);
      } else if (task.type === 'test' || task.type === 'custom' || childTasks.length === 0) {
        // Leaf node — treat as a test case (covers 'test', 'custom', and any future types)
        if (task.type !== 'suite') {
          cases.push({ file, suiteChain, test: task });
        }
      }
    }
  }

  walk(file.tasks ?? [], []);
  return cases;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Maps Vitest's internal TaskState to our canonical test status string.
 * v1-v3 use 'pass'/'fail'/'skip'; v4 uses 'passed'/'failed'/'skipped'. */
function normaliseStatus(state: string | undefined): 'pass' | 'fail' | 'skip' {
  if (state === 'pass'   || state === 'passed')           return 'pass';
  if (state === 'fail'   || state === 'failed')           return 'fail';
  if (state === 'skip'   || state === 'skipped'
   || state === 'todo'   || state === 'pending')          return 'skip';
  return 'skip'; // 'run', undefined — shouldn't happen after test run completes
}

// ─── Default export ───────────────────────────────────────────────────────────
//
// Required for Vitest reporter loading via `--reporter=/path/to/reporter.mjs`.
// Vitest (all versions 1–4) loads reporters via ESM dynamic import() and then
// does `new mod.default()`.  Without this export, mod.default is undefined.
//
// The named export `TraceGraphReporter` is preserved for:
//   • Direct import:  import { TraceGraphReporter } from '@tracegraph/vitest'
//   • vitest.config:  reporters: [new TraceGraphReporter()]
export default TraceGraphReporter;
