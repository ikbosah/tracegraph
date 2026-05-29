/**
 * TraceGraph VS Code Extension — entry point
 *
 * T8.1 — Extension manifest + activation
 * T8.2 — CliRunner wiring
 * T8.3 — FileWatcher wiring
 *
 * Activation:
 *   workspaceContains:.tracegraph/**
 *
 * Registers:
 *   - Commands: runLatest, compareLatest, openTrace, viewReport,
 *               createBaseline, generatePack, refresh
 *   - Views: tracegraphTraces, tracegraphFindings, tracegraphBaselines,
 *            tracegraphScenarios
 *   - File watcher → auto-refresh sidebar trees
 *   - Output channel for CLI stdout/stderr
 */
import * as vscode from 'vscode';
export declare function activate(context: vscode.ExtensionContext): void;
export declare function deactivate(): void;
//# sourceMappingURL=extension.d.ts.map