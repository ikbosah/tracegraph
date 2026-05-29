/**
 * T2.7 — `tracegraph baseline` subcommands
 *
 *   tracegraph baseline create [--reason "..."] [--approved-by "..."]
 *   tracegraph baseline list
 *   tracegraph baseline approve <baselineId> --reason "..."
 */
import fs   from 'fs';
import path from 'path';
import { EXIT_CODES, SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceSession, CompactBaseline, LatestPointer } from '@tracegraph/shared-types';
import { sessionToBaseline, deriveTestId } from '@tracegraph/graph-engine';

// ─── baseline create ──────────────────────────────────────────────────────────

export type BaselineCreateOptions = {
  reason?:     string;
  approvedBy?: string;
  /** Overwrite all existing baselines (legacy / explicit override). */
  all?:        boolean;
  /** Use ALL traces in .tracegraph/traces/ regardless of run. Overrides default. */
  allTraces?:  boolean;
  /** Scope to traces from the latest run recorded in .tracegraph/latest.json (default). */
  latestRun?:  boolean;
  /** Scope to traces from a specific run ID. */
  runId?:      string;
  /** Skip traces whose status is not 'passed'. */
  onlyPassed?: boolean;
};

export function baselineCreateCommand(options: BaselineCreateOptions): number {
  const cwd            = process.cwd();
  const tracegraphDir  = path.join(cwd, '.tracegraph');
  const tracesDir      = path.join(tracegraphDir, 'traces');
  const baselinesDir   = path.join(tracegraphDir, 'baselines');

  if (!fs.existsSync(tracesDir)) {
    process.stderr.write(
      '[tracegraph] No traces found. Run `tracegraph run -- <your-test-command>` first.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Resolve the trace files to baseline ──────────────────────────────────
  const traceFiles = resolveTraceFiles(tracesDir, tracegraphDir, options);

  if (traceFiles.length === 0) {
    process.stderr.write('[tracegraph] No .trace.json files found for the selected scope.\n');
    process.stderr.write('  Try: tracegraph baseline create --all-traces\n');
    return EXIT_CODES.CLI_ERROR;
  }

  // Default to CI/non-interactive mode if --reason provided
  const approvedBy = options.approvedBy ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'system';
  const reason     = options.reason ?? 'Baseline created by tracegraph CLI';

  fs.mkdirSync(baselinesDir, { recursive: true });

  let created = 0;
  let skipped = 0;

  for (const traceFile of traceFiles) {
    let session: TraceSession;
    try {
      session = JSON.parse(fs.readFileSync(traceFile, 'utf8')) as TraceSession;
    } catch {
      process.stderr.write(`[tracegraph] Skipping unreadable trace: ${traceFile}\n`);
      skipped++;
      continue;
    }

    if (session.schemaVersion !== SCHEMA_VERSIONS.trace) {
      process.stderr.write(
        `[tracegraph] Schema mismatch in ${path.basename(traceFile)} — ` +
        `expected ${SCHEMA_VERSIONS.trace}, got ${session.schemaVersion}\n` +
        `  Run: tracegraph baseline migrate\n`,
      );
      skipped++;
      continue;
    }

    const baseline = sessionToBaseline(session, { approvedBy, reason });
    const outFile  = path.join(baselinesDir, `${baseline.testId}.baseline.json`);

    // Check for existing baseline
    if (fs.existsSync(outFile) && !options.all) {
      const existing = JSON.parse(fs.readFileSync(outFile, 'utf8')) as CompactBaseline;
      process.stdout.write(
        `  [skip] Baseline already exists for testId ${baseline.testId} ` +
        `(approved ${new Date(existing.approvedAt).toISOString().slice(0, 10)}). ` +
        `Use --all to overwrite.\n`,
      );
      skipped++;
      continue;
    }

    fs.writeFileSync(outFile, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
    process.stdout.write(`  [ok] Baseline created: ${path.relative(cwd, outFile)}\n`);
    created++;
  }

  process.stdout.write(
    `\n[tracegraph] baseline create: ${created} created, ${skipped} skipped\n`,
  );
  return EXIT_CODES.SUCCESS;
}

// ─── Helpers — trace file resolution ─────────────────────────────────────────

/**
 * Resolves which .trace.json files should be baselined, based on the
 * provided options:
 *
 *  --all-traces     → all files in .tracegraph/traces/
 *  --run-id <id>    → traces whose session.runId matches
 *  --latest-run     → traces listed in .tracegraph/latest.json
 *  (default)        → same as --latest-run; falls back to all traces with a warning
 *  --only-passed    → applied as a post-filter on any of the above
 */
function resolveTraceFiles(
  tracesDir:     string,
  tracegraphDir: string,
  options:       BaselineCreateOptions,
): string[] {
  let files: string[];

  if (options.allTraces) {
    // Explicit override: use everything
    files = allTraceFiles(tracesDir);
    process.stdout.write(`[tracegraph] Scoping to ALL ${files.length} trace(s) in .tracegraph/traces/\n`);

  } else if (options.runId) {
    // Filter by run ID — load each file and check session.runId
    const allFiles = allTraceFiles(tracesDir);
    files = allFiles.filter((f) => {
      try {
        const session = JSON.parse(fs.readFileSync(f, 'utf8')) as TraceSession;
        return session.runId === options.runId;
      } catch { return false; }
    });
    process.stdout.write(
      `[tracegraph] Scoping to run ${options.runId}: ${files.length} trace(s) found.\n`,
    );

  } else {
    // Default: use latest.json if available
    const latestPath = path.join(tracegraphDir, 'latest.json');
    if (fs.existsSync(latestPath)) {
      try {
        const ptr = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as LatestPointer;
        const resolved = ptr.latestTraceIds
          .map((id) => path.join(tracesDir, `${id}.trace.json`))
          .filter((p) => fs.existsSync(p));
        if (resolved.length > 0) {
          process.stdout.write(
            `[tracegraph] Scoping to latest run ${ptr.latestRunId} ` +
            `(${resolved.length} trace(s)). Use --all-traces to baseline everything.\n`,
          );
          files = resolved;
        } else {
          process.stderr.write(
            '[tracegraph] latest.json found but no matching trace files — falling back to all traces.\n',
          );
          files = allTraceFiles(tracesDir);
        }
      } catch {
        files = allTraceFiles(tracesDir);
      }
    } else {
      // No latest.json yet — fall back to all traces with an advisory
      process.stderr.write(
        '[tracegraph] .tracegraph/latest.json not found. ' +
        'Baseline will include ALL traces in .tracegraph/traces/.\n' +
        '  Run `tracegraph run -- <command>` first to create a latest.json pointer.\n',
      );
      files = allTraceFiles(tracesDir);
    }
  }

  // --only-passed post-filter
  if (options.onlyPassed) {
    const before = files.length;
    files = files.filter((f) => {
      try {
        const session = JSON.parse(fs.readFileSync(f, 'utf8')) as TraceSession;
        return session.status === 'passed';
      } catch { return false; }
    });
    const skipped = before - files.length;
    if (skipped > 0) {
      process.stdout.write(`[tracegraph] --only-passed: skipped ${skipped} non-passing trace(s).\n`);
    }
  }

  return files;
}

function allTraceFiles(tracesDir: string): string[] {
  return fs.readdirSync(tracesDir)
    .filter((f) => f.endsWith('.trace.json'))
    .map((f) => path.join(tracesDir, f));
}

// ─── baseline list ────────────────────────────────────────────────────────────

export function baselineListCommand(): number {
  const cwd           = process.cwd();
  const baselinesDir  = path.join(cwd, '.tracegraph', 'baselines');

  if (!fs.existsSync(baselinesDir)) {
    process.stdout.write('[tracegraph] No baselines found. Run `tracegraph baseline create` first.\n');
    return EXIT_CODES.SUCCESS;
  }

  const files = fs.readdirSync(baselinesDir).filter((f) => f.endsWith('.baseline.json'));

  if (files.length === 0) {
    process.stdout.write('[tracegraph] No baselines found.\n');
    return EXIT_CODES.SUCCESS;
  }

  // Header
  process.stdout.write(
    ['testId'.padEnd(16), 'events'.padEnd(8), 'captureLevel'.padEnd(14), 'approvedBy'.padEnd(16), 'approvedAt'].join(' | ') + '\n',
  );
  process.stdout.write('─'.repeat(72) + '\n');

  for (const file of files) {
    try {
      const b = JSON.parse(
        fs.readFileSync(path.join(baselinesDir, file), 'utf8'),
      ) as CompactBaseline;

      const row = [
        b.testId.slice(0, 14).padEnd(16),
        String(b.events.length).padEnd(8),
        String(b.captureLevel).padEnd(14),
        (b.approvedBy ?? 'unknown').slice(0, 14).padEnd(16),
        new Date(b.approvedAt).toISOString().slice(0, 10),
      ];
      process.stdout.write(row.join(' | ') + '\n');
    } catch {
      process.stderr.write(`  [warn] Could not read ${file}\n`);
    }
  }

  return EXIT_CODES.SUCCESS;
}

// ─── baseline approve ─────────────────────────────────────────────────────────

export type BaselineApproveOptions = {
  reason:      string;
  approvedBy?: string;
  expiresAt?:  string;
};

export function baselineApproveCommand(
  baselineIdOrTestId: string,
  options: BaselineApproveOptions,
): number {
  const cwd          = process.cwd();
  const baselinesDir = path.join(cwd, '.tracegraph', 'baselines');

  if (!fs.existsSync(baselinesDir)) {
    process.stderr.write('[tracegraph] No baselines directory found.\n');
    return EXIT_CODES.CLI_ERROR;
  }

  // Find the baseline file
  const files = fs.readdirSync(baselinesDir).filter((f) => f.endsWith('.baseline.json'));
  let found: string | null = null;

  for (const file of files) {
    if (file.startsWith(baselineIdOrTestId)) {
      found = path.join(baselinesDir, file);
      break;
    }
    try {
      const b = JSON.parse(fs.readFileSync(path.join(baselinesDir, file), 'utf8')) as CompactBaseline;
      if (b.baselineId === baselineIdOrTestId || b.testId === baselineIdOrTestId) {
        found = path.join(baselinesDir, file);
        break;
      }
    } catch { /* skip */ }
  }

  if (!found) {
    process.stderr.write(`[tracegraph] Baseline not found: ${baselineIdOrTestId}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  const baseline = JSON.parse(fs.readFileSync(found, 'utf8')) as CompactBaseline;

  // Update approval metadata
  baseline.approvedBy = options.approvedBy ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'system';
  baseline.reason     = options.reason;
  baseline.approvedAt = Date.now();

  fs.writeFileSync(found, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  process.stdout.write(`[tracegraph] Baseline approved: ${path.relative(cwd, found)}\n`);
  return EXIT_CODES.SUCCESS;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the baseline file matching a candidate session's testId.
 * Returns null if not found.
 */
export function findBaselineForSession(
  baselinesDir: string,
  session: TraceSession,
): CompactBaseline | null {
  const testId = deriveTestId(session.entrypoint);
  const file   = path.join(baselinesDir, `${testId}.baseline.json`);

  if (!fs.existsSync(file)) return null;

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CompactBaseline;
  } catch {
    return null;
  }
}
