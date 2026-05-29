#!/usr/bin/env node
/**
 * TraceGraph CLI — entry point
 *
 * Architecture: ARCHITECTURE.md §6 (CLI stdout Protocol)
 *
 * Parsing strategy:
 *   The `--` separator is significant — everything after it is the wrapped command.
 *   We extract it from process.argv before handing to Commander so Commander
 *   does not try to parse the wrapped command's flags as TraceGraph flags.
 */

import { Command } from 'commander';
import { EXIT_CODES } from '@tracegraph/shared-types';
import { runCommand }          from './commands/run';
import { cleanCommand }        from './commands/clean';
import { storageStatusCommand } from './commands/storage-status';
import { openCommand }         from './commands/open';
import { initCommand }         from './commands/init';
import {
  baselineCreateCommand,
  baselineListCommand,
  baselineApproveCommand,
} from './commands/baseline';
import { compareCommand }      from './commands/compare';
import {
  findingListCommand,
  findingApproveCommand,
  findingSuppressCommand,
} from './commands/finding';
import { findingExplainCommand } from './commands/explain';
import { reportCommand }       from './commands/report';
import { diagnoseCommand }     from './commands/diagnose';
import { importXdebugCommand }  from './commands/import-xdebug';
import {
  schemaDoctorCommand,
  baselineMigrateCommand,
} from './commands/schema';
import {
  scenarioRunCommand,
  scenarioValidateCommand,
  scenarioListCommand,
} from './commands/scenario';

// ── Extract the wrapped command (everything after --) ─────────────────────
const rawArgv     = process.argv.slice(2); // strip 'node' and script path
const ddIdx       = rawArgv.indexOf('--');
const tgArgv      = ddIdx === -1 ? rawArgv : rawArgv.slice(0, ddIdx);
const wrappedArgs = ddIdx === -1 ? [] : rawArgv.slice(ddIdx + 1);

const program = new Command();

program
  .name('tracegraph')
  .description('Capture how code actually behaves during tests, scenarios, and local development runs, then produces trace files, behavior graphs, baselines, diffs, findings, and reports that help code reviewers with with runtime evidence of code changes.')
  .version('0.0.1');

// ── tracegraph run [options] -- <command> ─────────────────────────────────
program
  .command('run')
  .description('Run a command with tracing enabled')
  .option('--run-id <id>',       'Override the generated run ID')
  .option('--scenario-id <id>',  'Tag this run with a scenario/PR correlation ID')
  .action(async (options: { runId?: string; scenarioId?: string }) => {
    const code = await runCommand(wrappedArgs, options);
    process.exit(code);
  });

// ── tracegraph baseline ───────────────────────────────────────────────────
const baselineCmd = program.command('baseline').description('Manage behaviour baselines');

baselineCmd
  .command('create')
  .description('Create baselines from traces (defaults to latest run)')
  .option('--reason <reason>',      'Approval reason (non-interactive mode)')
  .option('--approved-by <name>',   'Approver name (defaults to current user)')
  .option('--all',                  'Overwrite existing baselines')
  .option('--latest-run',           'Use traces from the most recent run (default)')
  .option('--run-id <id>',          'Use traces from a specific run ID')
  .option('--all-traces',           'Use ALL traces in .tracegraph/traces/ (overrides default scope)')
  .option('--only-passed',          'Skip traces whose status is not "passed"')
  .action((options: {
    reason?: string; approvedBy?: string; all?: boolean;
    latestRun?: boolean; runId?: string; allTraces?: boolean; onlyPassed?: boolean;
  }) => {
    process.exit(baselineCreateCommand(options));
  });

baselineCmd
  .command('list')
  .description('List all stored baselines')
  .action(() => {
    process.exit(baselineListCommand());
  });

baselineCmd
  .command('migrate')
  .description('Migrate baseline files to the current schema version')
  .option('--dry-run', 'Show what would be migrated without writing changes')
  .action((options: { dryRun?: boolean }) => {
    process.exit(baselineMigrateCommand(options));
  });

baselineCmd
  .command('approve')
  .description('Approve (re-approve) an existing baseline')
  .argument('<baseline-id>', 'Baseline ID or test ID')
  .requiredOption('--reason <reason>', 'Approval reason')
  .option('--approved-by <name>', 'Approver name')
  .action((baselineId: string, options: { reason: string; approvedBy?: string }) => {
    process.exit(baselineApproveCommand(baselineId, options));
  });

// ── tracegraph compare ────────────────────────────────────────────────────
program
  .command('compare')
  .description('Compare candidate traces against baselines and produce a report')
  .option('--baseline <dir>',     'Directory containing baseline files')
  .option('--candidate <file>',   'Candidate trace file or directory (default: latest run)')
  .option('--bundle <file>',      'TraceBundle JSON file — compare all traces in the bundle')
  .option('--out <file>',         'Output path for the report JSON')
  .option('--latest',             'Compare only traces from the most recent run (reads .tracegraph/latest.json)')
  .option('--fail-on-critical',   'Exit 3 if any critical findings are open')
  .action((options: { baseline?: string; candidate?: string; bundle?: string; out?: string; latest?: boolean; failOnCritical?: boolean }) => {
    process.exit(compareCommand(options));
  });

// ── tracegraph finding ────────────────────────────────────────────────────
const findingCmd = program.command('finding').description('Manage findings');

findingCmd
  .command('list')
  .description('List all findings from the latest report')
  .option('--report <file>', 'Path to a specific report JSON')
  .action((options: { report?: string }) => {
    process.exit(findingListCommand(options.report));
  });

findingCmd
  .command('approve')
  .description('Approve a finding by fingerprint')
  .argument('<fingerprint>', 'Finding fingerprint (16-char hex)')
  .requiredOption('--reason <reason>', 'Approval reason')
  .option('--approved-by <name>', 'Approver name')
  .option('--expires <ISO-date>', 'Approval expiry date (default: 1 year)')
  .action((fingerprint: string, options: { reason: string; approvedBy?: string; expiresAt?: string }) => {
    process.exit(findingApproveCommand(fingerprint, options));
  });

findingCmd
  .command('suppress')
  .description('Add a suppression for a finding')
  .argument('<fingerprint>', 'Finding fingerprint (16-char hex)')
  .requiredOption('--reason <reason>', 'Suppression reason')
  .option('--approved-by <name>',             'Approver name')
  .option('--expires <ISO-date>',             'Expiry date')
  .option('--requires-evidence <type:name>',  'Evidence required for suppression to be active')
  .action((fingerprint: string, options: {
    reason:            string;
    approvedBy?:       string;
    expiresAt?:        string;
    requiresEvidence?: string;
  }) => {
    process.exit(findingSuppressCommand(fingerprint, options));
  });

findingCmd
  .command('explain')
  .description('Show a detailed explanation of a finding by fingerprint')
  .argument('<fingerprint>', 'Finding fingerprint (or unique prefix)')
  .option('--report <file>', 'Path to a specific report JSON')
  .option('--json', 'Output raw JSON instead of human-readable text')
  .action((fingerprint: string, options: { report?: string; json?: boolean }) => {
    process.exit(findingExplainCommand(fingerprint, options));
  });

// ── tracegraph report ─────────────────────────────────────────────────────
program
  .command('report')
  .description('Render a trace report in the requested format')
  .option('--format <format>',       'Output format: markdown | json | github-step-summary', 'markdown')
  .option('--input <file>',          'Path to a specific .report.json file')
  .option('--out <file>',            'Write rendered output to this file instead of stdout')
  .option('--project-name <name>',   'Project name for the report header')
  .action((options: { format?: string; input?: string; out?: string; projectName?: string }) => {
    process.exit(reportCommand(options));
  });

// ── tracegraph open ───────────────────────────────────────────────────────
program
  .command('open')
  .description('Open a trace or report in the browser')
  .option('--html',          'Produce a self-contained HTML file')
  .option('--out <path>',    'Output path for the HTML file')
  .option('--no-open',       'Write the HTML file but do not open a browser')
  .argument('[file]',        'Trace JSON file to open')
  .action((file: string | undefined, options: { html?: boolean; out?: string; open?: boolean }) => {
    if (!file) {
      process.stderr.write('Usage: tracegraph open --html <trace-file>\n');
      process.exit(EXIT_CODES.CLI_ERROR);
    }
    openCommand(file, { out: options.out, noOpen: options.open === false });
    process.exit(EXIT_CODES.SUCCESS);
  });

// ── tracegraph init ───────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialise TraceGraph in the current project')
  .action(() => {
    initCommand();
    process.exit(EXIT_CODES.SUCCESS);
  });

// ── tracegraph diagnose ───────────────────────────────────────────────────
program
  .command('diagnose')
  .description('Show what is being captured and how to improve the capture level')
  .option('--trace <traceId>', 'Diagnose a specific trace by ID or file path')
  .option('--json',            'Output as JSON instead of human-readable text')
  .action((options: { trace?: string; json?: boolean }) => {
    process.exit(diagnoseCommand(options));
  });

// ── tracegraph schema ─────────────────────────────────────────────────────
const schemaCmd = program.command('schema').description('Inspect and migrate TraceGraph artifact schemas');

schemaCmd
  .command('doctor')
  .description('Scan local artifacts for schema version mismatches')
  .option('--json', 'Output report as JSON instead of human-readable text')
  .action((options: { json?: boolean }) => {
    process.exit(schemaDoctorCommand(options));
  });

// ── tracegraph import ─────────────────────────────────────────────────────
const importCmd = program.command('import').description('Import traces from external tools');

importCmd
  .command('xdebug')
  .description('Import an Xdebug .xt trace file, optionally merging with a Laravel semantic trace')
  .argument('<file>', 'Path to the Xdebug .xt trace file')
  .option('--semantic <file>',    'Path to a Laravel semantic JSONL trace to merge with')
  .option('--include <pattern>',  'Only include functions whose file path matches this pattern')
  .option('--max-events <n>',     'Maximum number of events to emit (default: 10000)', parseInt)
  .option('--out-dir <dir>',      'Output directory (default: .tracegraph/traces/)')
  .action(async (file: string, options: {
    semantic?:   string;
    include?:    string;
    maxEvents?:  number;
    outDir?:     string;
  }) => {
    process.exit(await importXdebugCommand(file, options));
  });

// ── tracegraph scenario ───────────────────────────────────────────────────
const scenarioCmd = program.command('scenario').description('Run and manage TraceGraph scenarios');

scenarioCmd
  .command('run')
  .description('Execute a scenario definition file end-to-end')
  .argument('<file>', 'Path to the .scenario.json file')
  .action(async (file: string) => {
    process.exit(await scenarioRunCommand(file));
  });

scenarioCmd
  .command('validate')
  .description('Validate a scenario file structure without running it')
  .argument('<file>', 'Path to the .scenario.json file')
  .action((file: string) => {
    process.exit(scenarioValidateCommand(file));
  });

scenarioCmd
  .command('list')
  .description('List scenario files in .tracegraph/scenarios/')
  .action(() => {
    process.exit(scenarioListCommand());
  });

// ── tracegraph clean ──────────────────────────────────────────────────────
program
  .command('clean')
  .description('Remove local trace run artifacts')
  .option('--older-than <age>',  'Remove runs older than this (e.g. 7d, 12h)')
  .option('--keep-last <n>',     'Keep the N most recent runs', parseInt)
  .option('--all-runs',          'Remove all runs (baselines are never removed)')
  .action((options: { olderThan?: string; keepLast?: number; allRuns?: boolean }) => {
    cleanCommand(options);
    process.exit(EXIT_CODES.SUCCESS);
  });

// ── tracegraph storage ────────────────────────────────────────────────────
const storageCmd = program.command('storage').description('Manage local trace storage');

storageCmd
  .command('status')
  .description('Show storage usage for the current project')
  .action(() => {
    storageStatusCommand();
    process.exit(EXIT_CODES.SUCCESS);
  });

// ── Parse (using tgArgv — TraceGraph flags only, no wrapped command args) ──
program.parseAsync(['node', 'tracegraph', ...tgArgv]).catch((err: unknown) => {
  process.stderr.write(`[tracegraph] Unexpected error: ${String(err)}\n`);
  process.exit(EXIT_CODES.CLI_ERROR);
});
