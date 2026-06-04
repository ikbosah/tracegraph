/**
 * T2.4 — BehaviorDiff engine unit tests.
 */
import { describe, it, expect } from 'vitest';
import type { TraceSession, TraceEvent, CompactBaseline } from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import { sessionToBaseline } from '../src/baseline';
import { diffBaseline }      from '../src/diff';

function makeSession(events: Partial<TraceEvent>[]): TraceSession {
  return {
    schemaVersion: SCHEMA_VERSIONS.trace,
    traceId:       'trace_cand',
    sessionId:     'sess_cand',
    runId:         'run_cand',
    workspaceRoot: '/workspace',
    language:      'javascript',
    entrypoint:    { type: 'cli_command', command: 'node test.js' },
    startedAt:     1_000_000,
    status:        'passed',
    captureLevel:  { overall: 1, label: 'test', adapters: {} },
    events:        events.map((overrides, i) => ({
      schemaVersion:  'tracegraph.event.v1' as const,
      eventId:        `evt_${i}`,
      traceId:        'trace_cand',
      parentEventId:  null,
      type:           'function_call' as const,
      language:       'javascript' as const,
      name:           `fn_${i}`,
      startTime:      1_000_000 + i * 100,
      ...overrides,
    })),
  };
}

function makeBaseline(events: Partial<TraceEvent>[]): CompactBaseline {
  const baselineSession: TraceSession = {
    ...makeSession(events),
    traceId:   'trace_base',
    sessionId: 'sess_base',
    runId:     'run_base',
  };
  return sessionToBaseline(baselineSession, { approvedBy: 'alice', reason: 'test' });
}

describe('diffBaseline()', () => {
  it('returns empty diff for identical sessions', () => {
    const events = [
      { name: 'processPayment', functionName: 'processPayment' },
      { name: 'validateInvoice', functionName: 'validateInvoice' },
    ];
    const baseline  = makeBaseline(events);
    const candidate = makeSession(events);
    const diff      = diffBaseline(baseline, candidate);

    expect(diff.removedSignatures).toHaveLength(0);
    expect(diff.addedSignatures).toHaveLength(0);
    expect(diff.changedResources).toHaveLength(0);
  });

  it('detects a removed function', () => {
    const baseline  = makeBaseline([
      { name: 'processPayment',   functionName: 'processPayment' },
      { name: 'validateInvoice',  functionName: 'validateInvoice' },
    ]);
    const candidate = makeSession([
      { name: 'processPayment', functionName: 'processPayment' },
      // validateInvoice removed
    ]);
    const diff = diffBaseline(baseline, candidate);

    expect(diff.removedSignatures).toHaveLength(1);
    expect(diff.removedSignatures[0]!.signature.functionName).toBe('validateInvoice');
    expect(diff.addedSignatures).toHaveLength(0);
  });

  it('detects an added function', () => {
    const baseline  = makeBaseline([
      { name: 'processPayment', functionName: 'processPayment' },
    ]);
    const candidate = makeSession([
      { name: 'processPayment',  functionName: 'processPayment' },
      { name: 'sendEmailAlert',  functionName: 'sendEmailAlert' },  // new
    ]);
    const diff = diffBaseline(baseline, candidate);

    expect(diff.addedSignatures).toHaveLength(1);
    expect(diff.addedSignatures[0]!.signature.functionName).toBe('sendEmailAlert');
    expect(diff.removedSignatures).toHaveLength(0);
  });

  it('moving a file does NOT produce a removed+added pair', () => {
    // Baseline: processPayment in services/invoice.ts:42
    const baseline = makeBaseline([{
      name:         'processPayment',
      functionName: 'processPayment',
      file:         'services/invoice.ts',
      line:         42,
    }]);

    // Candidate: same function, moved to payments/processor.ts:99
    const candidate = makeSession([{
      name:         'processPayment',
      functionName: 'processPayment',
      file:         'payments/processor.ts',
      line:         99,
    }]);

    const diff = diffBaseline(baseline, candidate);
    expect(diff.removedSignatures).toHaveLength(0);
    expect(diff.addedSignatures).toHaveLength(0);
  });

  it('volatile IDs in outputs do NOT produce shape changes', () => {
    const makeWithOutput = (invoiceId: string): TraceSession => {
      const s = makeSession([]);
      return {
        ...s,
        events: [{
          schemaVersion: 'tracegraph.event.v1',
          eventId:       'evt_resp',
          traceId:       s.traceId,
          parentEventId: null,
          type:          'http_response',
          language:      'javascript',
          name:          'http_response',
          startTime:     1_000_000,
          output:        { statusCode: 201, body: { invoiceId, status: 'draft' } },
        }],
      };
    };

    const baseline  = makeBaseline([]);
    const baselineS = makeWithOutput('INV-001');
    const baseline2 = sessionToBaseline(baselineS, { approvedBy: 'alice', reason: 'test' });

    // Candidate has INV-523 — should normalise to <id> and NOT trigger shape change
    const candidate = makeWithOutput('INV-523');
    const diff      = diffBaseline(baseline2, candidate);

    // No response shape change (both normalise to same structure)
    expect(diff.responseShapeChange).toBeUndefined();
  });

  it('sets traceId and baselineId on the diff', () => {
    const baseline  = makeBaseline([{ name: 'fn', functionName: 'fn' }]);
    const candidate = makeSession([{ name: 'fn', functionName: 'fn' }]);
    const diff      = diffBaseline(baseline, candidate);

    expect(diff.traceId).toBe('trace_cand');
    expect(diff.baselineId).toBe(baseline.baselineId);
  });

  // ── IMP-5.1: Multiset sibling comparison ────────────────────────────────

  it('same 3 children in different order → 0 added, 0 removed (multiset)', () => {
    // Baseline: validateInput, processPayment, sendNotification
    const baseline = makeBaseline([
      { name: 'validateInput',    functionName: 'validateInput' },
      { name: 'processPayment',   functionName: 'processPayment' },
      { name: 'sendNotification', functionName: 'sendNotification' },
    ]);
    // Candidate: same three, different order
    const candidate = makeSession([
      { name: 'processPayment',   functionName: 'processPayment' },
      { name: 'sendNotification', functionName: 'sendNotification' },
      { name: 'validateInput',    functionName: 'validateInput' },
    ]);
    const diff = diffBaseline(baseline, candidate);

    // IMP-5.1: multiset comparison — reordering is not a diff
    expect(diff.removedSignatures).toHaveLength(0);
    expect(diff.addedSignatures).toHaveLength(0);
  });

  it('one call genuinely missing → 1 removed (unchanged from before)', () => {
    const baseline = makeBaseline([
      { name: 'validateInput',  functionName: 'validateInput' },
      { name: 'processPayment', functionName: 'processPayment' },
      { name: 'auditLog',       functionName: 'auditLog' },
    ]);
    const candidate = makeSession([
      { name: 'validateInput',  functionName: 'validateInput' },
      { name: 'processPayment', functionName: 'processPayment' },
      // auditLog removed
    ]);
    const diff = diffBaseline(baseline, candidate);

    expect(diff.removedSignatures).toHaveLength(1);
    expect(diff.removedSignatures[0]!.signature.functionName).toBe('auditLog');
    expect(diff.addedSignatures).toHaveLength(0);
  });

  it('signature count reduced (2→1) → detected as removed', () => {
    // Baseline: validateInput called twice (count=2 in baseline)
    const baseline = makeBaseline([
      { name: 'validateInput', functionName: 'validateInput' },
      { name: 'validateInput', functionName: 'validateInput' }, // second call
    ]);
    // Candidate: validateInput called only once
    const candidate = makeSession([
      { name: 'validateInput', functionName: 'validateInput' },
    ]);
    const diff = diffBaseline(baseline, candidate);

    // The count dropped from 2 to 1 → one SignatureChange for removal
    expect(diff.removedSignatures).toHaveLength(1);
    expect(diff.removedSignatures[0]!.signature.functionName).toBe('validateInput');
  });

  it('signature count increased (1→3) → detected as added', () => {
    const baseline = makeBaseline([
      { name: 'validateInput', functionName: 'validateInput' },
    ]);
    const candidate = makeSession([
      { name: 'validateInput', functionName: 'validateInput' },
      { name: 'validateInput', functionName: 'validateInput' }, // 2 extra calls
      { name: 'validateInput', functionName: 'validateInput' },
    ]);
    const diff = diffBaseline(baseline, candidate);

    // Count increased 1→3 → one added SignatureChange
    expect(diff.addedSignatures).toHaveLength(1);
    expect(diff.addedSignatures[0]!.signature.functionName).toBe('validateInput');
    expect(diff.removedSignatures).toHaveLength(0);
  });
});
