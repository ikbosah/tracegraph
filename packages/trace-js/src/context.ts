/**
 * AsyncLocalStorage context for propagating trace IDs and the call stack
 * through async Node.js execution (request handling, async/await chains).
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { TraceEvent } from '@tracegraph/shared-types';
import { ChildEventWriter } from './child-writer';

export type TraceContext = {
  traceId:      string;
  runId:        string;
  /** LIFO stack of active event IDs — top is the current parent. */
  callStack:    string[];
  /** The event ID of the inbound http_request event for this request. */
  requestEventId?: string;
};

export const traceStorage = new AsyncLocalStorage<TraceContext>();

/** Returns the current TraceContext if inside a traced async scope. */
export function getContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * Returns the event ID to use as `parentEventId` for a new event.
 * Falls back to `rootEventId` (the CLI's trace_start event) when no
 * request context is active, or null if not instrumented.
 */
export function currentParentEventId(): string | null {
  const ctx = traceStorage.getStore();
  if (ctx && ctx.callStack.length > 0) {
    return ctx.callStack[ctx.callStack.length - 1] ?? null;
  }
  // Outside request context: use the trace_start event as root parent
  const writer = ChildEventWriter.get();
  return writer?.rootEventId ?? null;
}

/**
 * Writes a TraceEvent to the active ChildEventWriter.
 * No-op if instrumentation is disabled.
 */
export function writeEvent(event: TraceEvent): void {
  ChildEventWriter.get()?.write(event);
}
