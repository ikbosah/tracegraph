/**
 * T2.9 — `tracegraph finding` subcommands
 *
 *   tracegraph finding list   [--report <report.json>]
 *   tracegraph finding approve <fingerprint> --reason "..." [--expires <ISO-date>]
 *   tracegraph finding suppress <fingerprint> --reason "..." [--expires <date>]
 *                              [--requires-evidence "auth_check:RolePolicy.update"]
 */
import fs   from 'fs';
import path from 'path';
import { EXIT_CODES, SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type {
  TraceReport,
  FindingApproval,
  FindingApprovalsFile,
  Suppression,
  SuppressionsFile,
  FindingSeverity,
} from '@tracegraph/shared-types';
import { createHash } from 'node:crypto';

const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪',
};
const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const STATUS_ICON: Record<string, string> = {
  open:       '●',
  approved:   '✓',
  suppressed: '○',
};

// ─── finding list ─────────────────────────────────────────────────────────────

export function findingListCommand(reportArg?: string): number {
  const cwd          = process.cwd();
  const report       = loadReport(reportArg, cwd);

  if (!report) {
    process.stderr.write(
      '[tracegraph] No report found. Run `tracegraph compare` first.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const findings = report.findings;
  if (findings.length === 0) {
    process.stdout.write('[tracegraph] No findings.\n');
    return EXIT_CODES.SUCCESS;
  }

  process.stdout.write(`\nFindings — ${new Date(report.createdAt).toISOString().slice(0, 16)}\n\n`);

  for (const sev of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;

    for (const f of group) {
      const icon = STATUS_ICON[f.status] ?? '?';
      process.stdout.write(
        `  ${SEVERITY_EMOJI[sev]} ${icon} ${f.title}\n` +
        `     rule: ${f.ruleId} | fingerprint: ${f.fingerprint} | status: ${f.status}\n\n`,
      );
    }
  }

  return EXIT_CODES.SUCCESS;
}

// ─── finding approve ──────────────────────────────────────────────────────────

export type FindingApproveOptions = {
  reason:      string;
  approvedBy?: string;
  expiresAt?:  string;
};

export function findingApproveCommand(
  fingerprint: string,
  options: FindingApproveOptions,
): number {
  const cwd         = process.cwd();
  const tracegraphDir = path.join(cwd, '.tracegraph');
  const report      = loadReport(undefined, cwd);

  // Find the finding to get its ruleId and semantic target
  let ruleId = 'unknown';
  if (report) {
    const f = report.findings.find((f) => f.fingerprint === fingerprint || f.id === fingerprint);
    if (f) ruleId = f.ruleId;
    else {
      process.stderr.write(`[tracegraph] Finding not found in latest report: ${fingerprint}\n`);
      return EXIT_CODES.CLI_ERROR;
    }
  }

  const approval: FindingApproval = {
    findingFingerprint: fingerprint,
    ruleId,
    semanticTarget:     {},
    approvedBy:         options.approvedBy ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'system',
    reason:             options.reason,
    expiresAt:          options.expiresAt ?? oneYearFromNow(),
    createdAt:          new Date().toISOString(),
  };

  const approvalDir  = path.join(tracegraphDir, 'approvals');
  const approvalFile = path.join(approvalDir, 'findings.json');
  fs.mkdirSync(approvalDir, { recursive: true });

  let existing: FindingApprovalsFile = {
    schemaVersion: SCHEMA_VERSIONS.findingApproval,
    approvals:     [],
  };
  if (fs.existsSync(approvalFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(approvalFile, 'utf8')) as FindingApprovalsFile;
    } catch { /* use default */ }
  }

  // Remove existing approval for same fingerprint
  existing.approvals = existing.approvals.filter(
    (a) => a.findingFingerprint !== fingerprint,
  );
  existing.approvals.push(approval);

  fs.writeFileSync(approvalFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  process.stdout.write(`[tracegraph] Finding approved: ${fingerprint}\n`);
  return EXIT_CODES.SUCCESS;
}

// ─── finding suppress ─────────────────────────────────────────────────────────

export type FindingSuppressOptions = {
  reason:            string;
  approvedBy?:       string;
  expiresAt?:        string;
  requiresEvidence?: string;  // "type:name[,type:name...]"
};

export function findingSuppressCommand(
  fingerprint: string,
  options: FindingSuppressOptions,
): number {
  const cwd         = process.cwd();
  const tracegraphDir = path.join(cwd, '.tracegraph');
  const report      = loadReport(undefined, cwd);

  let ruleId = 'unknown';
  if (report) {
    const f = report.findings.find((f) => f.fingerprint === fingerprint || f.id === fingerprint);
    if (f) ruleId = f.ruleId;
    else {
      process.stderr.write(`[tracegraph] Finding not found in latest report: ${fingerprint}\n`);
      return EXIT_CODES.CLI_ERROR;
    }
  }

  // Parse requiresEvidence: "auth_check:RolePolicy.update" → [{ type, name }]
  const requiresEvidence = options.requiresEvidence
    ? options.requiresEvidence.split(',').map((item) => {
        const [type, ...rest] = item.trim().split(':');
        return { type: type ?? '', name: rest.join(':') || '*' };
      })
    : undefined;

  const suppression: Suppression = {
    id:               `suppress_${createHash('sha256').update(fingerprint + Date.now()).digest('hex').slice(0, 12)}`,
    ruleId,
    semanticTarget:   {},
    requiresEvidence,
    reason:           options.reason,
    expiresAt:        options.expiresAt ?? oneYearFromNow(),
    approvedBy:       options.approvedBy ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'system',
    createdAt:        new Date().toISOString(),
  };

  const suppressDir  = path.join(tracegraphDir, 'suppressions');
  const suppressFile = path.join(suppressDir, 'tracegraph.suppressions.json');
  fs.mkdirSync(suppressDir, { recursive: true });

  let existing: SuppressionsFile = {
    schemaVersion: SCHEMA_VERSIONS.suppression,
    suppressions:  [],
  };
  if (fs.existsSync(suppressFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(suppressFile, 'utf8')) as SuppressionsFile;
    } catch { /* use default */ }
  }

  existing.suppressions.push(suppression);
  fs.writeFileSync(suppressFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  process.stdout.write(`[tracegraph] Suppression added for finding ${fingerprint}\n`);
  if (requiresEvidence) {
    process.stdout.write(
      `  requiresEvidence: ${requiresEvidence.map((e) => `${e.type}:${e.name}`).join(', ')}\n`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadReport(reportArg: string | undefined, cwd: string): TraceReport | null {
  const tracegraphDir = path.join(cwd, '.tracegraph');

  let reportFile: string;
  if (reportArg) {
    reportFile = path.resolve(cwd, reportArg);
  } else {
    // Find the most recent report
    const reportsDir = path.join(tracegraphDir, 'reports');
    if (!fs.existsSync(reportsDir)) return null;
    const files = fs.readdirSync(reportsDir)
      .filter((f) => f.endsWith('.report.json'))
      .map((f) => ({
        name: f,
        mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs,
      }))
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

function oneYearFromNow(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}
