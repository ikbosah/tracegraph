/**
 * M5.10 — `tracegraph finding explain <fingerprint>`
 *
 * Shows a detailed human-readable explanation of a single finding from the
 * most recent (or specified) report.
 *
 * Usage:
 *   tracegraph finding explain <fingerprint>
 *   tracegraph finding explain <fingerprint> --report <report.json>
 *   tracegraph finding explain <fingerprint> --json
 */
import fs   from 'fs';
import path from 'path';
import { EXIT_CODES } from '@tracegraph/shared-types';
import type { TraceReport, EvaluatedFinding, FindingSeverity } from '@tracegraph/shared-types';

export type FindingExplainOptions = {
  report?: string;
  json?:   boolean;
};

// ─── Severity display ─────────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '🔵',
  info:     '⚪',
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: 'CRITICAL',
  high:     'HIGH',
  medium:   'MEDIUM',
  low:      'LOW',
  info:     'INFO',
};

const STATUS_LABEL: Record<string, string> = {
  open:       'Open',
  approved:   'Approved',
  suppressed: 'Suppressed',
};

// ─── Command ─────────────────────────────────────────────────────────────────

export function findingExplainCommand(
  fingerprint: string,
  options: FindingExplainOptions,
): number {
  const cwd    = process.cwd();
  const report = loadReport(options.report, cwd);

  if (!report) {
    process.stderr.write(
      '[tracegraph] No report found. Run `tracegraph compare` first.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // Resolve by fingerprint or finding id (allow short prefix match)
  const finding = report.findings.find(
    (f) =>
      f.fingerprint === fingerprint ||
      f.id          === fingerprint ||
      f.fingerprint.startsWith(fingerprint),
  );

  if (!finding) {
    process.stderr.write(
      `[tracegraph] Finding not found in report: ${fingerprint}\n` +
      `  Run \`tracegraph finding list\` to see all fingerprints.\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(finding, null, 2) + '\n');
    return EXIT_CODES.SUCCESS;
  }

  process.stdout.write(renderFindingExplanation(finding));
  return EXIT_CODES.SUCCESS;
}

// ─── Renderer ────────────────────────────────────────────────────────────────

function renderFindingExplanation(f: EvaluatedFinding): string {
  const sev    = SEVERITY_LABEL[f.severity] ?? f.severity.toUpperCase();
  const emoji  = SEVERITY_EMOJI[f.severity] ?? '';
  const status = STATUS_LABEL[f.status]     ?? f.status;
  const divider = '─'.repeat(64);

  const lines: string[] = [];

  lines.push('');
  lines.push(`${emoji}  ${f.title}`);
  lines.push(divider);
  lines.push(`  Rule:        ${f.ruleId}`);
  lines.push(`  Fingerprint: ${f.fingerprint}`);
  lines.push(`  Severity:    ${sev}`);
  lines.push(`  Category:    ${f.category}`);
  lines.push(`  Status:      ${status}`);

  if (f.status === 'approved' && f.approvedBy) {
    lines.push(`  Approved by: ${f.approvedBy}`);
    if (f.approvedReason) lines.push(`  Reason:      ${f.approvedReason}`);
  }
  if (f.status === 'suppressed' && f.suppressedBy) {
    lines.push(`  Suppressed by: ${f.suppressedBy}`);
  }

  lines.push('');
  lines.push('Description:');
  // Word-wrap the description at ~72 chars
  for (const line of wrapText(f.description, 72)) {
    lines.push(`  ${line}`);
  }

  if (f.recommendation) {
    lines.push('');
    lines.push('Recommendation:');
    for (const line of wrapText(f.recommendation, 72)) {
      lines.push(`  ${line}`);
    }
  }

  // Evidence
  if (f.evidence.length > 0) {
    lines.push('');
    lines.push('Evidence:');
    for (const ev of f.evidence) {
      lines.push(`  Trace: ${ev.traceId}`);
      if (ev.eventIds.length > 0) {
        lines.push(`  Events: ${ev.eventIds.join(', ')}`);
      } else {
        lines.push('  Events: (none recorded)');
      }
      if (ev.file) {
        const loc = ev.line ? `${ev.file}:${ev.line}` : ev.file;
        lines.push(`  File: ${loc}`);
      }
    }
  }

  lines.push('');

  // Actions hint
  if (f.status === 'open') {
    lines.push('Actions:');
    lines.push(`  tracegraph finding approve ${f.fingerprint} --reason "..."`);
    lines.push(`  tracegraph finding suppress ${f.fingerprint} --reason "..."`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadReport(reportArg: string | undefined, cwd: string): TraceReport | null {
  const tracegraphDir = path.join(cwd, '.tracegraph');

  let reportFile: string;
  if (reportArg) {
    reportFile = path.resolve(cwd, reportArg);
  } else {
    const reportsDir = path.join(tracegraphDir, 'reports');
    if (!fs.existsSync(reportsDir)) return null;

    const files = fs.readdirSync(reportsDir)
      .filter((f) => f.endsWith('.report.json'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;
    reportFile = path.join(reportsDir, files[0]!.name);
  }

  if (!fs.existsSync(reportFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(reportFile, 'utf8')) as TraceReport;
  } catch {
    return null;
  }
}

/**
 * Very simple word-wrapper that splits long text at word boundaries.
 * Returns an array of lines, each ≤ maxWidth characters.
 */
function wrapText(text: string, maxWidth: number): string[] {
  const words  = text.split(/\s+/);
  const lines: string[] = [];
  let   current = '';

  for (const word of words) {
    if (!word) continue;
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
