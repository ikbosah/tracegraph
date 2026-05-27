/**
 * ChildEventWriter
 *
 * Writes TraceEvent objects from the instrumented child process by appending
 * JSON Lines to the `.events.jsonl.tmp` file created by the CLI host.
 *
 * Uses `fs.appendFileSync` (synchronous append) so:
 *  - No concurrent write races between CLI and child (CLI closes its stream
 *    before spawning the child).
 *  - Safe with Node.js's single-threaded async model (multiple Express
 *    request handlers won't truly interleave writes).
 *
 * This class is a singleton — only one writer exists per child process.
 */
import fs from 'fs';
import path from 'path';
import type { TraceEvent } from '@tracegraph/shared-types';
import { TRACEGRAPH_ENV } from './env';

export class ChildEventWriter {
  private static _instance: ChildEventWriter | null = null;

  readonly runDir:   string;
  readonly traceId:  string;
  readonly runId:    string;
  readonly sessionId: string;
  readonly rootEventId: string | null;
  private readonly jsonlPath: string;

  private constructor(
    runDir: string,
    traceId: string,
    runId: string,
    sessionId: string,
    rootEventId: string | null,
  ) {
    this.runDir       = runDir;
    this.traceId      = traceId;
    this.runId        = runId;
    this.sessionId    = sessionId;
    this.rootEventId  = rootEventId;
    this.jsonlPath    = path.join(runDir, `${traceId}.events.jsonl.tmp`);
  }

  /**
   * Returns the singleton writer if TRACEGRAPH_ENABLED=1 and all required
   * env vars are set. Returns null if instrumentation is disabled (no-op mode).
   */
  static get(): ChildEventWriter | null {
    if (!process.env[TRACEGRAPH_ENV.ENABLED]) return null;
    if (!process.env[TRACEGRAPH_ENV.RUN_DIR])  return null;
    if (!process.env[TRACEGRAPH_ENV.TRACE_ID]) return null;
    if (!process.env[TRACEGRAPH_ENV.RUN_ID])   return null;

    if (!ChildEventWriter._instance) {
      ChildEventWriter._instance = new ChildEventWriter(
        process.env[TRACEGRAPH_ENV.RUN_DIR]!,
        process.env[TRACEGRAPH_ENV.TRACE_ID]!,
        process.env[TRACEGRAPH_ENV.RUN_ID]!,
        process.env[TRACEGRAPH_ENV.SESSION_ID] ?? '',
        process.env[TRACEGRAPH_ENV.ROOT_EVENT_ID] ?? null,
      );
    }
    return ChildEventWriter._instance;
  }

  /** Reset singleton (for testing only). */
  static _resetForTest(): void {
    ChildEventWriter._instance = null;
  }

  write(event: TraceEvent): void {
    try {
      fs.appendFileSync(this.jsonlPath, JSON.stringify(event) + '\n', 'utf8');
    } catch {
      // Best-effort: never crash the user's process due to tracing errors
    }
  }
}
