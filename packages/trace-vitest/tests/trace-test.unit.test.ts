/**
 * Unit tests for traceTest() wrapper and expectBehavior() assertions.
 *
 * Tests:
 *   TT1: mustCall passes when the target function is wrapped with traceFunction
 *   TT2: mustCall fails when the target function is NOT wrapped
 *   TT3: mustNotCall fails when a forbidden function IS traced
 *   TT4: mustNotCall passes when the function is absent from the trace
 *   TT5: maxDbQueries passes when the db_query count is within the limit
 *   TT6: maxDbQueries fails when the db_query count exceeds the limit
 *   TT7: multiple mustCall names are all checked independently
 */
import { describe, test, expect } from 'vitest';
import type { TraceEvent } from '@tracegraph/shared-types';
import { traceFunction } from '@tracegraph/trace-js';
import { traceTest, makeTraceAssertions } from '../src/trace-test';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal function_call event stub. */
function functionCallEvent(name: string): Partial<TraceEvent> {
  return { type: 'function_call', name } as Partial<TraceEvent>;
}

/** Build a minimal db_query event stub. */
function dbQueryEvent(): Partial<TraceEvent> {
  return { type: 'db_query' } as Partial<TraceEvent>;
}

// ─── TT1 — mustCall passes when function is traced ────────────────────────────

// traceTest internally calls Vitest's `test()`, so these exercise
// the full integration path through traceStorage.
traceTest(
  'TT1: mustCall passes when traceFunction wraps the target function',
  (trace) => {
    const create = traceFunction('InvoiceService.create', () => ({ id: 42 }));
    create();

    trace.expectBehavior({ mustCall: ['InvoiceService.create'] });
  },
);

// ─── TT2 — mustCall fails when function is NOT traced ─────────────────────────

// We test the assertion logic directly via makeTraceAssertions() with an
// empty buffer, which is equivalent to calling an un-traced function.
test('TT2: mustCall fails when expected function_call event is absent', () => {
  const assertions = makeTraceAssertions([]);   // nothing in the trace

  expect(() => {
    assertions.expectBehavior({ mustCall: ['InvoiceService.create'] });
  }).toThrow(/InvoiceService\.create/);
});

// ─── TT3 — mustNotCall fails when forbidden function IS traced ────────────────

test('TT3: mustNotCall fails when a forbidden function_call event is present', () => {
  const assertions = makeTraceAssertions([
    functionCallEvent('dangerousMethod') as TraceEvent,
  ]);

  expect(() => {
    assertions.expectBehavior({ mustNotCall: ['dangerousMethod'] });
  }).toThrow(/dangerousMethod/);
});

// ─── TT4 — mustNotCall passes when function is absent ────────────────────────

test('TT4: mustNotCall passes when the forbidden function is not in the trace', () => {
  const assertions = makeTraceAssertions([
    functionCallEvent('safeMethod') as TraceEvent,
  ]);

  expect(() => {
    assertions.expectBehavior({ mustNotCall: ['dangerousMethod'] });
  }).not.toThrow();
});

// ─── TT5 — maxDbQueries passes when within limit ─────────────────────────────

test('TT5: maxDbQueries passes when db_query count is within the limit', () => {
  const assertions = makeTraceAssertions([
    dbQueryEvent() as TraceEvent,
    dbQueryEvent() as TraceEvent,
  ]);

  expect(() => {
    assertions.expectBehavior({ maxDbQueries: 3 });
  }).not.toThrow();
});

// ─── TT6 — maxDbQueries fails when limit is exceeded ─────────────────────────

test('TT6: maxDbQueries fails when db_query count exceeds the limit', () => {
  const assertions = makeTraceAssertions([
    dbQueryEvent() as TraceEvent,
    dbQueryEvent() as TraceEvent,
    dbQueryEvent() as TraceEvent,
  ]);

  expect(() => {
    assertions.expectBehavior({ maxDbQueries: 2 });
  }).toThrow(/3.*2|at most 2/i);
});

// ─── TT7 — multiple mustCall names are all checked ───────────────────────────

describe('TT7: multiple mustCall names', () => {
  test('passes only when ALL named functions appear in the trace', () => {
    const assertions = makeTraceAssertions([
      functionCallEvent('A') as TraceEvent,
      // 'B' is missing
    ]);

    expect(() => {
      assertions.expectBehavior({ mustCall: ['A', 'B'] });
    }).toThrow(/\bB\b/);
  });

  test('passes when ALL named functions appear in the trace', () => {
    const assertions = makeTraceAssertions([
      functionCallEvent('A') as TraceEvent,
      functionCallEvent('B') as TraceEvent,
    ]);

    expect(() => {
      assertions.expectBehavior({ mustCall: ['A', 'B'] });
    }).not.toThrow();
  });
});

// ─── events accessor ─────────────────────────────────────────────────────────

test('trace.events provides a read-only view of collected events', () => {
  const buf: TraceEvent[] = [functionCallEvent('X') as TraceEvent];
  const assertions = makeTraceAssertions(buf);

  expect(assertions.events).toHaveLength(1);
  expect(assertions.events[0]?.type).toBe('function_call');
  expect(assertions.events[0]?.name).toBe('X');
});
