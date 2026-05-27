/**
 * T1.3 — traceFunction / traceMethod
 *
 * Manual wrapping for business-critical code paths. Works without any
 * transpilation — just wrap a function at call site.
 *
 * Usage:
 *   const result = traceFunction('validateInvoice', () => validate(invoice));
 *   // or
 *   const tracedValidate = traceFunction('validateInvoice', validate);
 */
import { createEventId } from '@tracegraph/trace-core';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceEvent } from '@tracegraph/shared-types';
import { ChildEventWriter } from './child-writer';
import { traceStorage, writeEvent, currentParentEventId } from './context';

// ─── traceFunction ────────────────────────────────────────────────────────────

/**
 * Wraps `fn` so that every invocation emits `function_call` + `return` (or `error`)
 * events into the current trace context.
 *
 * Supports both sync and async (Promise-returning) functions.
 * The `callStack` in the current `TraceContext` is maintained correctly so that
 * nested `traceFunction` calls produce the right `parentEventId` chain.
 */
export function traceFunction<TArgs extends unknown[], TReturn>(
  name:      string,
  fn:        (...args: TArgs) => TReturn,
  metadata?: Record<string, unknown>,
): (...args: TArgs) => TReturn {
  return function traced(this: unknown, ...args: TArgs): TReturn {
    const writer = ChildEventWriter.get();
    if (!writer) return fn.apply(this, args);

    const eventId      = createEventId();
    const parentId     = currentParentEventId();
    const startTime    = Date.now();

    // ── function_call event ───────────────────────────────────────────────────
    writeEvent({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId,
      traceId:       writer.traceId,
      parentEventId: parentId,
      type:          'function_call',
      language:      'javascript',
      name,
      functionName:  name,
      startTime,
      ...(metadata ? { metadata } : {}),
    });

    // ── helpers ───────────────────────────────────────────────────────────────
    const emitReturn = (endTime: number): void => {
      writeEvent({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:   createEventId(),
        traceId:   writer.traceId,
        parentEventId: eventId,
        type:      'return',
        language:  'javascript',
        name:      `${name} → return`,
        startTime,
        endTime,
        durationMs: endTime - startTime,
      });
    };

    const emitError = (err: unknown, endTime: number): void => {
      const e = err instanceof Error ? err : new Error(String(err));
      writeEvent({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:   createEventId(),
        traceId:   writer.traceId,
        parentEventId: eventId,
        type:      'error',
        language:  'javascript',
        name:      `${name} → error`,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        error: {
          type:    e.constructor?.name ?? 'Error',
          message: e.message,
          stack:   e.stack,
        },
      });
    };

    // ── Establish a new context with this call on the stack ───────────────────
    // Using traceStorage.run() ensures nested traceFunction calls correctly
    // parent to this call even when invoked outside any existing context.
    const ctx = traceStorage.getStore();
    const newCtx = {
      traceId:   writer.traceId,
      runId:     writer.runId,
      callStack: ctx ? [...ctx.callStack, eventId] : [eventId],
    };

    // ── invoke fn ─────────────────────────────────────────────────────────────
    let result!: TReturn;
    let threw = false;
    let thrownErr: unknown;

    traceStorage.run(newCtx, () => {
      try {
        result = fn.apply(this, args);
      } catch (err) {
        threw = true;
        thrownErr = err;
      }
    });

    if (threw) {
      emitError(thrownErr, Date.now());
      throw thrownErr;
    }

    // Handle async (Promise-returning) functions.
    // The Promise was created inside traceStorage.run(), so its async continuations
    // inherit the newCtx — nested traced async calls will parent correctly.
    if (result instanceof Promise) {
      return result.then(
        (val) => { emitReturn(Date.now()); return val; },
        (err: unknown) => { emitError(err, Date.now()); return Promise.reject(err) as never; },
      ) as TReturn;
    }

    emitReturn(Date.now());
    return result;
  };
}

// ─── traceMethod ─────────────────────────────────────────────────────────────

/**
 * Convenience wrapper for class methods. Records `className` and `methodName`
 * in the event for richer display in the viewer.
 */
export function traceMethod<TArgs extends unknown[], TReturn>(
  className:  string,
  methodName: string,
  fn:         (...args: TArgs) => TReturn,
  metadata?:  Record<string, unknown>,
): (...args: TArgs) => TReturn {
  const traced = traceFunction(
    `${className}.${methodName}`,
    fn,
    metadata,
  );

  return function tracedMethod(this: unknown, ...args: TArgs): TReturn {
    const writer = ChildEventWriter.get();
    if (!writer) return fn.apply(this, args);

    const eventId   = createEventId();
    const parentId  = currentParentEventId();
    const startTime = Date.now();

    writeEvent({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId,
      traceId:      writer.traceId,
      parentEventId: parentId,
      type:         'method_call',
      language:     'javascript',
      name:         `${className}.${methodName}`,
      className,
      functionName: methodName,
      startTime,
      ...(metadata ? { metadata } : {}),
    });

    const emitReturn = (endTime: number) => {
      writeEvent({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:   createEventId(),
        traceId:   writer.traceId,
        parentEventId: eventId,
        type:      'return',
        language:  'javascript',
        name:      `${className}.${methodName} → return`,
        startTime, endTime, durationMs: endTime - startTime,
      });
    };

    const emitError = (err: unknown, endTime: number) => {
      const e = err instanceof Error ? err : new Error(String(err));
      writeEvent({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:   createEventId(),
        traceId:   writer.traceId,
        parentEventId: eventId,
        type:      'error',
        language:  'javascript',
        name:      `${className}.${methodName} → error`,
        startTime, endTime, durationMs: endTime - startTime,
        error: { type: e.constructor?.name ?? 'Error', message: e.message, stack: e.stack },
      });
    };

    const ctx = traceStorage.getStore();
    const newCtx = {
      traceId:   writer.traceId,
      runId:     writer.runId,
      callStack: ctx ? [...ctx.callStack, eventId] : [eventId],
    };

    let result!: TReturn;
    let threw = false;
    let thrownErr: unknown;

    traceStorage.run(newCtx, () => {
      try {
        result = fn.apply(this, args);
      } catch (err) {
        threw = true;
        thrownErr = err;
      }
    });

    if (threw) {
      emitError(thrownErr, Date.now());
      throw thrownErr;
    }

    if (result instanceof Promise) {
      return result.then(
        (val) => { emitReturn(Date.now()); return val; },
        (err: unknown) => { emitError(err, Date.now()); return Promise.reject(err) as never; },
      ) as TReturn;
    }

    emitReturn(Date.now());
    return result;
  };
}
