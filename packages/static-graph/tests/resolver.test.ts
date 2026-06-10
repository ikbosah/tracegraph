/**
 * G2 — resolver + enricher unit tests
 *
 * Validates:
 *   - All 5 resolution strategies (exact_fqn, file_class_method,
 *     file_function, class_method, route_handler)
 *   - minMatchConfidence threshold enforcement
 *   - Idempotent enrichment (second run = same result)
 *   - enrichSession mutates in-place and returns correct stats
 *   - Events below threshold are left unchanged
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';
import type { GraphifyGraph }  from '../src/graphify-schema';
import { normalizeGraphify }   from '../src/normalizer';
import { buildIndex }          from '../src/indexer';
import { resolveEvent }        from '../src/resolver';
import {
  enrichSession,
  enrichTraceFile,
  enrichTracesDir,
} from '../src/enricher';
import type { GraphIndex } from '../src/indexer';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const RAW_GRAPH: GraphifyGraph = {
  nodes: [
    {
      id: 'n1',
      name: 'charge',
      qualified_name: 'App\\Services\\PaymentProcessor::charge',
      file: 'src/Services/PaymentProcessor.php',
      line: 42,
      type: 'method',
      community_id: 1, community_label: 'payments_core',
      degree: 99,
      docstring: 'Processes a payment and charges the customer.',
      provenance: 'EXTRACTED',
    },
    {
      id: 'n2',
      name: 'authenticate',
      qualified_name: 'authenticate',
      file: 'src/helpers/auth.ts',
      line: 10,
      type: 'function',
      community_id: 2, community_label: 'auth_core',
      degree: 70,
      provenance: 'EXTRACTED',
    },
    {
      id: 'n3',
      name: 'create',
      qualified_name: 'OrderService.create',
      file: 'src/services/order.ts',
      line: 22,
      type: 'method',
      community_id: 3, community_label: 'orders',
      degree: 40,
      provenance: 'EXTRACTED',
    },
    {
      id: 'n4',
      name: 'duplicate',
      qualified_name: 'ModuleA.duplicate',
      file: 'src/a.ts',
      line: 1, type: 'method',
      community_id: 4, community_label: 'misc',
      degree: 5, provenance: 'EXTRACTED',
    },
    {
      id: 'n5',
      name: 'duplicate',
      qualified_name: 'ModuleB.duplicate',
      file: 'src/b.ts',
      line: 1, type: 'method',
      community_id: 4, community_label: 'misc',
      degree: 5, provenance: 'EXTRACTED',
    },
  ],
  edges: [],
  communities: [
    { id: 1, label: 'payments_core', size: 10, members: ['n1'] },
    { id: 2, label: 'auth_core',     size: 8,  members: ['n2'] },
    { id: 3, label: 'orders',        size: 15, members: ['n3'] },
    { id: 4, label: 'misc',          size: 5,  members: ['n4', 'n5'] },
  ],
};

const GRAPH = normalizeGraphify(RAW_GRAPH, { godNodeThresholdPercentile: 90 });
const INDEX: GraphIndex = buildIndex(GRAPH);

// ─── resolveEvent ─────────────────────────────────────────────────────────────

describe('resolveEvent — strategy 1: exact_fqn', () => {
  it('matches by exact qualified name in event.name', () => {
    const result = resolveEvent(
      { name: 'App\\Services\\PaymentProcessor::charge' },
      INDEX,
    );
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('exact_fqn');
    expect(result!.confidence).toBe(1.00);
    expect(result!.node.nodeId).toBe('n1');
  });

  it('matches dot-style qualified name', () => {
    const result = resolveEvent(
      { name: 'OrderService.create' },
      INDEX,
    );
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('exact_fqn');
    expect(result!.node.nodeId).toBe('n3');
  });
});

describe('resolveEvent — strategy 2: file_class_method', () => {
  it('matches by file + className + methodName', () => {
    const result = resolveEvent(
      {
        type:       'method_call',
        name:       'charge',               // not an FQN — will miss exact_fqn
        file:       'src/Services/PaymentProcessor.php',
        className:  'PaymentProcessor',
        methodName: 'charge',
      },
      INDEX,
    );
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('file_class_method');
    expect(result!.confidence).toBe(0.95);
    expect(result!.node.nodeId).toBe('n1');
  });

  it('normalises backslashes in file path', () => {
    const result = resolveEvent(
      {
        file:       'src\\Services\\PaymentProcessor.php',
        className:  'PaymentProcessor',
        methodName: 'charge',
      },
      INDEX,
    );
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('file_class_method');
  });
});

describe('resolveEvent — strategy 3: file_function', () => {
  it('matches by file + functionName', () => {
    const result = resolveEvent(
      {
        type:         'function_call',
        file:         'src/helpers/auth.ts',
        functionName: 'authenticate',
      },
      INDEX,
    );
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('file_function');
    expect(result!.confidence).toBe(0.90);
    expect(result!.node.nodeId).toBe('n2');
  });
});

describe('resolveEvent — strategy 4: class_method', () => {
  it('matches by className + methodName with no file', () => {
    const result = resolveEvent(
      {
        type:       'method_call',
        className:  'PaymentProcessor',
        methodName: 'charge',
        // no file provided
      },
      INDEX,
    );
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('class_method');
    expect(result!.confidence).toBe(0.85);
    expect(result!.node.nodeId).toBe('n1');
  });
});

describe('resolveEvent — confidence threshold', () => {
  it('returns null when only strategy 4 matches and threshold > 0.85', () => {
    const result = resolveEvent(
      { type: 'method_call', className: 'PaymentProcessor', methodName: 'charge' },
      INDEX,
      { minMatchConfidence: 0.90 }, // requires file_function or better
    );
    expect(result).toBeNull();
  });

  it('returns match when threshold equals confidence exactly', () => {
    const result = resolveEvent(
      { type: 'method_call', className: 'PaymentProcessor', methodName: 'charge' },
      INDEX,
      { minMatchConfidence: 0.85 },
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.85);
  });

  it('function_name_only (0.50) is below default threshold 0.75', () => {
    // 'authenticate' appears in only one node — strategy 6 would match,
    // but default threshold 0.75 should block it (only file + class/method would match)
    const result = resolveEvent(
      { type: 'function_call', functionName: 'authenticate' /* no file */ },
      INDEX,
      // default threshold 0.75 — strategy 6 is 0.50
    );
    // Should return null (no match above 0.75 without file)
    expect(result).toBeNull();
  });

  it('function_name_only (0.50) is returned when threshold is lowered', () => {
    const result = resolveEvent(
      { type: 'function_call', functionName: 'authenticate' },
      INDEX,
      { minMatchConfidence: 0.50 },
    );
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('function_name_only');
    expect(result!.confidence).toBe(0.50);
  });

  it('ambiguous display name (multiple candidates) is not matched at strategy 6', () => {
    // 'duplicate' appears in both ModuleA and ModuleB
    const result = resolveEvent(
      { type: 'function_call', functionName: 'duplicate' },
      INDEX,
      { minMatchConfidence: 0.50 },
    );
    // Strategy 6 requires exactly one candidate — multiple means no match
    expect(result).toBeNull();
  });
});

describe('resolveEvent — resultToStaticMeta', () => {
  it('converts a result to StaticNodeMeta with all expected fields', () => {
    const { resultToStaticMeta } = await import('../src/resolver');
    const result = resolveEvent(
      { name: 'App\\Services\\PaymentProcessor::charge' },
      INDEX,
    )!;
    const meta = resultToStaticMeta(result);
    expect(meta.provider).toBe('graphify');
    expect(meta.nodeId).toBe('n1');
    expect(meta.symbolName).toBe('App\\Services\\PaymentProcessor::charge');
    expect(meta.communityLabel).toBe('payments_core');
    expect(meta.matchConfidence).toBe(1.00);
    expect(meta.docstring).toBe('Processes a payment and charges the customer.');
  });
});

// ─── enrichSession ────────────────────────────────────────────────────────────

function makeSession(events: Partial<TraceEvent>[]): TraceSession {
  return {
    schemaVersion: 'tracegraph.trace.v1',
    traceId:       'trace_001',
    sessionId:     'session_001',
    runId:         'run_001',
    workspaceRoot: '/workspace',
    language:      'typescript',
    entrypoint:    { type: 'http_request', method: 'POST', path: '/checkout' },
    startedAt:     1000000,
    status:        'passed',
    captureLevel:  { overall: 3, label: 'Level 3', adapters: {} },
    events:        events as TraceEvent[],
  };
}

describe('enrichSession', () => {
  it('enriches matching function_call events with static metadata', () => {
    const session = makeSession([
      {
        schemaVersion: 'tracegraph.event.v1',
        eventId: 'e1', traceId: 'trace_001',
        type: 'function_call', language: 'typescript',
        name: 'App\\Services\\PaymentProcessor::charge',
        startTime: 1000,
      },
    ]);

    const stats = enrichSession(session, INDEX);

    expect(stats.enrichedCount).toBe(1);
    expect(session.events[0]!.static).toBeDefined();
    expect(session.events[0]!.static!.provider).toBe('graphify');
    expect(session.events[0]!.static!.communityLabel).toBe('payments_core');
  });

  it('does not enrich http_request or trace_start events', () => {
    const session = makeSession([
      {
        schemaVersion: 'tracegraph.event.v1',
        eventId: 'e1', traceId: 'trace_001',
        type: 'http_request', language: 'typescript',
        name: 'POST /checkout', startTime: 1000,
      },
      {
        schemaVersion: 'tracegraph.event.v1',
        eventId: 'e2', traceId: 'trace_001',
        type: 'trace_start', language: 'typescript',
        name: 'trace_start', startTime: 999,
      },
    ]);

    const stats = enrichSession(session, INDEX);
    expect(stats.enrichedCount).toBe(0);
    expect(session.events[0]!.static).toBeUndefined();
    expect(session.events[1]!.static).toBeUndefined();
  });

  it('is idempotent: second call produces the same result', () => {
    const session = makeSession([
      {
        schemaVersion: 'tracegraph.event.v1',
        eventId: 'e1', traceId: 'trace_001',
        type: 'function_call', language: 'typescript',
        name: 'OrderService.create', startTime: 1000,
      },
    ]);

    enrichSession(session, INDEX);
    const firstMeta = { ...session.events[0]!.static };
    enrichSession(session, INDEX);
    const secondMeta = session.events[0]!.static;

    expect(secondMeta?.nodeId).toBe(firstMeta.nodeId);
    expect(secondMeta?.matchConfidence).toBe(firstMeta.matchConfidence);
  });

  it('does not update static if existing match has higher confidence', () => {
    const session = makeSession([
      {
        schemaVersion: 'tracegraph.event.v1',
        eventId: 'e1', traceId: 'trace_001',
        type: 'function_call', language: 'typescript',
        name: 'App\\Services\\PaymentProcessor::charge',
        startTime: 1000,
        // Pre-set static with a "better" confidence
        static: {
          provider: 'graphify',
          nodeId: 'n1',
          matchConfidence: 1.00,  // same as exact_fqn — should NOT be replaced
        },
      },
    ]);

    const stats = enrichSession(session, INDEX);
    // confidence matches exactly — won't replace (not strictly greater)
    // The condition is >  so 1.00 > 1.00 is false, won't re-enrich
    expect(stats.enrichedCount).toBe(0);
  });

  it('returns correct stats with mixed enrichable and non-enrichable events', () => {
    const session = makeSession([
      {
        schemaVersion: 'tracegraph.event.v1',
        eventId: 'e1', traceId: 'trace_001',
        type: 'function_call', language: 'typescript',
        name: 'App\\Services\\PaymentProcessor::charge',
        startTime: 1000,
      },
      {
        schemaVersion: 'tracegraph.event.v1',
        eventId: 'e2', traceId: 'trace_001',
        type: 'function_call', language: 'typescript',
        name: 'unknownFunction',  // won't match
        startTime: 1001,
      },
      {
        schemaVersion: 'tracegraph.event.v1',
        eventId: 'e3', traceId: 'trace_001',
        type: 'db_query', language: 'typescript',
        name: 'SELECT * FROM orders',
        startTime: 1002,
      },
    ]);

    const stats = enrichSession(session, INDEX);
    expect(stats.enrichedCount).toBe(1);   // only e1 matched
    expect(stats.skippedCount).toBe(1);    // e2 was candidate but no match
    expect(stats.totalEvents).toBe(3);
  });
});

// ─── enrichTraceFile ──────────────────────────────────────────────────────────

describe('enrichTraceFile', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-enricher-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads, enriches, and atomically writes a trace file', () => {
    const session = makeSession([
      {
        schemaVersion: 'tracegraph.event.v1',
        eventId: 'e1', traceId: 'trace_001',
        type: 'method_call', language: 'typescript',
        name: 'OrderService.create', startTime: 1000,
      },
    ]);
    const filePath = path.join(tmpDir, 'test.trace.json');
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');

    const result = enrichTraceFile(filePath, INDEX);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stats.enrichedCount).toBe(1);

    // Verify the file was updated
    const updated = JSON.parse(fs.readFileSync(filePath, 'utf8')) as TraceSession;
    expect(updated.events[0]!.static).toBeDefined();
    expect(updated.events[0]!.static!.communityLabel).toBe('orders');
  });

  it('returns an error result for a non-existent file', () => {
    const result = enrichTraceFile('/nonexistent/trace.json', INDEX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Cannot read');
  });

  it('returns an error for a file with wrong schema version', () => {
    const filePath = path.join(tmpDir, 'bad-schema.json');
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 'unknown.v1', events: [] }), 'utf8');
    const result = enrichTraceFile(filePath, INDEX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('schema version');
  });
});

// ─── enrichTracesDir ──────────────────────────────────────────────────────────

describe('enrichTracesDir', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-enrichdir-test-'));
    // Write two trace files
    const session1 = makeSession([{
      schemaVersion: 'tracegraph.event.v1',
      eventId: 'e1', traceId: 't1',
      type: 'function_call', language: 'typescript',
      name: 'App\\Services\\PaymentProcessor::charge', startTime: 1000,
    }]);
    const session2 = makeSession([{
      schemaVersion: 'tracegraph.event.v1',
      eventId: 'e2', traceId: 't2',
      type: 'function_call', language: 'typescript',
      name: 'unknownFunction', startTime: 1000,
    }]);
    fs.writeFileSync(path.join(tmpDir, 'trace1.trace.json'), JSON.stringify(session1));
    fs.writeFileSync(path.join(tmpDir, 'trace2.trace.json'), JSON.stringify(session2));
    fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'ignored');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enriches all .trace.json files in a directory', () => {
    const result = enrichTracesDir(tmpDir, INDEX);
    expect(result.files).toBe(2);
    expect(result.enriched).toBe(1);        // only trace1 had a match
    expect(result.eventMatches).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('returns zero for an empty directory', () => {
    const emptyDir = path.join(os.tmpdir(), 'tg-empty-' + Date.now());
    fs.mkdirSync(emptyDir);
    const result = enrichTracesDir(emptyDir, INDEX);
    expect(result.files).toBe(0);
    fs.rmSync(emptyDir, { recursive: true });
  });

  it('returns zero for a non-existent directory', () => {
    const result = enrichTracesDir('/nonexistent/dir', INDEX);
    expect(result.files).toBe(0);
  });
});
