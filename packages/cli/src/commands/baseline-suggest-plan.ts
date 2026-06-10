/**
 * G3B — `tracegraph baseline suggest`
 *
 * Ranks unbaselined entrypoints by architecture risk, so teams know exactly
 * which runtime baselines to create first.
 *
 * Distinct from `tracegraph baseline suggest-update` (which helps update an
 * existing baseline). This command helps decide WHICH baselines to create.
 *
 * Usage:
 *   tracegraph baseline suggest [--top N] [--json] [--format markdown]
 */
import * as fs     from 'fs';
import * as path   from 'path';
import { EXIT_CODES } from '@tracegraph/shared-types';
import type { TracegraphConfig, StaticGraphConfig } from '@tracegraph/shared-types';
import {
  loadOrRebuildGraphIndex,
  loadNormalizedGraph,
  loadGraphMetadata,
  suggestBaselines,
} from '@tracegraph/static-graph';
import type { ScoredEntrypoint, PriorityLevel } from '@tracegraph/static-graph';

// ─── Options ──────────────────────────────────────────────────────────────────

export type BaselineSuggestOptions = {
  top?:    number;
  json?:   boolean;
  format?: 'text' | 'markdown';
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const HR = '─'.repeat(54);
const PRIORITY_EMOJI: Record<PriorityLevel, string> = {
  CRITICAL: '🔴',
  HIGH:     '🟠',
  MEDIUM:   '🟡',
  LOW:      '⚪',
};

function loadConfig(cwd: string): TracegraphConfig {
  const p = path.join(cwd, 'tracegraph.config.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as TracegraphConfig; }
  catch { return {}; }
}

function resolveStaticConfig(cwd: string): StaticGraphConfig {
  const cfg = loadConfig(cwd);
  return {
    enabled:  cfg.staticGraph?.enabled ?? false,
    provider: 'graphify',
    ...cfg.staticGraph,
  };
}

// ─── Main command ──────────────────────────────────────────────────────────────

export function baselineSuggestCommand(options: BaselineSuggestOptions = {}): number {
  const cwd          = process.cwd();
  const tgDir        = path.join(cwd, '.tracegraph');
  const tracesDir    = path.join(tgDir, 'traces');
  const baselinesDir = path.join(tgDir, 'baselines');
  const scenariosDir = path.join(tgDir, 'scenarios');

  // ── Load static graph (optional but strongly recommended) ──────────────────
  const graph = loadNormalizedGraph(cwd);
  const index = graph ? loadOrRebuildGraphIndex(cwd) : null;
  const meta  = graph ? loadGraphMetadata(cwd) : null;

  // ── Count existing state ───────────────────────────────────────────────────
  const existingTraces    = countFiles(tracesDir, '.trace.json');
  const existingBaselines = countFiles(baselinesDir, '.baseline.json');

  // ── Run scoring engine ─────────────────────────────────────────────────────
  const candidates = suggestBaselines({
    tracesDir,
    baselinesDir,
    scenariosDir,
    graph,
    index,
    top: options.top,
  });

  // ── Output ─────────────────────────────────────────────────────────────────
  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        graphAvailable:     graph != null,
        graphNodeCount:     meta?.nodeCount ?? 0,
        existingTraces,
        existingBaselines,
        suggestions:        candidates,
      }, null, 2) + '\n',
    );
    return EXIT_CODES.SUCCESS;
  }

  if (options.format === 'markdown') {
    printMarkdown(candidates, { existingTraces, existingBaselines, meta });
  } else {
    printText(candidates, { existingTraces, existingBaselines, meta, graph, cwd });
  }

  return EXIT_CODES.SUCCESS;
}

// ─── Text output ──────────────────────────────────────────────────────────────

function printText(
  candidates: ScoredEntrypoint[],
  ctx: {
    existingTraces:    number;
    existingBaselines: number;
    meta:              ReturnType<typeof loadGraphMetadata>;
    graph:             ReturnType<typeof loadNormalizedGraph>;
    cwd:               string;
  },
): void {
  const e = process.stderr;

  e.write(`\n  tracegraph baseline suggest\n  ${HR}\n`);

  // Header
  if (ctx.meta) {
    e.write(
      `  Static graph: Graphify ${ctx.meta.graphifyVersion} | ` +
      `${ctx.meta.nodeCount.toLocaleString()} nodes | ` +
      `${ctx.meta.communityCount} communities | ` +
      `${ctx.meta.godNodeCount} god nodes\n`,
    );
  } else {
    e.write(
      `  Static graph: ○  not available  ` +
      `(run \`tracegraph graph build\` for architecture-aware scoring)\n`,
    );
  }
  e.write(
    `  Existing baselines: ${ctx.existingBaselines}  |  ` +
    `Existing traces: ${ctx.existingTraces}\n\n`,
  );

  if (candidates.length === 0) {
    if (ctx.existingTraces === 0) {
      e.write(
        `  ○  No traces found.\n` +
        `  Run \`tracegraph run -- <test-command>\` to capture runtime traces,\n` +
        `  then re-run \`tracegraph baseline suggest\` to see the priority plan.\n\n`,
      );
    } else {
      e.write(`  ✅  All traced entrypoints already have runtime baselines.\n\n`);
    }
    e.write(`  Next: tracegraph baseline create --all\n\n`);
    return;
  }

  e.write(`  Priority Baseline Plan  (${candidates.length} unbaselined)\n  ${HR}\n`);

  // Group by priority
  const groups: PriorityLevel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  let rank = 1;

  for (const priority of groups) {
    const group = candidates.filter((c) => c.priority === priority);
    if (group.length === 0) continue;

    e.write(`\n  ${PRIORITY_EMOJI[priority]} ${priority}  (${priorityDescription(priority)})\n`);

    for (const c of group) {
      const traceLabel = c.traceCount > 0
        ? `${c.traceCount} trace${c.traceCount > 1 ? 's' : ''}, no baseline`
        : `no traces yet`;

      const scoreLabel = ctx.graph ? `  [score: ${c.score}]` : '';
      e.write(`\n  ${String(rank++).padStart(2)}. ${c.label}${scoreLabel}\n`);

      if (c.godNodes.length > 0) {
        e.write(`      ⚡ God nodes: ${c.godNodes.map((n) => n.displayName).slice(0, 3).join(', ')}\n`);
      }
      if (c.sensitiveCommunities.length > 0) {
        e.write(`      🔒 Sensitive: ${c.sensitiveCommunities.map((c) => c.label).join(', ')}\n`);
      }
      if (c.communities.length > 0 && c.sensitiveCommunities.length === 0) {
        e.write(`      Communities: ${c.communities.map((c) => c.label).slice(0, 3).join(', ')}\n`);
      }
      if (c.type === 'static_hint') {
        e.write(`      ○  Static hint: no runtime trace exists yet\n`);
      }
      e.write(`      ${traceLabel}\n`);
    }
  }

  // Footer
  e.write(`\n  ${HR}\n`);
  e.write(`  To create all listed baselines:\n`);
  e.write(`    1. tracegraph run -- <test-command>\n`);
  e.write(`    2. tracegraph baseline create --all\n`);
  e.write(`    3. tracegraph baseline suggest  (re-run to see progress)\n\n`);
}

// ─── Markdown output ──────────────────────────────────────────────────────────

function printMarkdown(
  candidates: ScoredEntrypoint[],
  ctx: {
    existingTraces:    number;
    existingBaselines: number;
    meta:              ReturnType<typeof loadGraphMetadata>;
  },
): void {
  const lines: string[] = [
    '# TraceGraph — Baseline Priority Plan',
    '',
    ctx.meta
      ? `> Static graph: Graphify ${ctx.meta.graphifyVersion} | ${ctx.meta.nodeCount.toLocaleString()} nodes | ${ctx.meta.communityCount} communities`
      : '> Static graph: not available',
    `> Existing baselines: ${ctx.existingBaselines} | Existing traces: ${ctx.existingTraces}`,
    '',
  ];

  if (candidates.length === 0) {
    lines.push('✅ All traced entrypoints already have runtime baselines.');
  } else {
    const groups: PriorityLevel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    let rank = 1;

    for (const priority of groups) {
      const group = candidates.filter((c) => c.priority === priority);
      if (group.length === 0) continue;

      lines.push(`## ${PRIORITY_EMOJI[priority]} ${priority}`, '');
      lines.push('| # | Flow | Score | God Nodes | Sensitive | Traces |');
      lines.push('|---|------|------:|-----------|-----------|--------|');

      for (const c of group) {
        const godLabel       = c.godNodes.map((n) => n.displayName).slice(0, 2).join(', ') || '—';
        const sensitiveLabel = c.sensitiveCommunities.map((c) => c.label).join(', ') || '—';
        const traceLabel     = c.traceCount > 0 ? String(c.traceCount) : '0';
        lines.push(
          `| ${rank++} | ${c.label} | ${c.score} | ${godLabel} | ${sensitiveLabel} | ${traceLabel} |`,
        );
      }
      lines.push('');
    }

    lines.push(
      '## Next Steps',
      '',
      '1. `tracegraph run -- <test-command>`',
      '2. `tracegraph baseline create --all`',
      '3. Re-run `tracegraph baseline suggest` to track progress',
      '',
    );
  }

  process.stdout.write(lines.join('\n') + '\n');
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function countFiles(dir: string, extension: string): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(extension)).length;
  } catch { return 0; }
}

function priorityDescription(p: PriorityLevel): string {
  switch (p) {
    case 'CRITICAL': return 'baseline these first';
    case 'HIGH':     return 'important but deferrable';
    case 'MEDIUM':   return 'lower architecture risk';
    case 'LOW':      return 'minimal risk';
  }
}
