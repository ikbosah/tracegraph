/**
 * IMP-1 T-IMP1.2 — `tracegraph ci-summary`
 *
 * Reads the latest report and produces a structured CI summary:
 *
 *   tracegraph ci-summary [--format text|json|github] [--slack-webhook <url>]
 *
 * Formats:
 *   text    — human-readable one-liner to stdout (default)
 *   json    — machine-readable JSON to stdout
 *   github  — writes to $GITHUB_STEP_SUMMARY + sets $GITHUB_OUTPUT step outputs
 *
 * Exit codes:
 *   0 — pass (no open findings)
 *   1 — warn (open findings, none critical)
 *   2 — fail (has critical findings)
 */
import fs   from 'fs';
import path from 'path';
import https from 'https';
import http  from 'http';
import { URL } from 'url';
import type { TraceReport, FindingSeverity } from '@tracegraph/shared-types';

export type CiSummaryOptions = {
  format?:      'text' | 'json' | 'github';
  slackWebhook?: string;
  input?:       string;
};

export type CiSummary = {
  verdict:        'pass' | 'warn' | 'fail';
  openFindings:   number;
  criticalCount:  number;
  highCount:      number;
  mediumCount:    number;
  lowCount:       number;
  tracesCompared: number;
  oneLineSummary: string;
  reportFile:     string;
};

export async function ciSummaryCommand(options: CiSummaryOptions): Promise<number> {
  const cwd  = process.cwd();
  const report = loadReport(options.input, cwd);

  if (!report) {
    process.stderr.write(
      '[tracegraph] No report found. Run `tracegraph compare` first.\n',
    );
    return 2;
  }

  const summary = computeSummary(report, options.input ?? findLatestReportFile(cwd) ?? '');
  const format  = options.format ?? 'text';

  if (format === 'json') {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else if (format === 'github') {
    writeGitHubSummary(summary);
  } else {
    // text
    const icon = summary.verdict === 'pass' ? '✅' : summary.verdict === 'warn' ? '⚠️ ' : '❌';
    process.stdout.write(`${icon}  ${summary.oneLineSummary}\n`);
  }

  if (options.slackWebhook) {
    await postSlackWebhook(options.slackWebhook, summary);
  }

  // Exit code: 0 = pass, 1 = warn, 2 = fail
  return summary.verdict === 'pass' ? 0 : summary.verdict === 'warn' ? 1 : 2;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeSummary(report: TraceReport, reportFile: string): CiSummary {
  const open   = report.findings.filter((f) => f.status === 'open');
  const counts = countBySeverity(open.map((f) => f.severity));

  const verdict: CiSummary['verdict'] =
    counts.critical > 0 ? 'fail' :
    open.length     > 0 ? 'warn' :
    'pass';

  let summary: string;
  if (verdict === 'pass') {
    summary = `No open findings — ${report.diffs.length} traces compared`;
  } else {
    const parts: string[] = [];
    if (counts.critical > 0) parts.push(`${counts.critical} critical`);
    if (counts.high     > 0) parts.push(`${counts.high} high`);
    if (counts.medium   > 0) parts.push(`${counts.medium} medium`);
    if (counts.low      > 0) parts.push(`${counts.low} low`);
    const label = verdict === 'fail' ? 'FAIL' : 'WARN';
    summary = `${open.length} open finding${open.length !== 1 ? 's' : ''} (${parts.join(', ')}) — ${label}`;
  }

  return {
    verdict,
    openFindings:   open.length,
    criticalCount:  counts.critical,
    highCount:      counts.high,
    mediumCount:    counts.medium,
    lowCount:       counts.low,
    tracesCompared: report.diffs.length,
    oneLineSummary: summary,
    reportFile,
  };
}

function countBySeverity(severities: FindingSeverity[]): Record<'critical' | 'high' | 'medium' | 'low', number> {
  const c = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const s of severities) {
    if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') {
      c[s]++;
    }
  }
  return c;
}

function writeGitHubSummary(summary: CiSummary): void {
  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  const outputFile  = process.env['GITHUB_OUTPUT'];

  // ── $GITHUB_STEP_SUMMARY markdown table ──────────────────────────────────
  if (summaryFile) {
    const badge =
      summary.verdict === 'pass'  ? '![pass](https://img.shields.io/badge/tracegraph-pass-brightgreen)' :
      summary.verdict === 'warn'  ? '![warn](https://img.shields.io/badge/tracegraph-warn-yellow)'       :
                                    '![fail](https://img.shields.io/badge/tracegraph-fail-red)';

    const md = [
      `## TraceGraph — Behaviour Analysis`,
      ``,
      badge,
      ``,
      `| | Count |`,
      `|---|---|`,
      `| 🔴 Critical | ${summary.criticalCount} |`,
      `| 🟠 High     | ${summary.highCount}     |`,
      `| 🟡 Medium   | ${summary.mediumCount}   |`,
      `| 🔵 Low      | ${summary.lowCount}      |`,
      `| Traces compared | ${summary.tracesCompared} |`,
      ``,
      `**${summary.oneLineSummary}**`,
      ``,
    ].join('\n');

    try {
      fs.appendFileSync(summaryFile, md, 'utf8');
    } catch {
      // Running outside GitHub Actions — ignore
    }
  }

  // ── $GITHUB_OUTPUT step outputs ──────────────────────────────────────────
  if (outputFile) {
    const outputs = [
      `verdict=${summary.verdict}`,
      `open-findings=${summary.openFindings}`,
      `critical-count=${summary.criticalCount}`,
      `high-count=${summary.highCount}`,
    ].join('\n') + '\n';

    try {
      fs.appendFileSync(outputFile, outputs, 'utf8');
    } catch {
      // Running outside GitHub Actions — ignore
    }
  }

  // Always also print to stdout in text form
  const icon = summary.verdict === 'pass' ? '✅' : summary.verdict === 'warn' ? '⚠️ ' : '❌';
  process.stdout.write(`${icon}  ${summary.oneLineSummary}\n`);
}

async function postSlackWebhook(webhookUrl: string, summary: CiSummary): Promise<void> {
  const color =
    summary.verdict === 'pass' ? 'good' :
    summary.verdict === 'warn' ? 'warning' : 'danger';

  const fields = [
    { title: 'Critical',         value: String(summary.criticalCount),  short: true },
    { title: 'High',             value: String(summary.highCount),       short: true },
    { title: 'Medium',           value: String(summary.mediumCount),     short: true },
    { title: 'Traces compared',  value: String(summary.tracesCompared),  short: true },
  ];

  const payload = JSON.stringify({
    attachments: [{
      color,
      title:       'TraceGraph — Behaviour Analysis',
      text:        summary.oneLineSummary,
      fields,
      footer:      'TraceGraph',
      ts:          Math.floor(Date.now() / 1000),
    }],
  });

  return new Promise((resolve) => {
    try {
      const parsed  = new URL(webhookUrl);
      const lib     = parsed.protocol === 'https:' ? https : http;
      const reqOpts = {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const req = lib.request(reqOpts, () => resolve());
      req.on('error', () => resolve()); // best-effort — never fail CI
      req.setTimeout(5000, () => { req.destroy(); resolve(); });
      req.write(payload);
      req.end();
    } catch {
      resolve(); // best-effort
    }
  });
}

function loadReport(reportArg: string | undefined, cwd: string): TraceReport | null {
  const file = reportArg
    ? path.resolve(cwd, reportArg)
    : findLatestReportFile(cwd);

  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TraceReport;
  } catch {
    return null;
  }
}

function findLatestReportFile(cwd: string): string | null {
  const reportsDir = path.join(cwd, '.tracegraph', 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs.readdirSync(reportsDir)
    .filter((f) => f.endsWith('.report.json'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(reportsDir, files[0]!.name) : null;
}
