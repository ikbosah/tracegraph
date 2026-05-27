/**
 * T2.2 — CompactBaseline builder unit tests.
 */
import { describe, it, expect } from 'vitest';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import { sessionToBaseline, deriveTestId } from '../src/baseline';

function makeSession(events: Partial<TraceEvent>[] = []): TraceSession {
  const base: TraceSession = {
    schemaVersion:  SCHEMA_VERSIONS.trace,
    traceId:        'trace_001',
    sessionId:      'sess_001',
    runId:          'run_001',
    workspaceRoot:  '/workspace',
    language:       'javascript',
    entrypoint:     { type: 'cli_command', command: 'node test.js' },
    startedAt:      1_000_000,
    endedAt:        1_001_000,
    status:         'passed',
    captureLevel:   { overall: 1, label: 'Framework-level', adapters: {} },
    events:         events.map((overrides, i) => ({
      schemaVersion:  'tracegraph.event.v1' as const,
      eventId:        `evt_${i}`,
      traceId:        'trace_001',
      parentEventId:  null,
      type:           'function_call' as const,
      language:       'javascript' as const,
      name:           `fn_${i}`,
      startTime:      1_000_000 + i * 100,
      ...overrides,
    })),
  };
  return base;
}

describe('sessionToBaseline()', () => {
  it('produces correct schemaVersion', () => {
    const session  = makeSession([]);
    const baseline = sessionToBaseline(session, { approvedBy: 'alice', reason: 'initial' });
    expect(baseline.schemaVersion).toBe(SCHEMA_VERSIONS.baseline);
  });

  it('sets approvedBy and reason from meta', () => {
    const session  = makeSession([{ name: 'fn_a' }]);
    const baseline = sessionToBaseline(session, { approvedBy: 'bob', reason: 'M2 test' });
    expect(baseline.approvedBy).toBe('bob');
    expect(baseline.reason).toBe('M2 test');
  });

  it('excludes trace_start and trace_end events', () => {
    const session = makeSession([
      { type: 'trace_start', name: 'trace_start' },
      { type: 'function_call', name: 'processPayment' },
      { type: 'trace_end', name: 'trace_end' },
    ]);
    const baseline = sessionToBaseline(session, { approvedBy: 'alice', reason: 'test' });
    expect(baseline.events.length).toBe(1);
    expect(baseline.events[0]!.signature.functionName).toBe('processPayment');
  });

  it('deduplicates identical signatures (counts occurrences)', () => {
    const session = makeSession([
      { name: 'processPayment' },
      { name: 'processPayment' }, // duplicate
      { name: 'validateInvoice' },
    ]);
    const baseline = sessionToBaseline(session, { approvedBy: 'alice', reason: 'test' });
    // 2 unique signatures
    expect(baseline.events.length).toBe(2);
    const pp = baseline.events.find((e) => e.signature.functionName === 'processPayment');
    expect(pp?.count).toBe(2);
  });

  it('marks auth_check events as critical', () => {
    const session = makeSession([
      { type: 'auth_check', name: 'AuthMiddleware.check' },
    ]);
    const baseline = sessionToBaseline(session, { approvedBy: 'alice', reason: 'test' });
    expect(baseline.events[0]!.critical).toBe(true);
  });

  it('two identical traces produce identical baselines (same events → same testId)', () => {
    const events = [
      { name: 'processPayment' },
      { name: 'validateInvoice' },
    ];
    const s1 = makeSession(events);
    const s2 = makeSession(events);

    const b1 = sessionToBaseline(s1, { approvedBy: 'x', reason: 'r' });
    const b2 = sessionToBaseline(s2, { approvedBy: 'x', reason: 'r' });

    expect(b1.testId).toBe(b2.testId);
    expect(b1.events.map((e) => e.signature.functionName).sort()).toEqual(
      b2.events.map((e) => e.signature.functionName).sort(),
    );
  });
});

describe('deriveTestId()', () => {
  it('same http entrypoint produces same testId', () => {
    const ep = { type: 'http_request' as const, method: 'POST', path: '/invoices' };
    expect(deriveTestId(ep)).toBe(deriveTestId(ep));
  });

  it('different routes produce different testIds', () => {
    const t1 = deriveTestId({ type: 'http_request', method: 'GET',  path: '/invoices' });
    const t2 = deriveTestId({ type: 'http_request', method: 'POST', path: '/invoices' });
    expect(t1).not.toBe(t2);
  });

  it('cli_command testId is stable', () => {
    const ep = { type: 'cli_command' as const, command: 'node test.js' };
    expect(deriveTestId(ep)).toBe(deriveTestId(ep));
    expect(deriveTestId(ep)).toHaveLength(12);
  });
});
