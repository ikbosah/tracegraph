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
import type { TraceEvent, CaptureLevel, TraceEntrypoint } from '@tracegraph/shared-types';
import { emit, emitError } from '../protocol';
import { loadConfig } from '../config';

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

  const [command, ...commandArgs] = wrappedArgs;
  const commandStr = wrappedArgs.join(' ');

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

  // ── Finalise trace (atomic rename) ────────────────────────────────────────
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
      language: 'javascript',
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
