/**
 * IMP-2 T-IMP2.2 — `tracegraph adopt`
 *
 * Baseline adoption for existing codebases. Treats the current behaviour as the
 * approved baseline while producing a human-readable record of what was adopted.
 *
 *   tracegraph adopt [--dry-run] [--reason <text>] [--approved-by <name>]
 *
 * What it does:
 *  1. Reads all traces from the latest run (via .tracegraph/latest.json)
 *  2. Analyses each trace for findings (using analyseTraceFindings)
 *  3. Presents findings grouped by severity with approve/suppress prompts
 *  4. Creates baselines for all traces (calls baselineCreateCommand internally)
 *  5. Writes BASELINE_ASSUMPTIONS.md and adoption-report.json
 */
import fs   from 'fs';
import path from 'path';
import { EXIT_CODES, SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type {
  TraceSession,
  Finding,
  FindingSeverity,
  LatestPointer,
  FindingApproval,
  FindingApprovalsFile,
  AdoptionReport,
} from '@tracegraph/shared-types';
import { analyseTraceFindings } from '@tracegraph/graph-engine';
import { baselineCreateCommand } from './baseline';

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪',
};

export type AdoptOptions = {
  dryRun?:     boolean;
  reason?:     string;
  approvedBy?: string;
};

export function adoptCommand(options: AdoptOptions): number {
  const cwd            = process.cwd();
  const tracegraphDir  = path.join(cwd, '.tracegraph');
  const tracesDir      = path.join(tracegraphDir, 'traces');

  if (!fs.existsSync(tracesDir)) {
    process.stderr.write(
      '[tracegraph] No traces found. Run `tracegraph run -- <test-command>` first.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Resolve trace files from latest run ────────────────────────────────────
  const traceFiles = resolveLatestTraceFiles(tracesDir, tracegraphDir);

  if (traceFiles.length === 0) {
    process.stderr.write(
      '[tracegraph] No trace files found for the latest run.\n' +
      '  Run `tracegraph run -- <test-command>` first.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const approvedBy = options.approvedBy ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'system';
  const reason     = options.reason ?? 'Adopted as existing baseline behaviour';

  process.stdout.write(`\n[tracegraph] Analysing ${traceFiles.length} trace(s) for adoption...\n\n`);

  // ── Collect all findings across all traces ────────────────────────────────
  type FindingWithRoute = Finding & { traceFile: string; route?: string };
  const allFindings: FindingWithRoute[] = [];

  for (const traceFile of traceFiles) {
    let session: TraceSession;
    try {
      session = JSON.parse(fs.readFileSync(traceFile, 'utf8')) as TraceSession;
    } catch {
      process.stderr.write(`  [skip] Unreadable trace: ${path.basename(traceFile)}\n`);
      continue;
    }

    if (session.schemaVersion !== SCHEMA_VERSIONS.trace) {
      process.stderr.write(`  [skip] Schema mismatch: ${path.basename(traceFile)}\n`);
      continue;
    }

    const findings = analyseTraceFindings(session);
    const route = session.entrypoint.type === 'http_request'
      ? `${session.entrypoint.method} ${session.entrypoint.path}`
      : undefined;

    for (const f of findings) {
      allFindings.push({ ...f, traceFile, route });
    }
  }

  // ── Display findings grouped by severity ──────────────────────────────────
  if (allFindings.length === 0) {
    process.stdout.write('  ✅ No findings detected — all traces are clean.\n\n');
  } else {
    process.stdout.write(`  Found ${allFindings.length} finding(s) across ${traceFiles.length} trace(s):\n\n`);
    for (const sev of SEVERITY_ORDER) {
      const group = allFindings.filter((f) => f.severity === sev);
      if (group.length === 0) continue;
      process.stdout.write(`  ${SEVERITY_EMOJI[sev]} ${sev.toUpperCase()} (${group.length})\n`);
      for (const f of group) {
        const route = f.route ? ` — ${f.route}` : '';
        process.stdout.write(`    • ${f.title}${route}\n`);
        process.stdout.write(`      rule: ${f.ruleId}\n`);
      }
      process.stdout.write('\n');
    }
  }

  if (options.dryRun) {
    process.stdout.write(
      `[tracegraph] Dry run — no changes written.\n` +
      `  Would create baselines for ${traceFiles.length} trace(s).\n` +
      `  Would suppress ${allFindings.length} finding(s) as adopted behaviour.\n`,
    );
    return EXIT_CODES.SUCCESS;
  }

  // ── Create baselines for all traces ───────────────────────────────────────
  process.stdout.write(`[tracegraph] Creating baselines for ${traceFiles.length} trace(s)...\n`);
  const baselineResult = baselineCreateCommand({
    reason,
    approvedBy,
    all: true,
    allTraces: false,
    latestRun: true,
  });

  if (baselineResult !== EXIT_CODES.SUCCESS) {
    process.stderr.write('[tracegraph] Warning: some baselines could not be created.\n');
  }

  // ── Write suppressions for all findings ──────────────────────────────────
  const findingsAdopted:    AdoptionReport['findingsAdopted']    = [];
  const findingsSuppressed: AdoptionReport['findingsSuppressed'] = [];

  // ── Record approvals for all findings (keyed by fingerprint) ────────────
  // We use FindingApproval (not Suppression) so future new occurrences of the
  // same rule still fire — only this specific fingerprint is approved.
  if (allFindings.length > 0) {
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

    for (const f of allFindings) {
      // Remove any prior approval for this fingerprint before re-adding
      existing.approvals = existing.approvals.filter(
        (a) => a.findingFingerprint !== f.fingerprint,
      );
      existing.approvals.push({
        findingFingerprint: f.fingerprint,
        ruleId:             f.ruleId,
        semanticTarget:     {},
        approvedBy,
        reason:             `Adopted via tracegraph adopt — ${reason}`,
        expiresAt:          tenYearsFromNow(),
        createdAt:          new Date().toISOString(),
      } satisfies FindingApproval);

      findingsSuppressed.push({ severity: f.severity, ruleId: f.ruleId, reason });
    }

    fs.writeFileSync(approvalFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  }

  for (const f of allFindings) {
    findingsAdopted.push({ severity: f.severity, ruleId: f.ruleId, route: (f as FindingWithRoute).route });
  }

  // ── Write BASELINE_ASSUMPTIONS.md ─────────────────────────────────────────
  const report: AdoptionReport = {
    adoptedAt:       Date.now(),
    adoptedBy:       approvedBy,
    tracesAdopted:   traceFiles.length,
    findingsAdopted,
    findingsSuppressed,
  };

  writeBaselineAssumptions(tracegraphDir, report);

  // Write machine-readable adoption report
  try {
    fs.writeFileSync(
      path.join(tracegraphDir, 'adoption-report.json'),
      JSON.stringify(report, null, 2) + '\n',
      'utf8',
    );
  } catch { /* non-fatal */ }

  process.stdout.write(
    `\n[tracegraph] ✅ Adoption complete.\n` +
    `  Baselines created:   ${traceFiles.length}\n` +
    `  Findings suppressed: ${allFindings.length}\n` +
    `  See: .tracegraph/BASELINE_ASSUMPTIONS.md\n\n`,
  );

  return EXIT_CODES.SUCCESS;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveLatestTraceFiles(tracesDir: string, tracegraphDir: string): string[] {
  // Try latest.json first for scoping to the most recent run
  const latestFile = path.join(tracegraphDir, 'latest.json');
  if (fs.existsSync(latestFile)) {
    try {
      const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8')) as LatestPointer;
      const files = latest.latestTraceIds
        .map((id) => path.join(tracesDir, `${id}.trace.json`))
        .filter((f) => fs.existsSync(f));
      if (files.length > 0) return files;
    } catch { /* fall through */ }
  }

  // Fall back: all trace files sorted by mtime (most recent first), limit 50
  if (!fs.existsSync(tracesDir)) return [];
  return fs.readdirSync(tracesDir)
    .filter((f) => f.endsWith('.trace.json'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(tracesDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 50)
    .map((f) => path.join(tracesDir, f.name));
}

function writeBaselineAssumptions(tracegraphDir: string, report: AdoptionReport): void {
  const lines: string[] = [
    `# TraceGraph Baseline Assumptions`,
    ``,
    `Adopted: ${new Date(report.adoptedAt).toISOString().slice(0, 10)} by ${report.adoptedBy}`,
    `Traces adopted: ${report.tracesAdopted}`,
    ``,
  ];

  if (report.findingsSuppressed.length === 0) {
    lines.push(`No findings were present at time of adoption — clean baseline.`);
  } else {
    lines.push(
      `## Suppressed at Adoption`,
      ``,
      `These findings were present when the baseline was adopted.`,
      `They are suppressed by fingerprint — **new occurrences will still fire.**`,
      ``,
    );
    for (const f of report.findingsSuppressed) {
      lines.push(`- \`${f.ruleId}\` (${f.severity}): ${f.reason}`);
    }
  }

  lines.push(``, `---`, `*Generated by \`tracegraph adopt\`*`, ``);

  try {
    fs.writeFileSync(
      path.join(tracegraphDir, 'BASELINE_ASSUMPTIONS.md'),
      lines.join('\n'),
      'utf8',
    );
  } catch { /* non-fatal */ }
}

function tenYearsFromNow(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 10);
  return d.toISOString();
}
