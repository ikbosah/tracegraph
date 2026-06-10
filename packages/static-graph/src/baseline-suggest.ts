/**
 * G3B — Baseline Suggestion Engine
 *
 * Discovers unbaselined entrypoints from existing traces, scenarios, and
 * the static graph, then ranks them by architecture risk so teams know
 * exactly which runtime baselines to create first.
 *
 * Distinct from `tracegraph baseline suggest-update`, which tells you whether
 * it is safe to UPDATE an existing baseline. This module tells you WHICH
 * baselines to CREATE when starting from zero.
 *
 * Scoring formula:
 *   (godNodeCount × 10) + (sensitiveCommunityCount × 5)
 *   + (communityCount × 2) + min(matchedNodeCount, 8)
 *   + (noRuntimeTrace ? 3 : 0)
 */
import * as fs            from 'fs';
import * as path          from 'path';
import { createHash }     from 'node:crypto';
import type { TraceEntrypoint, CompactBaseline } from '@tracegraph/shared-types';
import type { NormalizedGraph, NormalizedNode, NormalizedCommunity } from './normalizer';
import type { GraphIndex } from './indexer';

// ─── Public types ─────────────────────────────────────────────────────────────

export type EntrypointType = 'http' | 'test' | 'function' | 'scenario' | 'static_hint';

export type PriorityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type ScoredEntrypoint = {
  /** Stable key derived from the entrypoint (same as baseline testId). */
  testId: string;
  /** Human-readable label, e.g. "POST /checkout" or "user can login". */
  label: string;
  type: EntrypointType;
  /** Number of existing trace files for this entrypoint. */
  traceCount: number;
  /** Whether a runtime baseline already exists (these are excluded from output). */
  isBaselined: boolean;
  /** Static nodes matched from this entrypoint's runtime events. */
  matchedNodes: NormalizedNode[];
  /** Matched nodes that are god nodes. */
  godNodes: NormalizedNode[];
  /** All unique communities involved. */
  communities: NormalizedCommunity[];
  /** Communities flagged as sensitive. */
  sensitiveCommunities: NormalizedCommunity[];
  /** Composite risk score. Higher = more important to baseline. */
  score: number;
  priority: PriorityLevel;
  /** Human-readable reasons contributing to the score. */
  reasons: string[];
};

export type SuggestBaselinesOptions = {
  tracesDir:    string;
  baselinesDir: string;
  scenariosDir: string;
  graph:        NormalizedGraph | null;
  index:        GraphIndex | null;
  top?:         number;
};

// ─── Raw trace data collected per entrypoint ──────────────────────────────────

type TraceEventLike = {
  type?:         string;
  name?:         string;
  functionName?: string;
  className?:    string;
  methodName?:   string;
  file?:         string;
};

type TraceEntrypointGroup = {
  testId:     string;
  label:      string;
  type:       EntrypointType;
  entrypoint: TraceEntrypoint;
  traceCount: number;
  /** Deduplicated set of function events from all traces for this entrypoint. */
  functionEvents: TraceEventLike[];
};

// ─── Entry point: suggestBaselines ───────────────────────────────────────────

/**
 * Discover unbaselined entrypoints and rank them by architecture risk.
 * Returns candidates sorted by score descending (highest priority first).
 * Already-baselined entrypoints are excluded.
 */
export function suggestBaselines(opts: SuggestBaselinesOptions): ScoredEntrypoint[] {
  const { tracesDir, baselinesDir, scenariosDir, graph, index, top } = opts;

  // ── 1. Collect existing baseline testIds ──────────────────────────────────
  const baselinedIds = loadBaselinedIds(baselinesDir);

  // ── 2. Discover entrypoints from traces ───────────────────────────────────
  const fromTraces = discoverFromTraces(tracesDir);

  // ── 3. Discover entrypoints from scenarios (not yet traced) ───────────────
  const fromScenarios = discoverFromScenarios(scenariosDir, fromTraces, baselinedIds);

  // ── 4. Discover high-risk static hints (god nodes not yet traced at all) ──
  const staticHints = graph && index
    ? discoverStaticHints(graph, index, fromTraces, baselinedIds)
    : [];

  // ── 5. Combine all candidates ─────────────────────────────────────────────
  const allCandidates = [...fromTraces, ...fromScenarios, ...staticHints];

  // ── 6. Score each (skip already-baselined) ────────────────────────────────
  const scored: ScoredEntrypoint[] = [];
  for (const candidate of allCandidates) {
    if (baselinedIds.has(candidate.testId)) continue;
    scored.push(scoreEntrypoint(candidate, graph, index));
  }

  // ── 7. Sort by score descending, apply top limit ──────────────────────────
  scored.sort((a, b) => b.score - a.score);
  return top != null ? scored.slice(0, top) : scored;
}

// ─── Baseline discovery ───────────────────────────────────────────────────────

function loadBaselinedIds(baselinesDir: string): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(baselinesDir)) return ids;

  for (const file of fs.readdirSync(baselinesDir)) {
    if (!file.endsWith('.baseline.json')) continue;
    try {
      const baseline = JSON.parse(
        fs.readFileSync(path.join(baselinesDir, file), 'utf8'),
      ) as Partial<CompactBaseline>;
      if (baseline.testId) ids.add(baseline.testId);
    } catch { /* skip unreadable */ }
  }
  return ids;
}

// ─── Trace discovery ──────────────────────────────────────────────────────────

function discoverFromTraces(tracesDir: string): TraceEntrypointGroup[] {
  if (!fs.existsSync(tracesDir)) return [];

  const byTestId = new Map<string, TraceEntrypointGroup>();

  const files = fs.readdirSync(tracesDir)
    .filter((f) => f.endsWith('.trace.json'))
    .slice(0, 500); // cap for memory

  for (const file of files) {
    try {
      const session = JSON.parse(
        fs.readFileSync(path.join(tracesDir, file), 'utf8'),
      ) as {
        entrypoint?: TraceEntrypoint;
        events?:     TraceEventLike[];
      };
      if (!session.entrypoint) continue;

      const testId = deriveTestIdLocal(session.entrypoint);
      const label  = entrypointLabel(session.entrypoint);
      const type   = entrypointType(session.entrypoint);

      let group = byTestId.get(testId);
      if (!group) {
        group = { testId, label, type, entrypoint: session.entrypoint, traceCount: 0, functionEvents: [] };
        byTestId.set(testId, group);
      }
      group.traceCount++;

      // Collect function/method call events for static matching
      for (const evt of session.events ?? []) {
        if (evt.type !== 'function_call' && evt.type !== 'method_call') continue;
        group.functionEvents.push({
          type:         evt.type,
          name:         evt.name,
          functionName: evt.functionName,
          className:    evt.className,
          methodName:   evt.methodName,
          file:         evt.file,
        });
      }
    } catch { /* skip unreadable */ }
  }

  return [...byTestId.values()];
}

// ─── Scenario discovery ───────────────────────────────────────────────────────

function discoverFromScenarios(
  scenariosDir: string,
  alreadyFromTraces: TraceEntrypointGroup[],
  baselinedIds: Set<string>,
): TraceEntrypointGroup[] {
  if (!fs.existsSync(scenariosDir)) return [];

  const traceKeys = new Set(alreadyFromTraces.map((g) => g.testId));
  const groups: TraceEntrypointGroup[] = [];

  for (const file of fs.readdirSync(scenariosDir)) {
    if (!file.endsWith('.scenario.json')) continue;
    try {
      const scenario = JSON.parse(
        fs.readFileSync(path.join(scenariosDir, file), 'utf8'),
      ) as { name?: string; steps?: Array<{ name?: string; http?: { method: string; url: string } }> };

      // Each scenario step with an HTTP call is a candidate
      for (const step of scenario.steps ?? []) {
        if (!step.http) continue;
        const { method, url } = step.http;
        const routePath = urlToPath(url);
        const ep: TraceEntrypoint = { type: 'http_request', method: method.toUpperCase(), path: routePath };
        const testId = deriveTestIdLocal(ep);

        if (traceKeys.has(testId) || baselinedIds.has(testId)) continue;

        groups.push({
          testId,
          label:          `${method.toUpperCase()} ${routePath}  (scenario: ${scenario.name ?? file})`,
          type:           'scenario',
          entrypoint:     ep,
          traceCount:     0,
          functionEvents: [],
        });
        traceKeys.add(testId); // deduplicate
      }
    } catch { /* skip */ }
  }

  return groups;
}

// ─── Static graph hint discovery ─────────────────────────────────────────────

/**
 * Find god nodes not covered by any existing trace.
 * These are the most architecturally important functions with zero runtime evidence.
 */
function discoverStaticHints(
  graph: NormalizedGraph,
  index: GraphIndex,
  alreadyFromTraces: TraceEntrypointGroup[],
  baselinedIds: Set<string>,
): TraceEntrypointGroup[] {
  // Build set of all symbol names already seen in traces
  const seenSymbols = new Set<string>();
  for (const group of alreadyFromTraces) {
    for (const evt of group.functionEvents) {
      if (evt.name)         seenSymbols.add(evt.name);
      if (evt.functionName) seenSymbols.add(evt.functionName);
      if (evt.className && evt.methodName) {
        seenSymbols.add(`${evt.className}.${evt.methodName}`);
        seenSymbols.add(`${evt.className}::${evt.methodName}`);
      }
    }
  }

  const hints: TraceEntrypointGroup[] = [];
  const seen = new Set<string>();

  for (const node of index.godNodes) {
    if (seenSymbols.has(node.symbolName) || seenSymbols.has(node.displayName)) continue;
    if (seen.has(node.symbolName)) continue;
    seen.add(node.symbolName);

    // Create a synthetic entrypoint for this god node
    const ep: TraceEntrypoint = { type: 'function', functionName: node.symbolName };
    const testId = deriveTestIdLocal(ep);
    if (baselinedIds.has(testId)) continue;

    hints.push({
      testId,
      label:          `${node.displayName}  (static: ${node.communityLabel ?? '?'}, top ${100 - node.centralityPercentile}%)`,
      type:           'static_hint',
      entrypoint:     ep,
      traceCount:     0,
      functionEvents: [{ type: 'function_call', name: node.symbolName, functionName: node.displayName }],
    });
  }

  return hints.slice(0, 20); // cap — don't overwhelm the output
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreEntrypoint(
  group: TraceEntrypointGroup,
  graph: NormalizedGraph | null,
  index: GraphIndex | null,
): ScoredEntrypoint {
  const reasons: string[] = [];

  // Match function events to static nodes
  const matchedNodes: NormalizedNode[] = [];
  const seen = new Set<string>();

  if (index) {
    for (const evt of group.functionEvents) {
      const node = matchEventToNode(evt, index);
      if (node && !seen.has(node.nodeId)) {
        seen.add(node.nodeId);
        matchedNodes.push(node);
      }
    }
  }

  // Build community set from matched nodes
  const communityMap = new Map(
    (graph?.communities ?? []).map((c) => [c.communityId, c]),
  );
  const communityIds = new Set<string>(
    matchedNodes.map((n) => n.communityId).filter((id): id is string => id != null),
  );
  const communities = [...communityIds]
    .map((id) => communityMap.get(id))
    .filter((c): c is NormalizedCommunity => c != null);

  const godNodes           = matchedNodes.filter((n) => n.isGodNode);
  const sensitiveCommunities = communities.filter((c) => c.isSensitive);

  // Compute score
  let score = 0;

  if (godNodes.length > 0) {
    score += godNodes.length * 10;
    reasons.push(`${godNodes.length} god node${godNodes.length > 1 ? 's' : ''}: ${godNodes.map((n) => n.displayName).slice(0, 3).join(', ')}`);
  }

  if (sensitiveCommunities.length > 0) {
    score += sensitiveCommunities.length * 5;
    reasons.push(`sensitive: ${sensitiveCommunities.map((c) => c.label).join(', ')}`);
  }

  if (communities.length > 0) {
    score += communities.length * 2;
    if (communities.length > 1) {
      reasons.push(`${communities.length} communities touched`);
    }
  }

  const cappedNodes = Math.min(matchedNodes.length, 8);
  score += cappedNodes;
  if (matchedNodes.length > 0) {
    reasons.push(`${matchedNodes.length} static node${matchedNodes.length > 1 ? 's' : ''} in call path`);
  }

  if (group.traceCount === 0) {
    score += 3;
    reasons.push('no runtime traces yet');
  }

  // Priority thresholds
  const priority: PriorityLevel =
    score >= 35 ? 'CRITICAL' :
    score >= 15 ? 'HIGH' :
    score >=  5 ? 'MEDIUM' :
    'LOW';

  return {
    testId:               group.testId,
    label:                group.label,
    type:                 group.type,
    traceCount:           group.traceCount,
    isBaselined:          false,
    matchedNodes,
    godNodes,
    communities,
    sensitiveCommunities,
    score,
    priority,
    reasons,
  };
}

// ─── Static node matching from raw trace events ────────────────────────────────

function matchEventToNode(evt: TraceEventLike, index: GraphIndex): NormalizedNode | null {
  // 1. Exact FQN match (most precise)
  if (evt.name && index.byFqn[evt.name]) return index.byFqn[evt.name]!;

  // 2. File + class + method
  if (evt.file && evt.className && evt.methodName) {
    const key = `${normalizeFilePath(evt.file)}:${evt.className}.${evt.methodName}`;
    if (index.byFileClassMethod[key]) return index.byFileClassMethod[key]!;
  }

  // 3. File + function
  if (evt.file && evt.functionName) {
    const key = `${normalizeFilePath(evt.file)}:${evt.functionName}`;
    if (index.byFileFunction[key]) return index.byFileFunction[key]!;
  }

  // 4. Class + method (no file)
  if (evt.className && evt.methodName) {
    const key = `${evt.className}.${evt.methodName}`;
    if (index.byClassMethod[key]) return index.byClassMethod[key]!;
  }

  // 5. Display name — only when unambiguous
  const displayName = evt.methodName ?? evt.functionName ?? evt.name;
  if (displayName) {
    const candidates = index.byDisplayName[displayName];
    if (candidates?.length === 1) return candidates[0]!;
  }

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Replicate graph-engine's deriveTestId locally to avoid circular dependency. */
function deriveTestIdLocal(entrypoint: TraceEntrypoint): string {
  let key: string;
  switch (entrypoint.type) {
    case 'http_request': key = `${entrypoint.method}:${entrypoint.path}`; break;
    case 'test_case':    key = entrypoint.testName;                        break;
    case 'function':     key = `fn:${entrypoint.functionName}`;            break;
    case 'cli_command':  key = `cmd:${entrypoint.command}`;                break;
    default:             key = JSON.stringify(entrypoint);
  }
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function entrypointLabel(ep: TraceEntrypoint): string {
  switch (ep.type) {
    case 'http_request': return `${ep.method} ${ep.path}`;
    case 'test_case':    return ep.testName;
    case 'function':     return `${ep.functionName}()`;
    case 'cli_command':  return `$ ${ep.command}`;
    case 'server':       return `server:${ep.port}`;
    default:             return '(unknown)';
  }
}

function entrypointType(ep: TraceEntrypoint): EntrypointType {
  switch (ep.type) {
    case 'http_request': return 'http';
    case 'test_case':    return 'test';
    case 'function':     return 'function';
    default:             return 'function';
  }
}

/** Convert an absolute or relative URL to a route path. */
function urlToPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    // Not a full URL — treat as path
    return url.startsWith('/') ? url : `/${url}`;
  }
}

function normalizeFilePath(p: string): string {
  return p.replace(/\\/g, '/');
}
