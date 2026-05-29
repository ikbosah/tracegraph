/**
 * M6 T6.1 — ServerManager
 *
 * Lifecycle management for server processes started by the scenario runner.
 *
 * Each server is spawned as a child process with TRACEGRAPH env vars set so
 * that framework adapters (traceExpress, Laravel middleware, etc.) can write
 * trace files automatically.  When the server is stopped (SIGTERM), the
 * scenario runner calls `finaliseTrace()` to flush the accumulated events into
 * a `.trace.json` file.
 *
 * Health-check polling uses native `fetch` (Node.js 18+) and retries at a
 * configurable interval until the server responds with the expected status.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ScenarioServer } from '@tracegraph/shared-types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ServerHandle = {
  serverName: string;
  traceId:    string;
  sessionId:  string;
  runDir:     string;
  startedAt:  number;
  process:    ChildProcess;
};

// ─── ServerManager ────────────────────────────────────────────────────────────

export class ServerManager {
  private handles: Map<string, ServerHandle> = new Map();

  /**
   * Spawn the server process and wait until its health check passes.
   *
   * @param server     Server config from the scenario definition.
   * @param handle     Pre-populated handle (traceId, runDir, etc.) so the
   *                   caller can set up the JSONL writer before spawning.
   * @param extraEnv   Extra env vars to pass to the child (TRACEGRAPH_* etc.).
   */
  async start(
    server: ScenarioServer,
    handle: Omit<ServerHandle, 'process'>,
    extraEnv: Record<string, string>,
  ): Promise<void> {
    const [cmd, ...cmdArgs] = server.command.trim().split(/\s+/);
    if (!cmd) throw new Error(`[scenario-runner] Empty command for server "${server.name}"`);

    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(server.env ?? {}),
      ...extraEnv,
    };

    const proc = spawn(cmd, cmdArgs, {
      env:   childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows: shell: true is needed for .cmd scripts
      shell: process.platform === 'win32',
    });

    // Forward server stdout/stderr with a prefix so it's visible but distinguished
    const tag = `[${server.name}]`;
    proc.stdout?.on('data', (chunk: Buffer) => {
      process.stderr.write(`${tag} ${chunk.toString()}`);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`${tag} ${chunk.toString()}`);
    });

    const fullHandle: ServerHandle = { ...handle, process: proc };
    this.handles.set(server.name, fullHandle);

    await this.waitForHealth(server);
  }

  /** Gracefully stop all managed server processes and wait for them to exit. */
  async stopAll(drainMs = 600): Promise<void> {
    const procs = [...this.handles.values()].map((h) => h.process);

    for (const proc of procs) {
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    }

    // Give processes a moment to flush their JSONL writers before we finalise
    if (procs.length > 0) {
      await sleep(drainMs);
    }

    // Force-kill any stragglers
    for (const proc of procs) {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    }

    this.handles.clear();
  }

  /** Return all handles (used by the scenario runner to call finaliseTrace). */
  getHandles(): ServerHandle[] {
    return [...this.handles.values()];
  }

  // ─── Health check ──────────────────────────────────────────────────────────

  private async waitForHealth(server: ScenarioServer): Promise<void> {
    const hc         = server.healthCheck;
    const urlPath    = hc?.path           ?? '/health';
    const method     = hc?.method         ?? 'GET';
    const expected   = hc?.expectedStatus ?? 200;
    const intervalMs = hc?.intervalMs     ?? 500;
    const maxAttempts = hc?.maxAttempts   ?? 60;
    const timeoutMs  = server.readyTimeoutMs ?? (maxAttempts * intervalMs + 5000);

    const url = `http://localhost:${server.port}${urlPath}`;
    const deadline = Date.now() + timeoutMs;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (Date.now() > deadline) break;

      try {
        const res = await fetchWithTimeout(url, method, Math.min(intervalMs - 50, 400));
        if (res.status === expected) {
          process.stderr.write(
            `[scenario-runner] Server "${server.name}" is ready ` +
            `(${url} → ${res.status}) after ${attempt + 1} attempt(s)\n`,
          );
          return;
        }
      } catch {
        // Server not ready yet
      }

      await sleep(intervalMs);
    }

    throw new Error(
      `[scenario-runner] Server "${server.name}" did not become healthy ` +
      `at ${url} within ${timeoutMs}ms`,
    );
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  method: string,
  timeoutMs: number,
): Promise<{ status: number }> {
  // AbortSignal.timeout is available in Node 17.3+
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { method, signal });
  return { status: res.status };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
