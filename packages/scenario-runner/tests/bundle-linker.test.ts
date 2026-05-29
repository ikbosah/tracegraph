/**
 * M6 T6.4 — bundle-linker unit tests
 *
 * Covers createBundle() and the cross-trace correlation link detection
 * (findCorrelationLinks) via `x-tracegraph-correlation-id`.
 */
import { describe, it, expect } from 'vitest';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';
import { createBundle } from '../src/bundle-linker';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 1;
function nextId(prefix = 'evt'): string {
  return `${prefix}_${String(_seq++).padStart(4, '0')}`;
}

function baseEvent(overrides: Partial<TraceEvent> & Pick<TraceEvent, 'type' | 'traceId'>): TraceEvent {
  return {
    schemaVersion: 'tracegraph.event.v1',
    eventId:   nextId(),
    traceId:   overrides.traceId,
    type:      overrides.type,
    language:  'javascript',
    name:      overrides.type,
    startTime: Date.now(),
    ...overrides,
  };
}

function makeSession(traceId: string, events: TraceEvent[]): TraceSession {
  return {
    schemaVersion: 'tracegraph.trace.v1',
    traceId,
    sessionId:     'sess_001',
    runId:         'run_001',
    workspaceRoot: '/workspace',
    language:      'typescript',
    entrypoint:    { type: 'http_request', method: 'GET', path: '/' },
    startedAt:     1_000_000,
    status:        'passed',
    captureLevel:  { overall: 1, label: 'framework', adapters: {} },
    events,
  };
}

// ─── createBundle() structure ──────────────────────────────────────────────────

describe('createBundle()', () => {
  it('returns a valid TraceBundle with correct schemaVersion', () => {
    const session = makeSession('trace_a', []);
    const bundle  = createBundle([session], 'scenario_1');

    expect(bundle.schemaVersion).toBe('tracegraph.bundle.v1');
    expect(bundle.scenarioId).toBe('scenario_1');
    expect(bundle.bundleId).toMatch(/^bundle_/);
    expect(typeof bundle.createdAt).toBe('number');
  });

  it('includes all provided traces in bundle.traces', () => {
    const s1 = makeSession('trace_a', []);
    const s2 = makeSession('trace_b', []);
    const bundle = createBundle([s1, s2], 'scenario_2');

    expect(bundle.traces).toHaveLength(2);
    expect(bundle.traces[0]!.traceId).toBe('trace_a');
    expect(bundle.traces[1]!.traceId).toBe('trace_b');
  });

  it('builds file paths using the traceDir prefix', () => {
    const s = makeSession('trace_xyz', []);
    const bundle = createBundle([s], 'scen', 'traces');

    expect(bundle.traces[0]!.file).toBe('traces/trace_xyz.trace.json');
  });

  it('uses custom traceDir when provided', () => {
    const s = makeSession('trace_abc', []);
    const bundle = createBundle([s], 'scen', 'custom/dir');

    expect(bundle.traces[0]!.file).toBe('custom/dir/trace_abc.trace.json');
  });

  it('returns empty links when there are no cross-trace calls', () => {
    const s = makeSession('trace_solo', []);
    const bundle = createBundle([s], 'solo_scenario');

    expect(bundle.links).toHaveLength(0);
  });
});

// ─── Correlation link detection ────────────────────────────────────────────────

describe('createBundle() — correlation links', () => {
  it('creates a causes link when external_http_call correlates with http_request', () => {
    const corrId = 'scenario_abc_step0';

    // Frontend trace: outbound call with correlationId in metadata
    const outboundEventId = nextId('evt');
    const frontendSession = makeSession('trace_frontend', [
      baseEvent({
        type:    'external_http_call',
        traceId: 'trace_frontend',
        eventId: outboundEventId,
        metadata: { correlationId: corrId },
      }),
    ]);

    // Backend trace: inbound request with x-tracegraph-correlation-id header
    const inboundEventId = nextId('evt');
    const backendSession = makeSession('trace_backend', [
      baseEvent({
        type:    'http_request',
        traceId: 'trace_backend',
        eventId: inboundEventId,
        input:   { headers: { 'x-tracegraph-correlation-id': corrId } },
      }),
    ]);

    const bundle = createBundle([frontendSession, backendSession], 'corr_scenario');

    expect(bundle.links).toHaveLength(1);
    const link = bundle.links[0]!;
    expect(link.type).toBe('causes');
    expect(link.correlationId).toBe(corrId);
    expect(link.source.traceId).toBe('trace_frontend');
    expect(link.source.eventId).toBe(outboundEventId);
    expect(link.target.traceId).toBe('trace_backend');
    expect(link.target.eventId).toBe(inboundEventId);
  });

  it('does not create a self-link when source and target are the same trace', () => {
    const corrId = 'self_corr_id';
    const evtId1 = nextId('evt');
    const evtId2 = nextId('evt');

    const session = makeSession('trace_self', [
      baseEvent({
        type:    'external_http_call',
        traceId: 'trace_self',
        eventId: evtId1,
        metadata: { correlationId: corrId },
      }),
      baseEvent({
        type:    'http_request',
        traceId: 'trace_self',
        eventId: evtId2,
        input:   { headers: { 'x-tracegraph-correlation-id': corrId } },
      }),
    ]);

    const bundle = createBundle([session], 'self_scenario');
    expect(bundle.links).toHaveLength(0);
  });

  it('deduplicates identical (source, target) pairs', () => {
    const corrId = 'dup_corr';
    const outId  = nextId('evt');
    const inId   = nextId('evt');

    const frontend = makeSession('trace_fe', [
      // Two identical outbound events with the same correlation ID
      baseEvent({ type: 'external_http_call', traceId: 'trace_fe', eventId: outId, metadata: { correlationId: corrId } }),
    ]);
    const backend = makeSession('trace_be', [
      baseEvent({ type: 'http_request', traceId: 'trace_be', eventId: inId, input: { headers: { 'x-tracegraph-correlation-id': corrId } } }),
    ]);

    const bundle = createBundle([frontend, backend], 'dup_scenario');
    // Only one unique (outId → inId) pair
    expect(bundle.links).toHaveLength(1);
  });

  it('supports metadata.x-tracegraph-correlation-id field on outbound event', () => {
    const corrId  = 'header_field_corr';
    const outId   = nextId('evt');
    const inId    = nextId('evt');

    const frontend = makeSession('trace_fe2', [
      baseEvent({
        type:    'external_http_call',
        traceId: 'trace_fe2',
        eventId: outId,
        metadata: { 'x-tracegraph-correlation-id': corrId },
      }),
    ]);
    const backend = makeSession('trace_be2', [
      baseEvent({
        type:    'http_request',
        traceId: 'trace_be2',
        eventId: inId,
        input:   { headers: { 'x-tracegraph-correlation-id': corrId } },
      }),
    ]);

    const bundle = createBundle([frontend, backend], 'header_field_scenario');
    expect(bundle.links).toHaveLength(1);
    expect(bundle.links[0]!.correlationId).toBe(corrId);
  });

  it('supports direct x-tracegraph-correlation-id field on http_request input', () => {
    const corrId = 'direct_corr';
    const outId  = nextId('evt');
    const inId   = nextId('evt');

    const frontend = makeSession('trace_fe3', [
      baseEvent({ type: 'external_http_call', traceId: 'trace_fe3', eventId: outId, metadata: { correlationId: corrId } }),
    ]);
    const backend = makeSession('trace_be3', [
      baseEvent({
        type:    'http_request',
        traceId: 'trace_be3',
        eventId: inId,
        input:   { 'x-tracegraph-correlation-id': corrId },  // direct field, no headers wrapper
      }),
    ]);

    const bundle = createBundle([frontend, backend], 'direct_scenario');
    expect(bundle.links).toHaveLength(1);
  });

  it('supports metadata.headers.x-tracegraph-correlation-id on outbound event', () => {
    const corrId = 'nested_header_corr';
    const outId  = nextId('evt');
    const inId   = nextId('evt');

    const frontend = makeSession('trace_fe4', [
      baseEvent({
        type:     'external_http_call',
        traceId:  'trace_fe4',
        eventId:  outId,
        metadata: { headers: { 'x-tracegraph-correlation-id': corrId } },
      }),
    ]);
    const backend = makeSession('trace_be4', [
      baseEvent({ type: 'http_request', traceId: 'trace_be4', eventId: inId, input: { headers: { 'x-tracegraph-correlation-id': corrId } } }),
    ]);

    const bundle = createBundle([frontend, backend], 'nested_header_scenario');
    expect(bundle.links).toHaveLength(1);
  });

  it('creates multiple links for different correlation IDs in one scenario', () => {
    const corrId1 = 'step0_corr';
    const corrId2 = 'step1_corr';

    const out1 = nextId('evt');
    const out2 = nextId('evt');
    const in1  = nextId('evt');
    const in2  = nextId('evt');

    const frontend = makeSession('trace_multi_fe', [
      baseEvent({ type: 'external_http_call', traceId: 'trace_multi_fe', eventId: out1, metadata: { correlationId: corrId1 } }),
      baseEvent({ type: 'external_http_call', traceId: 'trace_multi_fe', eventId: out2, metadata: { correlationId: corrId2 } }),
    ]);
    const backend1 = makeSession('trace_svc1', [
      baseEvent({ type: 'http_request', traceId: 'trace_svc1', eventId: in1, input: { headers: { 'x-tracegraph-correlation-id': corrId1 } } }),
    ]);
    const backend2 = makeSession('trace_svc2', [
      baseEvent({ type: 'http_request', traceId: 'trace_svc2', eventId: in2, input: { headers: { 'x-tracegraph-correlation-id': corrId2 } } }),
    ]);

    const bundle = createBundle([frontend, backend1, backend2], 'multi_link_scenario');
    expect(bundle.links).toHaveLength(2);

    const ids = bundle.links.map((l) => l.correlationId).sort();
    expect(ids).toEqual([corrId2, corrId1].sort());
  });

  it('ignores non-http_request and non-external_http_call events', () => {
    const corrId = 'ignored_corr';

    const session = makeSession('trace_misc', [
      baseEvent({ type: 'db_query',      traceId: 'trace_misc', metadata: { correlationId: corrId } }),
      baseEvent({ type: 'function_call', traceId: 'trace_misc', input: { headers: { 'x-tracegraph-correlation-id': corrId } } }),
    ]);

    const bundle = createBundle([session], 'misc_scenario');
    expect(bundle.links).toHaveLength(0);
  });

  it('returns empty links when no traces are provided', () => {
    const bundle = createBundle([], 'empty_scenario');
    expect(bundle.traces).toHaveLength(0);
    expect(bundle.links).toHaveLength(0);
  });
});
