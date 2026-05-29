/**
 * M7A T7A.3 — `tracegraph pack` command
 *
 * Generates AI context packs from a TraceReport (findings) and optional
 * trace files.  Packs are written to conventional file locations that AI
 * tools automatically pick up.
 *
 * Usage:
 *   tracegraph pack [options]
 *
 * Options:
 *   --format <fmt>     cursor | claude-code | copilot | mcp | all (default: all)
 *   --report <file>    Path to a .report.json file (default: latest report)
 *   --traces <glob>    Glob or directory of .trace.json files to include as context
 *   --out-dir <dir>    Output directory (default: project root)
 *   --project <name>   Project name for pack headers
 *   --max-chars <n>    Max trace context characters per pack (default: 40000)
 *   --dry-run          Print what would be written without writing files
 */

import * as fs   from 'fs';
import * as path from 'path';
import { buildPromptPacks } from '@tracegraph/ai-coverage';
import { EXIT_CODES } from '@tracegraph/shared-types';
import type { PromptPackFormat } from '@tracegraph/shared-types';

export type PackCommandOptions = {
  format?:   string;       // 'cursor' | 'claude-code' | 'copilot' | 'mcp' | 'all'
  report?:   string;
  traces?:   string;
  outDir?:   string;
  project?:  string;
  maxChars?: number;
  dryRun?:   boolean;
};

const ALL_FORMATS: PromptPackFormat[] = ['cursor', 'claude-code', 'copilot', 'mcp'];
const VALID_FORMATS = new Set<string>([...ALL_FORMATS, 'all']);

export function packCommand(options: PackCommandOptions = {}): number {
  const {
    format:  formatArg = 'all',
    report:  reportArg,
    traces:  tracesArg,
    outDir:  outDirArg,
    project: projectName,
    maxChars = 40_000,
    dryRun   = false,
  } = options;

  const cwd = process.cwd();

  // ─── Resolve formats ─────────────────────────────────────────────────────
  if (!VALID_FORMATS.has(formatArg)) {
    process.stderr.write(
      `[tracegraph pack] Unknown format "${formatArg}". ` +
      `Valid values: cursor, claude-code, copilot, mcp, all\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }
  const formats: PromptPackFormat[] =
    formatArg === 'all' ? ALL_FORMATS : [formatArg as PromptPackFormat];

  // ─── Resolve report file ─────────────────────────────────────────────────
  const reportFile = reportArg
    ? path.resolve(cwd, reportArg)
    : findLatestReport(cwd);

  if (!reportFile) {
    process.stderr.write(
      '[tracegraph pack] No report file found. ' +
      'Run `tracegraph compare` first, or supply --report <file>.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  if (!fs.existsSync(reportFile)) {
    process.stderr.write(`[tracegraph pack] Report not found: ${reportFile}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  // ─── Resolve trace files ─────────────────────────────────────────────────
  const traceFiles = resolveTraceFiles(tracesArg, cwd);

  // ─── Resolve project name ─────────────────────────────────────────────────
  const resolvedProjectName = projectName ?? resolveProjectName(cwd);

  // ─── Build packs ─────────────────────────────────────────────────────────
  let packs;
  try {
    packs = buildPromptPacks({
      formats,
      report:          reportFile,
      traceFiles,
      maxContextChars: maxChars,
      projectName:     resolvedProjectName,
    });
  } catch (err) {
    process.stderr.write(`[tracegraph pack] Error building packs: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  // ─── Write or dry-run ────────────────────────────────────────────────────
  const outBase = outDirArg ? path.resolve(cwd, outDirArg) : cwd;

  process.stderr.write('\n');
  if (dryRun) {
    process.stderr.write('  tracegraph pack (dry run)\n');
  } else {
    process.stderr.write('  tracegraph pack\n');
  }
  process.stderr.write(`  report: ${reportFile}\n`);
  process.stderr.write(`  ─────────────────────────────────────────────\n`);

  let errCount = 0;
  for (const pack of packs) {
    const destFile = path.join(outBase, pack.fileName);
    const rel      = path.relative(cwd, destFile);

    if (dryRun) {
      process.stderr.write(`  [dry-run] would write: ${rel} (${pack.format})\n`);
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.writeFileSync(destFile, pack.content, 'utf8');
      process.stderr.write(`  ✓ wrote: ${rel}\n`);
    } catch (err) {
      process.stderr.write(`  ✗ failed: ${rel} — ${String(err)}\n`);
      errCount++;
    }
  }

  process.stderr.write('\n');

  return errCount > 0 ? EXIT_CODES.CLI_ERROR : EXIT_CODES.SUCCESS;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findLatestReport(cwd: string): string | null {
  // Try latest.json pointer first
  const latestJsonPath = path.join(cwd, '.tracegraph', 'latest.json');
  if (fs.existsSync(latestJsonPath)) {
    try {
      const latest = JSON.parse(fs.readFileSync(latestJsonPath, 'utf8')) as {
        latestReportId?: string | null;
      };
      if (latest.latestReportId) {
        const reportPath = path.join(
          cwd,
          '.tracegraph',
          'reports',
          `${latest.latestReportId}.report.json`,
        );
        if (fs.existsSync(reportPath)) return reportPath;
      }
    } catch {
      // fall through
    }
  }

  // Fall back: most recently modified .report.json in reports dir
  const reportsDir = path.join(cwd, '.tracegraph', 'reports');
  if (!fs.existsSync(reportsDir)) return null;

  try {
    const files = fs
      .readdirSync(reportsDir)
      .filter(f => f.endsWith('.report.json'))
      .map(f => ({
        file:  path.join(reportsDir, f),
        mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.file ?? null;
  } catch {
    return null;
  }
}

function resolveTraceFiles(tracesArg: string | undefined, cwd: string): string[] {
  if (!tracesArg) {
    // Default: all .trace.json files in .tracegraph/traces/
    const tracesDir = path.join(cwd, '.tracegraph', 'traces');
    if (!fs.existsSync(tracesDir)) return [];
    try {
      return fs
        .readdirSync(tracesDir)
        .filter(f => f.endsWith('.trace.json'))
        .map(f => path.join(tracesDir, f));
    } catch {
      return [];
    }
  }

  // If it's a directory, list .trace.json files inside
  const resolved = path.resolve(cwd, tracesArg);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    try {
      return fs
        .readdirSync(resolved)
        .filter(f => f.endsWith('.trace.json'))
        .map(f => path.join(resolved, f));
    } catch {
      return [];
    }
  }

  // Treat as a single file
  return fs.existsSync(resolved) ? [resolved] : [];
}

function resolveProjectName(cwd: string): string {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (pkg.name) return pkg.name;
    } catch {
      // fall through
    }
  }
  return path.basename(cwd);
}
