/**
 * T2.8 — `tracegraph compare`
 *
 * Compares a candidate trace (or set of traces) against stored baselines and
 * produces a TraceReport.
 *
 * Usage:
 *   tracegraph compare --baseline .tracegraph/baselines
 *                      --candidate .tracegraph/traces/latest.trace.json
 *                      [--out .tracegraph/reports/report.json]
 *                      [--fail-on-critical]
 */
import fs   from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { EXIT_CODES, SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type {
  TraceSession,
  TraceReport,
  BehaviorDiff,
  EvaluatedFinding,
  FindingSeverity,
  SuppressionsFile,
  FindingApprovalsFile,
} from '@tracegraph/shared-types';
import { diffBaseline, diffToFindings, evaluateFindings } from '@tracegraph/graph-engine';
import { findBaselineForSession } from './baseline';
import { emit } from '../protocol';

export type CompareOptions = {
  baseline?:      string;
  candidate?:     string;
  out?:           string;
  failOnCritical?: boolean;
};

export function compareCommand(options: CompareOptions): number {
  const cwd           = process.cwd();
  const tracegraphDir = path.join(cwd, '.tracegraph');
  const baselinesDir  = options.baseline
    ? path.resolve(cwd, options.baseline)
    : path.join(tracegraphDir, 'baselines');

  // ── Resolve candidate trace files ────────────────────────────────────────
  const candidateFiles = resolveCandidateFiles(options.candidate, tracegraphDir, cwd);
  if (candidateFiles.length === 0) {
    process.stderr.write(
      '[tracegraph] No candidate traces found. ' +
      'Run `tracegraph run -- <command>` first, or specify --candidate.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Load suppressions and approvals ──────────────────────────────────────
  const suppressions = loadSuppressions(tracegraphDir);
  const approvals    = loadApprovals(tracegraphDir);

  // ── Compare each candidate against its baseline ───────────────────────────
  const diffs:    BehaviorDiff[]    = [];
  const allEvaluated: EvaluatedFinding[] = [];
  let   tracesCompared = 0;

  for (const candidateFile of candidateFiles) {
    let session: TraceSession;
    try {
      session = JSON.parse(fs.readFileSync(candidateFile, 'utf8')) as TraceSession;
    } catch (err) {
      process.stderr.write(`[tracegraph] Skipping unreadable trace: ${candidateFile}\n`);
      continue;
    }

    if (session.schemaVersion !== SCHEMA_VERSIONS.trace) {
      process.stderr.write(
        `[tracegraph] Schema mismatch: ${path.basename(candidateFile)} — ` +
        `expected ${SCHEMA_VERSIONS.trace}, got ${session.schemaVersion}\n`,
      );
      continue;
    }

    // Find matching baseline
    const baseline = findBaselineForSession(baselinesDir, session);
    if (!baseline) {
      process.stderr.write(
        `[tracegraph] No baseline found for trace ${session.traceId} — skipping comparison.\n` +
        `  Run: tracegraph baseline create\n`,
      );
      continue;
    }

    tracesCompared++;

    // Diff
    const diff = diffBaseline(baseline, session);
    diffs.push(diff);

    // Generate findings
    const rawFindings = diffToFindings(diff);

    // Evaluate (apply suppressions + approvals)
    const evaluated = evaluateFindings(rawFindings, session, suppressions, approvals);
    allEvaluated.push(...evaluated);

    // Emit findings over stdout (for VS Code extension and CI)
    for (const f of evaluated.filter((e) => e.status === 'open')) {
      emit({
        type: 'finding',
        runId: session.runId,
        payload: {
          fingerprint: f.fingerprint,
          ruleId:      f.ruleId,
          severity:    f.severity,
          title:       f.title,
        },
      });
    }
  }

  // ── Suppression file change detection ────────────────────────────────────
  const suppressionsModified = checkSuppressionsFileModified(tracegraphDir);

  // ── Build summary ─────────────────────────────────────────────────────────
  const findingsBySeverity: Record<FindingSeverity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };
  for (const f of allEvaluated) {
    if (f.status === 'open') {
      findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] ?? 0) + 1;
    }
  }
  const hasOpenCritical = (findingsBySeverity.critical ?? 0) > 0;

  // ── Build report ──────────────────────────────────────────────────────────
  const report: TraceReport = {
    schemaVersion:  SCHEMA_VERSIONS.report,
    reportId:       `report_${createHash('sha256').update(Date.now().toString()).digest('hex').slice(0, 12)}`,
    createdAt:      Date.now(),
    baselineDir:    path.relative(cwd, baselinesDir),
    candidateFiles: candidateFiles.map((f) => path.relative(cwd, f)),
    diffs,
    findings:       allEvaluated,
    summary: {
      tracesCompared,
      findingsBySeverity,
      hasOpenCritical,
      suppressionsModified,
    },
  };

  // ── Write report file ─────────────────────────────────────────────────────
  const outPath = resolveOutPath(options.out, tracegraphDir, report.reportId, cwd);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  process.stdout.write(`[tracegraph] Report: ${path.relative(cwd, outPath)}\n`);

  const openCount = allEvaluated.filter((f) => f.status === 'open').length;
  if (openCount > 0) {
    process.stdout.write(
      `[tracegraph] ${openCount} open finding(s): ` +
      SEVERITY_ORDER.filter((s) => (findingsBySeverity[s] ?? 0) > 0)
        .map((s) => `${findingsBySeverity[s]} ${s}`)
        .join(', ') +
      '\n',
    );
  } else {
    process.stdout.write('[tracegraph] No open findings.\n');
  }

  // Emit report.created
  emit({
    type:  'report.created',
    runId: `compare_${Date.now()}`,
    payload: {
      file:             path.relative(cwd, outPath),
      openFindings:     openCount,
      hasOpenCritical,
    },
  });

  // Exit codes
  if (suppressionsModified) return EXIT_CODES.POLICY_REVIEW;
  if (hasOpenCritical && options.failOnCritical) return EXIT_CODES.COMMAND_FAILURE;
  return EXIT_CODES.SUCCESS;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function resolveCandidateFiles(
  candidateArg: string | undefined,
  tracegraphDir: string,
  cwd: string,
): string[] {
  if (candidateArg) {
    const abs = path.resolve(cwd, candidateArg);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isDirectory()) {
      return fs.readdirSync(abs)
        .filter((f) => f.endsWith('.trace.json'))
        .map((f) => path.join(abs, f));
    }
    return [abs];
  }

  // Default: all traces in .tracegraph/traces/
  const tracesDir = path.join(tracegraphDir, 'traces');
  if (!fs.existsSync(tracesDir)) return [];
  return fs.readdirSync(tracesDir)
    .filter((f) => f.endsWith('.trace.json'))
    .map((f) => path.join(tracesDir, f));
}

function loadSuppressions(tracegraphDir: string) {
  const suppressionFile = path.join(tracegraphDir, 'suppressions', 'tracegraph.suppressions.json');
  if (!fs.existsSync(suppressionFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(suppressionFile, 'utf8')) as SuppressionsFile;
    return data.suppressions ?? [];
  } catch {
    return [];
  }
}

function loadApprovals(tracegraphDir: string) {
  const approvalFile = path.join(tracegraphDir, 'approvals', 'findings.json');
  if (!fs.existsSync(approvalFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(approvalFile, 'utf8')) as FindingApprovalsFile;
    return data.approvals ?? [];
  } catch {
    return [];
  }
}

function checkSuppressionsFileModified(_tracegraphDir: string): boolean {
  // Full git-diff suppression detection is a T2.6 feature.
  // For M2 we return false; git integration can be added later.
  return false;
}

function resolveOutPath(
  outArg: string | undefined,
  tracegraphDir: string,
  reportId: string,
  cwd: string,
): string {
  if (outArg) return path.resolve(cwd, outArg);
  return path.join(tracegraphDir, 'reports', `${reportId}.report.json`);
}
