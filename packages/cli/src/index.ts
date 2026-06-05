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
import path from 'path';
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
  findingApproveBatchCommand,
  findingSuppressCommand,
  findingRejectCommand,
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
import { coverageCommand }  from './commands/coverage';
import { packCommand }      from './commands/pack';
import { ciSummaryCommand } from './commands/ci-summary';
import { adoptCommand }     from './commands/adopt';
import { quickCommand }     from './commands/quick';
import { replayCommand }    from './commands/replay';
import {
  serverInstallCommand,
  serverStatusCommand,
  serverStopCommand,
  serverLogsCommand,
} from './commands/server';
import { pullBaselinesFromTeamServer } from './commands/team-server';
import { testgenCommand }              from './commands/testgen';
import { baselineSuggestUpdateCommand } from './commands/baseline-suggest';
import { auditCommand }                from './commands/audit';

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
  .option('--server-mode',       'Keep the child process alive (dev server); write one trace per HTTP request')
  .action(async (options: { runId?: string; scenarioId?: string; serverMode?: boolean }) => {
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
  .option('--verbose',            'Show remediation snippets for each finding')
  .option('--upload <url>',       'Upload traces and report to Team Server after comparing')
  .option('--project-id <id>',    'Project ID on Team Server (default: cwd basename)')
  .option('--token <token>',      'Bearer token for Team Server (default: $TRACEGRAPH_TOKEN)')
  .action(async (options: {
    baseline?: string; candidate?: string; bundle?: string; out?: string;
    latest?: boolean; failOnCritical?: boolean; verbose?: boolean;
    upload?: string; projectId?: string; token?: string;
  }) => {
    const code = compareCommand(options);
    if (options.upload) {
      // Upload after compare completes (non-blocking on result)
      const { uploadToTeamServer: _upload, createTeamServerRun: _create } =
        await import('./commands/team-server');
      const tgDir    = path.join(process.cwd(), '.tracegraph');
      const tracesDir = path.join(tgDir, 'traces');
      let latestRunId = 'unknown';
      try {
        const latest = JSON.parse(
          require('fs').readFileSync(path.join(tgDir, 'latest.json'), 'utf8'),
        ) as { latestRunId: string; latestTraceIds: string[]; latestReportId: string | null };
        latestRunId = latest.latestRunId;
        const traceFiles = latest.latestTraceIds.map(
          (id: string) => path.join(tracesDir, `${id}.trace.json`),
        ).filter((f: string) => require('fs').existsSync(f));
        const reportsDir  = path.join(tgDir, 'reports');
        const reportFiles = require('fs').existsSync(reportsDir)
          ? require('fs').readdirSync(reportsDir)
              .filter((f: string) => f.endsWith('.report.json'))
              .map((f: string) => path.join(reportsDir, f))
              .sort((a: string, b: string) =>
                require('fs').statSync(b).mtimeMs - require('fs').statSync(a).mtimeMs)
          : [];
        const reportFile = reportFiles[0] as string | undefined;
        const serverRunId = await _create(
          { serverUrl: options.upload, projectId: options.projectId, token: options.token },
          latestRunId,
        );
        if (serverRunId) {
          await _upload(
            { serverUrl: options.upload!, projectId: options.projectId, token: options.token },
            serverRunId,
            traceFiles,
            reportFile,
          );
        }
      } catch (err) {
        process.stderr.write(`[tracegraph] Upload failed: ${String(err)}\n`);
      }
    }
    process.exit(code);
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
  .description('Approve a finding or batch-approve multiple findings')
  .argument('[fingerprint]', 'Finding fingerprint (16-char hex) — omit for batch mode')
  .option('--reason <reason>',       'Approval reason')
  .option('--approved-by <name>',    'Approver name')
  .option('--expires <ISO-date>',    'Approval expiry date (default: 1 year)')
  .option('--all',                   'Batch: approve all open findings')
  .option('--rule <pattern>',        'Batch: approve findings matching rule ID pattern (glob)')
  .option('--severity <level>',      'Batch: approve findings at or below this severity')
  .option('--dry-run',               'Show what would be approved without writing changes')
  .action((fingerprint: string | undefined, options: {
    reason?:     string;
    approvedBy?: string;
    expiresAt?:  string;
    all?:        boolean;
    rule?:       string;
    severity?:   string;
    dryRun?:     boolean;
  }) => {
    // If no fingerprint and batch flags present → batch mode
    if (!fingerprint || options.all || options.rule || options.severity) {
      if (!fingerprint && !options.all && !options.rule && !options.severity) {
        process.stderr.write('[tracegraph] Provide a fingerprint or use --all / --rule / --severity\n');
        process.exit(EXIT_CODES.CLI_ERROR);
      }
      process.exit(findingApproveBatchCommand({
        all:        options.all,
        rule:       options.rule ?? (fingerprint && !options.all ? undefined : fingerprint),
        severity:   options.severity as never,
        reason:     options.reason,
        approvedBy: options.approvedBy,
        dryRun:     options.dryRun,
      }));
    }
    if (!options.reason) {
      process.stderr.write('[tracegraph] --reason is required\n');
      process.exit(EXIT_CODES.CLI_ERROR);
    }
    process.exit(findingApproveCommand(fingerprint, { reason: options.reason, approvedBy: options.approvedBy, expiresAt: options.expiresAt }));
  });

findingCmd
  .command('reject')
  .description('Mark a finding as "needs fix" — overrides any existing approval')
  .argument('<fingerprint>', 'Finding fingerprint (16-char hex)')
  .option('--reason <reason>',    'Rejection reason')
  .option('--rejected-by <name>', 'Who is rejecting this finding')
  .action((fingerprint: string, options: { reason?: string; rejectedBy?: string }) => {
    process.exit(findingRejectCommand(fingerprint, options));
  });

findingCmd
  .command('suppress')
  .description('Add a suppression for a finding')
  .argument('<fingerprint>', 'Finding fingerprint (16-char hex)')
  .requiredOption('--reason <reason>', 'Suppression reason')
  .option('--approved-by <name>',             'Approver name')
  .option('--expires <ISO-date>',             'Expiry date')
  .option('--requires-evidence <type:name>',  'Evidence required for suppression to be active')
  .option('--route <pattern>',                'Scope: suppress only for this route (glob, e.g. "GET /health*")')
  .option('--resource <name>',                'Scope: suppress only for this DB table or resource')
  .option('--file <pattern>',                 'Scope: suppress only for files matching this glob (e.g. "src/legacy/**")')
  .action((fingerprint: string, options: {
    reason:            string;
    approvedBy?:       string;
    expiresAt?:        string;
    requiresEvidence?: string;
    route?:            string;
    resource?:         string;
    file?:             string;
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

// ── tracegraph coverage ───────────────────────────────────────────────────
program
  .command('coverage')
  .description('Map changed functions (git diff) to runtime trace coverage')
  .option('--base <ref>',        'Git ref to diff from (default: HEAD~1)')
  .option('--head <ref>',        'Git ref to diff to (default: HEAD)')
  .option('--traces <dir>',      'Directory containing .trace.json files')
  .option('--out <file>',        'Write coverage report JSON to this file')
  .option('--json',              'Also print the full report JSON to stdout')
  .option('--fail-uncovered',    'Exit 1 if any changed functions have no trace coverage')
  .action((options: {
    base?:          string;
    head?:          string;
    traces?:        string;
    out?:           string;
    json?:          boolean;
    failUncovered?: boolean;
  }) => {
    process.exit(coverageCommand(options));
  });

// ── tracegraph pack ───────────────────────────────────────────────────────
program
  .command('pack')
  .description('Generate AI context packs (Cursor / Claude Code / Copilot / MCP) from findings')
  .option('--format <fmt>',      'cursor | claude-code | copilot | mcp | all (default: all)')
  .option('--report <file>',     'Path to a .report.json file (default: latest report)')
  .option('--traces <dir>',      'Directory of .trace.json files to include as context')
  .option('--out-dir <dir>',     'Output directory for pack files (default: project root)')
  .option('--project <name>',    'Project name for pack headers')
  .option('--max-chars <n>',     'Max trace context characters per pack', parseInt)
  .option('--dry-run',           'Print what would be written without writing files')
  .action((options: {
    format?:   string;
    report?:   string;
    traces?:   string;
    outDir?:   string;
    project?:  string;
    maxChars?: number;
    dryRun?:   boolean;
  }) => {
    process.exit(packCommand(options));
  });

// ── tracegraph ci-summary ─────────────────────────────────────────────────
program
  .command('ci-summary')
  .description('Print a structured CI summary from the latest report')
  .option('--format <fmt>',          'Output format: text | json | github (default: text)')
  .option('--input <file>',          'Path to a specific .report.json file')
  .option('--slack-webhook <url>',   'Post the summary to a Slack Incoming Webhook URL')
  .action(async (options: { format?: string; input?: string; slackWebhook?: string }) => {
    const code = await ciSummaryCommand({
      format:       options.format as never,
      input:        options.input,
      slackWebhook: options.slackWebhook,
    });
    process.exit(code);
  });

// ── tracegraph adopt ──────────────────────────────────────────────────────
program
  .command('adopt')
  .description('Adopt current behaviour as the approved baseline (for existing codebases)')
  .option('--dry-run',              'Show what would be adopted without writing changes')
  .option('--reason <reason>',      'Adoption reason recorded in BASELINE_ASSUMPTIONS.md')
  .option('--approved-by <name>',   'Name of the person authorising the adoption')
  .action((options: { dryRun?: boolean; reason?: string; approvedBy?: string }) => {
    process.exit(adoptCommand(options));
  });

// ── tracegraph quick ──────────────────────────────────────────────────────
program
  .command('quick')
  .description('Zero-config demo: create a sample project, trace it, and open the viewer')
  .option('--out-dir <path>',       'Directory to create the demo project in (default: system temp)')
  .action((options: { outDir?: string }) => {
    process.exit(quickCommand(options));
  });

// ── tracegraph replay ─────────────────────────────────────────────────────
program
  .command('replay')
  .description('Replay HTTP requests from a trace against a target URL')
  .argument('<trace-file>', 'Path to a .trace.json file')
  .option('--base-url <url>',       'Base URL for replayed requests (e.g. http://localhost:3000)')
  .option('--env <name>',           'Environment name from tracegraph.config.json replay.environments')
  .option('--dry-run',              'Print the requests that would be sent without executing them')
  .option('--compare',              'Run `tracegraph compare` automatically after replay')
  .option('--include-auth',         'Include Authorization/Cookie headers (stripped by default)')
  .option('--allow-destructive',    'Allow DELETE and PUT requests (skipped by default)')
  .action(async (traceFile: string, options: {
    baseUrl?:          string;
    env?:              string;
    dryRun?:           boolean;
    compare?:          boolean;
    includeAuth?:      boolean;
    allowDestructive?: boolean;
  }) => {
    const code = await replayCommand(traceFile, options);
    process.exit(code);
  });

// ── tracegraph server ─────────────────────────────────────────────────────
const serverCmd = program.command('server').description('Manage the TraceGraph Team Server');

serverCmd
  .command('install')
  .description('Install and start the Team Server via Docker Compose')
  .option('--port <port>',        'HTTP port to bind (default: 3000)')
  .option('--data-dir <dir>',     'Host path for persistent data (default: ./.tracegraph-server/data)')
  .action((options: { port?: string; dataDir?: string }) => {
    process.exit(serverInstallCommand(options));
  });

serverCmd
  .command('status')
  .description('Check whether the Team Server is running and healthy')
  .option('--url <url>',          'Team Server URL (default: http://localhost:3000)')
  .action(async (options: { url?: string }) => {
    process.exit(await serverStatusCommand(options));
  });

serverCmd
  .command('stop')
  .description('Stop the Team Server container')
  .action(() => {
    process.exit(serverStopCommand());
  });

serverCmd
  .command('logs')
  .description('Stream Team Server container logs')
  .option('-f, --follow',         'Follow log output (docker compose logs -f)')
  .action((options: { follow?: boolean }) => {
    process.exit(serverLogsCommand(options));
  });

// ── tracegraph baseline pull ──────────────────────────────────────────────
// (added to the existing baseline command group, which is defined above as baselineCmd)
baselineCmd
  .command('pull')
  .description('Pull latest baselines from Team Server into .tracegraph/baselines/')
  .option('--team-server <url>',   'Team Server URL (default: http://localhost:3000)')
  .option('--project-id <id>',     'Project ID on the Team Server (default: cwd basename)')
  .option('--token <token>',       'Bearer token (default: $TRACEGRAPH_TOKEN)')
  .action(async (options: { teamServer?: string; projectId?: string; token?: string }) => {
    const serverUrl   = options.teamServer ?? 'http://localhost:3000';
    const baselinesDir = path.join(process.cwd(), '.tracegraph', 'baselines');
    const count = await pullBaselinesFromTeamServer(
      { serverUrl, projectId: options.projectId, token: options.token },
      baselinesDir,
    );
    process.exit(count >= 0 ? EXIT_CODES.SUCCESS : EXIT_CODES.CLI_ERROR);
  });

// ── tracegraph baseline suggest-update ───────────────────────────────────────
// (added to the existing baseline command group)
baselineCmd
  .command('suggest-update')
  .description('Analyse the diff between current traces and baselines; suggest safe updates')
  .option('--trace <file>',           'Analyse a specific trace file instead of the latest run')
  .option('--interactive',            'Walk through each suggestion interactively')
  .option('--accept-suggestions',     'Automatically write baselines for all SAFE traces')
  .option('--approved-by <name>',     'Name to record on written baselines')
  .option('--reason <reason>',        'Reason to record on written baselines')
  .action(async (options: {
    trace?:             string;
    interactive?:       boolean;
    acceptSuggestions?: boolean;
    approvedBy?:        string;
    reason?:            string;
  }) => {
    process.exit(await baselineSuggestUpdateCommand(options));
  });

// ── tracegraph testgen ────────────────────────────────────────────────────────
program
  .command('testgen')
  .description('Generate HTTP test cases from a trace file')
  .argument('<trace-file>', 'Path to a .trace.json file')
  .option('--framework <name>',  'Test framework: express | laravel | fastapi | gin (auto-detected)')
  .option('--out <dir>',         'Directory to write the generated test file')
  .option('--dry-run',           'Print generated test content without writing to disk')
  .action(async (traceFile: string, options: {
    framework?: string;
    out?:       string;
    dryRun?:    boolean;
  }) => {
    process.exit(await testgenCommand(traceFile, options));
  });

// ── tracegraph audit ─────────────────────────────────────────────────────────
program
  .command('audit')
  .description('Fork a GitHub repo, find a major PR, run TraceGraph, and report findings')
  .argument('<github-url>', 'GitHub repository URL (https://github.com/owner/repo)')
  .option('--pr <number>',        'Analyse a specific PR number (skips scoring/selection)',
          (v) => parseInt(v, 10))
  .option('--workspace <dir>',    'Directory to clone into (default: ~/.tracegraph/audits/)')
  .option('--skip-fork',          'Clone upstream directly without forking (no GitHub fork created)')
  .option('--token <token>',      'GitHub personal access token (default: $GITHUB_TOKEN)')
  .option('--out <file>',         'Copy the generated markdown report to this file')
  .option('--json',               'Print machine-readable JSON summary')
  .option('--timeout <seconds>',  'Per-phase timeout in seconds (default: 300)',
          (v) => parseInt(v, 10))
  .action(async (githubUrl: string, options: {
    pr?:        number;
    workspace?: string;
    skipFork?:  boolean;
    token?:     string;
    out?:       string;
    json?:      boolean;
    timeout?:   number;
  }) => {
    process.exit(await auditCommand(githubUrl, options));
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
