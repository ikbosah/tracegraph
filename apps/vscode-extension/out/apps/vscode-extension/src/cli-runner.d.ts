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
import * as vscode from 'vscode';
export type CliEventType = 'trace.completed' | 'run.completed' | 'report.created' | 'bundle.created' | 'error';
export interface CliTraceCompletedEvent {
    type: 'trace.completed';
    traceId: string;
    file: string;
    status: string;
}
export interface CliRunCompletedEvent {
    type: 'run.completed';
    runId: string;
    traces: number;
}
export interface CliReportCreatedEvent {
    type: 'report.created';
    file: string;
    runId?: string;
}
export interface CliBundleCreatedEvent {
    type: 'bundle.created';
    file: string;
    runId?: string;
}
export interface CliErrorEvent {
    type: 'error';
    message: string;
    code?: number;
}
export type CliEvent = CliTraceCompletedEvent | CliRunCompletedEvent | CliReportCreatedEvent | CliBundleCreatedEvent | CliErrorEvent;
export declare class CliRunner {
    private readonly workspaceRoot;
    private readonly _onEvent;
    readonly onEvent: vscode.Event<CliEvent>;
    private readonly _onStderr;
    readonly onStderr: vscode.Event<string>;
    private _proc?;
    constructor(workspaceRoot: string);
    /**
     * Resolve the `tracegraph` binary path.
     *
     * Priority:
     *   1. `tracegraph.cliPath` VS Code setting
     *   2. `<workspaceRoot>/node_modules/.bin/tracegraph`
     *   3. `tracegraph` on $PATH
     */
    private resolveCli;
    /**
     * Run `tracegraph <args>` and stream events.
     * Resolves with the process exit code when finished.
     */
    run(args: string[]): Promise<number>;
    /** Cancel a running process. */
    cancel(): void;
    dispose(): void;
    private _parseLine;
}
//# sourceMappingURL=cli-runner.d.ts.map