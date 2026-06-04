/**
 * T2.10 — `tracegraph report`
 *
 * Renders a stored TraceReport in the requested format.
 *
 * Usage:
 *   tracegraph report --format markdown [--input <report.json>]
 *   tracegraph report --format json [--input <report.json>]
 *   tracegraph report --format github-step-summary [--input <report.json>]
 *   tracegraph report --format markdown-svg [--input <report.json>] [--out <file>]
 *
 * IMP-4: --format markdown-svg embeds SVG graphs inline in the Markdown report.
 */
import fs   from 'fs';
import path from 'path';
import { EXIT_CODES, SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceReport, TraceSession } from '@tracegraph/shared-types';
import { renderReport }  from '@tracegraph/ci-reporter';
import type { ReportFormat } from '@tracegraph/ci-reporter';
import { traceSessionToGraph, renderGraphSvg } from '@tracegraph/graph-engine';

export type ReportCommandOptions = {
  input?:       string;
  format?:      string;
  projectName?: string;
  out?:         string;
};

export function reportCommand(options: ReportCommandOptions): number {
  const cwd          = process.cwd();
  const tracegraphDir = path.join(cwd, '.tracegraph');

  // ── Resolve report file ───────────────────────────────────────────────────
  let reportFile: string;

  if (options.input) {
    reportFile = path.resolve(cwd, options.input);
  } else {
    const reportsDir = path.join(tracegraphDir, 'reports');
    if (!fs.existsSync(reportsDir)) {
      process.stderr.write(
        '[tracegraph] No reports found. Run `tracegraph compare` first.\n',
      );
      return EXIT_CODES.CLI_ERROR;
    }
    const files = fs.readdirSync(reportsDir)
      .filter((f) => f.endsWith('.report.json'))
      .map((f) => ({
        name:  f,
        mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      process.stderr.write('[tracegraph] No .report.json files found.\n');
      return EXIT_CODES.CLI_ERROR;
    }
    reportFile = path.join(reportsDir, files[0]!.name);
  }

  if (!fs.existsSync(reportFile)) {
    process.stderr.write(`[tracegraph] Report file not found: ${reportFile}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  let report: TraceReport;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as TraceReport;
  } catch (err) {
    process.stderr.write(`[tracegraph] Failed to read report: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  // ── IMP-4: markdown-svg format ─────────────────────────────────────────────
  if (options.format === 'markdown-svg') {
    return renderMarkdownSvg(report, options, cwd, tracegraphDir);
  }

  // ── Standard formats ──────────────────────────────────────────────────────
  const format = (options.format ?? 'markdown') as ReportFormat;
  const rendered = renderReport(report, {
    format,
    projectName: options.projectName,
  });

  // ── Output ────────────────────────────────────────────────────────────────
  if (options.out) {
    const outPath = path.resolve(cwd, options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, rendered, 'utf8');
    process.stdout.write(`[tracegraph] Report written: ${path.relative(cwd, outPath)}\n`);

    if (format === 'github-step-summary' && process.env['GITHUB_STEP_SUMMARY']) {
      fs.appendFileSync(process.env['GITHUB_STEP_SUMMARY'], rendered, 'utf8');
    }
  } else {
    process.stdout.write(rendered);
  }

  return EXIT_CODES.SUCCESS;
}

// ─── IMP-4: markdown-svg renderer ────────────────────────────────────────────

function renderMarkdownSvg(
  report:         TraceReport,
  options:        ReportCommandOptions,
  cwd:            string,
  tracegraphDir:  string,
): number {
  const tracesDir = path.join(tracegraphDir, 'traces');
  const lines: string[] = [];

  // Header
  lines.push(
    `# TraceGraph Report`,
    ``,
    `Generated: ${new Date(report.createdAt).toISOString().slice(0, 19).replace('T', ' ')} UTC  `,
    `Traces compared: **${report.summary.tracesCompared}**  `,
    `Open findings: **${report.findings.filter(f => f.status === 'open').length}**`,
    ``,
  );

  // Findings summary table
  const openFindings = report.findings.filter(f => f.status === 'open');
  if (openFindings.length > 0) {
    lines.push(`## Open Findings`, ``, `| Severity | Rule | Title |`, `|----------|------|-------|`);
    for (const f of openFindings) {
      lines.push(`| ${f.severity} | \`${f.ruleId}\` | ${f.title} |`);
    }
    lines.push(``);
  } else {
    lines.push(`## ✅ No Open Findings`, ``);
  }

  // Per-trace graphs
  lines.push(`## Trace Graphs`, ``);

  let graphsRendered = 0;
  for (const diff of report.diffs) {
    const traceFile = path.join(tracesDir, `${diff.traceId}.trace.json`);
    if (!fs.existsSync(traceFile)) continue;

    let session: TraceSession;
    try {
      session = JSON.parse(fs.readFileSync(traceFile, 'utf8')) as TraceSession;
    } catch {
      continue;
    }
    if (session.schemaVersion !== SCHEMA_VERSIONS.trace) continue;

    const graph  = traceSessionToGraph(session);
    const svgStr = renderGraphSvg(graph, { legend: true });
    const b64    = Buffer.from(svgStr).toString('base64');

    const entryLabel =
      session.entrypoint.type === 'http_request'
        ? `${session.entrypoint.method} ${session.entrypoint.path}`
        : session.entrypoint.type === 'test_case'
          ? session.entrypoint.testName
          : session.traceId.slice(0, 16);

    lines.push(
      `### ${entryLabel}`,
      ``,
      `![TraceGraph — ${entryLabel}](data:image/svg+xml;base64,${b64})`,
      ``,
    );

    if (diff.addedSignatures.length > 0 || diff.removedSignatures.length > 0) {
      lines.push(
        `**Diff:** +${diff.addedSignatures.length} added · −${diff.removedSignatures.length} removed`,
        ``,
      );
    }

    graphsRendered++;
  }

  if (graphsRendered === 0) {
    lines.push(`_No trace files found for graphing. Re-run \`tracegraph run\` first._`, ``);
  }

  const rendered = lines.join('\n');

  if (options.out) {
    const outPath = path.resolve(cwd, options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, rendered, 'utf8');
    process.stdout.write(
      `[tracegraph] Markdown+SVG report written: ${path.relative(cwd, outPath)}\n` +
      `  ${graphsRendered} graph(s) embedded as base64 SVG.\n`,
    );
  } else {
    process.stdout.write(rendered);
  }

  return EXIT_CODES.SUCCESS;
}
