/**
 * G3A — Tier 1 baseline-free architecture finding generators
 *
 * All findings here require only a static graph + git diff (and optionally
 * runtime traces). None require a runtime baseline.
 *
 * Rule IDs:
 *   static.god_node.untested                   — G3A/G3
 *   architecture.high_blast_radius_change      — G3A
 *   architecture.sensitive_community_unverified — G3A
 *   architecture.static_edge_added             — G3A (needs arch baseline)
 *   architecture.community_drift               — G3A (needs arch baseline)
 *   architecture.surprise_edge                 — G5  (needs enriched traces)
 */
import { createHash }    from 'node:crypto';
import type {
  Finding,
  ChangedFunction,
  ArchitectureBaseline,
  TraceSession,
  TraceEvent,
} from '@tracegraph/shared-types';
import type { NormalizedGraph, NormalizedNode, NormalizedCommunity } from './normalizer';
import type { GraphIndex } from './indexer';

// ─── Rule IDs ─────────────────────────────────────────────────────────────────

export const STATIC_RULES = {
  GOD_NODE_UNTESTED:               'static.god_node.untested',
  HIGH_BLAST_RADIUS_CHANGE:        'architecture.high_blast_radius_change',
  SENSITIVE_COMMUNITY_UNVERIFIED:  'architecture.sensitive_community_unverified',
  STATIC_EDGE_ADDED:               'architecture.static_edge_added',
  COMMUNITY_DRIFT:                 'architecture.community_drift',
  SURPRISE_EDGE:                   'architecture.surprise_edge',
  SENSITIVE_COMMUNITY_CROSSED:     'architecture.sensitive_community_crossed',
} as const;

// ─── Blast radius ─────────────────────────────────────────────────────────────

export type BlastRadiusLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type BlastRadiusResult = {
  changedNodeCount:       number;
  changedNodes:           NormalizedNode[];
  affectedCommunityCount: number;
  affectedCommunities:    NormalizedCommunity[];
  godNodesAffected:       NormalizedNode[];
  sensitiveCommunityCount: number;
  /** Composite risk score: (godNodes × 10) + (sensitiveCommunities × 5) + nodeCount */
  score:                  number;
  level:                  BlastRadiusLevel;
};

/**
 * Map changed file paths to static nodes and compute blast radius metrics.
 * Changed files that do not appear in the graph are silently ignored.
 */
export function computeBlastRadius(
  changedFiles: string[],
  graph: NormalizedGraph,
  index: GraphIndex,
): BlastRadiusResult {
  const changedFileSet = new Set(changedFiles.map(normalizeFilePath));

  // Collect all static nodes whose file is in the changed set
  const changedNodes: NormalizedNode[] = graph.nodes.filter(
    (n) => n.file && changedFileSet.has(normalizeFilePath(n.file)),
  );

  // Build community set
  const communityIdSet = new Set<string>();
  for (const node of changedNodes) {
    if (node.communityId) communityIdSet.add(node.communityId);
  }

  const communityMap = new Map(graph.communities.map((c) => [c.communityId, c]));
  const affectedCommunities = [...communityIdSet]
    .map((id) => communityMap.get(id))
    .filter((c): c is NormalizedCommunity => c != null);

  const godNodesAffected  = changedNodes.filter((n) => n.isGodNode);
  const sensitiveCommunities = affectedCommunities.filter((c) => c.isSensitive);

  const score =
    (godNodesAffected.length  * 10) +
    (sensitiveCommunities.length * 5) +
    changedNodes.length;

  const level: BlastRadiusLevel =
    score >= 60 ? 'CRITICAL' :
    score >= 30 ? 'HIGH' :
    score >= 10 ? 'MEDIUM' :
    'LOW';

  return {
    changedNodeCount:       changedNodes.length,
    changedNodes,
    affectedCommunityCount: affectedCommunities.length,
    affectedCommunities,
    godNodesAffected,
    sensitiveCommunityCount: sensitiveCommunities.length,
    score,
    level,
  };
}

// ─── TG3A.1 / TG3.1: static.god_node.untested ─────────────────────────────────

/**
 * Detect changed functions that are god nodes with no runtime coverage.
 *
 * @param changedFunctions Functions extracted from git diff.
 * @param index            Pre-built graph index for symbol lookup.
 * @param coveredSymbols   Set of symbol names exercised by runtime traces.
 *                         Pass an empty set when no traces exist (all are untested).
 */
export function detectGodNodeUntested(
  changedFunctions: ChangedFunction[],
  index: GraphIndex,
  coveredSymbols: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const fn of changedFunctions) {
    const node = matchFunctionToNode(fn, index);
    if (!node) continue;
    if (!node.isGodNode) continue;

    // Check runtime coverage
    const covered = coveredSymbols.has(node.symbolName) ||
                    coveredSymbols.has(node.displayName);
    if (covered) continue;

    if (seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);

    const fingerprint = fp(STATIC_RULES.GOD_NODE_UNTESTED, node.symbolName);
    const communityLabel = node.communityLabel ?? node.communityId ?? 'unknown';
    const centralityLabel = `top ${100 - node.centralityPercentile}%`;

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId:      STATIC_RULES.GOD_NODE_UNTESTED,
      severity:    'critical',
      category:    'architecture_risk',
      title:       `God node changed without runtime coverage: ${node.displayName}`,
      description:
        `${node.symbolName} is in the ${centralityLabel} of graph centrality ` +
        `(${communityLabel} community) and was changed in this diff, but no runtime ` +
        `trace has exercised it. High-centrality functions carry disproportionate ` +
        `architectural risk when changed without test evidence.`,
      evidence:    [],
      recommendation:
        `Add a runtime trace that exercises ${node.displayName}, then run ` +
        `\`tracegraph compare\` to confirm expected behavior is preserved.`,
      confidence:    0.82,
      evidenceSources: ['static_graph', 'coverage_gap'],
    });
  }

  return findings;
}

// ─── TG3A.1: architecture.high_blast_radius_change ────────────────────────────

/**
 * Emit a finding when the blast radius of the current diff is HIGH or CRITICAL.
 * Returns null when the blast radius is LOW or MEDIUM (informational only).
 */
export function detectHighBlastRadius(
  blastRadius: BlastRadiusResult,
  changedFiles: string[],
): Finding | null {
  if (blastRadius.level === 'LOW' || blastRadius.level === 'MEDIUM') return null;

  const fingerprint = fp(
    STATIC_RULES.HIGH_BLAST_RADIUS_CHANGE,
    changedFiles.sort().join('\x00'),
  );

  const godDesc = blastRadius.godNodesAffected.length > 0
    ? ` including ${blastRadius.godNodesAffected.length} god node(s) ` +
      `(${blastRadius.godNodesAffected.map((n) => n.displayName).join(', ')})`
    : '';
  const sensitiveDesc = blastRadius.sensitiveCommunityCount > 0
    ? ` The change touches ${blastRadius.sensitiveCommunityCount} sensitive ` +
      `community(ies): ${blastRadius.affectedCommunities.filter((c) => c.isSensitive).map((c) => c.label).join(', ')}.`
    : '';

  const communityList = blastRadius.affectedCommunities.map((c) => c.label).join(', ');

  return {
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId:      STATIC_RULES.HIGH_BLAST_RADIUS_CHANGE,
    severity:    blastRadius.level === 'CRITICAL' ? 'critical' : 'high',
    category:    'architecture_risk',
    title:       `High architecture blast radius: ${blastRadius.changedNodeCount} nodes across ${blastRadius.affectedCommunityCount} communities`,
    description:
      `This change modifies ${blastRadius.changedNodeCount} static graph nodes ` +
      `across ${blastRadius.affectedCommunityCount} architecture communities ` +
      `(${communityList})${godDesc}.${sensitiveDesc} ` +
      `Blast radius score: ${blastRadius.score}.`,
    evidence:    [],
    recommendation:
      `Ensure all high-centrality functions in this diff have runtime coverage. ` +
      `Run \`tracegraph coverage\` to see which changed functions are unexercised.`,
    confidence:    0.75,
    evidenceSources: ['static_graph'],
  };
}

// ─── TG3A.1: architecture.sensitive_community_unverified ──────────────────────

/**
 * Detect changed functions belonging to sensitive communities that have no
 * runtime trace coverage.
 */
export function detectSensitiveCommunityUnverified(
  changedFunctions: ChangedFunction[],
  index: GraphIndex,
  graph: NormalizedGraph,
  coveredSymbols: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  const communityMap = new Map(graph.communities.map((c) => [c.communityId, c]));

  // Group unverified functions by sensitive community
  const byCommunity = new Map<string, { community: NormalizedCommunity; nodes: NormalizedNode[] }>();

  for (const fn of changedFunctions) {
    const node = matchFunctionToNode(fn, index);
    if (!node || !node.communityId) continue;

    const community = communityMap.get(node.communityId);
    if (!community?.isSensitive) continue;

    const covered = coveredSymbols.has(node.symbolName) ||
                    coveredSymbols.has(node.displayName);
    if (covered) continue;

    let entry = byCommunity.get(node.communityId);
    if (!entry) {
      entry = { community, nodes: [] };
      byCommunity.set(node.communityId, entry);
    }
    entry.nodes.push(node);
  }

  for (const { community, nodes } of byCommunity.values()) {
    const fingerprint = fp(
      STATIC_RULES.SENSITIVE_COMMUNITY_UNVERIFIED,
      community.communityId,
      nodes.map((n) => n.symbolName).sort().join('\x00'),
    );

    const nodeNames = nodes.slice(0, 5).map((n) => n.displayName).join(', ');
    const more = nodes.length > 5 ? ` + ${nodes.length - 5} more` : '';

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId:      STATIC_RULES.SENSITIVE_COMMUNITY_UNVERIFIED,
      severity:    'high',
      category:    'architecture_risk',
      title:       `${nodes.length} changed function(s) in sensitive community "${community.label}" have no runtime coverage`,
      description:
        `The following changed functions belong to the "${community.label}" community ` +
        `(flagged as sensitive) and have not been exercised by any runtime trace: ` +
        `${nodeNames}${more}. Changes to sensitive communities without runtime evidence ` +
        `increase the risk of undetected regressions.`,
      evidence:    [],
      recommendation:
        `Run tests that exercise the changed functions in "${community.label}" ` +
        `and capture traces with \`tracegraph run -- <test-command>\`.`,
      confidence:    0.65,
      evidenceSources: ['static_graph', 'coverage_gap'],
    });
  }

  return findings;
}

// ─── TG3A.1: architecture.static_edge_added (requires arch baseline) ──────────

/**
 * Detect new cross-community edges in the current graph that were not in the
 * architecture baseline. Requires an architecture baseline to be present.
 */
export function detectStaticEdgeAdded(
  graph: NormalizedGraph,
  baseline: ArchitectureBaseline,
): Finding[] {
  const findings: Finding[] = [];

  // Build node → communityId map for the current graph
  const nodeCommunity = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.communityId) nodeCommunity.set(node.nodeId, node.communityId);
  }

  // Build community label map
  const communityLabels = new Map(graph.communities.map((c) => [c.communityId, c.label]));

  // Build set of baseline cross-community edges (from → to community pair)
  const baselineEdgeKeys = new Set<string>(
    (baseline.crossCommunityEdges ?? []).map(
      (e) => `${e.fromCommunityId}\x00${e.toCommunityId}`,
    ),
  );

  // Find new cross-community edges in current graph
  const newEdges: Array<{
    fromCommunityId:    string;
    fromCommunityLabel: string;
    toCommunityId:      string;
    toCommunityLabel:   string;
    sourceNodeId:       string;
    targetNodeId:       string;
  }> = [];

  for (const edge of graph.edges) {
    const fromCommunity = nodeCommunity.get(edge.sourceId);
    const toCommunity   = nodeCommunity.get(edge.targetId);
    if (!fromCommunity || !toCommunity || fromCommunity === toCommunity) continue;

    const key = `${fromCommunity}\x00${toCommunity}`;
    if (baselineEdgeKeys.has(key)) continue;

    newEdges.push({
      fromCommunityId:    fromCommunity,
      fromCommunityLabel: communityLabels.get(fromCommunity) ?? fromCommunity,
      toCommunityId:      toCommunity,
      toCommunityLabel:   communityLabels.get(toCommunity) ?? toCommunity,
      sourceNodeId:       edge.sourceId,
      targetNodeId:       edge.targetId,
    });
  }

  // Deduplicate by community pair (many edges may share the same pair)
  const seenPairs = new Set<string>();
  const deduplicated = newEdges.filter((e) => {
    const key = `${e.fromCommunityId}\x00${e.toCommunityId}`;
    if (seenPairs.has(key)) return false;
    seenPairs.add(key);
    return true;
  });

  for (const edge of deduplicated) {
    const fingerprint = fp(
      STATIC_RULES.STATIC_EDGE_ADDED,
      edge.fromCommunityId,
      edge.toCommunityId,
    );

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId:      STATIC_RULES.STATIC_EDGE_ADDED,
      severity:    'medium',
      category:    'architecture_risk',
      title:       `New static dependency: ${edge.fromCommunityLabel} → ${edge.toCommunityLabel}`,
      description:
        `A new cross-community dependency from "${edge.fromCommunityLabel}" ` +
        `to "${edge.toCommunityLabel}" was detected in the static graph but was ` +
        `not present in the architecture baseline. This may indicate new coupling ` +
        `between previously independent modules.`,
      evidence:    [],
      recommendation:
        `Review the new dependency between ${edge.fromCommunityLabel} and ` +
        `${edge.toCommunityLabel}. If intentional, run ` +
        `\`tracegraph architecture baseline create\` to update the baseline.`,
      confidence:    0.80,
      evidenceSources: ['static_graph'],
    });
  }

  return findings;
}

// ─── TG3A.1: architecture.community_drift (requires arch baseline) ────────────

/**
 * Detect significant changes in the community structure compared to the
 * architecture baseline (new communities, major size changes).
 */
export function detectCommunityDrift(
  graph: NormalizedGraph,
  baseline: ArchitectureBaseline,
): Finding[] {
  const findings: Finding[] = [];

  const baselineCommunityIds = new Set((baseline.communities ?? []).map((c) => c.communityId));
  const currentCommunityIds  = new Set(graph.communities.map((c) => c.communityId));

  // New communities not in baseline
  const newCommunities = graph.communities.filter(
    (c) => !baselineCommunityIds.has(c.communityId),
  );

  // Removed communities (in baseline but not current)
  const removedCount = (baseline.communities ?? []).filter(
    (c) => !currentCommunityIds.has(c.communityId),
  ).length;

  if (newCommunities.length === 0 && removedCount === 0) return [];

  const fingerprint = fp(
    STATIC_RULES.COMMUNITY_DRIFT,
    String(baseline.communityCount),
    String(graph.communities.length),
  );

  const parts: string[] = [];
  if (newCommunities.length > 0) {
    parts.push(
      `${newCommunities.length} new: ${newCommunities.map((c) => c.label).join(', ')}`,
    );
  }
  if (removedCount > 0) {
    parts.push(`${removedCount} removed`);
  }

  findings.push({
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId:      STATIC_RULES.COMMUNITY_DRIFT,
    severity:    'info',
    category:    'architecture_risk',
    title:       `Architecture community drift: ${baseline.communityCount} → ${graph.communities.length} (${parts.join(', ')})`,
    description:
      `The number of architecture communities has changed from ` +
      `${baseline.communityCount} (baseline) to ${graph.communities.length} (current). ` +
      `${parts.join('. ')}. Community drift can indicate module reorganization, ` +
      `significant new code, or refactoring.`,
    evidence:    [],
    recommendation:
      `Review the community changes and update the architecture baseline with ` +
      `\`tracegraph architecture baseline create\` once the new structure is approved.`,
    confidence:    0.90,
    evidenceSources: ['static_graph'],
  });

  return findings;
}

// ─── TG5.1 / TG5.2: architecture.surprise_edge / architecture.sensitive_community_crossed ──

/**
 * Detect runtime cross-community calls that are not in the architecture baseline.
 *
 * Requires enriched traces: events must have `event.static.communityId` (set by the
 * G2 enricher). Parent–child event pairs in different communities that are absent
 * from the architecture baseline generate a surprise-edge finding.
 *
 * Severity escalation (TG5.2):
 *   - New edge into a sensitive community       → high  (rule: sensitive_community_crossed)
 *   - New edge involving a god-node caller/callee → high (rule: surprise_edge)
 *   - All other new edges                         → medium (rule: surprise_edge)
 *
 * @param sessions          Enriched TraceSession objects (must have event.static set).
 * @param baseline          The stored architecture baseline to compare against.
 * @param sensitivePatterns Community label substrings treated as sensitive (default:
 *                          ['auth', 'billing', 'payments', 'identity']).
 */
export function detectSurpriseEdge(
  sessions:          TraceSession[],
  baseline:          ArchitectureBaseline,
  sensitivePatterns: string[] = ['auth', 'billing', 'payments', 'identity'],
): Finding[] {
  // Known baseline cross-community pairs
  const baselineEdgeKeys = new Set(
    (baseline.crossCommunityEdges ?? []).map((e) => `${e.fromCommunityId}\x00${e.toCommunityId}`),
  );

  // Sensitive community IDs from the baseline's community list
  const sensitiveCommunityIds = new Set(
    (baseline.communities ?? [])
      .filter((c) =>
        c.isSensitive ||
        sensitivePatterns.some((p) => c.label.toLowerCase().includes(p.toLowerCase())),
      )
      .map((c) => c.communityId),
  );

  // Accumulate new runtime edges not in baseline
  type ObservedEdge = {
    fromCommunityId:    string;
    fromCommunityLabel: string;
    toCommunityId:      string;
    toCommunityLabel:   string;
    callerSymbol:       string;
    calleeSymbol:       string;
    fromIsGodNode:      boolean;
    toIsGodNode:        boolean;
    traceIds:           Set<string>;
    sampleEventId:      string;
    sampleTraceId:      string;
  };

  const newEdges = new Map<string, ObservedEdge>();

  for (const session of sessions) {
    // Index events by ID for parent lookup
    const eventById = new Map<string, TraceEvent>(
      session.events.map((e) => [e.eventId, e]),
    );

    for (const event of session.events) {
      const childStatic = event.static;
      if (!childStatic?.communityId) continue;
      if (!event.parentEventId)       continue;

      const parent       = eventById.get(event.parentEventId);
      const parentStatic = parent?.static;
      if (!parentStatic?.communityId) continue;

      const fromCommunityId = parentStatic.communityId;
      const toCommunityId   = childStatic.communityId;
      if (fromCommunityId === toCommunityId) continue;

      const key = `${fromCommunityId}\x00${toCommunityId}`;
      if (baselineEdgeKeys.has(key)) continue;

      if (!newEdges.has(key)) {
        newEdges.set(key, {
          fromCommunityId,
          fromCommunityLabel: parentStatic.communityLabel ?? fromCommunityId,
          toCommunityId,
          toCommunityLabel:   childStatic.communityLabel ?? toCommunityId,
          callerSymbol:       parentStatic.symbolName,
          calleeSymbol:       childStatic.symbolName,
          fromIsGodNode:      parentStatic.isGodNode,
          toIsGodNode:        childStatic.isGodNode,
          traceIds:           new Set(),
          sampleEventId:      event.eventId,
          sampleTraceId:      session.traceId,
        });
      }

      newEdges.get(key)!.traceIds.add(session.traceId);
    }
  }

  // Generate one finding per unique community pair
  const findings: Finding[] = [];

  for (const edge of newEdges.values()) {
    const intoSensitive   = sensitiveCommunityIds.has(edge.toCommunityId);
    const involvesGodNode = edge.fromIsGodNode || edge.toIsGodNode;

    const ruleId   = intoSensitive
      ? STATIC_RULES.SENSITIVE_COMMUNITY_CROSSED
      : STATIC_RULES.SURPRISE_EDGE;
    const severity: Finding['severity'] = (intoSensitive || involvesGodNode) ? 'high' : 'medium';

    const fingerprint = fp(ruleId, edge.fromCommunityId, edge.toCommunityId);
    const traceCount  = edge.traceIds.size;

    const title = intoSensitive
      ? `Runtime call into sensitive community: ${edge.fromCommunityLabel} → ${edge.toCommunityLabel}`
      : `Unexpected cross-community runtime call: ${edge.fromCommunityLabel} → ${edge.toCommunityLabel}`;

    const description = intoSensitive
      ? `At runtime, \`${edge.callerSymbol}\` called into the sensitive ` +
        `"${edge.toCommunityLabel}" community (via \`${edge.calleeSymbol}\`). ` +
        `This cross-community edge was not in the architecture baseline. ` +
        `Observed in ${traceCount} trace(s).`
      : `At runtime, \`${edge.callerSymbol}\` called \`${edge.calleeSymbol}\` across ` +
        `community boundaries (${edge.fromCommunityLabel} → ${edge.toCommunityLabel}). ` +
        `This edge was not in the architecture baseline, indicating new coupling ` +
        `between previously independent modules. Observed in ${traceCount} trace(s).`;

    const recommendation = intoSensitive
      ? `Review the runtime call from \`${edge.callerSymbol}\` into ` +
        `"${edge.toCommunityLabel}". If expected, update the architecture baseline ` +
        `with \`tracegraph architecture baseline create\`.`
      : `Confirm that the new dependency between ${edge.fromCommunityLabel} and ` +
        `${edge.toCommunityLabel} is intentional. If so, update the architecture ` +
        `baseline with \`tracegraph architecture baseline create\`.`;

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity,
      category:    'architecture_risk',
      title,
      description,
      evidence:    [{ traceId: edge.sampleTraceId, eventIds: [edge.sampleEventId] }],
      recommendation,
      confidence:      0.85,
      evidenceSources: ['runtime_trace', 'static_graph'],
    });
  }

  return findings;
}

// ─── Node matching (simplified resolver for scan — full resolver is G2) ────────

/**
 * Attempt to match a ChangedFunction to a NormalizedNode using the graph index.
 * Uses the same confidence ordering as the full G2 resolver, but without
 * the confidence threshold — we want a best-effort match for scan.
 */
export function matchFunctionToNode(
  fn: ChangedFunction,
  index: GraphIndex,
): NormalizedNode | null {
  const { file, className, methodName, functionName } = fn;
  const normalFile = normalizeFilePath(file);

  // 1. File + class + method  (0.95)
  if (className && methodName) {
    const byFileCM = index.byFileClassMethod[`${normalFile}:${className}.${methodName}`];
    if (byFileCM) return byFileCM;
  }

  // 2. File + function  (0.90)
  if (functionName) {
    const byFileFn = index.byFileFunction[`${normalFile}:${functionName}`];
    if (byFileFn) return byFileFn;
  }

  // 3. Class + method only  (0.85)
  if (className && methodName) {
    const byCM = index.byClassMethod[`${className}.${methodName}`];
    if (byCM) return byCM;
  }

  // 4. Display name (0.50) — only when there is exactly one candidate
  const name = methodName ?? functionName;
  if (name) {
    const candidates = index.byDisplayName[name];
    if (candidates?.length === 1) return candidates[0]!;
  }

  return null;
}

/**
 * Map a list of changed files to all static nodes that live in those files.
 * Used by blast radius and sensitive-community detection when function-level
 * matching is unavailable (e.g., languages parseDiff doesn't support).
 */
export function nodesInChangedFiles(
  changedFiles: string[],
  graph: NormalizedGraph,
): NormalizedNode[] {
  const fileSet = new Set(changedFiles.map(normalizeFilePath));
  return graph.nodes.filter(
    (n) => n.file && fileSet.has(normalizeFilePath(n.file)),
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Stable 16-hex-char fingerprint. */
function fp(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\x00')).digest('hex').slice(0, 16);
}

function normalizeFilePath(p: string): string {
  return p.replace(/\\/g, '/');
}
