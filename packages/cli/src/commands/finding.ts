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
  // IMP-3.2: contextual scope fields
  route?:            string;
  resource?:         string;
  file?:             string;
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
    // IMP-3.2: optional scope fields
    ...(options.route    ? { route:    options.route }    : {}),
    ...(options.resource ? { resource: options.resource } : {}),
    ...(options.file     ? { file:     options.file }     : {}),
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

// ─── finding approve (batch) ──────────────────────────────────────────────────

export type FindingApproveBatchOptions = {
  all?:         boolean;
  rule?:        string;   // glob pattern, e.g. "reliability.*"
  severity?:    FindingSeverity;
  reason?:      string;
  approvedBy?:  string;
  dryRun?:      boolean;
};

export function findingApproveBatchCommand(options: FindingApproveBatchOptions): number {
  const cwd           = process.cwd();
  const tracegraphDir = path.join(cwd, '.tracegraph');
  const report        = loadReport(undefined, cwd);

  if (!report) {
    process.stderr.write('[tracegraph] No report found. Run `tracegraph compare` first.\n');
    return EXIT_CODES.CLI_ERROR;
  }

  // Filter to open findings matching the batch criteria
  let targets = report.findings.filter((f) => f.status === 'open');

  if (options.rule) {
    const pattern = options.rule.replace(/\./g, '\\.').replace(/\*/g, '.*');
    const re = new RegExp(`^${pattern}$`);
    targets = targets.filter((f) => re.test(f.ruleId));
  }

  if (options.severity) {
    const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    const threshold = SEVERITY_RANK[options.severity] ?? 0;
    targets = targets.filter((f) => (SEVERITY_RANK[f.severity] ?? 0) <= threshold);
  }

  if (targets.length === 0) {
    process.stdout.write('[tracegraph] No open findings match the given criteria.\n');
    return EXIT_CODES.SUCCESS;
  }

  if (options.dryRun) {
    process.stdout.write(`[tracegraph] Dry run — would approve ${targets.length} finding(s):\n\n`);
    for (const f of targets) {
      process.stdout.write(`  ${SEVERITY_EMOJI[f.severity]} ${f.fingerprint}  ${f.title}\n`);
    }
    process.stdout.write('\n');
    return EXIT_CODES.SUCCESS;
  }

  const approvedBy = options.approvedBy ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'system';
  const reason     = options.reason ?? 'Batch approval via tracegraph finding approve';

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

  let added = 0;
  for (const f of targets) {
    // Remove any existing approval for this fingerprint before adding
    existing.approvals = existing.approvals.filter(
      (a) => a.findingFingerprint !== f.fingerprint,
    );
    existing.approvals.push({
      findingFingerprint: f.fingerprint,
      ruleId:             f.ruleId,
      semanticTarget:     {},
      approvedBy,
      reason,
      expiresAt:          oneYearFromNow(),
      createdAt:          new Date().toISOString(),
    });
    added++;
  }

  fs.writeFileSync(approvalFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  process.stdout.write(`[tracegraph] Approved ${added} finding(s).\n`);
  return EXIT_CODES.SUCCESS;
}

// ─── finding reject ───────────────────────────────────────────────────────────

export type FindingRejectOptions = {
  reason?:     string;
  rejectedBy?: string;
};

/**
 * Explicitly mark a finding as "needs fix".
 * A rejected finding stays open in `tracegraph compare` output even if a
 * baseline approval exists — the rejection takes precedence.
 */
export function findingRejectCommand(
  fingerprint: string,
  options: FindingRejectOptions,
): number {
  const cwd           = process.cwd();
  const tracegraphDir = path.join(cwd, '.tracegraph');
  const report        = loadReport(undefined, cwd);

  let ruleId = 'unknown';
  if (report) {
    const f = report.findings.find((f) => f.fingerprint === fingerprint || f.id === fingerprint);
    if (f) {
      ruleId = f.ruleId;
    } else {
      process.stderr.write(`[tracegraph] Finding not found in latest report: ${fingerprint}\n`);
      return EXIT_CODES.CLI_ERROR;
    }
  }

  const rejectionsDir  = path.join(tracegraphDir, 'rejections');
  const rejectionsFile = path.join(rejectionsDir, 'findings.json');
  fs.mkdirSync(rejectionsDir, { recursive: true });

  type RejectionRecord = {
    findingFingerprint: string;
    ruleId:             string;
    reason:             string;
    rejectedBy:         string;
    createdAt:          string;
  };

  let existing: { rejections: RejectionRecord[] } = { rejections: [] };
  if (fs.existsSync(rejectionsFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(rejectionsFile, 'utf8')) as typeof existing;
    } catch { /* use default */ }
  }

  // Replace any existing rejection for this fingerprint
  existing.rejections = existing.rejections.filter(
    (r) => r.findingFingerprint !== fingerprint,
  );
  existing.rejections.push({
    findingFingerprint: fingerprint,
    ruleId,
    reason:     options.reason ?? 'Rejected as needs-fix',
    rejectedBy: options.rejectedBy ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'system',
    createdAt:  new Date().toISOString(),
  });

  fs.writeFileSync(rejectionsFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  process.stdout.write(
    `[tracegraph] Finding ${fingerprint} marked as rejected (needs fix).\n` +
    `  This finding will remain open in all future compare runs.\n`,
  );
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
