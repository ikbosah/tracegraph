/**
 * M5 — analyseTraceFindings() unit tests
 *
 * Covers:
 *   M5.4  security.sensitive_data.in_response
 *   M5.6  reliability.n_plus_one_query
 *   M5.7  reliability.duplicate_side_effects
 *   M5.8  reliability.missing_transaction
 */
import { describe, it, expect } from 'vitest';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';
import { analyseTraceFindings, ANALYSE_RULES } from '../src/analyse';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 1;
function nextId(prefix = 'evt'): string {
  return `${prefix}_${String(_seq++).padStart(4, '0')}`;
}

function makeSession(events: TraceEvent[]): TraceSession {
  return {
    schemaVersion: 'tracegraph.trace.v1',
    traceId:       'trace_test_001',
    sessionId:     'session_001',
    runId:         'run_001',
    workspaceRoot: '/workspace',
    language:      'typescript',
    entrypoint:    { type: 'http_request', method: 'GET', path: '/test' },
    startedAt:     1000000,
    status:        'passed',
    captureLevel:  { overall: 1, label: 'framework', adapters: {} },
    events,
  };
}

function httpResponseEvent(output: Record<string, unknown>): TraceEvent {
  return {
    schemaVersion: 'tracegraph.event.v1',
    eventId:       nextId('evt'),
    traceId:       'trace_test_001',
    type:          'http_response',
    language:      'typescript',
    name:          'http_response',
    startTime:     1000010,
    output,
  };
}

function dbQueryEvent(resourceType: string, operation: string, id?: string): TraceEvent {
  return {
    schemaVersion: 'tracegraph.event.v1',
    eventId:       id ?? nextId('evt'),
    traceId:       'trace_test_001',
    type:          'db_query',
    language:      'typescript',
    name:          `${resourceType}.${operation}`,
    startTime:     1000005,
    resource:      { type: resourceType, key: 'default', operation },
  };
}

function transactionStartEvent(): TraceEvent {
  return {
    schemaVersion: 'tracegraph.event.v1',
    eventId:       nextId('evt'),
    traceId:       'trace_test_001',
    type:          'transaction_start',
    language:      'typescript',
    name:          'DB::transaction',
    startTime:     1000001,
  };
}

function queueEvent(name: string): TraceEvent {
  return {
    schemaVersion: 'tracegraph.event.v1',
    eventId:       nextId('evt'),
    traceId:       'trace_test_001',
    type:          'queue_event',
    language:      'typescript',
    name,
    startTime:     1000020,
  };
}

function externalHttpCallEvent(method: string, url: string): TraceEvent {
  return {
    schemaVersion: 'tracegraph.event.v1',
    eventId:       nextId('evt'),
    traceId:       'trace_test_001',
    type:          'external_http_call',
    language:      'typescript',
    name:          url,
    startTime:     1000030,
    metadata:      { method, url },
  };
}

// ─── M5.4: Sensitive data in response ─────────────────────────────────────────

describe('M5.4 — security.sensitive_data.in_response', () => {
  it('returns no findings for a safe response', () => {
    const session = makeSession([
      httpResponseEvent({ id: 1, email: 'user@example.com', name: 'Alice' }),
    ]);
    const findings = analyseTraceFindings(session);
    const rule = findings.filter((f) => f.ruleId === ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE);
    expect(rule).toHaveLength(0);
  });

  it('flags "password" in top-level response fields', () => {
    const session = makeSession([
      httpResponseEvent({ id: 1, email: 'user@example.com', password: 'hashed' }),
    ]);
    const findings = analyseTraceFindings(session);
    const rule = findings.filter((f) => f.ruleId === ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE);
    expect(rule).toHaveLength(1);
    expect(rule[0]!.severity).toBe('high');
    expect(rule[0]!.category).toBe('security_sensitive_data');
    expect(rule[0]!.title).toContain('"password"');
  });

  it('flags snake_case "api_key" after normalisation', () => {
    const session = makeSession([
      httpResponseEvent({ user_id: 1, api_key: 'sk-abc123' }),
    ]);
    const findings = analyseTraceFindings(session);
    const rule = findings.filter((f) => f.ruleId === ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE);
    expect(rule).toHaveLength(1);
    expect(rule[0]!.title).toContain('"api_key"');
  });

  it('flags camelCase "accessToken" after normalisation', () => {
    const session = makeSession([
      httpResponseEvent({ userId: 1, accessToken: 'tok_abc' }),
    ]);
    const findings = analyseTraceFindings(session);
    const rule = findings.filter((f) => f.ruleId === ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE);
    expect(rule[0]!.title).toContain('"accessToken"');
  });

  it('flags sensitive fields nested one level deep', () => {
    const session = makeSession([
      httpResponseEvent({ user: { id: 1, password: 'hashed' } }),
    ]);
    const findings = analyseTraceFindings(session);
    const rule = findings.filter((f) => f.ruleId === ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE);
    expect(rule).toHaveLength(1);
    expect(rule[0]!.title).toContain('"password"');
  });

  it('deduplicates findings with the same field in the same session', () => {
    // Two http_response events both exposing "token"
    const session = makeSession([
      httpResponseEvent({ token: 'tok_a' }),
      httpResponseEvent({ token: 'tok_b' }),
    ]);
    const findings = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE,
    );
    expect(findings).toHaveLength(1);
  });

  it('does not flag non-http_response events', () => {
    const session = makeSession([
      dbQueryEvent('users', 'select'),
    ]);
    const findings = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE,
    );
    expect(findings).toHaveLength(0);
  });
});

// ─── M5.6: N+1 query detection ────────────────────────────────────────────────

describe('M5.6 — reliability.n_plus_one_query', () => {
  it('returns no findings when the same query appears < 5 times', () => {
    const session = makeSession([
      dbQueryEvent('orders', 'select'),
      dbQueryEvent('orders', 'select'),
      dbQueryEvent('orders', 'select'),
      dbQueryEvent('orders', 'select'),
    ]);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.N_PLUS_ONE_QUERY,
    );
    expect(rule).toHaveLength(0);
  });

  it('flags the query when it appears ≥ 5 times', () => {
    const events = Array.from({ length: 7 }, () => dbQueryEvent('users', 'select'));
    const session = makeSession(events);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.N_PLUS_ONE_QUERY,
    );
    expect(rule).toHaveLength(1);
    expect(rule[0]!.severity).toBe('medium');
    expect(rule[0]!.category).toBe('performance');
    expect(rule[0]!.title).toContain('users.select');
    expect(rule[0]!.title).toContain('× 7');
  });

  it('only counts the same (table, operation) pair', () => {
    const events = [
      ...Array.from({ length: 6 }, () => dbQueryEvent('products', 'select')),
      ...Array.from({ length: 6 }, () => dbQueryEvent('products', 'insert')),
    ];
    const session = makeSession(events);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.N_PLUS_ONE_QUERY,
    );
    // Both select and insert for 'products' reach threshold
    expect(rule).toHaveLength(2);
  });

  it('includes event IDs in evidence (up to 10)', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      dbQueryEvent('invoices', 'select', `evt_q${i}`),
    );
    const session = makeSession(events);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.N_PLUS_ONE_QUERY,
    );
    expect(rule[0]!.evidence[0]!.eventIds).toHaveLength(10);
  });

  it('returns no findings for cli_command sessions (full test-suite run)', () => {
    // A test suite naturally repeats the same query across independent tests.
    // Flagging these as N+1 would be a systematic false positive.
    const events = Array.from({ length: 20 }, () => dbQueryEvent('users', 'select'));
    const session: TraceSession = {
      ...makeSession(events),
      entrypoint: { type: 'cli_command', command: 'npm test' },
    };
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.N_PLUS_ONE_QUERY,
    );
    expect(rule).toHaveLength(0);
  });
});

// ─── M5.7: Duplicate side effects ─────────────────────────────────────────────

describe('M5.7 — reliability.duplicate_side_effects', () => {
  it('returns no findings for a single queue dispatch', () => {
    const session = makeSession([queueEvent('SendWelcomeEmail')]);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS,
    );
    expect(rule).toHaveLength(0);
  });

  it('flags duplicate queue dispatches', () => {
    const session = makeSession([
      queueEvent('SendInvoiceEmail'),
      queueEvent('SendInvoiceEmail'),
    ]);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS,
    );
    expect(rule).toHaveLength(1);
    expect(rule[0]!.title).toContain('SendInvoiceEmail');
    expect(rule[0]!.title).toContain('× 2');
    expect(rule[0]!.category).toBe('data_integrity');
  });

  it('returns no findings for a single POST request', () => {
    const session = makeSession([externalHttpCallEvent('POST', 'https://api.stripe.com/charge')]);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS,
    );
    expect(rule).toHaveLength(0);
  });

  it('flags duplicate outbound POST requests', () => {
    const session = makeSession([
      externalHttpCallEvent('POST', 'https://api.stripe.com/charge'),
      externalHttpCallEvent('POST', 'https://api.stripe.com/charge'),
    ]);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS,
    );
    expect(rule).toHaveLength(1);
    expect(rule[0]!.title).toContain('POST');
  });

  it('does not flag duplicate GET requests (reads are idempotent)', () => {
    const session = makeSession([
      externalHttpCallEvent('GET', 'https://api.example.com/data'),
      externalHttpCallEvent('GET', 'https://api.example.com/data'),
    ]);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS,
    );
    expect(rule).toHaveLength(0);
  });

  it('returns no findings for cli_command sessions (full test-suite run)', () => {
    // A test suite that runs many tests against the same routes will produce
    // hundreds of POST calls to the same URL — none of them are duplicates
    // within a single request lifecycle.  Express test suite is the canonical
    // example: POST "/" × 228 across all mocha tests is not a bug.
    const events = Array.from({ length: 228 }, () =>
      externalHttpCallEvent('POST', '/'),
    );
    const session: TraceSession = {
      ...makeSession(events),
      entrypoint: { type: 'cli_command', command: 'npm test' },
    };
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS,
    );
    expect(rule).toHaveLength(0);
  });
});

// ─── M5.8: Missing transaction boundary ───────────────────────────────────────

describe('M5.8 — reliability.missing_transaction', () => {
  it('returns no findings when only one table is written', () => {
    const session = makeSession([
      dbQueryEvent('orders', 'insert'),
    ]);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.MISSING_TRANSACTION,
    );
    expect(rule).toHaveLength(0);
  });

  it('returns no findings when a transaction event is present', () => {
    const session = makeSession([
      transactionStartEvent(),
      dbQueryEvent('orders', 'insert'),
      dbQueryEvent('order_items', 'insert'),
    ]);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.MISSING_TRANSACTION,
    );
    expect(rule).toHaveLength(0);
  });

  it('flags multi-table writes with no transaction', () => {
    const session = makeSession([
      dbQueryEvent('orders', 'insert'),
      dbQueryEvent('invoices', 'insert'),
    ]);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.MISSING_TRANSACTION,
    );
    expect(rule).toHaveLength(1);
    expect(rule[0]!.severity).toBe('medium');
    expect(rule[0]!.category).toBe('data_integrity');
    expect(rule[0]!.title).toContain('invoices');
    expect(rule[0]!.title).toContain('orders');
  });

  it('does not flag multi-table reads (no writes)', () => {
    const session = makeSession([
      dbQueryEvent('orders',   'select'),
      dbQueryEvent('products', 'select'),
    ]);
    const rule = analyseTraceFindings(session).filter(
      (f) => f.ruleId === ANALYSE_RULES.MISSING_TRANSACTION,
    );
    expect(rule).toHaveLength(0);
  });

  it('fingerprint is stable for the same table set', () => {
    const mkSession = () => makeSession([
      dbQueryEvent('orders',   'insert'),
      dbQueryEvent('invoices', 'insert'),
    ]);
    const f1 = analyseTraceFindings(mkSession()).filter(
      (f) => f.ruleId === ANALYSE_RULES.MISSING_TRANSACTION,
    );
    const f2 = analyseTraceFindings(mkSession()).filter(
      (f) => f.ruleId === ANALYSE_RULES.MISSING_TRANSACTION,
    );
    expect(f1[0]!.fingerprint).toBe(f2[0]!.fingerprint);
  });
});

// ─── Integration: combined session ────────────────────────────────────────────

describe('analyseTraceFindings() — combined session', () => {
  it('returns an empty array for a simple clean session', () => {
    const session = makeSession([
      httpResponseEvent({ id: 1, status: 'ok' }),
      dbQueryEvent('users', 'select'),
    ]);
    expect(analyseTraceFindings(session)).toHaveLength(0);
  });

  it('returns findings from multiple rules in the same session', () => {
    const events = [
      httpResponseEvent({ id: 1, token: 'secret' }),
      ...Array.from({ length: 6 }, () => dbQueryEvent('products', 'select')),
      dbQueryEvent('orders', 'insert'),
      dbQueryEvent('invoices', 'insert'),
    ];
    const session = makeSession(events);
    const findings = analyseTraceFindings(session);

    const ruleIds = new Set(findings.map((f) => f.ruleId));
    expect(ruleIds.has(ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE)).toBe(true);
    expect(ruleIds.has(ANALYSE_RULES.N_PLUS_ONE_QUERY)).toBe(true);
    expect(ruleIds.has(ANALYSE_RULES.MISSING_TRANSACTION)).toBe(true);
  });
});
