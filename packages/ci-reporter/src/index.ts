/**
 * T2.10 — CI Reporter
 *
 * Renders a TraceReport in various output formats:
 *   markdown            — human-readable report for PR comments / terminal
 *   json                — passthrough of report JSON
 *   github-step-summary — markdown written to $GITHUB_STEP_SUMMARY
 */
import type { TraceReport, EvaluatedFinding, FindingSeverity } from '@tracegraph/shared-types';

export type ReportFormat = 'markdown' | 'json' | 'github-step-summary';

export type RenderOptions = {
  format?: ReportFormat;
  /** Project name shown in the report header. */
  projectName?: string;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a `TraceReport` to the requested format.
 *
 * @param report   The report produced by `tracegraph compare`.
 * @param options  Output format and display options.
 * @returns        The rendered output as a string.
 */
export function renderReport(report: TraceReport, options: RenderOptions = {}): string {
  const { format = 'markdown' } = options;

  switch (format) {
    case 'json':               return JSON.stringify(report, null, 2);
    case 'github-step-summary':
    case 'markdown':           return renderMarkdown(report, options);
  }
}

// ─── Markdown renderer ───────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '🔵',
  info:     '⚪',
};

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function renderMarkdown(report: TraceReport, options: RenderOptions): string {
  const project = options.projectName ?? 'TraceGraph';
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`## ${project} — Behaviour Diff Report`);
  lines.push('');

  const date = new Date(report.createdAt).toUTCString();
  lines.push(`_Generated: ${date}_`);
  lines.push('');

  // ── Summary table ─────────────────────────────────────────────────────────
  const { summary } = report;
  lines.push('### Summary');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Traces compared | ${summary.tracesCompared} |`);

  const totalFindings = Object.values(summary.findingsBySeverity).reduce((a, b) => a + b, 0);
  lines.push(`| Total findings | ${totalFindings} |`);

  for (const sev of SEVERITY_ORDER) {
    const count = summary.findingsBySeverity[sev] ?? 0;
    if (count > 0) {
      lines.push(`| ${SEVERITY_EMOJI[sev]} ${capitalise(sev)} findings | ${count} |`);
    }
  }

  if (summary.suppressionsModified) {
    lines.push(`| Suppressions file | ⚠️ Modified in this change |`);
  }
  lines.push('');

  // ── Open findings by severity ─────────────────────────────────────────────
  const openFindings = report.findings.filter((f) => f.status === 'open');
  if (openFindings.length > 0) {
    lines.push('### Findings');
    lines.push('');

    for (const sev of SEVERITY_ORDER) {
      const group = openFindings.filter((f) => f.severity === sev);
      if (group.length === 0) continue;

      lines.push(`#### ${SEVERITY_EMOJI[sev]} ${capitalise(sev)}`);
      lines.push('');
      for (const f of group) {
        lines.push(renderFinding(f));
      }
    }
  } else {
    lines.push('### Findings');
    lines.push('');
    lines.push('✅ No open findings.');
    lines.push('');
  }

  // ── Approved / suppressed findings ────────────────────────────────────────
  const nonOpen = report.findings.filter((f) => f.status !== 'open');
  if (nonOpen.length > 0) {
    lines.push('<details>');
    lines.push('<summary>Approved / suppressed findings</summary>');
    lines.push('');
    for (const f of nonOpen) {
      const badge = f.status === 'approved' ? '✅ Approved' : '🔇 Suppressed';
      lines.push(`- ${badge} — ${f.title} _(${f.ruleId})_`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // ── Behaviour changes (diffs summary) ────────────────────────────────────
  const hasDiffs = report.diffs.some(
    (d) => d.addedSignatures.length > 0 || d.removedSignatures.length > 0,
  );
  if (hasDiffs) {
    lines.push('### Behaviour Changes');
    lines.push('');
    for (const diff of report.diffs) {
      if (diff.removedSignatures.length === 0 && diff.addedSignatures.length === 0) continue;

      lines.push(`**Trace \`${diff.traceId.slice(0, 12)}…\`**`);
      lines.push('');

      if (diff.removedSignatures.length > 0) {
        lines.push('Removed from baseline:');
        for (const r of diff.removedSignatures) {
          const role = r.role ?? 'unknown';
          lines.push(`  - ❌ \`${r.eventName ?? r.signature.functionName ?? r.signature.eventType}\` _(${role})_`);
        }
      }
      if (diff.addedSignatures.length > 0) {
        lines.push('Added vs baseline:');
        for (const a of diff.addedSignatures) {
          lines.push(`  - ✅ \`${a.eventName ?? a.signature.functionName ?? a.signature.eventType}\``);
        }
      }
      lines.push('');
    }
  }

  // ── Capture level warning ─────────────────────────────────────────────────
  lines.push('### Capture Level');
  lines.push('');
  if (summary.tracesCompared === 0) {
    lines.push('> ⚠️ No traces compared. Run `tracegraph run -- <your-test-command>` to capture a trace.');
  } else {
    lines.push('> ℹ️ Run `tracegraph diagnose` to see recommendations for improving capture depth.');
  }
  lines.push('');

  // ── Do not merge block ────────────────────────────────────────────────────
  if (summary.hasOpenCritical) {
    lines.push('---');
    lines.push('');
    lines.push('> 🚫 **Do not merge** — Critical findings are open. Review and resolve before merging.');
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderFinding(f: EvaluatedFinding): string {
  const lines: string[] = [];
  lines.push(`**${f.title}**`);
  lines.push('');
  lines.push(`> ${f.description}`);
  if (f.recommendation) {
    lines.push('');
    lines.push(`_Recommendation: ${f.recommendation}_`);
  }
  lines.push('');
  lines.push(`\`fingerprint: ${f.fingerprint}\` · \`rule: ${f.ruleId}\``);
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
