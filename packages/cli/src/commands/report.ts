/**
 * T2.10 — `tracegraph report`
 *
 * Renders a stored TraceReport in the requested format.
 *
 * Usage:
 *   tracegraph report --format markdown [--input <report.json>]
 *   tracegraph report --format json [--input <report.json>]
 *   tracegraph report --format github-step-summary [--input <report.json>]
 */
import fs   from 'fs';
import path from 'path';
import { EXIT_CODES } from '@tracegraph/shared-types';
import type { TraceReport }  from '@tracegraph/shared-types';
import { renderReport }  from '@tracegraph/ci-reporter';
import type { ReportFormat } from '@tracegraph/ci-reporter';

export type ReportCommandOptions = {
  input?:       string;
  format?:      string;
  projectName?: string;
  out?:         string;
};

export function reportCommand(options: ReportCommandOptions): number {
  const cwd          = process.cwd();
  const tracegraphDir = path.join(cwd, '.tracegraph');

  // ── Resolve report file ───────────────────────────────────────────────────
  let reportFile: string;

  if (options.input) {
    reportFile = path.resolve(cwd, options.input);
  } else {
    const reportsDir = path.join(tracegraphDir, 'reports');
    if (!fs.existsSync(reportsDir)) {
      process.stderr.write(
        '[tracegraph] No reports found. Run `tracegraph compare` first.\n',
      );
      return EXIT_CODES.CLI_ERROR;
    }
    const files = fs.readdirSync(reportsDir)
      .filter((f) => f.endsWith('.report.json'))
      .map((f) => ({
        name:  f,
        mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      process.stderr.write('[tracegraph] No .report.json files found.\n');
      return EXIT_CODES.CLI_ERROR;
    }
    reportFile = path.join(reportsDir, files[0]!.name);
  }

  if (!fs.existsSync(reportFile)) {
    process.stderr.write(`[tracegraph] Report file not found: ${reportFile}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  let report: TraceReport;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as TraceReport;
  } catch (err) {
    process.stderr.write(`[tracegraph] Failed to read report: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const format = (options.format ?? 'markdown') as ReportFormat;
  const rendered = renderReport(report, {
    format,
    projectName: options.projectName,
  });

  // ── Output ────────────────────────────────────────────────────────────────
  if (options.out) {
    const outPath = path.resolve(cwd, options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, rendered, 'utf8');
    process.stdout.write(`[tracegraph] Report written: ${path.relative(cwd, outPath)}\n`);

    // If --format github-step-summary, also write to $GITHUB_STEP_SUMMARY
    if (format === 'github-step-summary' && process.env['GITHUB_STEP_SUMMARY']) {
      fs.appendFileSync(process.env['GITHUB_STEP_SUMMARY'], rendered, 'utf8');
    }
  } else {
    process.stdout.write(rendered);
  }

  return EXIT_CODES.SUCCESS;
}
