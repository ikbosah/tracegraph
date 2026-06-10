/**
 * G1 — normalizer + indexer unit tests
 *
 * Uses synthetic Graphify graph.json fixture data to validate:
 *   - Degree computation fallback
 *   - Centrality percentile ranking
 *   - God-node threshold application
 *   - Sensitive community detection
 *   - Class/method extraction in indexer
 *   - Index lookup maps
 */
import { describe, it, expect } from 'vitest';
import type { GraphifyGraph } from '../src/graphify-schema';
import { normalizeGraphify }   from '../src/normalizer';
import { buildIndex }          from '../src/indexer';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal Graphify graph.json fixture. */
const FIXTURE_GRAPH: GraphifyGraph = {
  version: '0.4.0',
  nodes: [
    // High-degree god node in payments community
    {
      id:             'n1',
      name:           'charge',
      qualified_name: 'App\\Services\\PaymentProcessor::charge',
      file:           'src/Services/PaymentProcessor.php',
      line:           42,
      type:           'method',
      docstring:      'Processes a payment transaction.',
      community_id:   1,
      community_label: 'payments_core',
      degree:         98,
      provenance:     'EXTRACTED',
    },
    // Medium-degree auth node
    {
      id:             'n2',
      name:           'handle',
      qualified_name: 'App\\Http\\Middleware\\AuthMiddleware::handle',
      file:           'src/Http/Middleware/AuthMiddleware.php',
      line:           15,
      type:           'method',
      community_id:   2,
      community_label: 'auth_core',
      degree:         75,
      provenance:     'EXTRACTED',
    },
    // Low-degree helper function
    {
      id:             'n3',
      name:           'formatCurrency',
      qualified_name: 'formatCurrency',
      file:           'src/helpers.php',
      line:           10,
      type:           'function',
      community_id:   3,
      community_label: 'utils',
      degree:         5,
      provenance:     'EXTRACTED',
    },
    // Method with dot-style qualified name (Python/Java style)
    {
      id:             'n4',
      name:           'create',
      qualified_name: 'OrderService.create',
      file:           'src/services/order.ts',
      line:           22,
      type:           'method',
      community_id:   4,
      community_label: 'orders',
      degree:         40,
      provenance:     'INFERRED',
    },
  ],
  edges: [
    { source: 'n1', target: 'n2', type: 'calls', provenance: 'EXTRACTED' },
    { source: 'n2', target: 'n3', type: 'uses',  provenance: 'INFERRED'  },
    { source: 'n4', target: 'n1', type: 'calls', provenance: 'EXTRACTED' },
  ],
  communities: [
    { id: 1, label: 'payments_core', size: 12, members: ['n1'] },
    { id: 2, label: 'auth_core',     size: 8,  members: ['n2'] },
    { id: 3, label: 'utils',         size: 20, members: ['n3'] },
    { id: 4, label: 'orders',        size: 15, members: ['n4'] },
  ],
};

const DEFAULT_CONFIG = {
  godNodeThresholdPercentile: 75,  // top 25% = god node
  sensitiveCommunities: ['auth', 'billing', 'payments', 'identity'],
};

// ─── normalizeGraphify ────────────────────────────────────────────────────────

describe('normalizeGraphify', () => {
  it('produces a graph with the correct schema version', () => {
    const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    expect(graph.schemaVersion).toBe('tracegraph.static-graph.v1');
  });

  it('normalizes all nodes', () => {
    const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    expect(graph.nodes).toHaveLength(4);
  });

  it('uses qualified_name as symbolName when available', () => {
    const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    const payment = graph.nodes.find((n) => n.nodeId === 'n1')!;
    expect(payment.symbolName).toBe('App\\Services\\PaymentProcessor::charge');
  });

  it('falls back to name when qualified_name is absent', () => {
    const graph = normalizeGraphify({ ...FIXTURE_GRAPH, nodes: [
      { id: 'x', name: 'myFunc', file: 'src/foo.ts', type: 'function', degree: 1 },
    ], edges: [], communities: [] }, DEFAULT_CONFIG);
    expect(graph.nodes[0]!.symbolName).toBe('myFunc');
  });

  it('normalizes forward slashes in file paths', () => {
    const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    const node = graph.nodes.find((n) => n.nodeId === 'n1')!;
    expect(node.file).not.toContain('\\');
    expect(node.file).toBe('src/Services/PaymentProcessor.php');
  });

  it('normalizes node type correctly', () => {
    const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    const fn    = graph.nodes.find((n) => n.nodeId === 'n3')!;
    expect(fn.type).toBe('function');
    const method = graph.nodes.find((n) => n.nodeId === 'n1')!;
    expect(method.type).toBe('method');
  });

  it('assigns centralityPercentile in range 0–100', () => {
    const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    for (const node of graph.nodes) {
      expect(node.centralityPercentile).toBeGreaterThanOrEqual(0);
      expect(node.centralityPercentile).toBeLessThanOrEqual(100);
    }
  });

  it('assigns highest centralityPercentile to highest-degree node', () => {
    const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    const n1    = graph.nodes.find((n) => n.nodeId === 'n1')!; // degree 98
    const n3    = graph.nodes.find((n) => n.nodeId === 'n3')!; // degree 5
    expect(n1.centralityPercentile).toBeGreaterThan(n3.centralityPercentile);
  });

  it('marks high-degree nodes as god nodes', () => {
    // threshold = 75 → nodes in top 25%
    const graph  = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    const n1     = graph.nodes.find((n) => n.nodeId === 'n1')!; // highest degree → god node
    const n3     = graph.nodes.find((n) => n.nodeId === 'n3')!; // lowest degree → not god node
    expect(n1.isGodNode).toBe(true);
    expect(n3.isGodNode).toBe(false);
  });

  it('uses 95 as default god-node threshold', () => {
    const graph  = normalizeGraphify(FIXTURE_GRAPH, {}); // no threshold specified
    // Only the node with the very highest percentile (n1, degree 98) should be a god node
    const godNodes = graph.nodes.filter((n) => n.isGodNode);
    expect(godNodes.length).toBeGreaterThanOrEqual(1);
    expect(godNodes.every((n) => n.centralityPercentile >= 95)).toBe(true);
  });

  it('normalizes all edges', () => {
    const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    expect(graph.edges).toHaveLength(3);
    const edge = graph.edges[0]!;
    expect(edge.sourceId).toBe('n1');
    expect(edge.targetId).toBe('n2');
    expect(edge.type).toBe('calls');
    expect(edge.provenance).toBe('EXTRACTED');
  });

  it('defaults edge type to "calls" when absent', () => {
    const graph = normalizeGraphify({
      ...FIXTURE_GRAPH,
      edges: [{ source: 'n1', target: 'n2' }],
    }, DEFAULT_CONFIG);
    expect(graph.edges[0]!.type).toBe('calls');
  });

  it('normalizes communities', () => {
    const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    expect(graph.communities).toHaveLength(4);
  });

  it('marks sensitive communities correctly', () => {
    const graph       = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    const payments    = graph.communities.find((c) => c.label === 'payments_core')!;
    const auth        = graph.communities.find((c) => c.label === 'auth_core')!;
    const utils       = graph.communities.find((c) => c.label === 'utils')!;
    expect(payments.isSensitive).toBe(true);
    expect(auth.isSensitive).toBe(true);
    expect(utils.isSensitive).toBe(false);
  });

  it('links community IDs to nodes', () => {
    const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
    const n1    = graph.nodes.find((n) => n.nodeId === 'n1')!;
    expect(n1.communityId).toBe('1');
    expect(n1.communityLabel).toBe('payments_core');
  });

  it('synthesises communities when graph.communities is empty', () => {
    const graphWithoutCommunities: GraphifyGraph = {
      ...FIXTURE_GRAPH,
      communities: [],
      nodes: FIXTURE_GRAPH.nodes.map((n) => ({ ...n })),
    };
    const result = normalizeGraphify(graphWithoutCommunities, DEFAULT_CONFIG);
    // Nodes have community_id set → communities should be synthesised
    expect(result.communities.length).toBeGreaterThan(0);
  });
});

// ─── buildIndex ───────────────────────────────────────────────────────────────

describe('buildIndex', () => {
  const graph = normalizeGraphify(FIXTURE_GRAPH, DEFAULT_CONFIG);
  const index = buildIndex(graph);

  it('indexes by fully qualified name', () => {
    const node = index.byFqn['App\\Services\\PaymentProcessor::charge'];
    expect(node).toBeDefined();
    expect(node!.nodeId).toBe('n1');
  });

  it('indexes PHP class::method by file + class + method', () => {
    // n1: file = "src/Services/PaymentProcessor.php", class = PaymentProcessor, method = charge
    const node = index.byFileClassMethod['src/Services/PaymentProcessor.php:PaymentProcessor.charge'];
    expect(node).toBeDefined();
    expect(node!.nodeId).toBe('n1');
  });

  it('indexes standalone functions by file + function name', () => {
    const node = index.byFileFunction['src/helpers.php:formatCurrency'];
    expect(node).toBeDefined();
    expect(node!.nodeId).toBe('n3');
  });

  it('indexes class::method by class + method without file', () => {
    const node = index.byClassMethod['PaymentProcessor.charge'];
    expect(node).toBeDefined();
    expect(node!.nodeId).toBe('n1');
  });

  it('indexes dot-style method names (OrderService.create)', () => {
    // n4: symbolName = "OrderService.create" — dot style
    const node = index.byFqn['OrderService.create'];
    expect(node).toBeDefined();
    expect(node!.nodeId).toBe('n4');
  });

  it('indexes by display name (multiple candidates)', () => {
    const candidates = index.byDisplayName['charge'];
    expect(candidates).toBeDefined();
    expect(candidates!.some((n) => n.nodeId === 'n1')).toBe(true);
  });

  it('includes god nodes in the godNodes list', () => {
    expect(index.godNodes.length).toBeGreaterThanOrEqual(1);
    expect(index.godNodes.every((n) => n.isGodNode)).toBe(true);
  });

  it('records correct counts', () => {
    expect(index.nodeCount).toBe(4);
    expect(index.edgeCount).toBe(3);
    expect(index.communityCount).toBe(4);
  });
});
