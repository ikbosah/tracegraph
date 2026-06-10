/**
 * G3D — `tracegraph architecture`
 *
 * Command group for static architecture baseline management.
 *
 *   tracegraph architecture baseline create   — snapshot current static graph
 *   tracegraph architecture baseline status   — show stored baseline metadata
 *   tracegraph architecture compare           — diff current graph vs baseline
 */
import * as fs   from 'fs';
import * as path from 'path';
import { EXIT_CODES }         from '@tracegraph/shared-types';
import type { ArchitectureBaselineDiff } from '@tracegraph/static-graph';
import {
  loadNormalizedGraph,
  loadOrRebuildGraphIndex,
  loadGraphMetadata,
  createArchitectureBaseline,
  writeArchitectureBaseline,
  loadArchitectureBaseline,
  diffArchitectureBaseline,
} from '@tracegraph/static-graph';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ArchitectureBaselineCreateOptions = {
  createdBy?: string;
  quiet?:     boolean;
};

export type ArchitectureCompareOptions = {
  failOnCritical?: boolean;
  json?:           boolean;
};

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * `tracegraph architecture baseline create`
 *
 * Snapshots the current static graph into architecture-baseline.json.
 * Run this after `tracegraph graph build` to establish a baseline for
 * drift detection. Commit the file for team use.
 */
export function architectureBaselineCreateCommand(
  options: ArchitectureBaselineCreateOptions = {},
): number {
  const cwd = process.cwd();

  const graph = loadNormalizedGraph(cwd);
  if (!graph) {
    process.stderr.write(
      '[tracegraph] No static graph found.\n' +
      '  Run: tracegraph graph build\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const index = loadOrRebuildGraphIndex(cwd);
  if (!index) {
    process.stderr.write(
      '[tracegraph] Static graph index is missing and could not be rebuilt.\n' +
      '  Run: tracegraph graph build\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const baseline = createArchitectureBaseline(graph, index, cwd, {
    createdBy: options.createdBy,
  });

  writeArchitectureBaseline(baseline, cwd);

  const outPath = path.join(cwd, '.tracegraph', 'static-graph', 'architecture-baseline.json');

  if (!options.quiet) {
    const e = process.stderr;
    e.write('\n  tracegraph architecture baseline create\n');
    e.write(`  ${'─'.repeat(50)}\n`);
    e.write(`  ✅  Baseline written: ${path.relative(cwd, outPath)}\n\n`);
    e.write(`  Created by:  ${baseline.createdBy}\n`);
    e.write(`  Commit:      ${baseline.commit.slice(0, 12)}\n`);
    e.write(`  Provider:    Graphify ${baseline.graphifyVersion}\n`);
    e.write(`  ${'─'.repeat(50)}\n`);
    e.write(`  Nodes:         ${baseline.nodeCount.toLocaleString()}\n`);
    e.write(`  Edges:         ${baseline.edgeCount.toLocaleString()}\n`);
    e.write(`  Communities:   ${baseline.communityCount}\n`);
    e.write(`  God nodes:     ${baseline.godNodes.length}\n`);
    e.write(`  Cross-community edges: ${baseline.crossCommunityEdges.length}\n`);

    if (baseline.communities.filter((c) => c.isSensitive).length > 0) {
      const names = baseline.communities.filter((c) => c.isSensitive).map((c) => c.label);
      e.write(`  Sensitive communities: ${names.join(', ')}\n`);
    }

    e.write('\n');
    e.write('  Commit this file to enable architecture drift detection for your team.\n');
    e.write(`  Run \`tracegraph architecture compare\` on future changes to detect drift.\n\n`);
  }

  return EXIT_CODES.SUCCESS;
}

/**
 * `tracegraph architecture baseline status`
 *
 * Shows the stored architecture baseline: when it was created, by whom,
 * which commit it represents, and top-level counts.
 */
export function architectureBaselineStatusCommand(): number {
  const cwd      = process.cwd();
  const baseline = loadArchitectureBaseline(cwd);
  const e        = process.stderr;

  e.write('\n  tracegraph architecture baseline status\n');
  e.write(`  ${'─'.repeat(50)}\n`);

  if (!baseline) {
    e.write('  ○  No architecture baseline found.\n\n');
    e.write('  Run: tracegraph graph build\n');
    e.write('       tracegraph architecture baseline create\n\n');
    return EXIT_CODES.SUCCESS;
  }

  const createdDate = new Date(baseline.createdAt).toLocaleString();
  e.write(`  Created:    ${createdDate}\n`);
  e.write(`  Created by: ${baseline.createdBy}\n`);
  e.write(`  Commit:     ${baseline.commit.slice(0, 12)}\n`);
  e.write(`  Provider:   Graphify ${baseline.graphifyVersion}\n`);
  e.write(`  ${'─'.repeat(50)}\n`);
  e.write(`  Nodes:              ${baseline.nodeCount.toLocaleString()}\n`);
  e.write(`  Edges:              ${baseline.edgeCount.toLocaleString()}\n`);
  e.write(`  Communities:        ${baseline.communityCount}\n`);
  e.write(`  God nodes:          ${baseline.godNodes.length}\n`);
  e.write(`  Cross-comm. edges:  ${baseline.crossCommunityEdges.length}\n`);

  if (baseline.communities.length > 0) {
    const sensitive = baseline.communities.filter((c) => c.isSensitive);
    e.write('\n  Communities:\n');
    for (const c of baseline.communities.slice(0, 10)) {
      const sensTag = c.isSensitive ? ' 🔒' : '';
      e.write(`    ${c.label}${sensTag}  (${c.size} nodes)\n`);
    }
    if (baseline.communities.length > 10) {
      e.write(`    … and ${baseline.communities.length - 10} more\n`);
    }
    if (sensitive.length > 0 && baseline.communities.length <= 10) {
      // Already shown inline — no extra note needed.
    }
  }

  if (baseline.godNodes.length > 0) {
    e.write('\n  God nodes (top 5):\n');
    for (const n of baseline.godNodes.slice(0, 5)) {
      e.write(`    ⚡ ${n.symbolName}  — ${n.communityLabel}  (top ${100 - n.centralityPercentile}%)\n`);
    }
    if (baseline.godNodes.length > 5) {
      e.write(`    … and ${baseline.godNodes.length - 5} more\n`);
    }
  }

  e.write('\n');
  return EXIT_CODES.SUCCESS;
}

/**
 * `tracegraph architecture compare`
 *
 * Diffs the current static graph against the stored architecture baseline
 * and reports: new/removed god nodes, community drift, new cross-community
 * edges (flagged critical when pointing into sensitive communities).
 *
 * --fail-on-critical  Exit 3 if critical architecture changes detected.
 * --json              Print machine-readable JSON to stdout.
 */
export function architectureCompareCommand(options: ArchitectureCompareOptions = {}): number {
  const cwd = process.cwd();

  // ── Load static graph (required) ──────────────────────────────────────────
  const graph = loadNormalizedGraph(cwd);
  if (!graph) {
    process.stderr.write(
      '[tracegraph] No static graph found.\n' +
      '  Run: tracegraph graph build\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const index = loadOrRebuildGraphIndex(cwd);
  if (!index) {
    process.stderr.write(
      '[tracegraph] Static graph index missing and could not be rebuilt.\n' +
      '  Run: tracegraph graph build\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Load baseline (required) ──────────────────────────────────────────────
  const baseline = loadArchitectureBaseline(cwd);
  if (!baseline) {
    process.stderr.write(
      '[tracegraph] No architecture baseline found.\n' +
      '  Run: tracegraph architecture baseline create\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Compute diff ──────────────────────────────────────────────────────────
  const diff = diffArchitectureBaseline(graph, index, baseline);
  const meta = loadGraphMetadata(cwd);

  // ── Output ────────────────────────────────────────────────────────────────
  if (options.json) {
    process.stdout.write(JSON.stringify({
      baseline: {
        commit:          baseline.commit.slice(0, 12),
        graphifyVersion: baseline.graphifyVersion,
        createdAt:       baseline.createdAt,
        // G15.3: included so audit.ts can show base→PR node-count delta in banner
        nodeCount:       baseline.nodeCount,
        edgeCount:       baseline.edgeCount,
      },
      current: {
        nodeCount:      graph.nodes.length,
        edgeCount:      graph.edges.length,
        communityCount: graph.communities.length,
        graphifyVersion: meta?.graphifyVersion ?? 'unknown',
      },
      diff,
    }, null, 2) + '\n');
  } else {
    printCompareReport(diff, baseline, graph, meta);
  }

  // ── Exit code ─────────────────────────────────────────────────────────────
  if (options.failOnCritical && diff.hasCriticalChanges) {
    return EXIT_CODES.FINDINGS_THRESHOLD;
  }
  return EXIT_CODES.SUCCESS;
}

// ─── Text report ──────────────────────────────────────────────────────────────

function printCompareReport(
  diff:     ArchitectureBaselineDiff,
  baseline: Awaited<ReturnType<typeof loadArchitectureBaseline>>,
  graph:    ReturnType<typeof loadNormalizedGraph>,
  meta:     ReturnType<typeof loadGraphMetadata>,
): void {
  if (!baseline || !graph) return;
  const e  = process.stderr;
  const HR = '─'.repeat(54);

  e.write('\n  tracegraph architecture compare\n');
  e.write(`  ${HR}\n`);
  e.write(`  Baseline: commit ${baseline.commit.slice(0, 12)}  (Graphify ${baseline.graphifyVersion})\n`);
  e.write(`  Current:  ${graph.nodes.length.toLocaleString()} nodes, ${graph.communities.length} communities`);
  if (meta?.graphifyVersion) e.write(`  (Graphify ${meta.graphifyVersion})`);
  e.write('\n');
  e.write(`  ${HR}\n\n`);

  // When the current graph has no edges (A1 quality), drift detection is
  // meaningless: there are no communities or cross-community edges to compare.
  // Emit a warning instead of a false-positive green checkmark.
  if (graph.edges.length === 0 && baseline.edgeCount === 0) {
    e.write('  ⚠️  Architecture comparison unavailable — static graph has no edges (A1 quality).\n');
    e.write('     Both baseline and current graph lack call-edge data.\n');
    e.write('     Run `tracegraph graph build --verbose` to diagnose relationship extraction.\n\n');
    return;
  }
  if (graph.edges.length === 0) {
    e.write('  ⚠️  Current graph has no edges (A1 quality) — comparison against baseline is incomplete.\n');
    e.write('     Run `tracegraph graph build --verbose` to diagnose relationship extraction.\n\n');
    return;
  }

  if (diff.totalChanges === 0) {
    e.write('  ✅  No architecture drift detected — graph matches baseline.\n\n');
    return;
  }

  // God nodes — guarded by graph density and community availability.
  // Without community structure (communityCount === 0), centrality rankings are
  // computed against the full node list, which makes even lightly-connected nodes
  // appear as "god nodes" in large sparse graphs.  Mark these as low-confidence.
  const godNodeLowConfidence =
    graph.communities.length === 0 ||
    (graph.nodes.length > 100 && graph.edges.length / graph.nodes.length < 0.1);

  if (diff.newGodNodes.length > 0) {
    e.write(`  ⚡ New god nodes (${diff.newGodNodes.length})`);
    if (godNodeLowConfidence) {
      e.write(' ⚠️  low-confidence — no community structure');
    }
    e.write(':\n');
    for (const n of diff.newGodNodes) {
      e.write(`    + ${n.symbolName}  — ${n.communityLabel}  (top ${100 - n.centralityPercentile}%)\n`);
    }
    if (godNodeLowConfidence) {
      e.write(
        '    ⓘ  God-node detection requires community structure to be meaningful.\n' +
        '       These nodes may have very few edges and are likely false positives.\n' +
        '       Run `tracegraph graph build` with a community-detection-capable graphify version.\n',
      );
    }
    e.write('\n');
  }
  if (diff.removedGodNodes.length > 0) {
    e.write(`  ⚡ Removed god nodes (${diff.removedGodNodes.length})`);
    if (godNodeLowConfidence) e.write(' ⚠️  low-confidence');
    e.write(':\n');
    for (const n of diff.removedGodNodes) {
      e.write(`    - ${n.symbolName}  — ${n.communityLabel}\n`);
    }
    e.write('\n');
  }

  // Communities
  if (diff.newCommunities.length > 0) {
    e.write(`  🔷 New communities (${diff.newCommunities.length}):\n`);
    for (const c of diff.newCommunities) {
      const sensTag = c.isSensitive ? ' 🔒 sensitive' : '';
      e.write(`    + ${c.label}${sensTag}  (${c.size} nodes)\n`);
    }
    e.write('\n');
  }
  if (diff.removedCommunities.length > 0) {
    e.write(`  🔷 Removed communities (${diff.removedCommunities.length}):\n`);
    for (const c of diff.removedCommunities) {
      e.write(`    - ${c.label}  (${c.size} nodes)\n`);
    }
    e.write('\n');
  }
  if (diff.changedCommunities.length > 0) {
    e.write(`  🔷 Changed community sizes (${diff.changedCommunities.length}):\n`);
    for (const c of diff.changedCommunities) {
      const delta = c.currentSize - c.baselineSize;
      const sign  = delta > 0 ? '+' : '';
      e.write(`    ~ ${c.label}  ${c.baselineSize} → ${c.currentSize}  (${sign}${delta})\n`);
    }
    e.write('\n');
  }

  // Cross-community edges
  if (diff.newCrossCommunityEdges.length > 0) {
    e.write(`  🔗 New cross-community edges (${diff.newCrossCommunityEdges.length}):\n`);
    for (const edge of diff.newCrossCommunityEdges) {
      const sensitiveFlag = isSensitiveCommunity(edge.toCommunityLabel)
        ? '  🔴 CRITICAL — edge into sensitive community'
        : '';
      e.write(
        `    + ${edge.callerSymbol}\n` +
        `      → ${edge.calleeSymbol}\n` +
        `      (${edge.fromCommunityLabel} → ${edge.toCommunityLabel})${sensitiveFlag}\n`,
      );
    }
    e.write('\n');
  }
  if (diff.removedCrossCommunityEdges.length > 0) {
    e.write(`  🔗 Removed cross-community edges (${diff.removedCrossCommunityEdges.length}):\n`);
    for (const edge of diff.removedCrossCommunityEdges) {
      e.write(
        `    - ${edge.callerSymbol} → ${edge.calleeSymbol}\n` +
        `      (${edge.fromCommunityLabel} → ${edge.toCommunityLabel})\n`,
      );
    }
    e.write('\n');
  }

  // Summary bar
  e.write(`  ${HR}\n`);
  const summary: string[] = [];
  if (diff.newGodNodes.length > 0)               summary.push(`+${diff.newGodNodes.length} god node${diff.newGodNodes.length !== 1 ? 's' : ''}`);
  if (diff.removedGodNodes.length > 0)           summary.push(`-${diff.removedGodNodes.length} god node${diff.removedGodNodes.length !== 1 ? 's' : ''}`);
  if (diff.newCommunities.length > 0)            summary.push(`+${diff.newCommunities.length} communit${diff.newCommunities.length !== 1 ? 'ies' : 'y'}`);
  if (diff.removedCommunities.length > 0)        summary.push(`-${diff.removedCommunities.length} communit${diff.removedCommunities.length !== 1 ? 'ies' : 'y'}`);
  if (diff.newCrossCommunityEdges.length > 0)    summary.push(`+${diff.newCrossCommunityEdges.length} cross-community edge${diff.newCrossCommunityEdges.length !== 1 ? 's' : ''}`);
  if (diff.removedCrossCommunityEdges.length > 0) summary.push(`-${diff.removedCrossCommunityEdges.length} cross-community edge${diff.removedCrossCommunityEdges.length !== 1 ? 's' : ''}`);

  e.write(`  Changes: ${summary.join('  ')}\n`);

  if (diff.hasCriticalChanges) {
    e.write('\n  🔴 CRITICAL: new edges cross into sensitive communities.\n');
    e.write('  Review these carefully — they may expose sensitive data flows.\n');
    e.write('  Use --fail-on-critical in CI to block merges.\n');
  }

  e.write('\n');
}

function isSensitiveCommunity(label: string): boolean {
  const lower = label.toLowerCase();
  return ['auth', 'billing', 'payment', 'identity', 'security'].some((kw) => lower.includes(kw));
}
