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

  // In-process event buffer.  Events are batched and flushed to disk either
  // every FLUSH_INTERVAL_MS or on process exit, whichever comes first.
  // This avoids one synchronous appendFileSync per event, which would block
  // Node.js's event loop and significantly slow down test suites (e.g.
  // supertest-based Express tests) that issue many HTTP requests.
  private _buffer: string[]  = [];
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly FLUSH_INTERVAL_MS = 50;

  write(event: TraceEvent): void {
    this._buffer.push(JSON.stringify(event) + '\n');
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this._flushSync();
      }, ChildEventWriter.FLUSH_INTERVAL_MS);
      // Don't keep the process alive just for the flush timer.
      if (this._flushTimer.unref) this._flushTimer.unref();
    }
  }

  /** Synchronous flush — safe to call from process.exit handlers. */
  _flushSync(): void {
    if (this._buffer.length === 0) return;
    const chunk = this._buffer.splice(0).join('');
    try {
      fs.appendFileSync(this.jsonlPath, chunk, 'utf8');
    } catch {
      // Best-effort: never crash the user's process due to tracing errors
    }
  }
}
