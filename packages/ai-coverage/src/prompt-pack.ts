/**
 * M7A T7A.3 — Prompt Pack Builder
 *
 * Generates structured AI context packs from a TraceReport (findings) and
 * optional trace files.  Supported formats:
 *
 *  - cursor       → .cursor/tracegraph-context.md (Cursor IDE rules)
 *  - claude-code  → CLAUDE.md (XML blocks for Claude Code / claude CLI)
 *  - copilot      → .github/copilot-instructions.md (GitHub Copilot instructions)
 *  - mcp          → .tracegraph/mcp-context.json (MCP resources list)
 *
 * All formats are self-contained text files that developers commit to the repo
 * so their AI tool automatically picks up runtime findings and context.
 */

import * as fs from 'fs';
import type {
  TraceReport,
  TraceSession,
  EvaluatedFinding,
  PromptPack,
  PromptPackFormat,
} from '@tracegraph/shared-types';

// ─── Public types ─────────────────────────────────────────────────────────────

export type PromptPackOptions = {
  /**
   * Formats to generate.  Default: all four formats.
   */
  formats?: PromptPackFormat[];

  /**
   * Path to a `.report.json` file, or an already-parsed `TraceReport` object.
   * When omitted, packs are generated without finding context.
   */
  report?: TraceReport | string;

  /**
   * Paths to `.trace.json` files to include as runtime context.
   */
  traceFiles?: string[];

  /**
   * Maximum characters of trace event context included per pack.
   * Default: 40 000.  Raise for claude-code; lower for copilot.
   */
  maxContextChars?: number;

  /**
   * Project name shown in pack headers.
   * Default: `'project'`.
   */
  projectName?: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CHARS   = 40_000;
const ALL_FORMATS: PromptPackFormat[] = ['cursor', 'claude-code', 'copilot', 'mcp'];

// ─── Loaders ─────────────────────────────────────────────────────────────────

function loadReport(input?: TraceReport | string): TraceReport | null {
  if (!input) return null;
  if (typeof input === 'string') {
    try {
      return JSON.parse(fs.readFileSync(input, 'utf8')) as TraceReport;
    } catch {
      return null;
    }
  }
  return input;
}

function loadTraces(traceFiles: string[]): TraceSession[] {
  return traceFiles.flatMap(f => {
    try {
      return [JSON.parse(fs.readFileSync(f, 'utf8')) as TraceSession];
    } catch {
      return [];
    }
  });
}

// ─── Shared formatters ────────────────────────────────────────────────────────

function formatEntrypoint(trace: TraceSession): string {
  const ep = trace.entrypoint;
  if (ep.type === 'http_request') return `${ep.method} ${ep.path}`;
  if (ep.type === 'test_case')    return `test: ${ep.testName}`;
  if (ep.type === 'function')     return `function: ${ep.functionName}`;
  if (ep.type === 'cli_command')  return `cli: ${ep.command}`;
  return 'unknown';
}

/**
 * Produce a concise multi-trace summary, capped at `maxChars`.
 * Returns an empty string if there are no traces or no budget.
 */
function formatTraceSummary(traces: TraceSession[], maxChars: number): string {
  if (traces.length === 0 || maxChars <= 0) return '';

  const summaries: string[] = [];
  let used = 0;

  for (const trace of traces) {
    if (used >= maxChars) break;

    const ep    = formatEntrypoint(trace);
    const events = trace.events
      .filter(e => e.type !== 'trace_start' && e.type !== 'trace_end')
      .slice(0, 20)
      .map(e => `    ${e.type}: ${e.displayName ?? e.name}${e.file ? ` (${e.file}${e.line != null ? `:${e.line}` : ''})` : ''}`)
      .join('\n');

    const block = [
      `Trace: ${trace.traceId}`,
      `Entrypoint: ${ep}`,
      `Capture level: ${trace.captureLevel.overall} — ${trace.captureLevel.label}`,
      `Status: ${trace.status}`,
      'Events:',
      events || '    (none)',
    ].join('\n');

    if (used + block.length > maxChars) {
      // Include a truncation notice and stop
      summaries.push(`[... ${traces.length - summaries.length} more trace(s) truncated]`);
      break;
    }
    summaries.push(block);
    used += block.length + 2; // +2 for '\n\n' separator
  }

  return summaries.join('\n\n');
}

/** Format open findings as a concise markdown list. */
function formatFindingsMd(findings: EvaluatedFinding[]): string {
  const open = findings.filter(f => f.status === 'open');
  if (open.length === 0) return '_No open findings._';

  return open
    .map(f => [
      `- **[${f.severity.toUpperCase()}] ${f.title}**`,
      `  Rule: \`${f.ruleId}\``,
      `  ${f.description}`,
      f.recommendation ? `  Fix: ${f.recommendation}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n');
}

// ─── Format: Cursor ───────────────────────────────────────────────────────────

function buildCursorPack(
  findings:    EvaluatedFinding[],
  traces:      TraceSession[],
  maxChars:    number,
  projectName: string,
): PromptPack {
  const open     = findings.filter(f => f.status === 'open');
  const critical = open.filter(f => f.severity === 'critical' || f.severity === 'high');

  const lines: string[] = [
    `# TraceGraph Runtime Assurance — ${projectName}`,
    '',
    '> Auto-generated by TraceGraph from runtime behaviour analysis.',
    '> Cursor will use this as context when reviewing or writing code.',
    '',
    '## Open Findings',
    '',
    formatFindingsMd(findings),
    '',
  ];

  if (critical.length > 0) {
    lines.push('## Priority Rules', '');
    for (const f of critical) {
      lines.push(`- **${f.ruleId}**: ${f.recommendation ?? f.description}`);
    }
    lines.push('');
  }

  const budget       = maxChars - lines.join('\n').length;
  const traceSummary = formatTraceSummary(traces, budget);
  if (traceSummary) {
    lines.push('## Runtime Trace Context', '', '```', traceSummary, '```', '');
  }

  return {
    format:   'cursor',
    content:  lines.join('\n'),
    fileName: '.cursor/tracegraph-context.md',
  };
}

// ─── Format: Claude Code (XML) ────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildClaudeCodePack(
  findings:    EvaluatedFinding[],
  traces:      TraceSession[],
  maxChars:    number,
  projectName: string,
): PromptPack {
  const open = findings.filter(f => f.status === 'open');

  const xml: string[] = [
    '<tracegraph_context>',
    `  <project>${escapeXml(projectName)}</project>`,
    `  <generated_at>${new Date().toISOString()}</generated_at>`,
    '',
    '  <findings>',
  ];

  if (open.length === 0) {
    xml.push('    <!-- No open findings -->');
  } else {
    for (const f of open) {
      xml.push(
        `    <finding severity="${f.severity}" rule="${escapeXml(f.ruleId)}" status="${f.status}">`,
        `      <title>${escapeXml(f.title)}</title>`,
        `      <description>${escapeXml(f.description)}</description>`,
        ...(f.recommendation
          ? [`      <recommendation>${escapeXml(f.recommendation)}</recommendation>`]
          : []),
        '    </finding>',
      );
    }
  }

  xml.push('  </findings>', '');

  if (traces.length > 0) {
    const budget       = maxChars - xml.join('\n').length - 50;
    const traceSummary = formatTraceSummary(traces, budget);
    if (traceSummary) {
      xml.push(
        '  <runtime_traces>',
        `    <summary><![CDATA[\n${traceSummary}\n    ]]></summary>`,
        '  </runtime_traces>',
        '',
      );
    }
  }

  xml.push('</tracegraph_context>');

  return {
    format:   'claude-code',
    content:  xml.join('\n'),
    fileName: 'CLAUDE.md',
  };
}

// ─── Format: GitHub Copilot ───────────────────────────────────────────────────

function buildCopilotPack(
  findings:    EvaluatedFinding[],
  traces:      TraceSession[],
  maxChars:    number,
  projectName: string,
): PromptPack {
  const open = findings.filter(f => f.status === 'open');

  const lines: string[] = [
    `# Copilot Instructions — ${projectName}`,
    '',
    '<!-- Generated by TraceGraph from runtime behaviour analysis. -->',
    '',
    '## Runtime Security and Reliability Context',
    '',
    'When suggesting code for this project, be aware of the following runtime findings:',
    '',
  ];

  if (open.length === 0) {
    lines.push('No open findings from runtime analysis.', '');
  } else {
    for (const f of open) {
      lines.push(
        `### ${f.title}`,
        '',
        `**Severity:** ${f.severity}  |  **Rule:** \`${f.ruleId}\``,
        '',
        f.description,
        ...(f.recommendation ? ['', `**Recommendation:** ${f.recommendation}`] : []),
        '',
      );
    }
  }

  const budget       = maxChars - lines.join('\n').length;
  const traceSummary = formatTraceSummary(traces, budget);
  if (traceSummary) {
    lines.push('## Observed Runtime Behaviour', '', '```', traceSummary, '```', '');
  }

  return {
    format:   'copilot',
    content:  lines.join('\n'),
    fileName: '.github/copilot-instructions.md',
  };
}

// ─── Format: MCP ──────────────────────────────────────────────────────────────

type McpResource = {
  uri:      string;
  name:     string;
  mimeType: string;
  text:     string;
};

function buildMcpPack(
  findings:    EvaluatedFinding[],
  traces:      TraceSession[],
  maxChars:    number,
  projectName: string,
): PromptPack {
  const open = findings.filter(f => f.status === 'open');
  const resources: McpResource[] = [];

  // ── Findings resource ──────────────────────────────────────────────────────
  const findingsText = open.length > 0
    ? open.map(f =>
        `[${f.severity.toUpperCase()}] ${f.ruleId}: ${f.title}\n${f.description}${f.recommendation ? `\nFix: ${f.recommendation}` : ''}`,
      ).join('\n\n')
    : 'No open findings.';

  resources.push({
    uri:      'tracegraph://findings',
    name:     `TraceGraph Findings — ${projectName}`,
    mimeType: 'text/plain',
    text:     findingsText,
  });

  // ── Per-trace resources ────────────────────────────────────────────────────
  let usedChars = findingsText.length;
  for (const trace of traces) {
    if (usedChars >= maxChars) break;
    const budget  = maxChars - usedChars;
    const summary = formatTraceSummary([trace], budget);
    if (!summary) continue;

    resources.push({
      uri:      `tracegraph://trace/${trace.traceId}`,
      name:     `Trace: ${formatEntrypoint(trace)}`,
      mimeType: 'text/plain',
      text:     summary,
    });
    usedChars += summary.length;
  }

  return {
    format:   'mcp',
    content:  JSON.stringify({ resources }, null, 2),
    fileName: '.tracegraph/mcp-context.json',
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build one or more prompt packs from a TraceReport and optional trace files.
 *
 * @example
 * ```ts
 * const packs = buildPromptPacks({
 *   formats:     ['cursor', 'claude-code'],
 *   report:      '.tracegraph/reports/latest.report.json',
 *   projectName: 'invoice-api',
 * });
 * for (const pack of packs) {
 *   fs.writeFileSync(pack.fileName, pack.content, 'utf8');
 * }
 * ```
 */
export function buildPromptPacks(options: PromptPackOptions = {}): PromptPack[] {
  const {
    formats         = ALL_FORMATS,
    maxContextChars = DEFAULT_MAX_CHARS,
    projectName     = 'project',
  } = options;

  const report   = loadReport(options.report);
  const findings = report?.findings ?? [];
  const traces   = loadTraces(options.traceFiles ?? []);

  return formats.map(format => {
    switch (format) {
      case 'cursor':      return buildCursorPack(findings, traces, maxContextChars, projectName);
      case 'claude-code': return buildClaudeCodePack(findings, traces, maxContextChars, projectName);
      case 'copilot':     return buildCopilotPack(findings, traces, maxContextChars, projectName);
      case 'mcp':         return buildMcpPack(findings, traces, maxContextChars, projectName);
    }
  });
}
