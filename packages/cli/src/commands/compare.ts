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
  TraceBundle,
  TraceSession,
  TraceReport,
  BehaviorDiff,
  EvaluatedFinding,
  Finding,
  FindingSeverity,
  SuppressionsFile,
  FindingApprovalsFile,
  LatestPointer,
} from '@tracegraph/shared-types';
import { diffBaseline, diffToFindings, evaluateFindings, analyseTraceFindings } from '@tracegraph/graph-engine';
import { findBaselineForSession } from './baseline';
import { emit } from '../protocol';

export type CompareOptions = {
  baseline?:      string;
  candidate?:     string;
  /**
   * Path to a TraceBundle JSON file.  When supplied, all traces listed in the
   * bundle are loaded and compared instead of using --candidate or latest.json.
   */
  bundle?:        string;
  out?:           string;
  failOnCritical?: boolean;
  /** Use traces from the most recent run recorded in .tracegraph/latest.json. */
  latest?:        boolean;
};

export function compareCommand(options: CompareOptions): number {
  const cwd           = process.cwd();
  const tracegraphDir = path.join(cwd, '.tracegraph');
  const baselinesDir  = options.baseline
    ? path.resolve(cwd, options.baseline)
    : path.join(tracegraphDir, 'baselines');

  // ── Resolve candidate trace files ────────────────────────────────────────
  const candidateFiles = options.bundle
    ? resolveBundleTraceFiles(options.bundle, tracegraphDir, cwd)
    : resolveCandidateFiles(options.candidate, tracegraphDir, cwd, options.latest);
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

    // Generate findings: diff-based (M2) + trace-level analysis (M5)
    const rawFindings = [
      ...diffToFindings(diff),
      ...analyseTraceFindings(session),
    ];

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

  // ── Suppression file change detection (M5.5) ─────────────────────────────
  const suppressionsModified = checkSuppressionsFileModified(tracegraphDir);

  // Emit a structured policy finding when the suppressions file has uncommitted
  // changes so that it appears in the report alongside other findings.
  if (suppressionsModified) {
    const policyFinding = buildSuppressionsModifiedFinding();
    // Policy findings are always "open" — they cannot be suppressed away.
    allEvaluated.push({ ...policyFinding, status: 'open' });
  }

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

  // ── Write back reportId to latest.json ───────────────────────────────────
  updateLatestReport(tracegraphDir, report.reportId);

  // Exit codes
  if (suppressionsModified) return EXIT_CODES.POLICY_REVIEW;
  if (hasOpenCritical && options.failOnCritical) return EXIT_CODES.FINDINGS_THRESHOLD;
  return EXIT_CODES.SUCCESS;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Update latest.json with the reportId produced by this compare run. */
function updateLatestReport(tracegraphDir: string, reportId: string): void {
  const latestPath = path.join(tracegraphDir, 'latest.json');
  try {
    let existing: LatestPointer = {
      latestRunId:    '',
      latestTraceIds: [],
      latestReportId: null,
      updatedAt:      Date.now(),
    };
    if (fs.existsSync(latestPath)) {
      existing = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as LatestPointer;
    }
    existing.latestReportId = reportId;
    existing.updatedAt      = Date.now();
    fs.writeFileSync(latestPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch {
    // Non-fatal
  }
}

/**
 * Resolve trace file paths from a TraceBundle JSON file.
 *
 * Bundle trace entries use paths relative to `.tracegraph/` (e.g. `traces/<id>.trace.json`).
 * Entries whose files cannot be found on disk are skipped with a warning.
 */
function resolveBundleTraceFiles(
  bundleArg: string,
  tracegraphDir: string,
  cwd: string,
): string[] {
  const abs = path.resolve(cwd, bundleArg);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`[tracegraph] Bundle file not found: ${abs}\n`);
    return [];
  }

  let bundle: TraceBundle;
  try {
    bundle = JSON.parse(fs.readFileSync(abs, 'utf8')) as TraceBundle;
  } catch (err) {
    process.stderr.write(`[tracegraph] Cannot parse bundle file: ${abs} — ${String(err)}\n`);
    return [];
  }

  if (!Array.isArray(bundle.traces)) {
    process.stderr.write(`[tracegraph] Bundle has no traces array: ${abs}\n`);
    return [];
  }

  const resolved: string[] = [];
  for (const entry of bundle.traces) {
    // bundle.traces[].file is relative to .tracegraph/
    const tracePath = path.join(tracegraphDir, entry.file);
    if (fs.existsSync(tracePath)) {
      resolved.push(tracePath);
    } else {
      process.stderr.write(
        `[tracegraph] Bundle trace file not found, skipping: ${entry.file}\n`,
      );
    }
  }

  if (resolved.length > 0) {
    process.stderr.write(
      `[tracegraph] Bundle "${bundle.scenarioId}" — ` +
      `${resolved.length}/${bundle.traces.length} trace(s) resolved.\n`,
    );
  }

  return resolved;
}

function resolveCandidateFiles(
  candidateArg: string | undefined,
  tracegraphDir: string,
  cwd: string,
  useLatest?: boolean,
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

  const tracesDir = path.join(tracegraphDir, 'traces');

  // --latest or no explicit candidate: prefer latest.json's trace IDs
  if (useLatest || !candidateArg) {
    const latestPath = path.join(tracegraphDir, 'latest.json');
    if (fs.existsSync(latestPath)) {
      try {
        const ptr = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as LatestPointer;
        const resolved = ptr.latestTraceIds
          .map((id) => path.join(tracesDir, `${id}.trace.json`))
          .filter((p) => fs.existsSync(p));
        if (resolved.length > 0) {
          process.stderr.write(
            `[tracegraph] Using latest run ${ptr.latestRunId} (${resolved.length} trace(s)).\n` +
            `  Pass --candidate <dir> to compare a different set.\n`,
          );
          return resolved;
        }
      } catch { /* fall through to full scan */ }
    }
  }

  // Fallback: all traces in .tracegraph/traces/
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

/**
 * Returns true when the suppressions file has uncommitted changes in git.
 *
 * Uses `git status --porcelain` on the suppressions file path. If git is not
 * available, or the directory is not a git repository, returns false (safe
 * default — does not block the workflow on non-git setups).
 *
 * Exit code 4 (POLICY_REVIEW) is emitted when this returns true, forcing
 * human review before results are trusted.
 */
function checkSuppressionsFileModified(tracegraphDir: string): boolean {
  const suppressionFile = path.join(
    tracegraphDir, 'suppressions', 'tracegraph.suppressions.json',
  );
  if (!fs.existsSync(suppressionFile)) return false;

  try {
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const result = spawnSync(
      'git',
      ['status', '--porcelain', suppressionFile],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // spawnSync returns error if git is not found; status !== 0 means not a repo
    if (result.error || result.status !== 0) return false;
    return (result.stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
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

/**
 * M5.5 — Build a structured Finding for a modified suppressions file.
 *
 * Suppressions control which findings are silenced. Uncommitted changes to the
 * suppressions file mean a reviewer has not yet signed off on the change,
 * introducing a policy risk that must surface in the report.
 */
function buildSuppressionsModifiedFinding(): Finding {
  const ruleId      = 'policy.suppressions_modified';
  const fingerprint = createHash('sha256')
    .update(`${ruleId}:tracegraph.suppressions.json`)
    .digest('hex')
    .slice(0, 16);

  return {
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId,
    severity:    'high',
    category:    'tracegraph_policy_change',
    title:       'Suppressions file modified in this change',
    description: 'The file .tracegraph/suppressions/tracegraph.suppressions.json has uncommitted ' +
                 'changes. Modifications to the suppressions file alter which findings are silenced, ' +
                 'which is a policy-level change that requires explicit human review.',
    evidence:    [{ traceId: 'policy', eventIds: [] }],
    recommendation:
      'Commit and review the suppressions change separately, or revert it if unintentional. ' +
      'Suppressions should be version-controlled and reviewed like code.',
  };
}
