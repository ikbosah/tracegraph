/**
 * M7A T7A.1 / G3 — `tracegraph coverage` command
 *
 * Maps changed functions (from a git diff) to runtime trace events, producing
 * a `ChangeCoverageReport` showing which changed code paths were exercised.
 *
 * G3 extension: when a static graph is available, the report is enriched with
 * architecture risk data (god nodes, sensitive communities).
 *
 * Usage:
 *   tracegraph coverage [options]
 *
 * Options:
 *   --base <ref>            Git ref to diff from (default: HEAD~1)
 *   --head <ref>            Git ref to diff to (default: HEAD)
 *   --traces <dir>          Directory containing .trace.json files
 *   --out <file>            Write report JSON to this file
 *   --json                  Print full report JSON to stdout
 *   --fail-uncovered        Exit 1 if any changed functions have no trace coverage
 *   --fail-on-uncovered-god Exit 7 if any uncovered god nodes exist (G3)
 */

import * as fs   from 'fs';
import * as path from 'path';
import { computeCoverage }         from '@tracegraph/ai-coverage';
import { EXIT_CODES }              from '@tracegraph/shared-types';
import type {
  ChangeCoverageReport,
  ChangedFunction,
  AssuranceLevel,
} from '@tracegraph/shared-types';
import {
  loadOrRebuildGraphIndex,
  loadGraphMetadata,
  matchFunctionToNode,
  computeAssuranceLevel,
  formatAssuranceLevel,
} from '@tracegraph/static-graph';

// ─── Options ──────────────────────────────────────────────────────────────────

export type CoverageCommandOptions = {
  base?:              string;
  head?:              string;
  traces?:            string;
  out?:               string;
  json?:              boolean;
  failUncovered?:     boolean;
  /** G3: Exit 7 if any uncovered god nodes are found. */
  failOnUncoveredGod?: boolean;
};

// ─── Main command ──────────────────────────────────────────────────────────────

export function coverageCommand(options: CoverageCommandOptions = {}): number {
  const {
    base               = 'HEAD~1',
    head               = 'HEAD',
    traces,
    out,
    json:    printJson = false,
    failUncovered      = false,
    failOnUncoveredGod = false,
  } = options;

  const cwd       = process.cwd();
  const tracesDir = traces
    ? path.resolve(cwd, traces)
    : path.join(cwd, '.tracegraph', 'traces');

  // ── Compute base coverage ─────────────────────────────────────────────────
  let report: ChangeCoverageReport;
  try {
    report = computeCoverage({ baseRef: base, headRef: head, tracesDir, cwd });
  } catch (err) {
    process.stderr.write(`[tracegraph coverage] Error: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  // ── G3: Enrich with static graph data ────────────────────────────────────
  const graphIndex  = loadOrRebuildGraphIndex(cwd);
  const graphMeta   = graphIndex ? loadGraphMetadata(cwd) : null;

  if (graphIndex) {
    enrichCoverageWithStaticGraph(report, graphIndex);
  }

  // ── G3C: Assurance level ──────────────────────────────────────────────────
  const assurance: AssuranceLevel = computeAssuranceLevel({
    staticGraphAvailable:     graphIndex != null,
    riskClassified:           graphIndex != null,
    runtimeTraceAvailable:    (report.covered.length + report.uncovered.length) > 0,
    runtimeBaselineAvailable: fs.existsSync(path.join(cwd, '.tracegraph', 'baselines')),
    contractAvailable:        false,
  });
  report.assurance = assurance;

  // ── Write report ──────────────────────────────────────────────────────────
  const reportsDir = path.join(cwd, '.tracegraph', 'reports');
  const outFile    = out
    ? path.resolve(cwd, out)
    : path.join(reportsDir, `${report.reportId}.coverage.json`);

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`[tracegraph coverage] Failed to write report: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Human-readable summary ────────────────────────────────────────────────
  const { summary } = report;
  const HR = '─'.repeat(46);

  process.stderr.write('\n');
  process.stderr.write(`  tracegraph coverage\n`);
  process.stderr.write(`  diff:  ${report.baseRef}..${report.headRef}\n`);
  process.stderr.write(`  ${HR}\n`);
  process.stderr.write(`  Changed functions: ${summary.changedFunctions}\n`);
  process.stderr.write(`  Covered:           ${summary.coveredCount}\n`);
  process.stderr.write(`  Uncovered:         ${summary.uncoveredCount}\n`);
  process.stderr.write(`  Coverage:          ${summary.coveragePercent}%\n`);

  if (report.uncovered.length > 0) {
    process.stderr.write('\n  Uncovered changed functions:\n');
    for (const fn of report.uncovered) {
      const godMark = fn.staticNode?.isGodNode ? ' ⚡' : '';
      process.stderr.write(`    ✗  ${formatFunction(fn)}${godMark}  (${fn.file}:${fn.startLine})\n`);
    }
  }

  if (report.covered.length > 0) {
    process.stderr.write('\n  Covered changed functions:\n');
    for (const entry of report.covered) {
      const godMark = entry.changed.staticNode?.isGodNode ? ' ⚡' : '';
      process.stderr.write(
        `    ✓  ${formatFunction(entry.changed)}${godMark}  — ${entry.coveredBy.length} trace(s)\n`,
      );
    }
  }

  // ── G3: Architecture Risk section ─────────────────────────────────────────
  if (graphIndex && report.architectureRisk) {
    printArchitectureRisk(report, graphMeta?.graphifyVersion);
  }

  process.stderr.write(`\n  Report: ${outFile}\n`);

  if (!graphIndex) {
    process.stderr.write(
      `  ○  Static graph not available. Run \`tracegraph graph build\` for architecture-aware coverage.\n`,
    );
  }

  // G3C: assurance level
  process.stderr.write(`\n  Assurance: ${formatAssuranceLevel(assurance)}\n`);

  process.stderr.write('\n');

  // ── Optional JSON stdout ──────────────────────────────────────────────────
  if (printJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }

  // ── Exit codes ────────────────────────────────────────────────────────────
  // G3: God-node gate takes priority (more specific than --fail-uncovered)
  if (failOnUncoveredGod && (report.architectureRisk?.godNodesUncovered ?? 0) > 0) {
    return EXIT_CODES.GOD_NODE_UNCOVERED;
  }
  if (failUncovered && report.uncovered.length > 0) {
    return EXIT_CODES.COMMAND_FAILURE;
  }
  return EXIT_CODES.SUCCESS;
}

// ─── G3: Static graph enrichment ─────────────────────────────────────────────

/**
 * Mutates `report.covered[*].changed` and `report.uncovered[*]` in-place,
 * attaching `staticNode` where a match is found. Also populates
 * `report.architectureRisk`.
 */
function enrichCoverageWithStaticGraph(
  report:     ChangeCoverageReport,
  graphIndex: ReturnType<typeof loadOrRebuildGraphIndex>,
): void {
  if (!graphIndex) return;

  const allChanged: { fn: ChangedFunction; isCovered: boolean }[] = [
    ...report.covered.map((e) => ({ fn: e.changed, isCovered: true })),
    ...report.uncovered.map((fn) => ({ fn, isCovered: false })),
  ];

  for (const { fn } of allChanged) {
    const node = matchFunctionToNode(fn, graphIndex);
    if (!node) continue;
    fn.staticNode = {
      symbolName:           node.symbolName,
      communityId:          node.communityId,
      communityLabel:       node.communityLabel,
      centralityPercentile: node.centralityPercentile,
      isGodNode:            node.isGodNode,
      degree:               node.degree,
    };
  }

  // Compute architecture risk summary
  const godNodesAll = allChanged.filter(({ fn }) => fn.staticNode?.isGodNode);
  const godNodesUncoveredList = allChanged.filter(
    ({ fn, isCovered }) => fn.staticNode?.isGodNode && !isCovered,
  );

  report.architectureRisk = {
    godNodesChanged:   godNodesAll.length,
    godNodesUncovered: godNodesUncoveredList.length,
    criticalNodes:     godNodesAll.map(({ fn, isCovered }) => ({
      symbolName:           fn.staticNode!.symbolName ?? formatFunction(fn),
      centralityPercentile: fn.staticNode!.centralityPercentile ?? 0,
      communityLabel:       fn.staticNode!.communityLabel,
      covered:              isCovered,
    })),
  };
}

// ─── G3: Architecture Risk output ────────────────────────────────────────────

function printArchitectureRisk(
  report:          ChangeCoverageReport,
  graphifyVersion: string | undefined,
): void {
  const risk = report.architectureRisk;
  if (!risk) return;

  const HR      = '─'.repeat(46);
  const version = graphifyVersion ? ` (Graphify ${graphifyVersion})` : '';

  process.stderr.write(`\n  Architecture Coverage Risk${version}\n`);
  process.stderr.write(`  ${HR}\n`);
  process.stderr.write(`  God nodes changed:    ${risk.godNodesChanged}\n`);

  if (risk.godNodesChanged === 0) {
    process.stderr.write(`  No god nodes in changed functions.\n`);
    return;
  }

  const uncoveredLabel = risk.godNodesUncovered > 0
    ? `${risk.godNodesUncovered}  ← 🔴 CRITICAL`
    : `0  ✅`;
  process.stderr.write(`  God nodes uncovered:  ${uncoveredLabel}\n`);

  if (risk.criticalNodes.length > 0) {
    process.stderr.write('\n');
    for (const node of risk.criticalNodes) {
      const centralityLabel = `top ${100 - node.centralityPercentile}%`;
      const community       = node.communityLabel ? `  |  Community: ${node.communityLabel}` : '';
      const statusIcon      = node.covered ? '✅ COVERED  ' : '🔴 CRITICAL ';

      process.stderr.write(
        `  ${statusIcon} ${node.symbolName}\n` +
        `              Centrality: ${centralityLabel}${community}\n`,
      );
    }
  }

  if (risk.godNodesUncovered > 0) {
    process.stderr.write(
      `\n  Recommendation: add runtime coverage for uncovered god nodes.\n` +
      `  Run: tracegraph baseline suggest\n`,
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFunction(fn: ChangedFunction): string {
  if (fn.className && fn.methodName) return `${fn.className}.${fn.methodName}()`;
  return `${fn.functionName ?? '(unknown)'}()`;
}
