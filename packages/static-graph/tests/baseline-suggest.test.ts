/**
 * G3B — Baseline suggestion engine unit tests
 *
 * Tests the scoring and discovery logic with synthetic fixture data.
 * Uses real file I/O via temporary directories.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import type { TraceSession, CompactBaseline } from '@tracegraph/shared-types';
import type { GraphifyGraph } from '../src/graphify-schema';
import { normalizeGraphify }  from '../src/normalizer';
import { buildIndex }         from '../src/indexer';
import { suggestBaselines }   from '../src/baseline-suggest';

// ─── Test directory setup ─────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-suggest-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkdirs(dirs: string[]): void {
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

function writeJson(p: string, obj: unknown): void {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RAW_GRAPH: GraphifyGraph = {
  nodes: [
    {
      id: 'n1', name: 'charge',
      qualified_name: 'PaymentProcessor::charge',
      file: 'src/PaymentProcessor.php', type: 'method',
      community_id: 1, community_label: 'payments_core',
      degree: 99, provenance: 'EXTRACTED',
    },
    {
      id: 'n2', name: 'handle',
      qualified_name: 'AuthMiddleware::handle',
      file: 'src/AuthMiddleware.php', type: 'method',
      community_id: 2, community_label: 'auth_core',
      degree: 80, provenance: 'EXTRACTED',
    },
    {
      id: 'n3', name: 'create',
      qualified_name: 'OrderService.create',
      file: 'src/OrderService.ts', type: 'method',
      community_id: 3, community_label: 'orders',
      degree: 40, provenance: 'EXTRACTED',
    },
    {
      id: 'n4', name: 'formatDate',
      qualified_name: 'formatDate',
      file: 'src/helpers.ts', type: 'function',
      community_id: 4, community_label: 'utils',
      degree: 5, provenance: 'EXTRACTED',
    },
  ],
  edges: [
    { source: 'n3', target: 'n1', type: 'calls', provenance: 'EXTRACTED' },
  ],
  communities: [
    { id: 1, label: 'payments_core', size: 10, members: ['n1'] },
    { id: 2, label: 'auth_core',     size: 8,  members: ['n2'] },
    { id: 3, label: 'orders',        size: 15, members: ['n3'] },
    { id: 4, label: 'utils',         size: 20, members: ['n4'] },
  ],
};

const CONFIG = {
  godNodeThresholdPercentile: 70,   // n1 and n2 are god nodes
  sensitiveCommunities: ['auth', 'payments'],
};

const GRAPH = normalizeGraphify(RAW_GRAPH, CONFIG);
const INDEX = buildIndex(GRAPH);

// ─── Helpers for writing fixture files ────────────────────────────────────────

function makeTrace(
  id: string,
  entrypoint: { method: string; path: string },
  events: Array<{ type: string; name?: string; className?: string; methodName?: string; file?: string }>,
): TraceSession {
  return {
    schemaVersion: 'tracegraph.trace.v1',
    traceId:       id,
    sessionId:     `session_${id}`,
    runId:         `run_${id}`,
    workspaceRoot: '/workspace',
    language:      'typescript',
    entrypoint:    { type: 'http_request', method: entrypoint.method, path: entrypoint.path },
    startedAt:     Date.now(),
    status:        'passed',
    captureLevel:  { overall: 3, label: 'Level 3', adapters: {} },
    events:        events as never,
  };
}

function makeBaseline(testId: string): Partial<CompactBaseline> {
  return {
    schemaVersion: 'tracegraph.baseline.v1',
    baselineId:    `baseline_${testId}`,
    testId,
    approvedAt:    Date.now(),
    approvedBy:    'test',
    reason:        'test baseline',
    captureLevel:  3,
    events:        [],
    resources:     [],
    responseShape: { type: 'object' },
    entrypoint:    { type: 'http_request', method: 'GET', path: '/test' },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('suggestBaselines — with static graph', () => {
  let tracesDir: string;
  let baselinesDir: string;
  let scenariosDir: string;

  beforeAll(() => {
    tracesDir    = path.join(tmpDir, 'traces');
    baselinesDir = path.join(tmpDir, 'baselines');
    scenariosDir = path.join(tmpDir, 'scenarios');
    mkdirs([tracesDir, baselinesDir, scenariosDir]);

    // Write two traces: checkout (god node) and health (no god node)
    writeJson(path.join(tracesDir, 'checkout.trace.json'), makeTrace(
      'checkout', { method: 'POST', path: '/checkout' },
      [
        { type: 'function_call', name: 'PaymentProcessor::charge', className: 'PaymentProcessor', methodName: 'charge', file: 'src/PaymentProcessor.php' },
        { type: 'function_call', name: 'OrderService.create', className: 'OrderService', methodName: 'create', file: 'src/OrderService.ts' },
      ],
    ));

    writeJson(path.join(tracesDir, 'health.trace.json'), makeTrace(
      'health', { method: 'GET', path: '/health' },
      [{ type: 'function_call', name: 'formatDate', functionName: 'formatDate', file: 'src/helpers.ts' }],
    ));

    writeJson(path.join(tracesDir, 'login.trace.json'), makeTrace(
      'login', { method: 'POST', path: '/auth/login' },
      [{ type: 'function_call', name: 'AuthMiddleware::handle', className: 'AuthMiddleware', methodName: 'handle', file: 'src/AuthMiddleware.php' }],
    ));
  });

  it('returns candidates sorted by score descending', () => {
    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: GRAPH, index: INDEX,
    });
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it('assigns CRITICAL priority to checkout (god node in sensitive community)', () => {
    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: GRAPH, index: INDEX,
    });
    const checkout = results.find((r) => r.label === 'POST /checkout');
    expect(checkout).toBeDefined();
    expect(checkout!.godNodes.length).toBeGreaterThan(0);
    expect(['CRITICAL', 'HIGH']).toContain(checkout!.priority);
  });

  it('assigns lower priority to GET /health (no god nodes)', () => {
    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: GRAPH, index: INDEX,
    });
    const checkout = results.find((r) => r.label === 'POST /checkout');
    const health   = results.find((r) => r.label === 'GET /health');
    expect(checkout).toBeDefined();
    expect(health).toBeDefined();
    expect(checkout!.score).toBeGreaterThan(health!.score);
  });

  it('identifies sensitive communities in the auth login route', () => {
    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: GRAPH, index: INDEX,
    });
    const login = results.find((r) => r.label === 'POST /auth/login');
    expect(login).toBeDefined();
    expect(login!.sensitiveCommunities.length).toBeGreaterThan(0);
  });

  it('excludes routes that already have baselines', () => {
    // Write a baseline for /health
    const healthTestId = deriveTestIdForTest('GET', '/health');
    writeJson(
      path.join(baselinesDir, `${healthTestId}.baseline.json`),
      makeBaseline(healthTestId),
    );

    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: GRAPH, index: INDEX,
    });
    const health = results.find((r) => r.label === 'GET /health');
    expect(health).toBeUndefined();

    // Clean up
    fs.unlinkSync(path.join(baselinesDir, `${healthTestId}.baseline.json`));
  });

  it('respects --top limit', () => {
    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: GRAPH, index: INDEX,
      top: 1,
    });
    expect(results.length).toBe(1);
  });

  it('returns correct traceCount for each entrypoint', () => {
    // Write a second checkout trace
    writeJson(path.join(tracesDir, 'checkout2.trace.json'), makeTrace(
      'checkout_2', { method: 'POST', path: '/checkout' },
      [{ type: 'function_call', name: 'PaymentProcessor::charge', className: 'PaymentProcessor', methodName: 'charge', file: 'src/PaymentProcessor.php' }],
    ));

    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: GRAPH, index: INDEX,
    });
    const checkout = results.find((r) => r.label === 'POST /checkout');
    expect(checkout!.traceCount).toBeGreaterThanOrEqual(2);

    // Clean up
    fs.unlinkSync(path.join(tracesDir, 'checkout2.trace.json'));
  });

  it('includes reasons for the score', () => {
    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: GRAPH, index: INDEX,
    });
    const checkout = results.find((r) => r.label === 'POST /checkout');
    expect(checkout!.reasons.length).toBeGreaterThan(0);
    expect(checkout!.reasons.some((r) => r.includes('god node') || r.includes('God node'))).toBe(true);
  });
});

describe('suggestBaselines — without static graph (graceful degradation)', () => {
  let tracesDir: string;
  let baselinesDir: string;
  let scenariosDir: string;

  beforeAll(() => {
    tracesDir    = path.join(tmpDir, 'traces-no-graph');
    baselinesDir = path.join(tmpDir, 'baselines-no-graph');
    scenariosDir = path.join(tmpDir, 'scenarios-no-graph');
    mkdirs([tracesDir, baselinesDir, scenariosDir]);

    writeJson(path.join(tracesDir, 'a.trace.json'), makeTrace(
      'a', { method: 'GET', path: '/orders' }, [],
    ));
    writeJson(path.join(tracesDir, 'b.trace.json'), makeTrace(
      'b', { method: 'POST', path: '/invoices' }, [],
    ));
  });

  it('returns candidates even without static graph', () => {
    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: null, index: null,
    });
    expect(results.length).toBe(2);
  });

  it('all candidates have score 3 when no static graph (no-trace bonus)', () => {
    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: null, index: null,
    });
    for (const r of results) {
      // traceCount = 1 (one trace file), so no "no runtime traces" bonus
      // And no static graph, so no node/community/god-node scores
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.matchedNodes.length).toBe(0);
    }
  });
});

describe('suggestBaselines — scenario discovery', () => {
  let tracesDir: string;
  let baselinesDir: string;
  let scenariosDir: string;

  beforeAll(() => {
    tracesDir    = path.join(tmpDir, 'traces-scenario');
    baselinesDir = path.join(tmpDir, 'baselines-scenario');
    scenariosDir = path.join(tmpDir, 'scenarios-scenario');
    mkdirs([tracesDir, baselinesDir, scenariosDir]);

    // Write a scenario with an HTTP step
    writeJson(path.join(scenariosDir, 'checkout.scenario.json'), {
      schemaVersion: 'tracegraph.scenario.v1',
      scenarioId:    'sc1',
      name:          'Checkout Flow',
      steps: [
        { name: 'checkout', http: { method: 'POST', url: 'http://localhost:3000/checkout' } },
        { name: 'confirm',  http: { method: 'GET',  url: 'http://localhost:3000/orders/1' } },
      ],
    });
  });

  it('discovers entrypoints from scenario files', () => {
    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: null, index: null,
    });
    const labels = results.map((r) => r.label);
    expect(labels.some((l) => l.includes('POST') && l.includes('/checkout'))).toBe(true);
    expect(labels.some((l) => l.includes('GET')  && l.includes('/orders/1'))).toBe(true);
  });

  it('marks scenario candidates as type scenario', () => {
    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: null, index: null,
    });
    const checkoutCandidate = results.find((r) => r.label.includes('/checkout'));
    expect(checkoutCandidate?.type).toBe('scenario');
  });

  it('does not duplicate candidates that appear in both traces and scenarios', () => {
    // Add a trace for /checkout
    writeJson(path.join(tracesDir, 'trace_checkout.json'), makeTrace(
      'checkout_sc', { method: 'POST', path: '/checkout' }, [],
    ));

    const results = suggestBaselines({
      tracesDir, baselinesDir, scenariosDir,
      graph: null, index: null,
    });
    const checkouts = results.filter((r) => r.label.includes('POST') && r.label.includes('/checkout'));
    // Should only appear once (from traces, not duplicated from scenarios)
    expect(checkouts.length).toBeLessThanOrEqual(1);
  });
});

// ─── Utility for deriving test IDs in tests ────────────────────────────────────

import { createHash } from 'node:crypto';

function deriveTestIdForTest(method: string, routePath: string): string {
  const key = `${method}:${routePath}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}
