/**
 * T2.1 — Semantic signature and identity hash unit tests.
 *
 * Key property: moving a file (changing file/line/column) must NOT change the hash.
 * Renaming a route path or class MUST change the hash.
 */
import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@tracegraph/shared-types';
import { eventToSignature, signatureToIdentityHash, classifyRole } from '../src/signature';

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    schemaVersion: 'tracegraph.event.v1',
    eventId:       'evt_001',
    traceId:       'trace_001',
    parentEventId: null,
    type:          'function_call',
    language:      'javascript',
    name:          'validateInvoice',
    functionName:  'validateInvoice',
    startTime:     1_000_000,
    ...overrides,
  };
}

describe('classifyRole()', () => {
  it('classifies auth_check as "authorization"', () => {
    expect(classifyRole(makeEvent({ type: 'auth_check' }))).toBe('authorization');
  });

  it('classifies authorization_check as "authorization"', () => {
    expect(classifyRole(makeEvent({ type: 'authorization_check' }))).toBe('authorization');
  });

  it('classifies db_query as "db"', () => {
    expect(classifyRole(makeEvent({ type: 'db_query' }))).toBe('db');
  });

  it('classifies external_http_call as "external_call"', () => {
    expect(classifyRole(makeEvent({ type: 'external_http_call' }))).toBe('external_call');
  });

  it('classifies validate* function names as "validation"', () => {
    const cases = ['validateInvoice', 'verifySignature', 'checkCouponExpiry',
                   'assertFunds', 'ensureAuthorized', 'guardResource', 'permissionCheck'];
    for (const name of cases) {
      expect(classifyRole(makeEvent({ name, functionName: name })), name).toBe('validation');
    }
  });

  it('classifies non-matching names as "business_logic"', () => {
    expect(classifyRole(makeEvent({ name: 'processPayment', functionName: 'processPayment' }))).toBe('business_logic');
  });
});

describe('eventToSignature()', () => {
  it('extracts function name, language, type', () => {
    const sig = eventToSignature(makeEvent({ name: 'processPayment', functionName: 'processPayment' }));
    expect(sig.functionName).toBe('processPayment');
    expect(sig.language).toBe('javascript');
    expect(sig.eventType).toBe('function_call');
  });

  it('sets role correctly from event type', () => {
    const sig = eventToSignature(makeEvent({ type: 'authorization_check', name: 'Gate.check' }));
    expect(sig.role).toBe('authorization');
  });

  it('does NOT include file or line in signature', () => {
    const sig = eventToSignature(makeEvent({
      file: 'services/invoice.ts',
      line: 42,
    }));
    expect((sig as Record<string, unknown>)['file']).toBeUndefined();
    expect((sig as Record<string, unknown>)['line']).toBeUndefined();
  });
});

describe('signatureToIdentityHash()', () => {
  it('produces a 16-char hex string', () => {
    const sig  = eventToSignature(makeEvent());
    const hash = signatureToIdentityHash(sig);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('moving a file does NOT change the hash', () => {
    const event = makeEvent({ name: 'processPayment', functionName: 'processPayment' });

    const hashBefore = signatureToIdentityHash(eventToSignature(event));

    // "Move" the file by changing file and line
    const moved = { ...event, file: 'src/payments/processor.ts', line: 99 };
    const hashAfter  = signatureToIdentityHash(eventToSignature(moved));

    expect(hashBefore).toBe(hashAfter);
  });

  it('renaming the function changes the hash', () => {
    const h1 = signatureToIdentityHash(eventToSignature(makeEvent({ name: 'foo', functionName: 'foo' })));
    const h2 = signatureToIdentityHash(eventToSignature(makeEvent({ name: 'bar', functionName: 'bar' })));
    expect(h1).not.toBe(h2);
  });

  it('changing the event type changes the hash', () => {
    const h1 = signatureToIdentityHash(eventToSignature(makeEvent({ type: 'function_call' })));
    const h2 = signatureToIdentityHash(eventToSignature(makeEvent({ type: 'method_call' })));
    expect(h1).not.toBe(h2);
  });

  it('changing className changes the hash', () => {
    const h1 = signatureToIdentityHash(eventToSignature(makeEvent({ className: 'InvoiceService' })));
    const h2 = signatureToIdentityHash(eventToSignature(makeEvent({ className: 'OrderService' })));
    expect(h1).not.toBe(h2);
  });

  it('is deterministic (same input → same hash)', () => {
    const sig  = eventToSignature(makeEvent());
    const h1   = signatureToIdentityHash(sig);
    const h2   = signatureToIdentityHash(sig);
    expect(h1).toBe(h2);
  });
});
