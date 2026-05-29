/**
 * M7A T7A.1 — `tracegraph coverage` command
 *
 * Maps changed functions (from a git diff) to runtime trace events, producing
 * a `ChangeCoverageReport` that shows which changed code paths were actually
 * exercised at runtime.
 *
 * Usage:
 *   tracegraph coverage [options]
 *
 * Options:
 *   --base <ref>       Git ref to diff from (default: HEAD~1)
 *   --head <ref>       Git ref to diff to (default: HEAD)
 *   --traces <dir>     Directory containing .trace.json files (default: .tracegraph/traces)
 *   --out <file>       Write report JSON to this file (default: .tracegraph/reports/<id>.coverage.json)
 *   --json             Print the full report JSON to stdout (in addition to the summary)
 *   --fail-uncovered   Exit 1 if any changed functions have no trace coverage
 */

import * as fs   from 'fs';
import * as path from 'path';
import { computeCoverage } from '@tracegraph/ai-coverage';
import { EXIT_CODES } from '@tracegraph/shared-types';
import type { ChangeCoverageReport, ChangedFunction } from '@tracegraph/shared-types';

export type CoverageCommandOptions = {
  base?:          string;
  head?:          string;
  traces?:        string;
  out?:           string;
  json?:          boolean;
  failUncovered?: boolean;
};

export function coverageCommand(options: CoverageCommandOptions = {}): number {
  const {
    base    = 'HEAD~1',
    head    = 'HEAD',
    traces,
    out,
    json:   printJson    = false,
    failUncovered = false,
  } = options;

  const cwd       = process.cwd();
  const tracesDir = traces
    ? path.resolve(cwd, traces)
    : path.join(cwd, '.tracegraph', 'traces');

  let report: ChangeCoverageReport;
  try {
    report = computeCoverage({
      baseRef:   base,
      headRef:   head,
      tracesDir,
      cwd,
    });
  } catch (err) {
    process.stderr.write(`[tracegraph coverage] Error: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  // ─── Write report to file ────────────────────────────────────────────────
  const reportsDir = path.join(cwd, '.tracegraph', 'reports');
  const outFile    = out
    ? path.resolve(cwd, out)
    : path.join(reportsDir, `${report.reportId}.coverage.json`);

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`[tracegraph coverage] Failed to write report: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  // ─── Human-readable summary ──────────────────────────────────────────────
  const { summary } = report;
  process.stderr.write('\n');
  process.stderr.write(`  tracegraph coverage\n`);
  process.stderr.write(`  diff:  ${report.baseRef}..${report.headRef}\n`);
  process.stderr.write(`  ─────────────────────────────────────────────\n`);
  process.stderr.write(`  Changed functions: ${summary.changedFunctions}\n`);
  process.stderr.write(`  Covered:           ${summary.coveredCount}\n`);
  process.stderr.write(`  Uncovered:         ${summary.uncoveredCount}\n`);
  process.stderr.write(`  Coverage:          ${summary.coveragePercent}%\n`);

  if (report.uncovered.length > 0) {
    process.stderr.write('\n  Uncovered changed functions:\n');
    for (const fn of report.uncovered) {
      process.stderr.write(`    ✗  ${formatFunction(fn)}  (${fn.file}:${fn.startLine})\n`);
    }
  }

  if (report.covered.length > 0) {
    process.stderr.write('\n  Covered changed functions:\n');
    for (const entry of report.covered) {
      process.stderr.write(
        `    ✓  ${formatFunction(entry.changed)}  — ${entry.coveredBy.length} trace(s)\n`,
      );
    }
  }

  process.stderr.write(`\n  Report: ${outFile}\n\n`);

  // ─── Optional JSON stdout ─────────────────────────────────────────────────
  if (printJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }

  // ─── Exit code ────────────────────────────────────────────────────────────
  if (failUncovered && report.uncovered.length > 0) {
    return EXIT_CODES.COMMAND_FAILURE;
  }
  return EXIT_CODES.SUCCESS;
}

function formatFunction(fn: ChangedFunction): string {
  if (fn.className && fn.methodName) {
    return `${fn.className}.${fn.methodName}()`;
  }
  return `${fn.functionName ?? '(unknown)'}()`;
}
