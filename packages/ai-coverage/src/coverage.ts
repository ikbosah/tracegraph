/**
 * M7A T7A.1 — AI Change Coverage engine
 *
 * Orchestrates the full coverage computation:
 *  1. Obtain a git diff (or use a pre-supplied diff string for testing).
 *  2. Parse the diff to identify changed functions (diff-parser).
 *  3. Scan trace files to match those functions to runtime events (trace-scanner).
 *  4. Build and return a `ChangeCoverageReport`.
 */

import * as path   from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import type { ChangeCoverageReport, CoverageEntry } from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import { parseDiff }             from './diff-parser';
import { scanTracesForCoverage } from './trace-scanner';

// ─── Options ──────────────────────────────────────────────────────────────────

export type CoverageOptions = {
  /**
   * Git ref to diff from (inclusive end of the "old" side).
   * Default: `HEAD~1`.  Ignored when `diffText` is supplied.
   */
  baseRef?: string;

  /**
   * Git ref to diff to (HEAD of the "new" side).
   * Default: `HEAD`.  Ignored when `diffText` is supplied.
   */
  headRef?: string;

  /**
   * Directory containing `.trace.json` files.
   * Default: `<cwd>/.tracegraph/traces`.
   */
  tracesDir?: string;

  /**
   * Working directory for git operations.
   * Default: `process.cwd()`.
   */
  cwd?: string;

  /**
   * Pre-computed unified-diff text.
   * When supplied, `baseRef`/`headRef`/`cwd` are not used for git invocation
   * but are still recorded in the report for provenance.
   */
  diffText?: string;
};

// ─── Git diff helper ──────────────────────────────────────────────────────────

/**
 * Run `git diff <baseRef> <headRef>` filtered to TS/JS/PHP files.
 * Returns empty string if git is unavailable or the repository has no commits.
 */
export function getDiff(baseRef: string, headRef: string, cwd: string): string {
  try {
    return execSync(
      `git diff ${baseRef} ${headRef} -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.php"`,
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return '';
  }
}

// ─── Main computation ─────────────────────────────────────────────────────────

/**
 * Compute a `ChangeCoverageReport` for the current workspace.
 *
 * @example
 * ```ts
 * const report = computeCoverage({ baseRef: 'origin/main' });
 * console.log(`Coverage: ${report.summary.coveragePercent}%`);
 * ```
 */
export function computeCoverage(options: CoverageOptions = {}): ChangeCoverageReport {
  const {
    baseRef   = 'HEAD~1',
    headRef   = 'HEAD',
    tracesDir = path.join(process.cwd(), '.tracegraph', 'traces'),
    cwd       = process.cwd(),
    diffText,
  } = options;

  // 1. Obtain diff
  const diff = diffText ?? getDiff(baseRef, headRef, cwd);

  // 2. Parse changed functions
  const changedFunctions = parseDiff(diff);

  // 3. Scan traces for matches
  const matches = scanTracesForCoverage(tracesDir, changedFunctions);

  // 4. Build coverage entries — one entry per matched changed function,
  //    collecting all traces that cover it.
  const coverageMap = new Map<
    /* identity key */ string,
    CoverageEntry
  >();

  for (const match of matches) {
    // Stable identity key based on the changed function
    const key = functionKey(match.changed);
    const entry = coverageMap.get(key);
    if (entry) {
      entry.coveredBy.push({
        traceId:   match.traceId,
        eventId:   match.eventId,
        traceFile: match.traceFile,
      });
    } else {
      coverageMap.set(key, {
        changed:   match.changed,
        coveredBy: [{
          traceId:   match.traceId,
          eventId:   match.eventId,
          traceFile: match.traceFile,
        }],
      });
    }
  }

  // 5. Partition into covered / uncovered
  const coveredKeys  = new Set(coverageMap.keys());
  const covered      = [...coverageMap.values()];
  const uncovered    = changedFunctions.filter(
    f => !coveredKeys.has(functionKey(f)),
  );

  const total         = changedFunctions.length;
  const coveredCount  = covered.length;
  const coveragePercent = total === 0
    ? 100
    : Math.round((coveredCount / total) * 100);

  return {
    schemaVersion: SCHEMA_VERSIONS.coverage,
    reportId:      `cov_${crypto.randomBytes(8).toString('hex')}`,
    createdAt:     Date.now(),
    baseRef,
    headRef,
    covered,
    uncovered,
    summary: {
      changedFunctions: total,
      coveredCount,
      uncoveredCount:   uncovered.length,
      coveragePercent,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function functionKey(f: {
  file: string;
  functionName?: string;
  className?:    string;
  methodName?:   string;
}): string {
  return `${f.file}|${f.className ?? ''}|${f.methodName ?? f.functionName ?? ''}`;
}
