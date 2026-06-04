/**
 * T1.2 — Express adapter
 *
 * A single middleware that captures the full request/response lifecycle
 * and populates an AsyncLocalStorage context for downstream traceFunction calls.
 *
 * Usage:
 *   import { traceExpress } from '@tracegraph/trace-js';
 *   app.use(traceExpress());  // must come BEFORE route definitions
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createEventId } from '@tracegraph/trace-core';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceEvent, CaptureLevel } from '@tracegraph/shared-types';
import { ChildEventWriter } from './child-writer';
import { traceStorage, writeEvent } from './context';
import { sanitize, sanitizeHeaders } from '@tracegraph/trace-sanitizer';
import type { SanitizerConfig } from '@tracegraph/trace-sanitizer';
import { RequestEventBuffer } from './request-buffer';
import { TRACEGRAPH_ENV } from './env';

export type TraceExpressOptions = {
  /** Sanitiser configuration applied to bodies and headers. */
  sanitizerConfig?: SanitizerConfig;
  /**
   * Server mode: each HTTP request produces its own `.trace.json` file without
   * requiring the server process to exit.
   *
   * Set automatically when `TRACEGRAPH_SERVER_MODE=1` is in the environment
   * (which `tracegraph run --server-mode` sets).  You can also set it explicitly
   * to force server mode even when not launched via `tracegraph run`.
   *
   * When `mode: 'server'`:
   *  - Each request gets a fresh traceId.
   *  - Events are written to a per-request tmp file.
   *  - The trace is finalised and a `trace.completed` event emitted when the
   *    response finishes.
   *
   * Default: `'process'` (original behaviour — one trace per process lifetime).
   */
  mode?: 'process' | 'server';
  /**
   * Capture level to record when server mode is active and no capture-level
   * file has been written by a test reporter.  Defaults to level 1 (framework
   * adapter, HTTP events only).
   */
  serverModeCaptureLevel?: Pick<CaptureLevel, 'overall' | 'label'>;
  /**
   * Sampling options for server mode (ignored in process mode).
   * These reduce the volume of traces collected from long-lived servers.
   */
  sampling?: {
    /** Fraction of requests to trace (0.0–1.0).  Default: 1.0 (all). */
    rate?: number;
    /** Only trace requests whose HTTP status code starts with one of these digits.
     *  E.g. [4, 5] traces 4xx and 5xx only. Default: all. */
    statusCodes?: number[];
    /** Trace only when this request header is present and set to '1'. */
    onDemandHeader?: string;
  };
};

/**
 * Returns an Express middleware that:
 *  1. Emits an `http_request` event on every incoming request.
 *  2. Establishes an `AsyncLocalStorage` context for the request lifecycle.
 *  3. Emits an `http_response` event when the response finishes.
 *  4. Emits an `error` event if `next(err)` is called.
 *
 * Register it with `app.use(traceExpress())` BEFORE your route handlers.
 *
 * In **process mode** (default): one trace for the entire process lifetime —
 * suitable for test runs wrapped by `tracegraph run --`.
 *
 * In **server mode** (`mode: 'server'` or `TRACEGRAPH_SERVER_MODE=1`): each
 * HTTP request produces its own `.trace.json` file without requiring the server
 * to exit.  Start the server with `tracegraph run --server-mode -- <cmd>`.
 */
export function traceExpress(options: TraceExpressOptions = {}): RequestHandler {
  const {
    sanitizerConfig = {},
    sampling        = {},
  } = options;

  // Determine effective mode: explicit option overrides env var
  const effectiveMode: 'process' | 'server' =
    options.mode ?? (process.env[TRACEGRAPH_ENV.SERVER_MODE] === '1' ? 'server' : 'process');

  const serverCapture: CaptureLevel = {
    overall:  options.serverModeCaptureLevel?.overall ?? 1,
    label:    options.serverModeCaptureLevel?.label   ?? 'Express middleware (server mode)',
    adapters: { express: { level: 1, mode: 'middleware', captured: ['http_request', 'http_response', 'error'], notCaptured: ['function_call'] } },
  };

  if (effectiveMode === 'server') {
    return buildServerModeMiddleware({ sanitizerConfig, sampling, serverCapture });
  }

  // ── Process mode (original behaviour) ────────────────────────────────────

  return function traceExpressMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const writer = ChildEventWriter.get();
    if (!writer) {
      // Instrumentation disabled — transparent pass-through
      next();
      return;
    }

    const requestEventId = createEventId();
    const startTime      = Date.now();

    // ── http_request event ────────────────────────────────────────────────────
    const requestEvent: TraceEvent = {
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId:       requestEventId,
      traceId:       writer.traceId,
      parentEventId: writer.rootEventId,
      type:          'http_request',
      language:      'javascript',
      framework:     'express',
      name:          `${req.method} ${req.path}`,
      displayName:   `${req.method} ${req.originalUrl}`,
      startTime,
      input: sanitize(
        {
          method:  req.method,
          path:    req.path,
          params:  req.params,
          query:   req.query,
          body:    req.body,
          headers: sanitizeHeaders(req.headers as Record<string, unknown>, sanitizerConfig),
        },
        sanitizerConfig,
      ) as TraceEvent['input'],
      metadata: {
        correlationId: req.headers['x-tracegraph-correlation-id'] as string | undefined,
        scenarioId:    req.headers['x-tracegraph-scenario-id']    as string | undefined,
        traceparent:   req.headers['traceparent']                  as string | undefined,
      },
    };

    writeEvent(requestEvent);

    let capturedError: Error | undefined;

    const wrappedNext: NextFunction = (err?: unknown) => {
      if (err !== undefined && err !== null) {
        capturedError = err instanceof Error ? err : new Error(String(err));
      }
      next(err);
    };

    res.on('finish', () => {
      const endTime    = Date.now();
      const statusCode = res.statusCode;

      if (capturedError || statusCode >= 500) {
        const e = capturedError;
        writeEvent({
          schemaVersion: SCHEMA_VERSIONS.event,
          eventId:       createEventId(),
          traceId:       writer.traceId,
          parentEventId: requestEventId,
          type:          'error',
          language:      'javascript',
          framework:     'express',
          name:          `${req.method} ${req.path} → error`,
          startTime,
          endTime,
          durationMs:    endTime - startTime,
          ...(e ? {
            error: { type: e.constructor?.name ?? 'Error', message: e.message, stack: e.stack },
          } : {
            error: { type: 'HttpError', message: `HTTP ${statusCode}` },
          }),
        });
      }

      writeEvent({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       createEventId(),
        traceId:       writer.traceId,
        parentEventId: requestEventId,
        type:          'http_response',
        language:      'javascript',
        framework:     'express',
        name:          `${req.method} ${req.path} → ${statusCode}`,
        displayName:   `HTTP ${statusCode}`,
        startTime,
        endTime,
        durationMs:    endTime - startTime,
        output: sanitize(
          {
            statusCode,
            headers: sanitizeHeaders(res.getHeaders() as Record<string, unknown>, sanitizerConfig),
          },
          sanitizerConfig,
        ) as TraceEvent['output'],
      });
    });

    const context = {
      traceId:         writer.traceId,
      runId:           writer.runId,
      callStack:       [requestEventId],
      requestEventId,
    };

    traceStorage.run(context, () => wrappedNext());
  };
}

// ─── Server-mode middleware (per-request tracing) ─────────────────────────────

type ServerModeMiddlewareOptions = {
  sanitizerConfig: SanitizerConfig;
  serverCapture:   CaptureLevel;
  sampling: {
    rate?:            number;
    statusCodes?:     number[];
    onDemandHeader?:  string;
  };
};

function buildServerModeMiddleware(opts: ServerModeMiddlewareOptions): RequestHandler {
  const { sanitizerConfig, serverCapture, sampling } = opts;

  return function traceExpressServerMode(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // ── Sampling: on-demand header gate (cheapest check first) ───────────────
    if (sampling.onDemandHeader) {
      if (req.headers[sampling.onDemandHeader.toLowerCase()] !== '1') {
        next();
        return;
      }
    }

    // ── Sampling: probabilistic rate ─────────────────────────────────────────
    const rate = sampling.rate ?? 1.0;
    if (rate < 1.0 && Math.random() > rate) {
      next();
      return;
    }

    // ── Create per-request buffer ─────────────────────────────────────────────
    const buf = RequestEventBuffer.fromEnv();
    if (!buf) {
      // Server mode env vars not set — fall through transparently
      next();
      return;
    }

    const requestEventId = createEventId();
    const startTime      = Date.now();

    // ── http_request event ────────────────────────────────────────────────────
    buf.write({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId:       requestEventId,
      traceId:       buf.traceId,
      parentEventId: null,
      type:          'http_request',
      language:      'javascript',
      framework:     'express',
      name:          `${req.method} ${req.path}`,
      displayName:   `${req.method} ${req.originalUrl}`,
      startTime,
      input: sanitize(
        {
          method:  req.method,
          path:    req.path,
          params:  req.params,
          query:   req.query,
          body:    req.body,
          headers: sanitizeHeaders(req.headers as Record<string, unknown>, sanitizerConfig),
        },
        sanitizerConfig,
      ) as TraceEvent['input'],
      metadata: {
        correlationId: req.headers['x-tracegraph-correlation-id'] as string | undefined,
        scenarioId:    req.headers['x-tracegraph-scenario-id']    as string | undefined,
        traceparent:   req.headers['traceparent']                  as string | undefined,
      },
    });

    let capturedError: Error | undefined;

    const wrappedNext: NextFunction = (err?: unknown) => {
      if (err !== undefined && err !== null) {
        capturedError = err instanceof Error ? err : new Error(String(err));
      }
      next(err);
    };

    // ── http_response + finalise on finish ────────────────────────────────────
    res.on('finish', () => {
      const endTime    = Date.now();
      const statusCode = res.statusCode;

      // ── Sampling: status-code filter (applied after the fact) ────────────
      // We collected the events already; just skip finalisation if filtered
      if (sampling.statusCodes && sampling.statusCodes.length > 0) {
        const firstDigit = Math.floor(statusCode / 100);
        if (!sampling.statusCodes.includes(firstDigit)) {
          return; // discard — no trace file written
        }
      }

      if (capturedError || statusCode >= 500) {
        const e = capturedError;
        buf.write({
          schemaVersion: SCHEMA_VERSIONS.event,
          eventId:       createEventId(),
          traceId:       buf.traceId,
          parentEventId: requestEventId,
          type:          'error',
          language:      'javascript',
          framework:     'express',
          name:          `${req.method} ${req.path} → error`,
          startTime,
          endTime,
          durationMs:    endTime - startTime,
          ...(e ? {
            error: { type: e.constructor?.name ?? 'Error', message: e.message, stack: e.stack },
          } : {
            error: { type: 'HttpError', message: `HTTP ${statusCode}` },
          }),
        });
      }

      buf.write({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       createEventId(),
        traceId:       buf.traceId,
        parentEventId: requestEventId,
        type:          'http_response',
        language:      'javascript',
        framework:     'express',
        name:          `${req.method} ${req.path} → ${statusCode}`,
        displayName:   `HTTP ${statusCode}`,
        startTime,
        endTime,
        durationMs:    endTime - startTime,
        output: sanitize(
          {
            statusCode,
            headers: sanitizeHeaders(res.getHeaders() as Record<string, unknown>, sanitizerConfig),
          },
          sanitizerConfig,
        ) as TraceEvent['output'],
      });

      const traceStatus: 'passed' | 'failed' = statusCode < 400 ? 'passed' : 'failed';

      // Flush async — best-effort, no await needed (res has already finished)
      void buf.flush({
        entrypoint:   { type: 'http_request', method: req.method, path: req.path },
        startedAt:    startTime,
        endedAt:      endTime,
        status:       traceStatus,
        captureLevel: serverCapture,
      });
    });

    // ── Run handler inside AsyncLocalStorage context ──────────────────────────
    // Use buf.traceId (the per-request ID) so downstream traceFunction calls
    // use the correct trace context for this request.
    const runId = process.env[TRACEGRAPH_ENV.RUN_ID] ?? '';
    const context = {
      traceId:         buf.traceId,
      runId,
      callStack:       [requestEventId],
      requestEventId,
    };

    traceStorage.run(context, () => wrappedNext());
  };
}
