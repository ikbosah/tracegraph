import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  createRunId,
  createTraceId,
  createSessionId,
  createEventId,
  TraceEventWriter,
  finaliseTrace,
  updateTraceIndex,
  StorageManager,
} from '@tracegraph/trace-core';
import { SCHEMA_VERSIONS, EXIT_CODES } from '@tracegraph/shared-types';
import type { TraceEvent, CaptureLevel, TraceEntrypoint, LanguageId, LatestPointer } from '@tracegraph/shared-types';
import { emit, emitError } from '../protocol';
import { loadConfig } from '../config';

// ── Reporter auto-injection ────────────────────────────────────────────────────

type InjectionResult = {
  /** Possibly-modified args (may have extra reporter flags appended) */
  args:        string[];
  /** Informational messages to print to stderr before spawning */
  messages:    string[];
  /** Whether a reporter was injected */
  injected:    boolean;
  /** Which runner was detected */
  runner:      'vitest' | 'jest' | null;
};

/**
 * Detects whether the wrapped command is a vitest or jest invocation and
 * appends the appropriate TraceGraph reporter flags.
 *
 * Rules:
 *   - vitest detected: any arg whose basename matches /vitest(\.cmd)?$/i
 *   - jest detected:   any arg whose basename matches /jest(\.cmd)?$/i
 *   - Reporter already present (--reporter=@tracegraph/... or
 *     --reporters=@tracegraph/...): skip injection and warn
 */
function detectAndInjectReporter(
  args:            string[],
  workspaceRoot:   string,
): InjectionResult {
  const messages: string[] = [];
  let runner: 'vitest' | 'jest' | null = null;

  // Check all args for a vitest / jest binary reference
  for (const arg of args) {
    const base = path.basename(arg).toLowerCase();
    if (/^vitest(\.cmd)?$/.test(base)) { runner = 'vitest'; break; }
    if (/^jest(\.cmd)?$/.test(base))   { runner = 'jest';   break; }
  }

  // Also check if the command string implicitly contains "vitest" or "jest"
  // (e.g. `npx vitest run` — the word "vitest" appears as a plain arg)
  if (!runner) {
    const joined = args.join(' ').toLowerCase();
    if (/\bvitest\b/.test(joined)) runner = 'vitest';
    else if (/\bjest\b/.test(joined)) runner = 'jest';
  }

  if (!runner) {
    // Could not detect a known test runner — advise the user
    messages.push(
      'TraceGraph: no test reporter detected — capture level will be 0–1',
      'Recommendation: add @tracegraph/vitest or @tracegraph/jest for test-level tracing',
    );
    return { args, messages, injected: false, runner: null };
  }

  // Check whether a TraceGraph reporter is already wired in (config or explicit flag)
  const alreadyPresent = args.some((a) =>
    /--reporters?=@tracegraph\//i.test(a),
  );

  // Also check: if any arg is exactly "--reporter" or "--reporters" followed by @tracegraph/
  let alreadyPresentByPair = false;
  for (let i = 0; i < args.length - 1; i++) {
    if ((args[i] === '--reporter' || args[i] === '--reporters') &&
        (args[i + 1] ?? '').startsWith('@tracegraph/')) {
      alreadyPresentByPair = true;
      break;
    }
  }

  // Also check the vitest config file if one exists (best-effort, not required)
  // Including any explicitly-passed --config path in the args
  const explicitConfig = extractConfigArg(args);
  const hasReporterInConfig = checkVitestConfigForTraceGraphReporter(workspaceRoot, explicitConfig);

  if (alreadyPresent || alreadyPresentByPair || hasReporterInConfig) {
    messages.push(
      `TraceGraph: detected ${runner} — @tracegraph/${runner} reporter already present, skipping injection`,
    );
    return { args, messages, injected: false, runner };
  }

  // Inject reporter
  let injectedArgs: string[];
  if (runner === 'vitest') {
    // --reporter default keeps vitest's own output; --reporter @tracegraph/vitest adds ours
    injectedArgs = [...args, '--reporter=default', '--reporter=@tracegraph/vitest'];
    messages.push(
      `TraceGraph: detected Vitest — injecting @tracegraph/vitest reporter (Level 5)`,
    );
  } else {
    // jest: --reporters=default --reporters=@tracegraph/jest
    injectedArgs = [...args, '--reporters=default', '--reporters=@tracegraph/jest'];
    messages.push(
      `TraceGraph: detected Jest — injecting @tracegraph/jest reporter (Level 5)`,
    );
  }

  return { args: injectedArgs, messages, injected: true, runner };
}

/**
 * Best-effort check for whether a vitest.config file in the workspace
 * already references the TraceGraph reporter (so we don't double-inject).
 *
 * Checks both the workspace-root default config files and any explicit
 * --config <path> value found in the command args.
 */
function checkVitestConfigForTraceGraphReporter(
  workspaceRoot: string,
  extraConfigPath?: string,
): boolean {
  const configCandidates = [
    'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs',
  ];

  const pathsToCheck: string[] = configCandidates.map((n) => path.join(workspaceRoot, n));
  if (extraConfigPath) {
    pathsToCheck.push(
      path.isAbsolute(extraConfigPath)
        ? extraConfigPath
        : path.join(workspaceRoot, extraConfigPath),
    );
  }

  for (const p of pathsToCheck) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        // Match by package name OR by reporter class name (which appears when
        // the config uses a relative require, e.g. require('./dist/index.cjs'))
        if (
          content.includes('@tracegraph/vitest') ||
          content.includes('TraceGraphReporter')
        ) {
          return true;
        }
      } catch { /* ignore */ }
    }
  }
  return false;
}

/**
 * Extract the value of --config or --config=<val> from an args array.
 * Returns undefined if not found.
 */
function extractConfigArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--config=')) return arg.slice('--config='.length);
    if (arg === '--config' || arg === '-c') return args[i + 1];
  }
  return undefined;
}

export type RunOptions = {
  runId?: string;
  scenarioId?: string;
};

/**
 * `tracegraph run -- <command> [args...]`
 *
 * Wraps any command, writes a minimal M0 trace (trace_start + trace_end),
 * finalises the trace via atomic rename, and exits with the wrapped
 * command's exit code.
 *
 * Capture level for M0: 0 (runner metadata only — no language adapters yet).
 */
export async function runCommand(
  wrappedArgs: string[],
  options: RunOptions,
): Promise<number> {
  if (wrappedArgs.length === 0) {
    process.stderr.write(
      'Usage: tracegraph run [options] -- <command> [args]\n' +
      'Example: tracegraph run -- npm test\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const workspaceRoot = process.cwd();
  const config = loadConfig(workspaceRoot);

  const runId     = options.runId ?? createRunId();
  const traceId   = createTraceId();
  const sessionId = createSessionId();
  const startedAt = Date.now();

  const tracegraphDir = path.join(workspaceRoot, '.tracegraph');
  const runDir        = path.join(tracegraphDir, 'runs', runId);
  const tracesDir     = path.join(tracegraphDir, 'traces');

  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(tracesDir, { recursive: true });

  // ── Auto-detect test runner and inject reporter if needed ─────────────────
  const injection = detectAndInjectReporter(wrappedArgs, workspaceRoot);
  for (const msg of injection.messages) {
    process.stderr.write(`${msg}\n`);
  }
  const effectiveArgs = injection.args;

  const [command, ...commandArgs] = effectiveArgs;
  const commandStr = wrappedArgs.join(' ');  // keep original command string for trace metadata

  const entrypoint: TraceEntrypoint = { type: 'cli_command', command: commandStr };

  // ── Emit run.started ──────────────────────────────────────────────────────
  emit({ type: 'run.started', runId });

  // ── Emit trace.started ────────────────────────────────────────────────────
  emit({ type: 'trace.started', runId, traceId, payload: { entrypoint } });

  // ── Open event writer ─────────────────────────────────────────────────────
  const jsonlTmpPath = path.join(runDir, `${traceId}.events.jsonl.tmp`);
  const writer = new TraceEventWriter(jsonlTmpPath);

  // ── trace_start event ─────────────────────────────────────────────────────
  const traceStartEventId = createEventId();
  const traceStartEvent: TraceEvent = {
    schemaVersion: SCHEMA_VERSIONS.event,
    eventId: traceStartEventId,
    traceId,
    parentEventId: null,
    type: 'trace_start',
    language: 'javascript',
    name: 'trace_start',
    startTime: startedAt,
    metadata: { command: commandStr },
  };
  writer.write(traceStartEvent);

  // Close the writer stream BEFORE spawning the child so the child can safely
  // append to the same .jsonl.tmp file via fs.appendFileSync.
  await writer.close();

  // ── Spawn the wrapped command ─────────────────────────────────────────────
  let exitCode = 0;
  let spawnErrorMsg: string | undefined;

  // Environment variables communicated to the instrumented child process.
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    TRACEGRAPH_ENABLED:    '1',
    TRACEGRAPH_RUN_DIR:    runDir,
    TRACEGRAPH_TRACE_ID:   traceId,
    TRACEGRAPH_RUN_ID:     runId,
    TRACEGRAPH_SESSION_ID: sessionId,
    TRACEGRAPH_ROOT_EVENT_ID: traceStartEventId,
  };

  try {
    if (!command) {
      spawnErrorMsg = 'No command provided';
      exitCode = EXIT_CODES.CLI_ERROR;
    } else {
      const result = spawnSync(command, commandArgs, {
        stdio: 'inherit',  // pass through so the user sees the command's output
        shell: false,
        env:   childEnv,
      });

      if (result.error) {
        spawnErrorMsg = result.error.message;
        // ENOENT means the command was not found
        exitCode = result.error.message.includes('ENOENT')
          ? EXIT_CODES.CLI_ERROR
          : EXIT_CODES.COMMAND_FAILURE;
      } else {
        exitCode = result.status ?? EXIT_CODES.SUCCESS;
      }
    }
  } catch (err) {
    spawnErrorMsg = err instanceof Error ? err.message : String(err);
    exitCode = EXIT_CODES.CLI_ERROR;
    emitError(runId, 'Failed to spawn command', spawnErrorMsg);
  }

  const endedAt = Date.now();
  const status  = spawnErrorMsg !== undefined
    ? 'error'
    : exitCode === EXIT_CODES.SUCCESS ? 'passed' : 'failed';

  // ── trace_end event (appended after child exits) ──────────────────────────
  const traceEndEvent: TraceEvent = {
    schemaVersion: SCHEMA_VERSIONS.event,
    eventId: createEventId(),
    traceId,
    parentEventId: traceStartEventId,
    type: 'trace_end',
    language: 'javascript',
    name: 'trace_end',
    startTime: endedAt,
    endTime: endedAt,
    durationMs: endedAt - startedAt,
    metadata: {
      exitCode,
      ...(spawnErrorMsg ? { error: spawnErrorMsg } : {}),
    },
  };
  // Use appendFileSync (not the closed stream) — safe because child has already exited
  try {
    fs.appendFileSync(jsonlTmpPath, JSON.stringify(traceEndEvent) + '\n', 'utf8');
  } catch (err) {
    emitError(runId, 'Failed to write trace_end event', err);
  }

  // ── Capture level: read from child process if the adapter wrote it ─────────
  let captureLevel: CaptureLevel = {
    overall: 0,
    label: 'Runner metadata only',
    adapters: {},
  };
  const captureLevelFile = path.join(runDir, 'capture-level.json');
  if (fs.existsSync(captureLevelFile)) {
    try {
      captureLevel = JSON.parse(fs.readFileSync(captureLevelFile, 'utf8')) as CaptureLevel;
    } catch {
      // If parse fails, fall back to level 0
    }
  }

  // ── Language/framework: read from meta.json written by language adapters ──
  // Defaults to 'javascript' for backwards compatibility with existing JS traces.
  let traceLanguage: LanguageId = 'javascript';
  let traceFramework: string | undefined;
  const metaFile = path.join(runDir, 'meta.json');
  if (fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
        language?: string;
        framework?: string;
      };
      if (meta.language === 'php') traceLanguage = 'php';
      if (meta.framework)          traceFramework = meta.framework;
    } catch {
      // If parse fails, fall back to 'javascript'
    }
  }

  // ── Finalise per-test-case traces (written by Vitest reporter) ───────────
  // The reporter writes one {testTraceId}.events.jsonl.tmp per test case
  // into {runDir}/tests/. Finalize each one before the main run trace.
  const testsRunDir = path.join(runDir, 'tests');
  const testTracePaths: string[] = [];

  if (fs.existsSync(testsRunDir)) {
    const testJsonlFiles = fs.readdirSync(testsRunDir)
      .filter((f) => f.endsWith('.events.jsonl.tmp'))
      .sort();

    for (const jsonlFile of testJsonlFiles) {
      const testTraceId = jsonlFile.replace('.events.jsonl.tmp', '');
      try {
        const testPath = await finaliseTrace({
          runDir:    testsRunDir,    // reporter wrote files into the tests/ subdir
          traceId:   testTraceId,
          tracesDir,
          workspaceRoot,
          sessionId,
          runId,
          ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
          language: traceLanguage,
          ...(traceFramework ? { framework: traceFramework } : {}),
          entrypoint,
          startedAt,
          endedAt,
          status,
          captureLevel,
        });
        testTracePaths.push(testPath);
      } catch {
        // Non-fatal: skip malformed test trace files
      }
    }
  }

  // ── Finalise main run trace (trace_start + trace_end) ─────────────────────
  let finalPath: string;
  try {
    finalPath = await finaliseTrace({
      runDir,
      traceId,
      tracesDir,
      workspaceRoot,
      sessionId,
      runId,
      ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
      language: traceLanguage,
      ...(traceFramework ? { framework: traceFramework } : {}),
      entrypoint,
      startedAt,
      endedAt,
      status,
      captureLevel,
    });
  } catch (err) {
    emitError(runId, 'Failed to finalise trace', err);
    emit({ type: 'run.completed', runId, payload: { status: 'error' } });
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Update trace index ────────────────────────────────────────────────────
  try {
    updateTraceIndex(tracegraphDir, {
      traceId,
      runId,
      file: path.relative(workspaceRoot, finalPath).replace(/\\/g, '/'),
      status,
      createdAt: startedAt,
      entrypoint,
    });
  } catch {
    // Non-fatal: index update failure does not abort the run
  }

  // ── Write latest.json pointer ─────────────────────────────────────────────
  // Provides a stable, Windows-safe pointer to this run's artifacts.
  // Used by `tracegraph compare`, `tracegraph baseline create`, etc.
  try {
    const testTraceIds = testTracePaths.map((p) =>
      path.basename(p, '.trace.json'),
    );
    const latestPointer: LatestPointer = {
      latestRunId:    runId,
      latestTraceIds: [traceId, ...testTraceIds],
      latestReportId: null,
      updatedAt:      Date.now(),
    };
    fs.writeFileSync(
      path.join(tracegraphDir, 'latest.json'),
      JSON.stringify(latestPointer, null, 2) + '\n',
      'utf8',
    );
  } catch {
    // Non-fatal: latest.json is a convenience pointer, not required
  }

  // ── Prune storage ─────────────────────────────────────────────────────────
  if (config.storage?.pruneOnRun !== false) {
    try {
      new StorageManager(tracegraphDir, config.storage).prune();
    } catch {
      // Non-fatal
    }
  }

  // ── Emit trace.completed (the VS Code notification signal) ───────────────
  emit({
    type: 'trace.completed',
    runId,
    traceId,
    captureLevel: { overall: captureLevel.overall, label: captureLevel.label },
    payload: {
      file: path.relative(workspaceRoot, finalPath).replace(/\\/g, '/'),
      status,
    },
  });

  // ── Emit run.completed ────────────────────────────────────────────────────
  emit({
    type: 'run.completed',
    runId,
    captureLevel: { overall: captureLevel.overall, label: captureLevel.label },
    payload: { status },
  });

  return exitCode;
}
