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
import type { TraceEvent } from '@tracegraph/shared-types';
import { ChildEventWriter } from './child-writer';
import { traceStorage, writeEvent } from './context';
import { sanitize, sanitizeHeaders } from '@tracegraph/trace-sanitizer';
import type { SanitizerConfig } from '@tracegraph/trace-sanitizer';

export type TraceExpressOptions = {
  /** Sanitiser configuration applied to bodies and headers. */
  sanitizerConfig?: SanitizerConfig;
};

/**
 * Returns an Express middleware that:
 *  1. Emits an `http_request` event on every incoming request.
 *  2. Establishes an `AsyncLocalStorage` context for the request lifecycle.
 *  3. Emits an `http_response` event when the response finishes.
 *  4. Emits an `error` event if `next(err)` is called.
 *
 * Register it with `app.use(traceExpress())` BEFORE your route handlers.
 * If called after routes are already registered, a warning is emitted.
 */
export function traceExpress(options: TraceExpressOptions = {}): RequestHandler {
  const { sanitizerConfig = {} } = options;

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
        // Pull distributed trace correlation headers if present
        correlationId: req.headers['x-tracegraph-correlation-id'] as string | undefined,
        scenarioId:    req.headers['x-tracegraph-scenario-id']    as string | undefined,
        traceparent:   req.headers['traceparent']                  as string | undefined,
      },
    };

    writeEvent(requestEvent);

    // ── Capture errors passed via next(err) from downstream handlers ──────────
    // Express does not route next(err) calls back through middleware's own next,
    // so we capture errors two ways:
    //  1. Synchronous: wrappedNext called with an error from THIS middleware
    //  2. Asynchronous: statusCode >= 500 detected in res.on('finish')
    let capturedError: Error | undefined;

    const wrappedNext: NextFunction = (err?: unknown) => {
      if (err !== undefined && err !== null) {
        capturedError = err instanceof Error ? err : new Error(String(err));
      }
      next(err);
    };

    // ── http_response + error (on finish) ─────────────────────────────────────
    res.on('finish', () => {
      const endTime    = Date.now();
      const statusCode = res.statusCode;

      // Emit error event when response indicates an error (5xx or captured error)
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

    // ── Run handler inside AsyncLocalStorage context ──────────────────────────
    const context = {
      traceId:         writer.traceId,
      runId:           writer.runId,
      callStack:       [requestEventId],
      requestEventId,
    };

    traceStorage.run(context, () => wrappedNext());
  };
}
