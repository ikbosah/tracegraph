/**
 * T8.5 — Source navigation
 *
 * Handles `OPEN_SOURCE` messages posted from the webview via
 * `acquireVsCodeApi().postMessage({ command: 'OPEN_SOURCE', file, line })`.
 *
 * Opens the file in the active editor group and scrolls to the requested line.
 * Tries an absolute path first; falls back to a workspace-relative lookup so
 * traces captured on a CI machine (absolute paths differ) still resolve.
 */
export declare function openSource(rawFile: string, line: number, workspaceRoot: string): Promise<void>;
//# sourceMappingURL=source-nav.d.ts.map