/**
 * Unit tests for TraceGraphReporter.
 *
 * Strategy: set up a real temp directory, populate TRACEGRAPH_* env vars,
 * call onInit() + onFinished() with hand-crafted Vitest task trees,
 * then read the emitted per-test JSONL files to verify correctness.
 *
 * Architecture: the reporter writes one {traceId}.events.jsonl.tmp per test
 * case into {runDir}/tests/. Each file contains:
 *   test_file (parentEventId: null) → test_suite(s) → test_run
 */
import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TraceGraphReporter } from '../src/reporter';
import type { File as VitestFile, Task } from 'vitest';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
const FAKE_TRACE_ID  = 'trace_unit_test_001';
const FAKE_ROOT_EVENT = 'evt_root_unit_001';

function setupEnv(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegraph-vitest-unit-'));
  process.env['TRACEGRAPH_ENABLED']       = '1';
  process.env['TRACEGRAPH_RUN_DIR']       = tmpDir;
  process.env['TRACEGRAPH_TRACE_ID']      = FAKE_TRACE_ID;
  process.env['TRACEGRAPH_ROOT_EVENT_ID'] = FAKE_ROOT_EVENT;
}

function clearEnv(): void {
  delete process.env['TRACEGRAPH_ENABLED'];
  delete process.env['TRACEGRAPH_RUN_DIR'];
  delete process.env['TRACEGRAPH_TRACE_ID'];
  delete process.env['TRACEGRAPH_ROOT_EVENT_ID'];
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Read all events from all per-test JSONL files in {tmpDir}/tests/.
 * The reporter now writes one file per test case.
 */
function readAllTestEvents(): Array<Record<string, unknown>> {
  const testsDir = path.join(tmpDir, 'tests');
  if (!fs.existsSync(testsDir)) return [];

  const all: Array<Record<string, unknown>> = [];
  for (const file of fs.readdirSync(testsDir).sort()) {
    if (!file.endsWith('.events.jsonl.tmp')) continue;
    const content = fs.readFileSync(path.join(testsDir, file), 'utf8');
    for (const line of content.trim().split('\n').filter(Boolean)) {
      try { all.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip */ }
    }
  }
  return all;
}

/**
 * Read events from each per-test JSONL file separately.
 * Returns an array of event-arrays (one per test trace file).
 */
function readTestTraceFiles(): Array<Array<Record<string, unknown>>> {
  const testsDir = path.join(tmpDir, 'tests');
  if (!fs.existsSync(testsDir)) return [];

  const traces: Array<Array<Record<string, unknown>>> = [];
  for (const file of fs.readdirSync(testsDir).sort()) {
    if (!file.endsWith('.events.jsonl.tmp')) continue;
    const content = fs.readFileSync(path.join(testsDir, file), 'utf8');
    const events = content.trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    traces.push(events);
  }
  return traces;
}

function readCaptureLevelJson(): Record<string, unknown> | null {
  const p = path.join(tmpDir, 'capture-level.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown> : null;
}

function readVitestSummaryJson(): Record<string, number> | null {
  const p = path.join(tmpDir, 'vitest-summary.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, number> : null;
}

/** Minimal VitestFile stub. */
function makeFile(opts: {
  filepath: string;
  tasks?: Task[];
  durationMs?: number;
}): VitestFile {
  return {
    id:          opts.filepath,
    name:        path.basename(opts.filepath),
    type:        'suite',
    mode:        'run',
    filepath:    opts.filepath,
    tasks:       opts.tasks ?? [],
    result:      { state: 'pass', startTime: 1_700_000_000_000, duration: opts.durationMs ?? 50 },
    collectDuration: 10,
    setupDuration:   5,
  } as unknown as VitestFile;
}

/** Minimal test stub. */
function makeTest(name: string, status: 'pass' | 'fail' | 'skip' = 'pass'): Task {
  const errors = status === 'fail'
    ? [{ name: 'AssertionError', message: 'expected 1 to be 2', stack: 'Error: expected 1 to be 2\n  at test' }]
    : undefined;

  return {
    id:     `test-${name}`,
    name,
    type:   'test',
    mode:   status === 'skip' ? 'skip' : 'run',
    result: {
      state:     status,
      startTime: 1_700_000_000_100,
      duration:  5,
      errors,
    },
  } as unknown as Task;
}

/** Minimal suite stub. */
function makeSuite(name: string, children: Task[]): Task {
  return {
    id:    `suite-${name}`,
    name,
    type:  'suite',
    mode:  'run',
    tasks: children,
    result: { state: 'pass', startTime: 1_700_000_000_050, duration: 20 },
  } as unknown as Task;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TraceGraphReporter — disabled', () => {
  afterEach(clearEnv);

  it('does nothing when TRACEGRAPH_ENABLED is not set', () => {
    // No env vars set
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/project/tests/foo.test.ts' })]);
    expect(true).toBe(true);
  });

  it('does nothing when TRACEGRAPH_ENABLED=0', () => {
    process.env['TRACEGRAPH_ENABLED'] = '0';
    process.env['TRACEGRAPH_RUN_DIR']  = '/tmp/nowhere';
    process.env['TRACEGRAPH_TRACE_ID'] = 'x';
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([]);
    expect(true).toBe(true);
  });
});

describe('TraceGraphReporter — onInit', () => {
  beforeEach(setupEnv);
  afterEach(clearEnv);

  it('initialises without throwing when all env vars are present', () => {
    const r = new TraceGraphReporter();
    expect(() => r.onInit()).not.toThrow();
  });

  it('creates the tests/ subdirectory on init', () => {
    const r = new TraceGraphReporter();
    r.onInit();
    expect(fs.existsSync(path.join(tmpDir, 'tests'))).toBe(true);
  });

  it('does not create any JSONL files on init alone', () => {
    const r = new TraceGraphReporter();
    r.onInit();
    expect(readAllTestEvents()).toHaveLength(0);
  });
});

describe('TraceGraphReporter — per-test trace files', () => {
  beforeEach(setupEnv);
  afterEach(clearEnv);

  it('creates one trace file per test case', () => {
    const suite = makeSuite('Suite', [makeTest('t1'), makeTest('t2'), makeTest('t3')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/project/tests/foo.test.ts', tasks: [suite] })]);

    const traces = readTestTraceFiles();
    expect(traces).toHaveLength(3);
  });

  it('each trace file has exactly 3 events: test_file, test_suite, test_run', () => {
    const suite = makeSuite('My Suite', [makeTest('one test')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/project/tests/foo.test.ts', tasks: [suite] })]);

    const traces = readTestTraceFiles();
    expect(traces).toHaveLength(1);
    const types = traces[0]!.map((e) => e['type']);
    expect(types).toEqual(['test_file', 'test_suite', 'test_run']);
  });

  it('test with no suite produces 2 events: test_file and test_run', () => {
    const test = makeTest('top-level test');
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/project/tests/foo.test.ts', tasks: [test] })]);

    const traces = readTestTraceFiles();
    expect(traces).toHaveLength(1);
    const types = traces[0]!.map((e) => e['type']);
    expect(types).toEqual(['test_file', 'test_run']);
  });

  it('two tests in different suites produce two separate trace files', () => {
    const suite1 = makeSuite('Suite A', [makeTest('test in A')]);
    const suite2 = makeSuite('Suite B', [makeTest('test in B')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite1, suite2] })]);

    expect(readTestTraceFiles()).toHaveLength(2);
  });
});

describe('TraceGraphReporter — test_file events', () => {
  beforeEach(setupEnv);
  afterEach(clearEnv);

  it('each trace has exactly one test_file event', () => {
    const suite = makeSuite('S', [makeTest('t1'), makeTest('t2')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const traces = readTestTraceFiles();
    for (const trace of traces) {
      const fileEvents = trace.filter((e) => e['type'] === 'test_file');
      expect(fileEvents).toHaveLength(1);
    }
  });

  it('test_file event has parentEventId=null (it is the trace root)', () => {
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [makeTest('t1')] })]);

    const events  = readAllTestEvents();
    const fileEvt = events.find((e) => e['type'] === 'test_file')!;
    expect(fileEvt['parentEventId']).toBeNull();
  });

  it('test_file event has correct schema fields', () => {
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [makeTest('t1')], durationMs: 75 })]);

    const fileEvt = readAllTestEvents().find((e) => e['type'] === 'test_file')!;
    expect(fileEvt['schemaVersion']).toBe('tracegraph.event.v1');
    expect(fileEvt['language']).toBe('javascript');
    expect(fileEvt['framework']).toBe('vitest');
    expect(typeof fileEvt['eventId']).toBe('string');
    expect((fileEvt['eventId'] as string).length).toBeGreaterThan(0);
    expect(fileEvt['durationMs']).toBe(75);
  });

  it('all events in one trace share the same traceId', () => {
    const suite = makeSuite('Suite', [makeTest('t1')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const traces = readTestTraceFiles();
    for (const trace of traces) {
      const traceIds = new Set(trace.map((e) => e['traceId']));
      expect(traceIds.size).toBe(1);
    }
  });

  it('different test cases have different traceIds', () => {
    const suite = makeSuite('Suite', [makeTest('t1'), makeTest('t2')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const traces = readTestTraceFiles();
    const traceIdSets = traces.map((trace) => trace[0]!['traceId'] as string);
    const unique = new Set(traceIdSets);
    expect(unique.size).toBe(2);
  });

  it('test_file name is a forward-slash relative path', () => {
    const filepath = path.join(process.cwd(), 'tests', 'sub', 'foo.test.ts');
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath, tasks: [makeTest('t1')] })]);

    const fileEvt = readAllTestEvents().find((e) => e['type'] === 'test_file')!;
    expect((fileEvt['name'] as string).includes('\\')).toBe(false);
  });
});

describe('TraceGraphReporter — test_suite events', () => {
  beforeEach(setupEnv);
  afterEach(clearEnv);

  it('test_suite parentEventId points to the test_file event', () => {
    const suite = makeSuite('My Suite', [makeTest('t1')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const traces  = readTestTraceFiles();
    const trace   = traces[0]!;
    const fileEvt  = trace.find((e) => e['type'] === 'test_file')!;
    const suiteEvt = trace.find((e) => e['type'] === 'test_suite')!;

    expect(suiteEvt['parentEventId']).toBe(fileEvt['eventId']);
  });

  it('nested describes produce a suite chain: outer → inner', () => {
    const inner = makeSuite('Inner', [makeTest('deep test')]);
    const outer = makeSuite('Outer', [inner]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [outer] })]);

    const trace    = readTestTraceFiles()[0]!;
    const suites   = trace.filter((e) => e['type'] === 'test_suite');
    expect(suites).toHaveLength(2);

    const outerEvt = suites[0]!;
    const innerEvt = suites[1]!;
    expect(innerEvt['parentEventId']).toBe(outerEvt['eventId']);
  });

  it('each test case in a two-test suite gets its own independent suite event', () => {
    const suite = makeSuite('Shared Suite', [makeTest('t1'), makeTest('t2')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const traces = readTestTraceFiles();
    expect(traces).toHaveLength(2);

    // Each trace is self-contained with its own suite event
    for (const trace of traces) {
      expect(trace.filter((e) => e['type'] === 'test_suite')).toHaveLength(1);
    }

    // Suite event IDs are independent (different eventIds in different traces)
    const suiteIds = traces.map((t) => t.find((e) => e['type'] === 'test_suite')!['eventId']);
    expect(new Set(suiteIds).size).toBe(2);
  });
});

describe('TraceGraphReporter — test_run events', () => {
  beforeEach(setupEnv);
  afterEach(clearEnv);

  it('each trace has exactly one test_run event', () => {
    const suite = makeSuite('Suite', [makeTest('t1'), makeTest('t2'), makeTest('t3')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const traces = readTestTraceFiles();
    for (const trace of traces) {
      expect(trace.filter((e) => e['type'] === 'test_run')).toHaveLength(1);
    }
  });

  it('passing test has testStatus=pass in metadata, no error field', () => {
    const suite = makeSuite('Suite', [makeTest('passes', 'pass')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const testEvt = readAllTestEvents().find((e) => e['type'] === 'test_run')!;
    expect((testEvt['metadata'] as Record<string, unknown>)['testStatus']).toBe('pass');
    expect(testEvt['error']).toBeUndefined();
  });

  it('failing test has testStatus=fail and error field populated', () => {
    const suite = makeSuite('Suite', [makeTest('fails', 'fail')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const testEvt = readAllTestEvents().find((e) => e['type'] === 'test_run')!;
    expect((testEvt['metadata'] as Record<string, unknown>)['testStatus']).toBe('fail');
    expect(testEvt['error']).toBeDefined();
    const err = testEvt['error'] as Record<string, unknown>;
    expect(err['type']).toBe('AssertionError');
    expect(err['message']).toBe('expected 1 to be 2');
    expect(typeof err['stack']).toBe('string');
  });

  it('skipped test has testStatus=skip and no error field', () => {
    const suite = makeSuite('Suite', [makeTest('skipped', 'skip')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const testEvt = readAllTestEvents().find((e) => e['type'] === 'test_run')!;
    expect((testEvt['metadata'] as Record<string, unknown>)['testStatus']).toBe('skip');
    expect(testEvt['error']).toBeUndefined();
  });

  it('test_run parentEventId points to the enclosing suite', () => {
    const suite = makeSuite('Suite', [makeTest('t1')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const trace    = readTestTraceFiles()[0]!;
    const suiteEvt = trace.find((e) => e['type'] === 'test_suite')!;
    const testEvt  = trace.find((e) => e['type'] === 'test_run')!;
    expect(testEvt['parentEventId']).toBe(suiteEvt['eventId']);
  });

  it('top-level test (no suite) parentEventId points to the file event', () => {
    const test = makeTest('top-level test');
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [test] })]);

    const trace   = readTestTraceFiles()[0]!;
    const fileEvt = trace.find((e) => e['type'] === 'test_file')!;
    const testEvt = trace.find((e) => e['type'] === 'test_run')!;
    expect(testEvt['parentEventId']).toBe(fileEvt['eventId']);
  });

  it('test name matches the it() call name', () => {
    const suite = makeSuite('Suite', [makeTest('my specific test name')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const testEvt = readAllTestEvents().find((e) => e['type'] === 'test_run')!;
    expect(testEvt['name']).toBe('my specific test name');
  });
});

describe('TraceGraphReporter — event ordering within a trace', () => {
  beforeEach(setupEnv);
  afterEach(clearEnv);

  it('events are ordered: test_file before test_suite before test_run', () => {
    const suite = makeSuite('Suite', [makeTest('t1')]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const trace = readTestTraceFiles()[0]!;
    expect(trace.map((e) => e['type'])).toEqual(['test_file', 'test_suite', 'test_run']);
  });
});

describe('TraceGraphReporter — capture-level.json', () => {
  beforeEach(setupEnv);
  afterEach(clearEnv);

  it('writes capture-level.json with overall: 5', () => {
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [makeTest('t1')] })]);

    const cl = readCaptureLevelJson()!;
    expect(cl['overall']).toBe(5);
    expect(typeof cl['label']).toBe('string');
  });

  it('adapters map contains vitest key with level 5 and mode=reporter', () => {
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [makeTest('t1')] })]);

    const cl      = readCaptureLevelJson()!;
    const adapters = cl['adapters'] as Record<string, unknown>;
    const vEntry   = adapters['vitest'] as Record<string, unknown>;
    expect(vEntry['level']).toBe(5);
    expect(vEntry['mode']).toBe('reporter');
  });

  it('adds a recommendation when no tests are collected', () => {
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([]);

    const cl      = readCaptureLevelJson()!;
    const adapters = cl['adapters'] as Record<string, unknown>;
    const vEntry  = adapters['vitest'] as Record<string, unknown>;
    expect(typeof vEntry['recommendation']).toBe('string');
  });

  it('recommendation is absent when tests were collected', () => {
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [makeTest('t1')] })]);

    const cl      = readCaptureLevelJson()!;
    const adapters = cl['adapters'] as Record<string, unknown>;
    const vEntry  = adapters['vitest'] as Record<string, unknown>;
    expect(vEntry['recommendation']).toBeUndefined();
  });
});

describe('TraceGraphReporter — vitest-summary.json', () => {
  beforeEach(setupEnv);
  afterEach(clearEnv);

  it('writes correct pass/fail/skip/total counts', () => {
    const suite = makeSuite('Suite', [
      makeTest('t1', 'pass'),
      makeTest('t2', 'pass'),
      makeTest('t3', 'fail'),
      makeTest('t4', 'skip'),
    ]);
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([makeFile({ filepath: '/p/foo.test.ts', tasks: [suite] })]);

    const summary = readVitestSummaryJson()!;
    expect(summary['total']).toBe(4);
    expect(summary['pass']).toBe(2);
    expect(summary['fail']).toBe(1);
    expect(summary['skip']).toBe(1);
  });

  it('aggregates counts across multiple files', () => {
    const file1 = makeFile({
      filepath: '/p/a.test.ts',
      tasks: [makeSuite('A', [makeTest('t1', 'pass'), makeTest('t2', 'fail')])],
    });
    const file2 = makeFile({
      filepath: '/p/b.test.ts',
      tasks: [makeSuite('B', [makeTest('t3', 'pass'), makeTest('t4', 'skip')])],
    });
    const r = new TraceGraphReporter();
    r.onInit();
    r.onFinished([file1, file2]);

    const summary = readVitestSummaryJson()!;
    expect(summary['total']).toBe(4);
    expect(summary['pass']).toBe(2);
    expect(summary['fail']).toBe(1);
    expect(summary['skip']).toBe(1);
  });
});

describe('TraceGraphReporter — onTaskUpdate', () => {
  beforeEach(setupEnv);
  afterEach(clearEnv);

  it('onTaskUpdate is a no-op and does not throw', () => {
    const r = new TraceGraphReporter();
    r.onInit();
    expect(() => r.onTaskUpdate([])).not.toThrow();
  });
});
