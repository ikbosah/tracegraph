import { describe, it, expect } from 'vitest';
import { traceSessionToGraph } from '../src/graph';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<TraceEvent> & { eventId: string; type: TraceEvent['type'] }): TraceEvent {
  return {
    schemaVersion: 'tracegraph.event.v1',
    traceId:   'trace_test',
    language:  'javascript',
    name:      overrides.type,
    startTime: Date.now(),
    ...overrides,
  };
}

function makeSession(events: TraceEvent[]): TraceSession {
  return {
    schemaVersion: 'tracegraph.trace.v1',
    traceId:      'trace_test',
    sessionId:    'sess_test',
    runId:        'run_test',
    workspaceRoot: '/workspace',
    language:     'javascript',
    entrypoint:   { type: 'cli_command', command: 'npm test' },
    startedAt:    Date.now(),
    status:       'passed',
    captureLevel: { overall: 1, label: 'Framework-level tracing', adapters: {} },
    events,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('traceSessionToGraph()', () => {
  it('produces a node per semantic event (strips trace_start/trace_end bookkeeping nodes)', () => {
    const session = makeSession([
      makeEvent({ eventId: 'evt_1', type: 'trace_start' }),
      makeEvent({ eventId: 'evt_2', type: 'http_request', parentEventId: 'evt_1' }),
      makeEvent({ eventId: 'evt_3', type: 'http_response', parentEventId: 'evt_2' }),
      makeEvent({ eventId: 'evt_4', type: 'trace_end', parentEventId: 'evt_1' }),
    ]);

    const { nodes, edges } = traceSessionToGraph(session);

    // trace_start and trace_end are stripped by stripBookkeepingNodes() —
    // they are internal lifecycle markers with no semantic value in the graph.
    expect(nodes).toHaveLength(2);  // http_request + http_response
    expect(edges).toHaveLength(1);  // http_request → http_response
  });

  it('assigns correct colours to node types', () => {
    const session = makeSession([
      makeEvent({ eventId: 'e1', type: 'http_request' }),
      makeEvent({ eventId: 'e2', type: 'db_query' }),
      makeEvent({ eventId: 'e3', type: 'authorization_check' }),
      makeEvent({ eventId: 'e4', type: 'external_http_call' }),
      makeEvent({ eventId: 'e5', type: 'error' }),
      makeEvent({ eventId: 'e6', type: 'queue_event' }),
    ]);

    const { nodes } = traceSessionToGraph(session);

    const byType = (t: string) => nodes.find((n) => n.type === t)!;
    expect(byType('http_request').color).toBe('#3b82f6');
    expect(byType('db_query').color).toBe('#f97316');
    expect(byType('authorization_check').color).toBe('#ef4444');
    expect(byType('external_http_call').color).toBe('#a855f7');
    expect(byType('error').color).toBe('#dc2626');
    expect(byType('queue_event').color).toBe('#14b8a6');
  });

  it('builds parent edges from parentEventId chain', () => {
    const session = makeSession([
      makeEvent({ eventId: 'root', type: 'http_request' }),
      makeEvent({ eventId: 'child1', type: 'function_call', parentEventId: 'root' }),
      makeEvent({ eventId: 'child2', type: 'return', parentEventId: 'child1' }),
    ]);

    const { edges } = traceSessionToGraph(session);

    expect(edges.find((e) => e.source === 'root'   && e.target === 'child1')).toBeDefined();
    expect(edges.find((e) => e.source === 'child1' && e.target === 'child2')).toBeDefined();
    expect(edges.every((e) => e.type === 'parent')).toBe(true);
  });

  it('marks asyncGroup sibling edges as parallel_branch', () => {
    const session = makeSession([
      makeEvent({ eventId: 'root', type: 'http_request' }),
      makeEvent({ eventId: 'branch_a', type: 'function_call', parentEventId: 'root', asyncGroupId: 'grp1' }),
      makeEvent({ eventId: 'branch_b', type: 'function_call', parentEventId: 'root', asyncGroupId: 'grp1' }),
    ]);

    const { edges } = traceSessionToGraph(session);

    // First branch → parent, second → parallel_branch
    const edgeA = edges.find((e) => e.target === 'branch_a');
    const edgeB = edges.find((e) => e.target === 'branch_b');
    expect(edgeA?.type).toBe('parent');
    expect(edgeB?.type).toBe('parallel_branch');
  });

  it('collapses vendor events into a single node', () => {
    const session = makeSession([
      makeEvent({ eventId: 'app',  type: 'function_call', file: '/app/src/service.ts' }),
      makeEvent({ eventId: 'v1',   type: 'function_call', file: '/app/node_modules/lodash/index.js',
                  parentEventId: 'app' }),
      makeEvent({ eventId: 'v2',   type: 'function_call', file: '/app/node_modules/lodash/chunk.js',
                  parentEventId: 'app' }),
    ]);

    const { nodes, edges } = traceSessionToGraph(session);

    // v1 and v2 should both collapse into a single vendor node for 'lodash'
    const vendorNodes = nodes.filter((n) => n.type === 'vendor');
    expect(vendorNodes).toHaveLength(1);
    expect(vendorNodes[0]!.label).toBe('lodash');

    // Both edges should point to the same vendor node
    const vendorEdges = edges.filter((e) => e.target === vendorNodes[0]!.id);
    // They collapse to the same target, so there's only one edge (deduped)
    expect(vendorEdges).toHaveLength(1);
  });

  it('strips xdebug marker events', () => {
    const session = makeSession([
      makeEvent({ eventId: 'e1', type: 'function_call', name: 'tracegraph_xdebug_marker' }),
      makeEvent({ eventId: 'e2', type: 'http_request',  name: 'GET /path' }),
    ]);

    const { nodes } = traceSessionToGraph(session);
    expect(nodes.every((n) => !n.label.includes('xdebug_marker'))).toBe(true);
    expect(nodes).toHaveLength(1);
  });

  it('handles an empty event list', () => {
    const session = makeSession([]);
    const { nodes, edges } = traceSessionToGraph(session);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('propagates captureLevel to the graph', () => {
    const session = makeSession([]);
    const { captureLevel } = traceSessionToGraph(session);
    expect(captureLevel.overall).toBe(1);
    expect(captureLevel.label).toBe('Framework-level tracing');
  });
});
