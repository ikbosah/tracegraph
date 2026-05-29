/**
 * T8.6 — Traces sidebar provider
 *
 * Lists `.trace.json` files found in `.tracegraph/traces/`, grouped by run ID
 * (derived from the file path pattern `<runId>/<traceId>.trace.json`).
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';

// ─── Tree items ───────────────────────────────────────────────────────────────

export class TraceRunItem extends vscode.TreeItem {
  constructor(
    public readonly runId:      string,
    public readonly runDir:     string,
    public readonly traceFiles: string[],
  ) {
    super(
      runId.slice(0, 12),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.description = `${traceFiles.length} trace${traceFiles.length !== 1 ? 's' : ''}`;
    this.tooltip     = `Run: ${runId}\n${runDir}`;
    this.contextValue = 'traceRun';
    this.iconPath     = new vscode.ThemeIcon('git-commit');
  }
}

export class TraceFileItem extends vscode.TreeItem {
  constructor(
    public readonly traceFile: string,
    public readonly traceId:   string,
    public readonly status:    string,
  ) {
    super(
      path.basename(traceFile, '.trace.json'),
      vscode.TreeItemCollapsibleState.None,
    );
    this.description  = status;
    this.tooltip      = traceFile;
    this.contextValue = 'trace';
    this.command      = {
      command:   'tracegraph.openTrace',
      title:     'Open Trace',
      arguments: [traceFile],
    };

    const icon =
      status === 'passed' ? 'pass'    :
      status === 'failed' ? 'error'   :
                            'warning';
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

type TraceTreeItem = TraceRunItem | TraceFileItem;

export class TracesProvider implements vscode.TreeDataProvider<TraceTreeItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<TraceTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<TraceTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  constructor(private readonly workspaceRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TraceTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TraceTreeItem): vscode.ProviderResult<TraceTreeItem[]> {
    if (element instanceof TraceRunItem) {
      return element.traceFiles.map((f) => {
        const meta   = tryReadTraceMeta(f);
        const traceId = meta?.traceId ?? path.basename(f, '.trace.json');
        const status  = meta?.status  ?? 'unknown';
        return new TraceFileItem(f, traceId, status);
      });
    }

    // Root: list run groups
    return this._listRuns();
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _listRuns(): TraceRunItem[] {
    const tracesDir = path.join(this.workspaceRoot, '.tracegraph', 'traces');
    if (!fs.existsSync(tracesDir)) return [];

    const items: TraceRunItem[] = [];

    // Structure: .tracegraph/traces/<runId>/<traceId>.trace.json
    // or flat:   .tracegraph/traces/<traceId>.trace.json
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(tracesDir, { withFileTypes: true });
    } catch {
      return [];
    }

    // Check if the directory contains run-subdirectories or flat files
    const runDirs   = entries.filter((e) => e.isDirectory());
    const flatFiles = entries.filter(
      (e) => e.isFile() && e.name.endsWith('.trace.json'),
    );

    // Run-scoped layout
    for (const runDir of runDirs) {
      const runPath   = path.join(tracesDir, runDir.name);
      const traceFiles = listTraceFiles(runPath);
      if (traceFiles.length > 0) {
        items.push(new TraceRunItem(runDir.name, runPath, traceFiles));
      }
    }

    // Flat layout (older runs / import)
    if (flatFiles.length > 0) {
      const files = flatFiles.map((e) => path.join(tracesDir, e.name));
      items.push(new TraceRunItem('(unscoped)', tracesDir, files));
    }

    return items.sort((a, b) => b.runId.localeCompare(a.runId));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function listTraceFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.trace.json'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function tryReadTraceMeta(
  file: string,
): { traceId: string; status: string } | null {
  try {
    const raw  = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      traceId: String(data.traceId ?? ''),
      status:  String(data.status  ?? 'unknown'),
    };
  } catch {
    return null;
  }
}
