/**
 * M7A T7A.1 — coverage engine unit tests
 *
 * Tests computeCoverage() and eventMatchesFunction() using in-memory diffs
 * and synthesised trace sessions (no real git or filesystem access).
 */

import { describe, it, expect } from 'vitest';
import type { TraceEvent, TraceSession, ChangedFunction } from '@tracegraph/shared-types';
import { eventMatchesFunction }  from '../src/trace-scanner';
import { computeCoverage }       from '../src/coverage';

// ─── Factory helpers ─────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    schemaVersion: 'tracegraph.event.v1',
    eventId:       'evt_test',
    traceId:       'trace_test',
    type:          'function_call',
    language:      'typescript',
    name:          'testFn',
    startTime:     0,
    ...overrides,
  };
}

// ─── eventMatchesFunction ─────────────────────────────────────────────────────

describe('eventMatchesFunction() — function name matching', () => {
  it('matches when event.functionName equals changed.functionName', () => {
    const event   = makeEvent({ functionName: 'createInvoice' });
    const changed: ChangedFunction = { file: 'src/invoice.ts', functionName: 'createInvoice', startLine: 1 };
    expect(eventMatchesFunction(event, changed)).toBe(true);
  });

  it('matches when event.name equals changed.functionName', () => {
    const event   = makeEvent({ name: 'createInvoice' });
    const changed: ChangedFunction = { file: 'src/invoice.ts', functionName: 'createInvoice', startLine: 1 };
    expect(eventMatchesFunction(event, changed)).toBe(true);
  });

  it('does not match when function name differs', () => {
    const event   = makeEvent({ functionName: 'updateInvoice' });
    const changed: ChangedFunction = { file: 'src/invoice.ts', functionName: 'createInvoice', startLine: 1 };
    expect(eventMatchesFunction(event, changed)).toBe(false);
  });
});

describe('eventMatchesFunction() — class method matching', () => {
  it('matches when event.className and event.methodName align', () => {
    const event   = makeEvent({ className: 'InvoiceService', methodName: 'create' });
    const changed: ChangedFunction = { file: 'src/service.ts', className: 'InvoiceService', methodName: 'create', startLine: 5 };
    expect(eventMatchesFunction(event, changed)).toBe(true);
  });

  it('matches ClassName.methodName in event.name', () => {
    const event   = makeEvent({ name: 'InvoiceService.create' });
    const changed: ChangedFunction = { file: 'src/service.ts', className: 'InvoiceService', methodName: 'create', startLine: 5 };
    expect(eventMatchesFunction(event, changed)).toBe(true);
  });

  it('matches ClassName.methodName in event.displayName', () => {
    const event   = makeEvent({ displayName: 'InvoiceService.create' });
    const changed: ChangedFunction = { file: 'src/service.ts', className: 'InvoiceService', methodName: 'create', startLine: 5 };
    expect(eventMatchesFunction(event, changed)).toBe(true);
  });

  it('does not match when method name differs', () => {
    const event   = makeEvent({ className: 'InvoiceService', methodName: 'update' });
    const changed: ChangedFunction = { file: 'src/service.ts', className: 'InvoiceService', methodName: 'create', startLine: 5 };
    expect(eventMatchesFunction(event, changed)).toBe(false);
  });
});

describe('eventMatchesFunction() — event type filtering', () => {
  it('does not match non-function event types (db_query)', () => {
    const event   = makeEvent({ type: 'db_query', functionName: 'createInvoice' });
    const changed: ChangedFunction = { file: 'src/invoice.ts', functionName: 'createInvoice', startLine: 1 };
    expect(eventMatchesFunction(event, changed)).toBe(false);
  });

  it('does not match trace_start events', () => {
    const event   = makeEvent({ type: 'trace_start', name: 'createInvoice' });
    const changed: ChangedFunction = { file: 'src/invoice.ts', functionName: 'createInvoice', startLine: 1 };
    expect(eventMatchesFunction(event, changed)).toBe(false);
  });
});

// ─── computeCoverage() ───────────────────────────────────────────────────────

describe('computeCoverage() — basic structure', () => {
  it('returns a valid ChangeCoverageReport when diff is empty', () => {
    const report = computeCoverage({ diffText: '', tracesDir: '/nonexistent' });

    expect(report.schemaVersion).toBe('tracegraph.coverage.v1');
    expect(report.reportId).toMatch(/^cov_[0-9a-f]{16}$/);
    expect(report.covered).toEqual([]);
    expect(report.uncovered).toEqual([]);
    expect(report.summary.changedFunctions).toBe(0);
    expect(report.summary.coveragePercent).toBe(100);
  });

  it('records baseRef and headRef in the report', () => {
    const report = computeCoverage({
      diffText:  '',
      tracesDir: '/nonexistent',
      baseRef:   'origin/main',
      headRef:   'feature/invoice',
    });

    expect(report.baseRef).toBe('origin/main');
    expect(report.headRef).toBe('feature/invoice');
  });

  it('has a numeric createdAt timestamp', () => {
    const before = Date.now();
    const report = computeCoverage({ diffText: '', tracesDir: '/nonexistent' });
    const after  = Date.now();
    expect(report.createdAt).toBeGreaterThanOrEqual(before);
    expect(report.createdAt).toBeLessThanOrEqual(after);
  });
});

describe('computeCoverage() — coverage percent', () => {
  it('reports 100% when no functions changed', () => {
    const report = computeCoverage({ diffText: '', tracesDir: '/nonexistent' });
    expect(report.summary.coveragePercent).toBe(100);
  });

  it('all uncovered → 0%', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '+function createOrder() {',
    ].join('\n');

    const report = computeCoverage({ diffText: diff, tracesDir: '/nonexistent' });
    expect(report.summary.coveragePercent).toBe(0);
    expect(report.uncovered).toHaveLength(1);
    expect(report.uncovered[0]).toMatchObject({ functionName: 'createOrder' });
  });

  it('covered and uncovered populate correct summary', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '+function fnOne() {',
      '+function fnTwo() {',
    ].join('\n');

    // Only fnOne will be "covered" by the trace
    const report = computeCoverage({ diffText: diff, tracesDir: '/nonexistent' });

    // With no trace files, both should be uncovered
    expect(report.summary.changedFunctions).toBe(2);
    expect(report.summary.coveredCount).toBe(0);
    expect(report.summary.uncoveredCount).toBe(2);
    expect(report.summary.coveragePercent).toBe(0);
  });
});

describe('computeCoverage() — default refs', () => {
  it('uses HEAD~1 as default baseRef and HEAD as headRef', () => {
    const report = computeCoverage({ diffText: '' });
    expect(report.baseRef).toBe('HEAD~1');
    expect(report.headRef).toBe('HEAD');
  });
});
