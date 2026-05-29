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
 * Asset location:
 *   The built webview bundle is copied to `apps/vscode-extension/media/` as
 *   part of the build step.  Files:
 *     media/tracegraph-viewer.iife.js
 *     media/tracegraph-viewer.css
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import { openSource } from './source-nav';
import type { TraceSession, TraceReport } from '@tracegraph/shared-types';

type PanelData =
  | { kind: 'trace';  data: TraceSession }
  | { kind: 'report'; data: TraceReport  };

export class TraceGraphPanel implements vscode.Disposable {
  private static readonly VIEW_TYPE = 'tracegraphViewer';

  private readonly _panel:         vscode.WebviewPanel;
  private readonly _extensionUri:  vscode.Uri;
  private readonly _workspaceRoot: string;
  private readonly _disposables:   vscode.Disposable[] = [];

  // ── Factory ─────────────────────────────────────────────────────────────────

  /**
   * Open (or reveal an existing) panel for `data`.
   * Panels are keyed by traceId / reportId so re-opening the same artifact
   * focuses the existing panel instead of spawning a duplicate.
   */
  static open(
    extensionUri:  vscode.Uri,
    workspaceRoot: string,
    panelData:     PanelData,
  ): TraceGraphPanel {
    const key   = panelData.kind === 'trace'
      ? panelData.data.traceId
      : panelData.data.reportId;
    const title = panelData.kind === 'trace'
      ? `Trace: ${key.slice(0, 8)}`
      : `Report: ${key.slice(0, 8)}`;

    const panel = vscode.window.createWebviewPanel(
      TraceGraphPanel.VIEW_TYPE,
      title,
      vscode.ViewColumn.Two,
      {
        enableScripts:          true,
        retainContextWhenHidden: true,
        localResourceRoots:     [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );

    return new TraceGraphPanel(panel, extensionUri, workspaceRoot, panelData);
  }

  // ── Constructor ─────────────────────────────────────────────────────────────

  private constructor(
    panel:         vscode.WebviewPanel,
    extensionUri:  vscode.Uri,
    workspaceRoot: string,
    panelData:     PanelData,
  ) {
    this._panel         = panel;
    this._extensionUri  = extensionUri;
    this._workspaceRoot = workspaceRoot;

    this._panel.webview.html = this._buildHtml(panelData);

    // Handle messages from the webview (source navigation)
    this._disposables.push(
      this._panel.webview.onDidReceiveMessage(async (msg: unknown) => {
        const m = msg as Record<string, unknown>;
        if (m.command === 'OPEN_SOURCE') {
          await openSource(
            String(m.file ?? ''),
            Number(m.line ?? 1),
            this._workspaceRoot,
          );
        }
      }),
    );

    this._disposables.push(
      this._panel.onDidDispose(() => this.dispose()),
    );
  }

  // ── Public ───────────────────────────────────────────────────────────────────

  /** Update the panel with new data (e.g. after a re-run). */
  update(panelData: PanelData): void {
    this._panel.webview.html = this._buildHtml(panelData);
    this._panel.reveal(vscode.ViewColumn.Two, true);
  }

  reveal(): void {
    this._panel.reveal(vscode.ViewColumn.Two, true);
  }

  dispose(): void {
    for (const d of this._disposables) d.dispose();
    try { this._panel.dispose(); } catch { /* already disposed */ }
  }

  // ── HTML builder ─────────────────────────────────────────────────────────────

  private _buildHtml(panelData: PanelData): string {
    const webview = this._panel.webview;
    const mediaDir = vscode.Uri.joinPath(this._extensionUri, 'media');

    // Asset URIs (converted to webview-safe vscode-resource:// URIs)
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaDir, 'tracegraph-viewer.iife.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaDir, 'tracegraph-viewer.css'),
    );

    const nonce   = generateNonce();
    const dataJson = JSON.stringify(panelData.data);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}' ${webview.cspSource};
                 img-src ${webview.cspSource} data:;" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>TraceGraph</title>
</head>
<body>
  <div id="root"></div>

  <!-- Data injected by the extension host (same contract as tracegraph open --html) -->
  <script id="tracegraph-data" type="application/json">${escapeForScript(dataJson)}</script>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/** Escape JSON for safe inline embedding in a script tag. */
function escapeForScript(json: string): string {
  return json
    .replace(/</g,  '\\u003c')
    .replace(/>/g,  '\\u003e')
    .replace(/&/g,  '\\u0026')
    .replace(/'/g,  '\\u0027');
}

// ─── Static helper: load and parse a trace/report file ───────────────────────

export function loadTraceFile(filePath: string): TraceSession | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as TraceSession;
  } catch {
    return null;
  }
}

export function loadReportFile(filePath: string): TraceReport | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as TraceReport;
  } catch {
    return null;
  }
}
