/**
 * G1 — `tracegraph graph` command group
 *
 * Subcommands:
 *   graph build         — run Graphify, normalize, index, update config
 *   graph status        — show metadata, staleness, counts
 *   graph open          — open Graphify HTML viewer in browser
 *   graph update        — alias for build
 *   graph communities   — list communities with god-node highlights
 *   graph doctor        — check Python, graphify, graph freshness
 *   graph derive-edges  — build runtime call-graph edges from enriched traces
 */
import * as fs           from 'fs';
import * as path         from 'path';
import { spawnSync }     from 'child_process';
import { EXIT_CODES }    from '@tracegraph/shared-types';
import { getPythonVersion, installGraphify, isGraphifyAvailable } from '../setup/install-graphify';
import type { TracegraphConfig, StaticGraphConfig } from '@tracegraph/shared-types';
import {
  detectGraphify,
  runGraphify,
  normalizeGraphify,
  buildIndex,
  writeGraphMetadata,
  writeNormalizedGraph,
  writeGraphIndex,
  buildGraphMetadata,
  loadGraphMetadata,
  checkGraphStaleness,
  loadOrRebuildGraphIndex,
  loadNormalizedGraph,
  rawGraphPath,
  rawGraphHtmlPath,
  graphifyDir,
  staticGraphDir,
  architectureBaselinePath,
  enrichTracesDir,
  enrichTraceFiles,
  augmentNormalizedGraph,
  deriveEdgesFromTracesDir,
} from '@tracegraph/static-graph';
import type { GraphifyGraph } from '@tracegraph/static-graph';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const HR = '─'.repeat(54);

function loadConfig(cwd: string): TracegraphConfig {
  const p = path.join(cwd, 'tracegraph.config.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as TracegraphConfig; }
  catch { return {}; }
}

function saveConfig(cwd: string, config: TracegraphConfig): void {
  fs.writeFileSync(
    path.join(cwd, 'tracegraph.config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8',
  );
}

function resolveStaticGraphConfig(cwd: string): StaticGraphConfig {
  const cfg = loadConfig(cwd);
  return {
    enabled:                    cfg.staticGraph?.enabled ?? false,
    provider:                   'graphify',
    buildCommand:               cfg.staticGraph?.buildCommand ?? 'graphify . --directed',
    godNodeThresholdPercentile: cfg.staticGraph?.godNodeThresholdPercentile ?? 95,
    sensitiveCommunities:       cfg.staticGraph?.sensitiveCommunities ??
                                  ['auth', 'billing', 'payments', 'identity'],
    staleGraphPolicy:           cfg.staticGraph?.staleGraphPolicy ?? 'warn',
    minMatchConfidence:         cfg.staticGraph?.minMatchConfidence ?? 0.75,
    enrichTraces:               cfg.staticGraph?.enrichTraces ?? true,
    ...cfg.staticGraph,
  };
}

function openInBrowser(filePath: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'win32'  ? ['cmd', '/c', 'start', '', filePath] :
    platform === 'darwin' ? ['open', filePath] :
    ['xdg-open', filePath];
  spawnSync(cmd[0]!, cmd.slice(1), { stdio: 'ignore', timeout: 5000 });
}

// ─── graph build ─────────────────────────────────────────────────────────────

export type GraphBuildOptions = {
  cwd?:    string;
  quiet?:  boolean;
};

export function graphBuildCommand(options: GraphBuildOptions = {}): number {
  const cwd      = options.cwd ?? process.cwd();
  const quiet    = options.quiet ?? false;
  const log      = (s: string) => { if (!quiet) process.stderr.write(s + '\n'); };
  const sgConfig = resolveStaticGraphConfig(cwd);

  log(`\n  tracegraph graph build`);
  log(`  ${HR}`);

  // ── Graph.json resolution — three paths ───────────────────────────────────
  //
  //   A) Graphify is installed → run it, output lands in graphify-out/, copy to store
  //   B) Graphify not installed but graphify-out/graph.json exists (CI artifact,
  //      or run on another machine) → copy to store and normalise
  //   C) Graphify not installed but .tracegraph/…/graph.json already stored
  //      (previous build, checked-in copy) → re-normalise in-place
  //
  // Fail only when A, B, and C are all unavailable.

  const rawDest         = rawGraphPath(cwd);
  const graphifyOutJson = path.join(cwd, 'graphify-out', 'graph.json');
  const graphifyOutHtml = path.join(cwd, 'graphify-out', 'graph.html');
  const graphifyOutMd   = path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');

  let graphifyVersion = 'unknown';

  log('  Detecting Graphify...');
  const detection = detectGraphify();

  if (detection.found) {
    // ── Path A: run Graphify ──────────────────────────────────────────────
    graphifyVersion = detection.version ?? 'unknown';
    log(`  ✅ Graphify ${graphifyVersion} detected`);
    fs.mkdirSync(graphifyDir(cwd), { recursive: true });
    fs.mkdirSync(staticGraphDir(cwd), { recursive: true });

    log(`  Building static graph (${sgConfig.buildCommand})...`);
    const buildResult = runGraphify(
      cwd,
      sgConfig.buildCommand!,
      300_000,
      (line) => log(`  ${line}`),
    );

    if (!buildResult.ok) {
      // Graphify ran but failed — try the graphify-out/ fallback before giving up
      if (fs.existsSync(graphifyOutJson)) {
        log('  Graphify failed; found graph.json in graphify-out/ — copying to store...');
        fs.mkdirSync(graphifyDir(cwd), { recursive: true });
        fs.copyFileSync(graphifyOutJson, rawDest);
        if (fs.existsSync(graphifyOutHtml)) fs.copyFileSync(graphifyOutHtml, path.join(graphifyDir(cwd), 'graph.html'));
        if (fs.existsSync(graphifyOutMd))   fs.copyFileSync(graphifyOutMd,   path.join(graphifyDir(cwd), 'GRAPH_REPORT.md'));
      } else {
        process.stderr.write(`[tracegraph] Graphify build failed:\n  ${buildResult.error}\n`);
        return EXIT_CODES.CLI_ERROR;
      }
    }

  } else if (fs.existsSync(graphifyOutJson)) {
    // ── Path B: Graphify not installed — use graphify-out/graph.json ─────
    log(`  ⚠️  Graphify not installed — using pre-built graph.json from graphify-out/`);
    log(`     (Install Graphify with: uv tool install graphifyy)`);
    fs.mkdirSync(graphifyDir(cwd), { recursive: true });
    fs.mkdirSync(staticGraphDir(cwd), { recursive: true });
    fs.copyFileSync(graphifyOutJson, rawDest);
    if (fs.existsSync(graphifyOutHtml)) fs.copyFileSync(graphifyOutHtml, path.join(graphifyDir(cwd), 'graph.html'));
    if (fs.existsSync(graphifyOutMd))   fs.copyFileSync(graphifyOutMd,   path.join(graphifyDir(cwd), 'GRAPH_REPORT.md'));

  } else if (fs.existsSync(rawDest)) {
    // ── Path C: Graphify not installed — re-normalise already-stored graph.json
    log(`  ⚠️  Graphify not installed — re-normalising existing graph.json in TraceGraph store`);
    log(`     (Install Graphify with: uv tool install graphifyy)`);

  } else {
    // ── No source available ───────────────────────────────────────────────
    process.stderr.write(
      `[tracegraph] Graphify not found and no pre-built graph.json available.\n` +
      `  To build the static graph, choose one option:\n` +
      `    1. Install Graphify and re-run:\n` +
      `         uv tool install graphifyy  &&  tracegraph graph build\n` +
      `    2. Copy an existing graph.json to graphify-out/graph.json, then re-run:\n` +
      `         tracegraph graph build\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Parse raw graph.json ──────────────────────────────────────────────────
  log('  Normalizing graph...');
  let rawGraph: GraphifyGraph;
  try {
    rawGraph = JSON.parse(fs.readFileSync(rawDest, 'utf8')) as GraphifyGraph;
  } catch (err) {
    process.stderr.write(
      `[tracegraph] Could not parse graph.json: ${String(err)}\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Normalize ─────────────────────────────────────────────────────────────
  const normalized = normalizeGraphify(rawGraph, sgConfig);

  // ── Build index ───────────────────────────────────────────────────────────
  log('  Building index...');
  const index = buildIndex(normalized);

  // ── Write artifacts ───────────────────────────────────────────────────────
  writeNormalizedGraph(cwd, normalized);
  writeGraphIndex(cwd, index);

  const meta = buildGraphMetadata(cwd, normalized, graphifyVersion);
  writeGraphMetadata(cwd, meta);

  // ── 8. Enable staticGraph in config if not already ───────────────────────
  const config = loadConfig(cwd);
  if (!config.staticGraph?.enabled) {
    config.staticGraph = {
      ...config.staticGraph,
      enabled:  true,
      provider: 'graphify',
    };
    saveConfig(cwd, config);
    log('  Updated tracegraph.config.json (staticGraph.enabled = true)');
  }

  // ── 9. Summary ────────────────────────────────────────────────────────────
  log(`  ${HR}`);
  log(`  ✅ Static graph built successfully`);
  log(`  Nodes:        ${normalized.nodes.length.toLocaleString()}`);
  log(`  Edges:        ${normalized.edges.length.toLocaleString()}`);
  log(`  Communities:  ${normalized.communities.length}`);
  log(`  God nodes:    ${index.godNodes.length}  (top ${100 - (sgConfig.godNodeThresholdPercentile ?? 95)}%)`);
  log(`  Commit:       ${meta.commit}`);
  log(`  Graph dir:    ${path.relative(cwd, staticGraphDir(cwd))}`);
  log('');

  return EXIT_CODES.SUCCESS;
}

// ─── graph status ─────────────────────────────────────────────────────────────

export function graphStatusCommand(cwd = process.cwd()): number {
  const meta = loadGraphMetadata(cwd);

  process.stderr.write(`\n  tracegraph graph status\n  ${HR}\n`);

  if (!meta) {
    process.stderr.write(
      `  No static graph found.\n` +
      `  Run: tracegraph graph build\n\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const { staleness, currentHead } = checkGraphStaleness(meta);
  const stalenessLabel =
    staleness === 'fresh'   ? `✅ up to date` :
    staleness === 'stale'   ? `⚠️  STALE (run: tracegraph graph build)` :
    staleness === 'unknown' ? `? (git unavailable)` :
    '? (no metadata)';

  const builtDate = new Date(meta.builtAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  process.stderr.write(`  Provider:     Graphify ${meta.graphifyVersion}\n`);
  process.stderr.write(`  Built at:     ${builtDate}\n`);
  process.stderr.write(`  Commit:       ${meta.commit}\n`);
  if (currentHead && currentHead !== meta.commit) {
    process.stderr.write(`  Current HEAD: ${currentHead}  ${stalenessLabel}\n`);
  } else {
    process.stderr.write(`  Current HEAD: ${currentHead ?? '?'}  ${stalenessLabel}\n`);
  }
  process.stderr.write(`  ${HR}\n`);
  process.stderr.write(`  Nodes:        ${meta.nodeCount.toLocaleString()}\n`);
  process.stderr.write(`  Edges:        ${meta.edgeCount.toLocaleString()}\n`);
  process.stderr.write(`  Communities:  ${meta.communityCount}\n`);
  process.stderr.write(`  God nodes:    ${meta.godNodeCount}\n`);

  const archBaseline = architectureBaselinePath(cwd);
  process.stderr.write(`  Arch baseline: ${fs.existsSync(archBaseline) ? '✅ present' : '○  none (run: tracegraph architecture baseline create)'}\n`);
  process.stderr.write('\n');

  return EXIT_CODES.SUCCESS;
}

// ─── graph open ──────────────────────────────────────────────────────────────

export function graphOpenCommand(cwd = process.cwd()): number {
  const htmlPath = rawGraphHtmlPath(cwd);

  if (!fs.existsSync(htmlPath)) {
    process.stderr.write(
      `[tracegraph] graph.html not found at: ${htmlPath}\n` +
      `  Run: tracegraph graph build\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  process.stderr.write(`[tracegraph] Opening: ${htmlPath}\n`);
  openInBrowser(htmlPath);
  return EXIT_CODES.SUCCESS;
}

// ─── graph communities ────────────────────────────────────────────────────────

export function graphCommunitiesCommand(cwd = process.cwd()): number {
  const graph = loadNormalizedGraph(cwd);
  if (!graph) {
    process.stderr.write(
      `[tracegraph] No static graph found.\n` +
      `  Run: tracegraph graph build\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // Load index to get god-node counts per community
  const index = loadOrRebuildGraphIndex(cwd);
  const godNodesByCommunity = new Map<string, number>();
  if (index) {
    for (const n of index.godNodes) {
      if (n.communityId) {
        godNodesByCommunity.set(n.communityId, (godNodesByCommunity.get(n.communityId) ?? 0) + 1);
      }
    }
  }

  const sorted = [...graph.communities].sort((a, b) => b.size - a.size);
  const sensitiveCount = sorted.filter((c) => c.isSensitive).length;

  process.stderr.write(`\n  tracegraph graph communities\n  ${HR}\n`);
  process.stderr.write(`  ${graph.communities.length} communities | ${sensitiveCount} sensitive\n\n`);

  for (const community of sorted) {
    const godCount = godNodesByCommunity.get(community.communityId) ?? 0;
    const godLabel = godCount > 0 ? `  ⚡ ${godCount} god node${godCount > 1 ? 's' : ''}` : '';
    const sensLabel = community.isSensitive ? '  [SENSITIVE]' : '';
    const prefix    = community.isSensitive || godCount > 0 ? '  ⚡' : '   ';
    process.stderr.write(
      `${prefix} ${community.label.padEnd(20)} — ${String(community.size).padStart(4)} members${godLabel}${sensLabel}\n`,
    );
  }
  process.stderr.write('\n');

  return EXIT_CODES.SUCCESS;
}

// ─── graph enrich ─────────────────────────────────────────────────────────────

export type GraphEnrichOptions = {
  trace?: string;   // path to a specific trace file
  all?:   boolean;  // enrich all traces in .tracegraph/traces/
  quiet?: boolean;
};

export function graphEnrichCommand(options: GraphEnrichOptions = {}): number {
  const cwd       = options.trace
    ? process.cwd()
    : process.cwd();
  const log       = (s: string) => { if (!options.quiet) process.stderr.write(s + '\n'); };
  const tracesDir = path.join(cwd, '.tracegraph', 'traces');

  const index = loadOrRebuildGraphIndex(cwd);
  if (!index) {
    process.stderr.write(
      `[tracegraph] No static graph index found.\n` +
      `  Run: tracegraph graph build\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const sgConfig  = resolveStaticGraphConfig(cwd);
  const resolverConfig = { minMatchConfidence: sgConfig.minMatchConfidence ?? 0.75 };

  if (options.trace) {
    // Enrich a single trace file
    const tracePath = path.resolve(cwd, options.trace);
    const { enrichTraceFile: _enrich } = require('@tracegraph/static-graph') as typeof import('@tracegraph/static-graph');
    const result = _enrich(tracePath, index, resolverConfig);
    if (!result.ok) {
      process.stderr.write(`[tracegraph] Enrich failed: ${result.error}\n`);
      return EXIT_CODES.CLI_ERROR;
    }
    log(`  ✅  ${path.basename(tracePath)}  (+${result.stats.enrichedCount} matches)`);
    return EXIT_CODES.SUCCESS;
  }

  if (options.all) {
    // Enrich all traces
    log(`\n  tracegraph graph enrich --all\n  ${HR}`);
    log(`  Enriching all traces in: ${path.relative(cwd, tracesDir)}`);
    const result = enrichTracesDir(tracesDir, index, resolverConfig, log);
    log(`  ${HR}`);
    log(`  Files: ${result.files}  |  Enriched: ${result.enriched}  |  Matches: ${result.eventMatches}  |  Errors: ${result.errors}`);
    log('');
    return EXIT_CODES.SUCCESS;
  }

  // Default: enrich traces from the latest run
  const latestPath = path.join(cwd, '.tracegraph', 'latest.json');
  if (!fs.existsSync(latestPath)) {
    process.stderr.write(
      `[tracegraph] No latest.json found. Use --all to enrich all traces.\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  let traceIds: string[] = [];
  try {
    const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as { latestTraceIds: string[] };
    traceIds = latest.latestTraceIds;
  } catch {
    process.stderr.write(`[tracegraph] Cannot read latest.json.\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  const tracePaths = traceIds.map((id) => path.join(tracesDir, `${id}.trace.json`));
  log(`\n  tracegraph graph enrich\n  ${HR}`);
  log(`  Enriching ${tracePaths.length} trace(s) from latest run...`);
  const result = enrichTraceFiles(tracePaths, index, resolverConfig);
  log(`  Matches: ${result.eventMatches} across ${result.enriched} trace(s)`);
  log('');
  return EXIT_CODES.SUCCESS;
}

// ─── graph doctor ─────────────────────────────────────────────────────────────

export type GraphDoctorOptions = {
  install?: boolean;
};

export function graphDoctorCommand(cwd = process.cwd(), options: GraphDoctorOptions = {}): number {
  const e = process.stderr;
  e.write(`\n  tracegraph graph doctor\n  ${HR}\n`);

  let allOk = true;

  // ── Python ─────────────────────────────────────────────────────────────────
  const pythonVersion = getPythonVersion();

  if (pythonVersion) {
    e.write(`  Python:    ✅ Python ${pythonVersion}\n`);
  } else {
    e.write(`  Python:    ❌ Not found  (install Python 3.10+ from python.org)\n`);
    allOk = false;
  }

  // ── Graphify ───────────────────────────────────────────────────────────────
  const graphifyFound = isGraphifyAvailable();
  // Get version string if available
  let graphifyVersion = '';
  if (graphifyFound) {
    try { graphifyVersion = detectGraphify().version ?? ''; } catch { /* ignore */ }
  }

  if (graphifyFound) {
    e.write(`  Graphify:  ✅ Graphify ${graphifyVersion}\n`);
  } else {
    e.write(`  Graphify:  ❌ Not found\n`);
    allOk = false;
  }

  // ── Static graph ───────────────────────────────────────────────────────────
  const meta = loadGraphMetadata(cwd);
  if (meta) {
    e.write(`  Graph:     ✅ Static graph exists (${meta.nodeCount.toLocaleString()} nodes)\n`);

    const { staleness, currentHead } = checkGraphStaleness(meta);
    if (staleness === 'fresh') {
      e.write(`  Freshness: ✅ Up to date (commit: ${meta.commit.slice(0, 8)})\n`);
    } else if (staleness === 'stale') {
      e.write(
        `  Freshness: ⚠️  Stale — built at ${meta.commit.slice(0, 8)}, HEAD is ${(currentHead ?? '?').slice(0, 8)}\n` +
        `             Run: tracegraph graph build\n`,
      );
    } else {
      e.write(`  Freshness: ? Cannot determine (git unavailable)\n`);
    }
  } else {
    e.write(`  Graph:     ○  No static graph yet — run: tracegraph graph build\n`);
  }

  // ── Architecture baseline ──────────────────────────────────────────────────
  if (fs.existsSync(architectureBaselinePath(cwd))) {
    e.write(`  Arch base: ✅ Architecture baseline present\n`);
  } else {
    e.write(`  Arch base: ○  No architecture baseline — run: tracegraph architecture baseline create\n`);
  }

  e.write('\n');

  // ── --install: attempt to fix missing deps ────────────────────────────────
  if (options.install && !allOk) {
    e.write(`  ${HR}\n`);
    e.write(`  tracegraph graph doctor --install\n`);
    e.write(`  ${HR}\n\n`);

    if (!pythonVersion) {
      e.write(
        `  ❌ Python not found — cannot install Graphify automatically.\n` +
        `     Install Python 3.10+ from https://www.python.org, then re-run:\n` +
        `       tracegraph graph doctor --install\n\n`,
      );
      return EXIT_CODES.CLI_ERROR;
    }

    if (!graphifyFound) {
      e.write(`  Installing Graphify...\n\n`);
      const result = installGraphify({ quiet: false });

      if (result.ok && !result.alreadyInstalled) {
        e.write(`\n  ✅ Graphify installed via ${result.installedWith}.\n\n`);
        e.write(
          `  Next steps:\n` +
          `    tracegraph graph build                    — build the static graph\n` +
          `    tracegraph architecture baseline create   — snapshot architecture\n` +
          `    tracegraph scan                           — run baseline-free risk scan\n\n`,
        );
        return EXIT_CODES.SUCCESS;
      } else if (result.alreadyInstalled) {
        e.write(`  ✅ Graphify is already installed.\n\n`);
        return EXIT_CODES.SUCCESS;
      } else {
        e.write(
          `  ❌ Installation failed: ${result.error ?? 'unknown error'}\n\n` +
          `     Try manually:\n` +
          `       uv tool install graphifyy\n` +
          `       pipx install graphifyy\n\n`,
        );
        return EXIT_CODES.CLI_ERROR;
      }
    }

    return EXIT_CODES.SUCCESS;
  }

  if (!allOk && !options.install) {
    e.write(
      `  ── Action required ──────────────────────────────────\n` +
      (pythonVersion
        ? `  Install Graphify:  tracegraph graph doctor --install\n`
        : `  1. Install Python 3.10+:  https://www.python.org\n` +
          `  2. Install Graphify:      tracegraph graph doctor --install\n`) +
      `  Build the graph:   tracegraph graph build\n\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  return EXIT_CODES.SUCCESS;
}

// ─── graph derive-edges ───────────────────────────────────────────────────────

export type GraphDeriveEdgesOptions = {
  cwd?:           string;
  quiet?:         boolean;
  /** Minimum event.static.matchConfidence to accept (default 0 = all enriched). */
  minConfidence?: number;
};

/**
 * `tracegraph graph derive-edges`
 *
 * Reads enriched trace files, extracts directed edges from the
 * parent→child event tree and sequential sibling ordering, then augments
 * the static graph with those runtime-derived edges.
 *
 * Recomputes degree, centralityPercentile, and isGodNode for every node.
 * Writes the augmented NormalizedGraph, a rebuilt GraphIndex, and updated
 * GraphMetadata in-place. Idempotent: existing RUNTIME edges are stripped
 * before new ones are added.
 *
 * Why this matters for JS/TS:
 *   graphify tree-sitter extracts symbol definitions but no call graphs →
 *   0 edges → 0 god nodes.  Runtime traces carry the actual call topology.
 *   This command bridges the gap without an LLM API key or source changes.
 */
export function graphDeriveEdgesCommand(options: GraphDeriveEdgesOptions = {}): number {
  const cwd           = options.cwd ?? process.cwd();
  const quiet         = options.quiet ?? false;
  const minConfidence = options.minConfidence ?? 0;
  const log           = (s: string) => { if (!quiet) process.stderr.write(s + '\n'); };

  log(`\n  tracegraph graph derive-edges`);
  log(`  ${HR}`);

  // ── 1. Load static graph ───────────────────────────────────────────────────
  const graph = loadNormalizedGraph(cwd);
  if (!graph) {
    process.stderr.write(
      `[tracegraph] No static graph found.\n` +
      `  Run: tracegraph graph build\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const sgConfig  = resolveStaticGraphConfig(cwd);
  const tracesDir = path.join(cwd, '.tracegraph', 'traces');

  // ── 2. Derive runtime edges ────────────────────────────────────────────────
  log(`  Scanning traces in: ${path.relative(cwd, tracesDir)}`);
  const { edges: runtimeEdges, stats } = deriveEdgesFromTracesDir(
    tracesDir,
    minConfidence,
  );

  log(`  Traces read:          ${stats.tracesRead}`);
  log(`  Traces with matches:  ${stats.tracesWithMatches}`);
  log(`  Enriched events:      ${stats.totalEnrichedEvents}`);
  log(`  ${HR}`);

  if (runtimeEdges.length === 0) {
    if (stats.totalEnrichedEvents === 0) {
      log(`  ○  No enriched events found in traces.`);
      log(`     Run: tracegraph graph enrich --all   then re-run derive-edges`);
      log(``);
      log(`  Note for JS/TS Level 3-4 (HTTP-only traces):`);
      log(`  The current traces contain external_http_call events, not function calls.`);
      log(`  To get function-level edges, one of:`);
      log(`    • Set ANTHROPIC_API_KEY etc. — graphify LLM mode extracts call graphs`);
      log(`    • Wrap functions with traceFunction() for explicit call capture`);
      log(`    • tracegraph attach --inspect (CDP-based profiling, coming soon)`);
    } else {
      log(`  ○  ${stats.totalEnrichedEvents} enriched event(s) found but no cross-node edges derived.`);
    }
    log('');
    return EXIT_CODES.SUCCESS;
  }

  // ── 3. Augment static graph ────────────────────────────────────────────────
  log(`  Runtime edges derived: ${runtimeEdges.length.toLocaleString()}`);
  log(`    Parent-child:        ${stats.parentChildPairs}`);
  log(`    Sequential siblings: ${stats.sequentialPairs}`);

  const augmented     = augmentNormalizedGraph(graph, runtimeEdges, sgConfig);
  const prevGodCount  = graph.nodes.filter((n) => n.isGodNode).length;
  const newGodCount   = augmented.nodes.filter((n) => n.isGodNode).length;
  const staticEdgeCount = graph.edges.filter((e) => e.provenance !== 'RUNTIME').length;

  log(`  ${HR}`);
  log(`  Static edges  (graphify): ${staticEdgeCount.toLocaleString()}`);
  log(`  Runtime edges (derived):  ${runtimeEdges.length.toLocaleString()}`);
  log(`  Total edges:              ${augmented.edges.length.toLocaleString()}`);
  log(`  God nodes: ${prevGodCount} → ${newGodCount}  (threshold: top ${100 - (sgConfig.godNodeThresholdPercentile ?? 95)}%)`);

  if (newGodCount > 0) {
    const topGodNodes = augmented.nodes
      .filter((n) => n.isGodNode)
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 10);
    log('');
    log('  Top god nodes by runtime degree:');
    for (const n of topGodNodes) {
      const label = n.symbolName.length > 55 ? `…${n.symbolName.slice(-54)}` : n.symbolName;
      log(`    ⚡ ${label.padEnd(56)}  degree ${n.degree}  (top ${100 - n.centralityPercentile}%)`);
    }
  }

  // ── 4. Write updated artifacts ─────────────────────────────────────────────
  log('');
  writeNormalizedGraph(cwd, augmented);
  writeGraphIndex(cwd, buildIndex(augmented));

  const existingMeta  = loadGraphMetadata(cwd);
  const detection     = (() => { try { return detectGraphify(); } catch { return null; } })();
  const updatedMeta   = {
    ...(existingMeta ?? buildGraphMetadata(cwd, augmented, detection?.version ?? 'unknown')),
    edgeCount:    augmented.edges.length,
    godNodeCount: newGodCount,
  };
  writeGraphMetadata(cwd, updatedMeta);

  log(`  ✅ Static graph augmented with runtime edges.`);
  log('');

  return EXIT_CODES.SUCCESS;
}
