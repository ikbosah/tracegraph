/**
 * RequestEventBuffer — per-request in-memory event accumulator for server mode.
 *
 * In normal mode, the CLI is the parent process and finalises the trace after
 * the child exits.  In server mode (`tracegraph run --server-mode`) the child
 * process is a long-lived server that must never exit for tracing to work.
 *
 * Each inbound HTTP request gets its own RequestEventBuffer:
 *  1. Events are appended to `{runDir}/{requestTraceId}.events.jsonl.tmp`.
 *  2. When the response finishes, flush() reads the tmp file, assembles a
 *     TraceSession, does the atomic rename, and emits a trace.completed
 *     JSON envelope on stdout so VS Code / CI pick it up.
 *
 * Usage:
 *   const buf = RequestEventBuffer.fromEnv();   // returns null if not in server mode
 *   if (buf) {
 *     buf.write(event);
 *     await buf.flush({ entrypoint, startedAt, endedAt, status, captureLevel });
 *   }
 */
import fs   from 'fs';
import path from 'path';
import type { TraceEvent, CaptureLevel, TraceEntrypoint } from '@tracegraph/shared-types';
import { createTraceId, finaliseTrace } from '@tracegraph/trace-core';
import { TRACEGRAPH_ENV } from './env';

export class RequestEventBuffer {
  /** Unique trace ID for this single HTTP request. */
  readonly traceId: string;

  private readonly jsonlPath: string;
  private _written = false;

  constructor(
    private readonly runDir:        string,
    private readonly tracesDir:     string,
    private readonly workspaceRoot: string,
    private readonly sessionId:     string,
    private readonly runId:         string,
  ) {
    this.traceId   = createTraceId();
    this.jsonlPath = path.join(runDir, `${this.traceId}.events.jsonl.tmp`);
  }

  /**
   * Append a single event to this request's JSONL tmp file.
   * Best-effort — never throws or crashes the server process.
   */
  write(event: TraceEvent): void {
    try {
      fs.appendFileSync(this.jsonlPath, JSON.stringify(event) + '\n', 'utf8');
      this._written = true;
    } catch {
      // Best-effort: instrumentation must never affect the server
    }
  }

  /**
   * Finalise this request's trace:
   *  1. Calls finaliseTrace() → atomic rename to `.trace.json`
   *  2. Emits a `trace.completed` JSON envelope on stdout
   *
   * Should be called from `res.on('finish')`.
   * Returns the final trace path, or null if finalisation failed.
   */
  async flush(opts: {
    entrypoint:   TraceEntrypoint;
    startedAt:    number;
    endedAt:      number;
    status:       'passed' | 'failed';
    captureLevel: CaptureLevel;
  }): Promise<string | null> {
    if (!this._written) {
      // No events were collected — skip finalisation to avoid empty trace files
      return null;
    }

    try {
      const finalPath = await finaliseTrace({
        runDir:        this.runDir,
        traceId:       this.traceId,
        tracesDir:     this.tracesDir,
        workspaceRoot: this.workspaceRoot,
        sessionId:     this.sessionId,
        runId:         this.runId,
        language:      'javascript',
        framework:     'express',
        entrypoint:    opts.entrypoint,
        startedAt:     opts.startedAt,
        endedAt:       opts.endedAt,
        status:        opts.status,
        captureLevel:  opts.captureLevel,
      });

      // Emit trace.completed protocol envelope on stdout.
      // The VS Code FileWatcher also catches the new file via filesystem events,
      // but the stdout envelope is the authoritative notification for CI/scripts.
      const relFile = path.relative(this.workspaceRoot, finalPath).replace(/\\/g, '/');
      const envelope = {
        protocol:     'tracegraph.cli.v1',
        timestamp:    Date.now(),
        type:         'trace.completed',
        runId:        this.runId,
        traceId:      this.traceId,
        captureLevel: { overall: opts.captureLevel.overall, label: opts.captureLevel.label },
        payload:      { file: relFile, status: opts.status },
      };
      process.stdout.write(JSON.stringify(envelope) + '\n');

      return finalPath;
    } catch {
      // Best-effort — never crash the server
      return null;
    }
  }

  /**
   * Factory: creates a new RequestEventBuffer from the current TRACEGRAPH_* env vars.
   * Returns null if server mode is not active or required env vars are missing —
   * the caller (traceExpress middleware) should treat null as "instrumentation disabled".
   */
  static fromEnv(): RequestEventBuffer | null {
    const env = process.env;

    if (!env[TRACEGRAPH_ENV.ENABLED])     return null;
    if (!env[TRACEGRAPH_ENV.SERVER_MODE]) return null;

    const runDir        = env[TRACEGRAPH_ENV.RUN_DIR];
    const workspaceRoot = env[TRACEGRAPH_ENV.WORKSPACE_ROOT];
    const runId         = env[TRACEGRAPH_ENV.RUN_ID];
    const sessionId     = env[TRACEGRAPH_ENV.SESSION_ID] ?? '';

    if (!runDir || !workspaceRoot || !runId) return null;

    const tracesDir = path.join(workspaceRoot, '.tracegraph', 'traces');
    return new RequestEventBuffer(runDir, tracesDir, workspaceRoot, sessionId, runId);
  }
}
