/**
 * T8.4 — WebviewPanel
 *
 * Hosts the TraceGraph viewer (the React IIFE bundle built by the `webview`
 * package) in a VS Code WebviewPanel.
 *
 * Data injection strategy:
 *   Identical to `tracegraph open --html` — the CLI injects a
 *   `<script id="tracegraph-data" type="application/json">` tag containing
 *   either a TraceSession or a TraceReport.  The React bundle detects the type
 *   from `schemaVersion` and renders the appropriate view.
 *
 * Source navigation (T8.5):
 *   The webview posts `{ command: 'OPEN_SOURCE', file, line }` messages
 *   which are forwarded to `openSource()`.
 *
 * Panel deduplication:
 *   A static `_panels` map keyed by traceId / reportId ensures that
 *   re-opening the same artifact reveals the existing panel rather than
 *   spawning a duplicate.
 *
 * Asset location:
 *   The built webview bundle is copied to `apps/vscode-extension/media/` as
 *   part of the build step.  Files:
 *     media/tracegraph-viewer.iife.js
 *     media/tracegraph-viewer.css
 */
import * as vscode from 'vscode';
import type { TraceSession, TraceReport } from '@tracegraph/shared-types';
type PanelData = {
    kind: 'trace';
    data: TraceSession;
} | {
    kind: 'report';
    data: TraceReport;
};
export declare class TraceGraphPanel implements vscode.Disposable {
    private static readonly VIEW_TYPE;
    /**
     * Open panels keyed by artifact ID (traceId or reportId).
     * Prevents duplicate panels for the same trace/report.
     */
    private static readonly _panels;
    private readonly _panel;
    private readonly _extensionUri;
    private readonly _workspaceRoot;
    private readonly _cacheKey;
    private readonly _disposables;
    /**
     * Open (or reveal an existing) panel for `data`.
     * Panels are keyed by traceId / reportId so re-opening the same artifact
     * focuses the existing panel instead of spawning a duplicate.
     */
    static open(extensionUri: vscode.Uri, workspaceRoot: string, panelData: PanelData): TraceGraphPanel;
    private constructor();
    /** Update the panel with new data (e.g. after a re-run). */
    update(panelData: PanelData): void;
    reveal(): void;
    dispose(): void;
    private _buildHtml;
}
export declare function loadTraceFile(filePath: string): TraceSession | null;
export declare function loadReportFile(filePath: string): TraceReport | null;
export {};
//# sourceMappingURL=webview-panel.d.ts.map