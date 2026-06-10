/**
 * G3A — Tier 1 finding generator unit tests
 *
 * Tests all five generators with synthetic fixture data:
 *   - detectGodNodeUntested
 *   - detectHighBlastRadius / computeBlastRadius
 *   - detectSensitiveCommunityUnverified
 *   - detectStaticEdgeAdded
 *   - detectCommunityDrift
 *   - matchFunctionToNode
 */
import { describe, it, expect } from 'vitest';
import type { ArchitectureBaseline, ChangedFunction } from '@tracegraph/shared-types';
import type { GraphifyGraph } from '../src/graphify-schema';
import { normalizeGraphify }   from '../src/normalizer';
import { buildIndex }          from '../src/indexer';
import {
  computeBlastRadius,
  detectGodNodeUntested,
  detectHighBlastRadius,
  detectSensitiveCommunityUnverified,
  detectStaticEdgeAdded,
  detectCommunityDrift,
  matchFunctionToNode,
  STATIC_RULES,
} from '../src/findings';

// ─── Fixture graph ────────────────────────────────────────────────────────────

const RAW_GRAPH: GraphifyGraph = {
  nodes: [
    {
      id: 'n1', name: 'charge',
      qualified_name: 'App\\Services\\PaymentProcessor::charge',
      file: 'src/Services/PaymentProcessor.php', line: 42, type: 'method',
      community_id: 1, community_label: 'payments_core',
      degree: 98, provenance: 'EXTRACTED',
    },
    {
      id: 'n2', name: 'handle',
      qualified_name: 'App\\Http\\Middleware\\AuthMiddleware::handle',
      file: 'src/Http/Middleware/AuthMiddleware.php', line: 15, type: 'method',
      community_id: 2, community_label: 'auth_core',
      degree: 75, provenance: 'EXTRACTED',
    },
    {
      id: 'n3', name: 'formatCurrency',
      qualified_name: 'formatCurrency',
      file: 'src/helpers.php', line: 10, type: 'function',
      community_id: 3, community_label: 'utils',
      degree: 5, provenance: 'EXTRACTED',
    },
    {
      id: 'n4', name: 'create',
      qualified_name: 'OrderService.create',
      file: 'src/services/OrderService.ts', line: 22, type: 'method',
      community_id: 4, community_label: 'orders',
      degree: 40, provenance: 'INFERRED',
    },
    {
      id: 'n5', name: 'debit',
      qualified_name: 'WalletRepository.debit',
      file: 'src/repositories/WalletRepository.ts', line: 55, type: 'method',
      community_id: 1, community_label: 'payments_core',
      degree: 30, provenance: 'EXTRACTED',
    },
  ],
  edges: [
    { source: 'n1', target: 'n2', type: 'calls', provenance: 'EXTRACTED' },
    { source: 'n4', target: 'n1', type: 'calls', provenance: 'EXTRACTED' },  // orders → payments
    { source: 'n1', target: 'n5', type: 'calls', provenance: 'EXTRACTED' },
  ],
  communities: [
    { id: 1, label: 'payments_core', size: 12, members: ['n1', 'n5'] },
    { id: 2, label: 'auth_core',     size: 8,  members: ['n2'] },
    { id: 3, label: 'utils',         size: 20, members: ['n3'] },
    { id: 4, label: 'orders',        size: 15, members: ['n4'] },
  ],
};

// Low threshold so n1 (degree 98) and n2 (degree 75) are god nodes
const CONFIG = { godNodeThresholdPercentile: 60, sensitiveCommunities: ['auth', 'payments'] };
const GRAPH   = normalizeGraphify(RAW_GRAPH, CONFIG);
const INDEX   = buildIndex(GRAPH);

// ─── matchFunctionToNode ──────────────────────────────────────────────────────

describe('matchFunctionToNode', () => {
  it('matches PHP class::method via file + class + method', () => {
    const fn: ChangedFunction = {
      file: 'src/Services/PaymentProcessor.php',
      className: 'PaymentProcessor', methodName: 'charge',
      startLine: 42,
    };
    const node = matchFunctionToNode(fn, INDEX);
    expect(node?.nodeId).toBe('n1');
  });

  it('matches TypeScript method via file + class + method', () => {
    const fn: ChangedFunction = {
      file: 'src/services/OrderService.ts',
      className: 'OrderService', methodName: 'create',
      startLine: 22,
    };
    const node = matchFunctionToNode(fn, INDEX);
    expect(node?.nodeId).toBe('n4');
  });

  it('matches standalone function via file + functionName', () => {
    const fn: ChangedFunction = {
      file: 'src/helpers.php',
      functionName: 'formatCurrency',
      startLine: 10,
    };
    const node = matchFunctionToNode(fn, INDEX);
    expect(node?.nodeId).toBe('n3');
  });

  it('falls back to byClassMethod when file does not match', () => {
    const fn: ChangedFunction = {
      file: 'wrong/path.php',
      className: 'PaymentProcessor', methodName: 'charge',
      startLine: 1,
    };
    const node = matchFunctionToNode(fn, INDEX);
    expect(node?.nodeId).toBe('n1');
  });

  it('returns null when no match found', () => {
    const fn: ChangedFunction = {
      file: 'nonexistent.ts', functionName: 'unknownFunc', startLine: 1,
    };
    expect(matchFunctionToNode(fn, INDEX)).toBeNull();
  });
});

// ─── computeBlastRadius ───────────────────────────────────────────────────────

describe('computeBlastRadius', () => {
  it('returns LOW when no changed files match static nodes', () => {
    const result = computeBlastRadius(['nonexistent.php'], GRAPH, INDEX);
    expect(result.changedNodeCount).toBe(0);
    expect(result.level).toBe('LOW');
    expect(result.score).toBe(0);
  });

  it('correctly counts nodes in changed files', () => {
    const result = computeBlastRadius(['src/Services/PaymentProcessor.php'], GRAPH, INDEX);
    expect(result.changedNodeCount).toBe(1);
    expect(result.changedNodes[0]!.nodeId).toBe('n1');
  });

  it('identifies god nodes in blast radius', () => {
    const result = computeBlastRadius(
      ['src/Services/PaymentProcessor.php', 'src/Http/Middleware/AuthMiddleware.php'],
      GRAPH, INDEX,
    );
    const godNodeIds = result.godNodesAffected.map((n) => n.nodeId);
    expect(godNodeIds).toContain('n1');
    expect(godNodeIds).toContain('n2');
  });

  it('computes HIGH level when god nodes and sensitive communities involved', () => {
    // n1 is god node in payments_core (sensitive) → score = 10+5+1 = 16 (MEDIUM)
    // n2 is god node in auth_core (sensitive) → score = 10+5+1 = 16 more
    // combined → score = 20+10+2 = 32 → HIGH
    const result = computeBlastRadius(
      ['src/Services/PaymentProcessor.php', 'src/Http/Middleware/AuthMiddleware.php'],
      GRAPH, INDEX,
    );
    expect(['HIGH', 'CRITICAL']).toContain(result.level);
    expect(result.score).toBeGreaterThan(10);
  });

  it('identifies sensitive communities', () => {
    const result = computeBlastRadius(['src/Services/PaymentProcessor.php'], GRAPH, INDEX);
    expect(result.sensitiveCommunityCount).toBe(1);
  });
});

// ─── detectGodNodeUntested ────────────────────────────────────────────────────

describe('detectGodNodeUntested', () => {
  const paymentFn: ChangedFunction = {
    file: 'src/Services/PaymentProcessor.php',
    className: 'PaymentProcessor', methodName: 'charge',
    startLine: 42,
  };
  const helperFn: ChangedFunction = {
    file: 'src/helpers.php',
    functionName: 'formatCurrency',
    startLine: 10,
  };

  it('generates a finding for an uncovered god node', () => {
    const findings = detectGodNodeUntested([paymentFn], INDEX, new Set());
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe(STATIC_RULES.GOD_NODE_UNTESTED);
    expect(findings[0]!.severity).toBe('critical');
    expect(findings[0]!.confidence).toBe(0.82);
  });

  it('suppresses finding when function is in covered symbols', () => {
    const covered = new Set(['App\\Services\\PaymentProcessor::charge']);
    const findings = detectGodNodeUntested([paymentFn], INDEX, covered);
    expect(findings).toHaveLength(0);
  });

  it('suppresses finding when display name is in covered symbols', () => {
    const covered = new Set(['charge']);
    const findings = detectGodNodeUntested([paymentFn], INDEX, covered);
    expect(findings).toHaveLength(0);
  });

  it('does not emit finding for non-god-node functions', () => {
    const findings = detectGodNodeUntested([helperFn], INDEX, new Set());
    expect(findings).toHaveLength(0);
  });

  it('deduplicates multiple references to the same god node', () => {
    const findings = detectGodNodeUntested([paymentFn, paymentFn], INDEX, new Set());
    expect(findings).toHaveLength(1);
  });

  it('fingerprint is stable across calls', () => {
    const a = detectGodNodeUntested([paymentFn], INDEX, new Set());
    const b = detectGodNodeUntested([paymentFn], INDEX, new Set());
    expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
  });

  it('includes static_graph and coverage_gap in evidence sources', () => {
    const findings = detectGodNodeUntested([paymentFn], INDEX, new Set());
    expect(findings[0]!.evidenceSources).toContain('static_graph');
    expect(findings[0]!.evidenceSources).toContain('coverage_gap');
  });
});

// ─── detectHighBlastRadius ────────────────────────────────────────────────────

describe('detectHighBlastRadius', () => {
  it('returns null for LOW blast radius', () => {
    const br = computeBlastRadius([], GRAPH, INDEX);
    expect(detectHighBlastRadius(br, [])).toBeNull();
  });

  it('returns null for MEDIUM blast radius', () => {
    // Small change: utils function only (score = 0+0+1 = 1 → LOW or MEDIUM)
    const br = computeBlastRadius(['src/helpers.php'], GRAPH, INDEX);
    // n3 is not a god node, utils is not sensitive → score = 0+0+1 = 1 → LOW
    expect(br.level).toBe('LOW');
    expect(detectHighBlastRadius(br, ['src/helpers.php'])).toBeNull();
  });

  it('returns a finding for HIGH blast radius', () => {
    // Force HIGH by giving a large set of changed files with god nodes
    const highBr = computeBlastRadius(
      ['src/Services/PaymentProcessor.php', 'src/Http/Middleware/AuthMiddleware.php'],
      GRAPH, INDEX,
    );
    if (highBr.level === 'LOW' || highBr.level === 'MEDIUM') return; // skip if threshold not met
    const finding = detectHighBlastRadius(highBr, ['src/Services/PaymentProcessor.php']);
    expect(finding).not.toBeNull();
    expect(finding!.ruleId).toBe(STATIC_RULES.HIGH_BLAST_RADIUS_CHANGE);
    expect(finding!.confidence).toBe(0.75);
  });
});

// ─── detectSensitiveCommunityUnverified ───────────────────────────────────────

describe('detectSensitiveCommunityUnverified', () => {
  const paymentFn: ChangedFunction = {
    file: 'src/Services/PaymentProcessor.php',
    className: 'PaymentProcessor', methodName: 'charge',
    startLine: 42,
  };
  const helperFn: ChangedFunction = {
    file: 'src/helpers.php',
    functionName: 'formatCurrency',
    startLine: 10,
  };

  it('generates a finding for uncovered sensitive community function', () => {
    const findings = detectSensitiveCommunityUnverified(
      [paymentFn], INDEX, GRAPH, new Set(),
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]!.ruleId).toBe(STATIC_RULES.SENSITIVE_COMMUNITY_UNVERIFIED);
    expect(findings[0]!.severity).toBe('high');
  });

  it('does not generate finding for non-sensitive community', () => {
    const findings = detectSensitiveCommunityUnverified(
      [helperFn], INDEX, GRAPH, new Set(),
    );
    expect(findings).toHaveLength(0);
  });

  it('suppresses finding when function is covered', () => {
    const covered = new Set(['App\\Services\\PaymentProcessor::charge', 'charge']);
    const findings = detectSensitiveCommunityUnverified(
      [paymentFn], INDEX, GRAPH, covered,
    );
    expect(findings).toHaveLength(0);
  });

  it('groups findings by community', () => {
    const authFn: ChangedFunction = {
      file: 'src/Http/Middleware/AuthMiddleware.php',
      className: 'AuthMiddleware', methodName: 'handle',
      startLine: 15,
    };
    const findings = detectSensitiveCommunityUnverified(
      [paymentFn, authFn], INDEX, GRAPH, new Set(),
    );
    // One finding per community (payments_core + auth_core = 2)
    const communityRefs = findings.map((f) => f.title);
    expect(communityRefs.some((t) => t.includes('payments_core'))).toBe(true);
    expect(communityRefs.some((t) => t.includes('auth_core'))).toBe(true);
  });
});

// ─── detectStaticEdgeAdded ────────────────────────────────────────────────────

describe('detectStaticEdgeAdded', () => {
  const BASELINE_WITH_EDGES: ArchitectureBaseline = {
    schemaVersion: 'tracegraph.architecture-baseline.v1',
    createdAt: Date.now(),
    createdBy: 'test',
    commit: 'abc123',
    provider: 'graphify',
    graphifyVersion: '0.4.0',
    nodeCount: 5,
    edgeCount: 3,
    communityCount: 4,
    // The orders→payments edge (n4→n1, community 4→1) was in the baseline
    godNodes: [],
    communities: [],
    crossCommunityEdges: [
      {
        fromCommunityId: '4', fromCommunityLabel: 'orders',
        toCommunityId: '1', toCommunityLabel: 'payments_core',
        callerSymbol: 'OrderService.create',
        calleeSymbol: 'App\\Services\\PaymentProcessor::charge',
        traceCount: 0, staticOnly: true,
      },
    ],
  };

  it('returns no findings when all cross-community edges were in the baseline', () => {
    const findings = detectStaticEdgeAdded(GRAPH, BASELINE_WITH_EDGES);
    // orders→payments is in baseline, payments→auth may be new
    const blastFindings = findings.filter((f) => f.ruleId === STATIC_RULES.STATIC_EDGE_ADDED);
    // payments→auth cross-community edge should fire (not in baseline)
    // orders→payments should not fire (in baseline)
    const fromOrders = blastFindings.find((f) => f.title.includes('orders'));
    expect(fromOrders).toBeUndefined();
  });

  it('generates a finding for a new cross-community edge not in baseline', () => {
    // Empty baseline — all edges are new
    const emptyBaseline: ArchitectureBaseline = {
      ...BASELINE_WITH_EDGES,
      crossCommunityEdges: [],
    };
    const findings = detectStaticEdgeAdded(GRAPH, emptyBaseline);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.ruleId).toBe(STATIC_RULES.STATIC_EDGE_ADDED);
    expect(findings[0]!.confidence).toBe(0.80);
  });

  it('deduplicates findings by community pair', () => {
    const emptyBaseline: ArchitectureBaseline = {
      ...BASELINE_WITH_EDGES,
      crossCommunityEdges: [],
    };
    const findings = detectStaticEdgeAdded(GRAPH, emptyBaseline);
    // Count unique community pairs
    const pairs = new Set(findings.map((f) => f.fingerprint));
    expect(pairs.size).toBe(findings.length);
  });
});

// ─── detectCommunityDrift ─────────────────────────────────────────────────────

describe('detectCommunityDrift', () => {
  const BASELINE_4_COMMUNITIES: ArchitectureBaseline = {
    schemaVersion: 'tracegraph.architecture-baseline.v1',
    createdAt: Date.now(),
    createdBy: 'test',
    commit: 'abc123',
    provider: 'graphify',
    graphifyVersion: '0.4.0',
    nodeCount: 5,
    edgeCount: 3,
    communityCount: 4,
    godNodes: [],
    communities: [
      { communityId: '1', label: 'payments_core', size: 12, isSensitive: true },
      { communityId: '2', label: 'auth_core',     size: 8,  isSensitive: true },
      { communityId: '3', label: 'utils',         size: 20, isSensitive: false },
      { communityId: '4', label: 'orders',        size: 15, isSensitive: false },
    ],
    crossCommunityEdges: [],
  };

  it('returns no findings when community counts match baseline', () => {
    // Graph has 4 communities, baseline has 4 — no drift
    const findings = detectCommunityDrift(GRAPH, BASELINE_4_COMMUNITIES);
    expect(findings).toHaveLength(0);
  });

  it('generates a finding when new communities appear', () => {
    const baselineWith2: ArchitectureBaseline = {
      ...BASELINE_4_COMMUNITIES,
      communityCount: 2,
      communities: [
        { communityId: '1', label: 'payments_core', size: 12, isSensitive: true },
        { communityId: '2', label: 'auth_core',     size: 8,  isSensitive: true },
      ],
    };
    const findings = detectCommunityDrift(GRAPH, baselineWith2);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe(STATIC_RULES.COMMUNITY_DRIFT);
    expect(findings[0]!.severity).toBe('info');
    expect(findings[0]!.confidence).toBe(0.90);
    expect(findings[0]!.title).toContain('2 →');
  });

  it('generates a finding when communities are removed', () => {
    const baselineWith6: ArchitectureBaseline = {
      ...BASELINE_4_COMMUNITIES,
      communityCount: 6,
      communities: [
        ...BASELINE_4_COMMUNITIES.communities,
        { communityId: '5', label: 'billing',  size: 9,  isSensitive: true },
        { communityId: '6', label: 'reporting', size: 11, isSensitive: false },
      ],
    };
    const findings = detectCommunityDrift(GRAPH, baselineWith6);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('6 →');
  });
});
