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

  const session: TraceSession = {
    schemaVersion: SCHEMA_VERSIONS.trace,
    traceId: opts.traceId,
    sessionId: opts.sessionId,
    runId: opts.runId,
    ...(opts.scenarioId ? { scenarioId: opts.scenarioId } : {}),
    workspaceRoot: opts.workspaceRoot,
    language: opts.language,
    ...(opts.framework ? { framework: opts.framework } : {}),
    entrypoint: opts.entrypoint,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    status: opts.status,
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
