/**
 * traceTest — Vitest test wrapper with TraceGraph behaviour assertions.
 *
 * Usage:
 *   import { traceTest } from '@tracegraph/vitest';
 *
 *   traceTest('InvoiceService creates an invoice', async (trace) => {
 *     const svc = new InvoiceService();
 *     await svc.create({ amount: 100 });
 *
 *     trace.expectBehavior({
 *       mustCall:     ['InvoiceService.create'],
 *       mustNotCall:  ['InvoiceService.delete'],
 *       maxDbQueries: 3,
 *     });
 *   });
 *
 * Events are collected from any traceFunction / traceMethod calls made inside
 * the test body. Works with or without `tracegraph run --` — no env vars needed
 * for assertions; events are ALSO written to the JSONL file when the CLI host
 * is active.
 *
 * Implementation note:
 *   traceTest() creates a TraceContext with an empty eventBuffer and runs the
 *   test body inside traceStorage.run(), causing writeEvent() in @tracegraph/trace-js
 *   to push every emitted event into that buffer. expectBehavior() then scans
 *   the buffer after the test body (and all its await chains) complete.
 */
import { test, expect } from 'vitest';
import { traceStorage } from '@tracegraph/trace-js';
import type { TraceEvent } from '@tracegraph/shared-types';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ExpectBehaviorOptions {
  /**
   * Function names that MUST appear as `function_call` events in the trace.
   * Fails if any name in this list has no matching event.
   * Use `traceFunction("InvoiceService.create", fn)` in the code under test
   * to produce function_call events.
   */
  mustCall?: string[];

  /**
   * Function names that MUST NOT appear as `function_call` events in the trace.
   * Fails if any name in this list IS found.
   */
  mustNotCall?: string[];

  /**
   * Maximum number of `db_query` events allowed. Fails if exceeded.
   */
  maxDbQueries?: number;
}

export interface TraceAssertions {
  /** All TraceGraph events collected during this test body. Immutable view. */
  readonly events: readonly TraceEvent[];

  /**
   * Assert behavioural constraints on the trace collected during this test.
   * Throws (fails the Vitest test) if any constraint is violated.
   */
  expectBehavior(opts: ExpectBehaviorOptions): void;
}

// ─── traceTest ────────────────────────────────────────────────────────────────

/**
 * Registers a Vitest test that collects TraceGraph events emitted by
 * traceFunction / traceMethod calls during the test body, then exposes
 * `trace.expectBehavior(...)` for behaviour-level assertions.
 */
export function traceTest(
  name: string,
  fn: (trace: TraceAssertions) => void | Promise<void>,
): void {
  test(name, async () => {
    const eventBuffer: TraceEvent[] = [];

    const ctx = {
      traceId:   `ttest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      runId:     `ttest-run-${Date.now()}`,
      callStack: [] as string[],
      eventBuffer,
    };

    const assertions = makeTraceAssertions(eventBuffer);

    // Run the test body inside an AsyncLocalStorage context so that
    // writeEvent() in @tracegraph/trace-js appends events to our buffer.
    await traceStorage.run(ctx, () => fn(assertions));
  });
}

// ─── Assertions builder (also exported for unit testing) ─────────────────────

/**
 * Build a `TraceAssertions` object from a pre-populated event buffer.
 * Exported so unit tests can exercise expectBehavior logic directly
 * without going through a full traceTest() invocation.
 */
export function makeTraceAssertions(buffer: TraceEvent[]): TraceAssertions {
  return {
    get events(): readonly TraceEvent[] {
      return buffer;
    },

    expectBehavior({ mustCall, mustNotCall, maxDbQueries }: ExpectBehaviorOptions): void {

      // ── mustCall ──────────────────────────────────────────────────────────
      if (mustCall) {
        for (const name of mustCall) {
          const found = buffer.some(
            (e) => e.type === 'function_call' && e.name === name,
          );
          expect(
            found,
            `[traceTest] Expected "${name}" to be traced but no function_call event found. ` +
            `Wrap the implementation with traceFunction("${name}", fn) or traceMethod(...).`,
          ).toBe(true);
        }
      }

      // ── mustNotCall ───────────────────────────────────────────────────────
      if (mustNotCall) {
        for (const name of mustNotCall) {
          const found = buffer.some(
            (e) => e.type === 'function_call' && e.name === name,
          );
          expect(
            found,
            `[traceTest] Expected "${name}" NOT to be traced but a function_call event was found. ` +
            `Remove the traceFunction wrapper or add it to an allow-list.`,
          ).toBe(false);
        }
      }

      // ── maxDbQueries ──────────────────────────────────────────────────────
      if (maxDbQueries !== undefined) {
        const count = buffer.filter((e) => e.type === 'db_query').length;
        expect(
          count,
          `[traceTest] Expected at most ${maxDbQueries} db_query events but found ${count}.`,
        ).toBeLessThanOrEqual(maxDbQueries);
      }
    },
  };
}
