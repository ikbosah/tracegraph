/**
 * M6 T6.3 — ScenarioRunner orchestrator
 *
 * Ties together ServerManager, executeStep (HTTP runner), and the
 * bundle linker to run a complete multi-service scenario.
 *
 * Run lifecycle:
 *  1. Load the scenario definition (JSON)
 *  2. Create per-server trace IDs and a shared run ID
 *  3. Start each server with TRACEGRAPH_* env vars so the framework
 *     adapters automatically write `.events.jsonl.tmp` files
 *  4. Execute each HTTP step in sequence (correlation headers injected)
 *  5. Stop all servers (SIGTERM → drain → SIGKILL)
 *  6. Finalise each server's trace (JSONL → `.trace.json`)
 *  7. Assemble a TraceBundle from the finalised sessions
 *  8. Write the bundle to `.tracegraph/bundles/` and return ScenarioRunResult
 */
import fs   from 'fs';
import path from 'path';
import {
  createRunId,
  createTraceId,
  createSessionId,
  finaliseTrace,
} from '@tracegraph/trace-core';
import type {
  CaptureLevel,
  ScenarioDefinition,
  ScenarioRunResult,
  ScenarioStepResult,
  TraceSession,
} from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import { ServerManager } from './server-manager';
import { executeStep }   from './http-runner';
import { createBundle }  from './bundle-linker';

// ─── Public API ───────────────────────────────────────────────────────────────

export type ScenarioRunOptions = {
  /** Root of the workspace — must contain `.tracegraph/`. Defaults to `process.cwd()`. */
  workspaceRoot?: string;
};

/**
 * Run a scenario definition file end-to-end and return a structured result.
 *
 * @param scenarioFile  Absolute or CWD-relative path to the `.scenario.json` file.
 * @param options       Optional overrides (workspaceRoot etc.).
 */
export async function runScenario(
  scenarioFile: string,
  options: ScenarioRunOptions = {},
): Promise<ScenarioRunResult> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const scenarioDef   = loadScenarioDefinition(scenarioFile);

  const runId      = createRunId();
  const startedAt  = Date.now();
  const scenarioId = scenarioDef.scenarioId;

  const tracegraphDir = path.join(workspaceRoot, '.tracegraph');
  const runDir        = path.join(tracegraphDir, 'runs', runId);
  const tracesDir     = path.join(tracegraphDir, 'traces');
  const bundlesDir    = path.join(tracegraphDir, 'bundles');

  fs.mkdirSync(runDir,     { recursive: true });
  fs.mkdirSync(tracesDir,  { recursive: true });
  fs.mkdirSync(bundlesDir, { recursive: true });

  const serverManager = new ServerManager();

  // ── Start servers ──────────────────────────────────────────────────────────
  for (const server of scenarioDef.servers ?? []) {
    const traceId      = createTraceId();
    const sessionId    = createSessionId();
    const serverRunDir = path.join(runDir, server.name);

    fs.mkdirSync(serverRunDir, { recursive: true });

    await serverManager.start(
      server,
      {
        serverName: server.name,
        traceId,
        sessionId,
        runDir:     serverRunDir,
        startedAt:  Date.now(),
      },
      {
        TRACEGRAPH_ENABLED:     '1',
        TRACEGRAPH_RUN_DIR:     serverRunDir,
        TRACEGRAPH_TRACE_ID:    traceId,
        TRACEGRAPH_RUN_ID:      runId,
        TRACEGRAPH_SESSION_ID:  sessionId,
        TRACEGRAPH_SCENARIO_ID: scenarioId,
      },
    );
  }

  // ── Execute steps ──────────────────────────────────────────────────────────
  const stepResults: ScenarioStepResult[] = [];
  let allPassed = true;

  for (let i = 0; i < scenarioDef.steps.length; i++) {
    const step   = scenarioDef.steps[i]!;
    const result = await executeStep(step, { scenarioId, stepIndex: i });
    stepResults.push(result);

    if (result.status === 'failed') {
      allPassed = false;
    }

    // Optional inter-step delay
    if (step.delayMs && step.delayMs > 0) {
      await sleep(step.delayMs);
    }
  }

  // ── Stop servers ───────────────────────────────────────────────────────────
  // Snapshot handles before stopAll() clears them.
  const handles = serverManager.getHandles();
  await serverManager.stopAll();

  // ── Finalise traces ────────────────────────────────────────────────────────
  const sessions: TraceSession[] = [];

  for (const handle of handles) {
    try {
      const captureLevel = readCaptureLevel(handle.runDir);

      const tracePath = await finaliseTrace({
        runDir:       handle.runDir,
        traceId:      handle.traceId,
        tracesDir,
        workspaceRoot,
        sessionId:    handle.sessionId,
        runId,
        scenarioId,
        language:     'javascript',
        // Generic entrypoint — the adapter will have written the real request events
        entrypoint:   { type: 'http_request', method: '*', path: '/*', handler: handle.serverName },
        startedAt:    handle.startedAt,
        endedAt:      Date.now(),
        status:       allPassed ? 'passed' : 'failed',
        captureLevel,
        metadata:     { serverName: handle.serverName },
      });

      const session = JSON.parse(
        fs.readFileSync(tracePath, 'utf8'),
      ) as TraceSession;

      sessions.push(session);
    } catch (err) {
      // Non-fatal — a server that crashed before writing any events yields no trace
      process.stderr.write(
        `[scenario-runner] Warning: could not finalise trace for server ` +
        `"${handle.serverName}": ${String(err)}\n`,
      );
    }
  }

  // ── Build and write bundle ─────────────────────────────────────────────────
  let bundleFile: string | undefined;

  if (sessions.length > 0) {
    const bundle     = createBundle(sessions, scenarioId);
    const bundleName = `${scenarioId}_${runId}.bundle.json`;
    const bundlePath = path.join(bundlesDir, bundleName);
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    bundleFile = path.relative(workspaceRoot, bundlePath).replace(/\\/g, '/');
  }

  return {
    scenarioId,
    runId,
    ...(bundleFile !== undefined ? { bundleFile } : {}),
    steps:      stepResults,
    passed:     allPassed,
    durationMs: Date.now() - startedAt,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load and validate a scenario definition from disk.
 * Throws a descriptive error for missing files, bad JSON, or schema mismatches.
 */
export function loadScenarioDefinition(scenarioFile: string): ScenarioDefinition {
  const abs = path.resolve(scenarioFile);

  if (!fs.existsSync(abs)) {
    throw new Error(`[scenario-runner] Scenario file not found: ${abs}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(`[scenario-runner] Cannot read scenario file "${abs}": ${String(err)}`);
  }

  let parsed: ScenarioDefinition;
  try {
    parsed = JSON.parse(raw) as ScenarioDefinition;
  } catch (err) {
    throw new Error(`[scenario-runner] Invalid JSON in scenario file "${abs}": ${String(err)}`);
  }

  if (parsed.schemaVersion !== SCHEMA_VERSIONS.scenario) {
    throw new Error(
      `[scenario-runner] Unsupported scenario schema version: "${parsed.schemaVersion}". ` +
      `Expected "${SCHEMA_VERSIONS.scenario}".`,
    );
  }
  if (!parsed.scenarioId) {
    throw new Error(`[scenario-runner] Missing "scenarioId" in ${abs}`);
  }
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(`[scenario-runner] No steps defined in ${abs}`);
  }

  return parsed;
}

/**
 * Read the capture level written by the framework adapter into the run dir.
 * Falls back to level-1 (framework adapter) if the file is absent or malformed.
 */
function readCaptureLevel(runDir: string): CaptureLevel {
  const captureLevelFile = path.join(runDir, 'capture-level.json');
  if (fs.existsSync(captureLevelFile)) {
    try {
      return JSON.parse(fs.readFileSync(captureLevelFile, 'utf8')) as CaptureLevel;
    } catch { /* fall through */ }
  }
  return { overall: 1, label: 'Framework adapter', adapters: {} };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
