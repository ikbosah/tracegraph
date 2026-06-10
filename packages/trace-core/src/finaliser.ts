import fs from 'fs';
import path from 'path';
import type {
  TraceSession,
  TraceEvent,
  TraceEntrypoint,
  CaptureLevel,
  LanguageId,
  TraceSessionStatus,
} from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';

export type FinaliseTraceOptions = {
  runDir: string;
  traceId: string;
  tracesDir: string;
  workspaceRoot: string;
  sessionId: string;
  runId: string;
  scenarioId?: string;
  language: LanguageId;
  framework?: string;
  entrypoint: TraceEntrypoint;
  startedAt: number;
  endedAt: number;
  status: TraceSessionStatus;
  captureLevel: CaptureLevel;
  metadata?: Record<string, unknown>;
};

/**
 * Post-processes the JSONL event stream into a complete TraceSession JSON file.
 *
 * Protocol (atomic write):
 *  1. Read all events from `{runDir}/{traceId}.events.jsonl.tmp`
 *  2. Assemble TraceSession
 *  3. Write to `{tracesDir}/{traceId}.trace.json.tmp`
 *  4. Atomic rename → `{tracesDir}/{traceId}.trace.json`
 *
 * Only after the rename is complete does the CLI emit `trace.completed` on stdout.
 * VS Code reads the file only after receiving that event.
 *
 * @returns Absolute path to the finalised `.trace.json` file.
 */
export async function finaliseTrace(opts: FinaliseTraceOptions): Promise<string> {
  const jsonlTmpPath  = path.join(opts.runDir, `${opts.traceId}.events.jsonl.tmp`);
  const traceTmpPath  = path.join(opts.tracesDir, `${opts.traceId}.trace.json.tmp`);
  const traceFinalPath = path.join(opts.tracesDir, `${opts.traceId}.trace.json`);

  fs.mkdirSync(opts.tracesDir, { recursive: true });

  // Read all events from the JSONL stream
  const events = readJsonlEvents(jsonlTmpPath);

  // ── Per-test entrypoint override ────────────────────────────────────────────
  // PHPUnit (and Vitest) per-test trace files contain a `test_run` event whose
  // `name` field is the unique test identity (e.g. "SomeTest::testMethod").
  // Without this override, ALL per-test traces from a suite-level run share the
  // cli_command entrypoint ("php artisan test"), so they all produce the same
  // testId and `baseline create` collapses them into a single baseline file —
  // causing every Phase-C candidate to compare against one stale Phase-A snapshot
  // and producing hundreds of false-positive "Authorization check added / DB
  // operation count changed" findings.
  //
  // When a test_run event is present we override the entrypoint with the test's
  // own identity.  For the suite-level main trace (which has no test_run event
  // because TestFinishedSubscriber writes to {runDir}/tests/, not the main file)
  // opts.entrypoint is preserved unchanged.
  let effectiveEntrypoint = opts.entrypoint;
  let effectiveStatus     = opts.status;

  const testRunEvent = events.find((e) => e.type === 'test_run');
  if (testRunEvent) {
    const testFile = events.find((e) => e.type === 'test_file')?.file;
    effectiveEntrypoint = {
      type:     'test_case',
      testName: testRunEvent.name,
      ...(testFile ? { testFile } : {}),
    };

    // Override session.status from the per-test outcome stored in metadata.
    // metadata.testStatus ('pass' | 'fail' | 'skip') is the accurate per-test
    // result written by the test reporter.  opts.status is the overall CLI run
    // status, which becomes 'failed' whenever any test in the suite fails —
    // causing all per-test trace files to be written with status='failed' even
    // when the individual test passed.
    const rawStatus = testRunEvent.metadata?.['testStatus'] as string | undefined;
    if (rawStatus === 'pass')  effectiveStatus = 'passed';
    if (rawStatus === 'fail')  effectiveStatus = 'failed';
    // 'skip' → leave effectiveStatus as-is (opts.status, usually 'passed')
  }

  const session: TraceSession = {
    schemaVersion: SCHEMA_VERSIONS.trace,
    traceId: opts.traceId,
    sessionId: opts.sessionId,
    runId: opts.runId,
    ...(opts.scenarioId ? { scenarioId: opts.scenarioId } : {}),
    workspaceRoot: opts.workspaceRoot,
    language: opts.language,
    ...(opts.framework ? { framework: opts.framework } : {}),
    entrypoint: effectiveEntrypoint,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    status: effectiveStatus,
    captureLevel: opts.captureLevel,
    events,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };

  // Write to .tmp file first
  fs.writeFileSync(traceTmpPath, JSON.stringify(session, null, 2), 'utf8');

  // Atomic rename: this is the signal that the file is complete and safe to read
  fs.renameSync(traceTmpPath, traceFinalPath);

  // Clean up the intermediate JSONL stream — it has been incorporated into the trace file
  try { fs.unlinkSync(jsonlTmpPath); } catch { /* best-effort; run dir may be cleaned later */ }

  return traceFinalPath;
}

function readJsonlEvents(jsonlPath: string): TraceEvent[] {
  if (!fs.existsSync(jsonlPath)) return [];

  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const events: TraceEvent[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // Malformed line — skip but don't crash the finaliser
      process.stderr.write(`[tracegraph] Warning: skipping malformed event line in ${jsonlPath}\n`);
    }
  }

  return events;
}
