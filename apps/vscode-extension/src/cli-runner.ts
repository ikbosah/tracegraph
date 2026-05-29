/**
 * T8.2 — CliRunner
 *
 * Spawns the `tracegraph` CLI binary and parses its stdout JSONL protocol
 * (`tracegraph.cli.v1` envelopes).  Fires typed events for key milestones:
 *
 *   trace.completed   — a single trace file is ready
 *   run.completed     — a full run finished (all traces written)
 *   report.created    — a compare report was written
 *   bundle.created    — a TraceBundle was written
 *   error             — the CLI reported an error
 *
 * Architecture: ARCHITECTURE.md §6 (CLI stdout Protocol)
 */

import * as cp         from 'child_process';
import * as path       from 'path';
import * as vscode     from 'vscode';
import * as fs         from 'fs';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CliEventType =
  | 'trace.completed'
  | 'run.completed'
  | 'report.created'
  | 'bundle.created'
  | 'error';

export interface CliTraceCompletedEvent {
  type:     'trace.completed';
  traceId:  string;
  file:     string;
  status:   string;
}

export interface CliRunCompletedEvent {
  type:   'run.completed';
  runId:  string;
  traces: number;
}

export interface CliReportCreatedEvent {
  type:   'report.created';
  file:   string;
  runId?: string;
}

export interface CliBundleCreatedEvent {
  type:   'bundle.created';
  file:   string;
  runId?: string;
}

export interface CliErrorEvent {
  type:    'error';
  message: string;
  code?:   number;
}

export type CliEvent =
  | CliTraceCompletedEvent
  | CliRunCompletedEvent
  | CliReportCreatedEvent
  | CliBundleCreatedEvent
  | CliErrorEvent;

// ─── Runner ───────────────────────────────────────────────────────────────────

export class CliRunner {
  private readonly _onEvent = new vscode.EventEmitter<CliEvent>();
  readonly onEvent: vscode.Event<CliEvent> = this._onEvent.event;

  private readonly _onStderr = new vscode.EventEmitter<string>();
  readonly onStderr: vscode.Event<string> = this._onStderr.event;

  private _proc?: cp.ChildProcess;

  constructor(private readonly workspaceRoot: string) {}

  /**
   * Resolve the `tracegraph` binary path.
   *
   * Priority:
   *   1. `tracegraph.cliPath` VS Code setting
   *   2. `<workspaceRoot>/node_modules/.bin/tracegraph`
   *   3. `tracegraph` on $PATH
   */
  private resolveCli(): string {
    const cfg = vscode.workspace.getConfiguration('tracegraph');
    const cliPath = cfg.get<string>('cliPath');
    if (cliPath && cliPath.trim() !== '') return cliPath;

    const localBin = path.join(this.workspaceRoot, 'node_modules', '.bin', 'tracegraph');
    if (fs.existsSync(localBin)) return localBin;

    return 'tracegraph'; // rely on $PATH
  }

  /**
   * Run `tracegraph <args>` and stream events.
   * Resolves with the process exit code when finished.
   */
  run(args: string[]): Promise<number> {
    return new Promise((resolve) => {
      const cli = this.resolveCli();

      this._proc = cp.spawn(cli, args, {
        cwd:   this.workspaceRoot,
        shell: process.platform === 'win32', // needed on Windows for .cmd wrappers
      });

      let stdoutBuf = '';

      this._proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          this._parseLine(line.trim());
        }
      });

      this._proc.stderr?.on('data', (chunk: Buffer) => {
        this._onStderr.fire(chunk.toString('utf8'));
      });

      this._proc.on('close', (code) => {
        // Flush any remaining buffer
        if (stdoutBuf.trim()) this._parseLine(stdoutBuf.trim());
        this._proc = undefined;
        resolve(code ?? 1);
      });

      this._proc.on('error', (err) => {
        this._onEvent.fire({ type: 'error', message: err.message });
        resolve(1);
      });
    });
  }

  /** Cancel a running process. */
  cancel(): void {
    this._proc?.kill();
    this._proc = undefined;
  }

  dispose(): void {
    this.cancel();
    this._onEvent.dispose();
    this._onStderr.dispose();
  }

  // ── JSONL parser ────────────────────────────────────────────────────────────

  private _parseLine(line: string): void {
    if (!line.startsWith('{')) return; // ignore non-JSON lines (human-readable stderr)
    try {
      const envelope = JSON.parse(line) as Record<string, unknown>;
      if (envelope.protocol !== 'tracegraph.cli.v1') return;

      const event = envelope.event as Record<string, unknown> | undefined;
      if (!event) return;

      switch (event.type) {
        case 'trace.completed':
          this._onEvent.fire({
            type:    'trace.completed',
            traceId: String(event.traceId ?? ''),
            file:    String(event.file    ?? ''),
            status:  String(event.status  ?? 'unknown'),
          });
          break;

        case 'run.completed':
          this._onEvent.fire({
            type:   'run.completed',
            runId:  String(event.runId  ?? ''),
            traces: Number(event.traces ?? 0),
          });
          break;

        case 'report.created':
          this._onEvent.fire({
            type:   'report.created',
            file:   String(event.file   ?? ''),
            runId:  event.runId != null ? String(event.runId) : undefined,
          });
          break;

        case 'bundle.created':
          this._onEvent.fire({
            type:   'bundle.created',
            file:   String(event.file   ?? ''),
            runId:  event.runId != null ? String(event.runId) : undefined,
          });
          break;

        case 'error':
          this._onEvent.fire({
            type:    'error',
            message: String(event.message ?? 'Unknown CLI error'),
            code:    event.code != null ? Number(event.code) : undefined,
          });
          break;
      }
    } catch {
      // Not valid JSON — ignore
    }
  }
}
