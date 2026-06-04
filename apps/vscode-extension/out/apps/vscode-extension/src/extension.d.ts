/**
 * TraceGraph VS Code Extension — entry point
 *
 * T8.1 — Extension manifest + activation
 * T8.2 — CliRunner wiring
 * T8.3 — FileWatcher wiring
 *
 * Activation: workspaceContains:.tracegraph (root-level and monorepo
 *   subfolders — see activationEvents in package.json).
 *
 * Monorepo support:
 *   findTracegraphRoots() scans each workspace folder and its immediate
 *   children for a `.tracegraph/` directory.  All providers receive the
 *   full list of roots so they aggregate data across every sub-project.
 *
 * Registers:
 *   - Commands: runLatest, compareLatest, openTrace, viewReport,
 *               createBaseline, generatePack, refresh
 *   - Views: tracegraphTraces, tracegraphFindings, tracegraphBaselines,
 *            tracegraphScenarios
 *   - File watcher and auto-refresh sidebar trees
 *   - Output channel for CLI stdout/stderr
 */
import * as vscode from 'vscode';
export declare function activate(context: vscode.ExtensionContext): void;
export declare function deactivate(): void;
/**
 * Find every directory within the current workspace that contains a
 * `.tracegraph/` subdirectory.
 *
 * Searches:
 *   - Each workspace folder directly (level 0)
 *   - Each immediate child of each workspace folder (level 1)
 *
 * Level-1 search handles the common monorepo pattern:
 *   <workspace>/
 *     backend/   ← has .tracegraph/
 *     frontend/
 *
 * Skips hidden dirs, node_modules, and vendor.
 */
export declare function findTracegraphRoots(): string[];
//# sourceMappingURL=extension.d.ts.map