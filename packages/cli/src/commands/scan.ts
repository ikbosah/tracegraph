/**
 * G3A — `tracegraph scan`
 *
 * Baseline-free architecture risk scan. Produces findings using only:
 *   - The Graphify static graph (.tracegraph/static-graph/)
 *   - A git diff (--base / --head refs)
 *   - Runtime traces if available (optional — enriches coverage-gap findings)
 *   - Architecture baseline if present (optional — enables drift/edge findings)
 *
 * No runtime baseline is required. This command is the solution to the
 * cold-start problem: teams get actionable risk output on day zero.
 *
 * Usage:
 *   tracegraph scan [--base <ref>] [--head <ref>]
 *                   [--fail-on-critical] [--json] [--format markdown]
 */
import * as fs          from 'fs';
import * as path        from 'path';
import { execSync }     from 'child_process';
import { EXIT_CODES }   from '@tracegraph/shared-types';
import type {
  Finding,
  FindingSeverity,
  TracegraphConfig,
  ArchitectureBaseline,
} from '@tracegraph/shared-types';
import {
  loadOrRebuildGraphIndex,
  loadNormalizedGraph,
  loadGraphMetadata,
  checkGraphStaleness,
  architectureBaselinePath,
  computeBlastRadius,
  detectGodNodeUntested,
  detectHighBlastRadius,
  detectSensitiveCommunityUnverified,
  detectStaticEdgeAdded,
  detectCommunityDrift,
  computeAssuranceLevel,
  formatAssuranceLevel,
} from '@tracegraph/static-graph';
import type { StaticGraphConfig } from '@tracegraph/shared-types';
import { parseDiff, getDiff } from '@tracegraph/ai-coverage';

// ─── Options ──────────────────────────────────────────────────────────────────

export type ScanOptions = {
  base?:          string;
  head?:          string;
  traces?:        string;
  failOnCritical?: boolean;
  json?:          boolean;
  format?:        'text' | 'markdown';
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const HR  = '─'.repeat(54);
const SEV_EMOJI: Record<FindingSeverity, string> = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '🔵',
  info:     '⚪',
};
const SEV_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function loadConfig(cwd: string): TracegraphConfig {
  const p = path.join(cwd, 'tracegraph.config.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as TracegraphConfig; }
  catch { return {}; }
}

function resolveStaticGraphConfig(cwd: string): StaticGraphConfig {
  const cfg = loadConfig(cwd);
  return {
    enabled:                    cfg.staticGraph?.enabled ?? false,
    provider:                   'graphify',
    godNodeThresholdPercentile: cfg.staticGraph?.godNodeThresholdPercentile ?? 95,
    sensitiveCommunities:
      cfg.staticGraph?.sensitiveCommunities ?? ['auth', 'billing', 'payments', 'identity'],
    ...cfg.staticGraph,
  };
}

/** Get changed file paths (all file types, not just TS/JS/PHP). */
function getChangedFiles(base: string, head: string, cwd: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${base} ${head}`, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Load architecture baseline if it exists and is well-formed. */
function loadArchitectureBaseline(cwd: string): ArchitectureBaseline | null {
  const p = architectureBaselinePath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Validate that required array fields are present; treat empty/truncated
    // baseline files (e.g. `{}`) as missing rather than crashing callers.
    if (
      !raw ||
      !Array.isArray(raw.communities) ||
      !Array.isArray(raw.crossCommunityEdges) ||
      !Array.isArray(raw.godNodes)
    ) {
      return null;
    }
    return raw as ArchitectureBaseline;
  } catch { return null; }
}

/**
 * Collect all symbol names exercised by runtime traces.
 * Returns an empty set when the traces directory doesn't exist.
 */
function collectCoveredSymbols(tracesDir: string): Set<string> {
  const covered = new Set<string>();
  if (!fs.existsSync(tracesDir)) return covered;

  const files = fs.readdirSync(tracesDir).filter((f) => f.endsWith('.trace.json'));
  for (const file of files.slice(0, 200)) { // cap to avoid memory issues
    try {
      const session = JSON.parse(
        fs.readFileSync(path.join(tracesDir, file), 'utf8'),
      ) as { events?: Array<{ type?: string; name?: string; functionName?: string; className?: string; methodName?: string }> };
      for (const evt of session.events ?? []) {
        if (!['function_call', 'method_call'].includes(evt.type ?? '')) continue;
        if (evt.name)         covered.add(evt.name);
        if (evt.functionName) covered.add(evt.functionName);
        if (evt.className && evt.methodName) {
          covered.add(`${evt.className}.${evt.methodName}`);
          covered.add(`${evt.className}::${evt.methodName}`);
        }
      }
    } catch { /* skip unreadable traces */ }
  }
  return covered;
}

/** Check whether any runtime baselines exist. */
function hasRuntimeBaselines(cwd: string): boolean {
  const baselinesDir = path.join(cwd, '.tracegraph', 'baselines');
  if (!fs.existsSync(baselinesDir)) return false;
  const files = fs.readdirSync(baselinesDir).filter((f) => f.endsWith('.baseline.json'));
  return files.length > 0;
}

/** Count trace files. */
function countTraceFiles(tracesDir: string): number {
  if (!fs.existsSync(tracesDir)) return 0;
  return fs.readdirSync(tracesDir).filter((f) => f.endsWith('.trace.json')).length;
}

// ─── Main command ──────────────────────────────────────────────────────────────

export function scanCommand(options: ScanOptions = {}): number {
  const cwd       = process.cwd();
  const base      = options.base ?? 'HEAD~1';
  const head      = options.head ?? 'HEAD';
  const tracesDir = options.traces
    ? path.resolve(cwd, options.traces)
    : path.join(cwd, '.tracegraph', 'traces');

  const sgConfig  = resolveStaticGraphConfig(cwd);

  // ── 1. Load static graph (required) ─────────────────────────────────────
  const graph = loadNormalizedGraph(cwd);
  if (!graph) {
    process.stderr.write(
      `[tracegraph] No static graph found.\n` +
      `  Run: tracegraph graph build\n` +
      `  (Requires Graphify: pip install graphify)\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const index = loadOrRebuildGraphIndex(cwd);
  if (!index) {
    process.stderr.write(
      `[tracegraph] Static graph index is missing and could not be rebuilt.\n` +
      `  Run: tracegraph graph build\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const meta = loadGraphMetadata(cwd);
  const { staleness } = checkGraphStaleness(meta);

  if (staleness === 'stale' && sgConfig.staleGraphPolicy === 'error') {
    process.stderr.write(
      `[tracegraph] Static graph is stale (staleGraphPolicy: error).\n` +
      `  Run: tracegraph graph build\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }
  if (staleness === 'stale' && sgConfig.staleGraphPolicy !== 'ignore') {
    process.stderr.write(
      `[tracegraph] ⚠️  Static graph may be stale — run \`tracegraph graph build\` to refresh.\n`,
    );
  }

  // ── 2. Load optional inputs ──────────────────────────────────────────────
  const archBaseline    = loadArchitectureBaseline(cwd);
  const coveredSymbols  = collectCoveredSymbols(tracesDir);
  const traceCount      = countTraceFiles(tracesDir);

  // ── 3. Get git diff ──────────────────────────────────────────────────────
  const changedFiles = getChangedFiles(base, head, cwd);
  const diffText     = getDiff(base, head, cwd);
  const changedFunctions = diffText ? parseDiff(diffText) : [];

  const noChanges = changedFiles.length === 0;

  // ── 4. Run all Tier 1 finding generators ─────────────────────────────────
  const allFindings: Finding[] = [];

  // Blast radius
  const blastRadius = computeBlastRadius(changedFiles, graph, index);
  const blastFinding = detectHighBlastRadius(blastRadius, changedFiles);
  if (blastFinding) allFindings.push(blastFinding);

  // God node untested
  allFindings.push(...detectGodNodeUntested(changedFunctions, index, coveredSymbols));

  // Sensitive community unverified
  allFindings.push(...detectSensitiveCommunityUnverified(
    changedFunctions, index, graph, coveredSymbols,
  ));

  // Architecture baseline-dependent findings
  if (archBaseline) {
    allFindings.push(...detectStaticEdgeAdded(graph, archBaseline));
    allFindings.push(...detectCommunityDrift(graph, archBaseline));
  }

  // ── 5. Compute assurance level ───────────────────────────────────────────
  const assurance = computeAssuranceLevel({
    staticGraphAvailable:     true,
    riskClassified:           true,   // we just ran risk classification
    runtimeTraceAvailable:    traceCount > 0,
    runtimeBaselineAvailable: hasRuntimeBaselines(cwd),
    contractAvailable:        false,  // M9C not yet implemented
  });

  // ── 6. Output ─────────────────────────────────────────────────────────────
  if (options.json) {
    const report = {
      base, head, changedFiles, changedFunctionCount: changedFunctions.length,
      blastRadius: {
        level: blastRadius.level, score: blastRadius.score,
        changedNodeCount: blastRadius.changedNodeCount,
        affectedCommunityCount: blastRadius.affectedCommunityCount,
        godNodesAffected: blastRadius.godNodesAffected.map((n) => ({
          symbolName: n.symbolName, communityLabel: n.communityLabel,
          centralityPercentile: n.centralityPercentile,
        })),
      },
      findings: allFindings,
      assurance,
      graphNodeCount:      graph.nodes.length,
      graphCommunityCount: graph.communities.length,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printTextReport({
      base, head, changedFiles, changedFunctions, blastRadius,
      allFindings, assurance, meta, archBaseline, traceCount, noChanges,
    });
  }

  // ── 7. Exit code ──────────────────────────────────────────────────────────
  const criticalCount = allFindings.filter(
    (f) => f.severity === 'critical' && options.failOnCritical,
  ).length;
  if (criticalCount > 0) return EXIT_CODES.FINDINGS_THRESHOLD;

  return EXIT_CODES.SUCCESS;
}

// ─── Text report ──────────────────────────────────────────────────────────────

function printTextReport(ctx: {
  base:              string;
  head:              string;
  changedFiles:      string[];
  changedFunctions:  ReturnType<typeof parseDiff>;
  blastRadius:       ReturnType<typeof computeBlastRadius>;
  allFindings:       Finding[];
  assurance:         ReturnType<typeof computeAssuranceLevel>;
  meta:              ReturnType<typeof loadGraphMetadata>;
  archBaseline:      ArchitectureBaseline | null;
  traceCount:        number;
  noChanges:         boolean;
}): void {
  const { base, head, changedFiles, blastRadius, allFindings, assurance, meta, archBaseline, traceCount, noChanges } = ctx;
  const e = process.stderr;

  e.write(`\n  tracegraph scan\n`);

  // Header
  const diffLabel = noChanges
    ? `${base}..${head}  (no changes detected)`
    : `${base}..${head}  (${changedFiles.length} file${changedFiles.length !== 1 ? 's' : ''} changed)`;
  const graphLabel = meta
    ? `Graphify ${meta.graphifyVersion} | ${meta.nodeCount.toLocaleString()} nodes | ${meta.communityCount} communities | ${meta.godNodeCount} god nodes`
    : 'graph loaded';
  e.write(`  diff:  ${diffLabel}\n`);
  e.write(`  graph: ${graphLabel}\n`);
  if (archBaseline) {
    e.write(`  baseline: architecture baseline present (commit ${archBaseline.commit.slice(0, 8)})\n`);
  }
  if (traceCount > 0) {
    e.write(`  traces: ${traceCount} runtime trace${traceCount !== 1 ? 's' : ''} available\n`);
  }
  e.write(`  ${HR}\n\n`);

  if (noChanges) {
    e.write(`  ○  No changes detected between ${base} and ${head}.\n\n`);
    printAssuranceAndNextSteps(e, assurance, archBaseline, traceCount);
    return;
  }

  // Blast radius
  if (blastRadius.changedNodeCount > 0) {
    const blastEmoji =
      blastRadius.level === 'CRITICAL' ? '🔴' :
      blastRadius.level === 'HIGH'     ? '🟠' :
      blastRadius.level === 'MEDIUM'   ? '🟡' : '⚪';
    e.write(`  Blast Radius: ${blastEmoji} ${blastRadius.level}  (score: ${blastRadius.score})\n`);

    const godLabel = blastRadius.godNodesAffected.length > 0
      ? `  |  God nodes: ${blastRadius.godNodesAffected.length}`
      : '';
    e.write(
      `  Changed nodes: ${blastRadius.changedNodeCount} across ` +
      `${blastRadius.affectedCommunityCount} communit${blastRadius.affectedCommunityCount !== 1 ? 'ies' : 'y'}` +
      `${godLabel}\n`,
    );

    if (blastRadius.godNodesAffected.length > 0) {
      for (const n of blastRadius.godNodesAffected.slice(0, 5)) {
        e.write(
          `    ⚡ ${n.displayName}  — ${n.communityLabel ?? '?'}  (top ${100 - n.centralityPercentile}%)\n`,
        );
      }
    }
    e.write('\n');
  } else {
    e.write(`  Blast Radius: ⚪ LOW  (no static nodes in changed files)\n\n`);
  }

  // Findings
  if (allFindings.length === 0) {
    e.write(`  ✅  No architecture findings detected.\n`);
  } else {
    e.write(`  Findings  (${allFindings.length})\n  ${HR}\n`);

    // Sort by severity
    const sorted = [...allFindings].sort(
      (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity),
    );

    for (const f of sorted) {
      const confLabel = f.confidence != null
        ? `  [confidence: ${f.confidence.toFixed(2)}]`
        : '';
      const srcLabel = f.evidenceSources?.length
        ? `  (${f.evidenceSources.join(', ')})`
        : '';
      e.write(`\n  ${SEV_EMOJI[f.severity]} ${f.severity.toUpperCase().padEnd(8)}  ${f.ruleId}${confLabel}\n`);
      e.write(`  ${f.title}\n`);
      if (f.description.length <= 180) {
        e.write(`  ${f.description}${srcLabel}\n`);
      }
      if (f.recommendation) {
        e.write(`  → ${f.recommendation}\n`);
      }
    }
    e.write('\n');
  }

  // Summary bar
  e.write(`  ${HR}\n`);
  const bySev = SEV_ORDER.map((s) => {
    const count = allFindings.filter((f) => f.severity === s).length;
    return count > 0 ? `${count} ${s}` : null;
  }).filter(Boolean);
  if (bySev.length > 0) {
    e.write(`  Open: ${allFindings.length} finding${allFindings.length !== 1 ? 's' : ''} (${bySev.join(', ')})\n`);
  } else {
    e.write(`  Open: 0 findings\n`);
  }

  // Assurance + next steps
  e.write('\n');
  printAssuranceAndNextSteps(e, assurance, archBaseline, traceCount);
}

function printAssuranceAndNextSteps(
  e: NodeJS.WriteStream,
  assurance: ReturnType<typeof computeAssuranceLevel>,
  archBaseline: ArchitectureBaseline | null,
  traceCount: number,
): void {
  e.write(`  Assurance Level: ${assurance.level} — ${assurance.label}\n`);

  const nextSteps: string[] = [];
  if (!assurance.staticGraphAvailable) {
    nextSteps.push('Run `tracegraph graph build` to enable architecture-aware scanning');
  } else if (!archBaseline) {
    nextSteps.push('Run `tracegraph architecture baseline create` to enable drift detection');
  }
  if (!assurance.runtimeTraceAvailable) {
    nextSteps.push('Run `tracegraph run -- <test-command>` to add runtime coverage (→ Level 3)');
  }
  if (assurance.runtimeTraceAvailable && !assurance.runtimeBaselineAvailable) {
    nextSteps.push('Run `tracegraph baseline create` to establish a runtime baseline (→ Level 4)');
  }
  if (!assurance.runtimeBaselineAvailable) {
    nextSteps.push('Run `tracegraph baseline suggest` for a priority-ordered baseline plan');
  }

  if (nextSteps.length > 0) {
    e.write('\n  To strengthen this analysis:\n');
    for (const step of nextSteps) {
      e.write(`  ○  ${step}\n`);
    }
  }
  e.write('\n');
}
