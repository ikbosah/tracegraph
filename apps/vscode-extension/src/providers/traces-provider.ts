/**
 * T8.6 — Traces sidebar provider
 *
 * Lists `.trace.json` files found in `.tracegraph/traces/`, grouped by run ID
 * (derived from the file path pattern `<runId>/<traceId>.trace.json`).
 *
 * Monorepo support:
 *   Accepts an array of roots.  When more than one root is configured each
 *   TraceRunItem's description includes the project folder name so the user
 *   can tell which sub-project a run belongs to.
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
    /** Set when multiple roots are active so the user can tell runs apart. */
    projectName?: string,
  ) {
    super(
      runId.slice(0, 12),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    const countStr = `${traceFiles.length} trace${traceFiles.length !== 1 ? 's' : ''}`;
    this.description  = projectName ? `${countStr}  [${projectName}]` : countStr;
    this.tooltip      = `Run: ${runId}\n${runDir}`;
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

  constructor(private roots: string[]) {}

  setRoots(roots: string[]): void {
    this.roots = roots;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TraceTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TraceTreeItem): vscode.ProviderResult<TraceTreeItem[]> {
    if (element instanceof TraceRunItem) {
      return element.traceFiles.map((f) => {
        const meta    = tryReadTraceMeta(f);
        const traceId = meta?.traceId ?? path.basename(f, '.trace.json');
        const status  = meta?.status  ?? 'unknown';
        return new TraceFileItem(f, traceId, status);
      });
    }

    // Root: list run groups aggregated across all roots
    return this._listRuns();
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _listRuns(): TraceRunItem[] {
    const items:       TraceRunItem[] = [];
    const multiRoot  = this.roots.length > 1;

    for (const root of this.roots) {
      const projectName = multiRoot ? path.basename(root) : undefined;
      const tracesDir   = path.join(root, '.tracegraph', 'traces');
      if (!fs.existsSync(tracesDir)) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(tracesDir, { withFileTypes: true });
      } catch {
        continue;
      }

      // Structure: .tracegraph/traces/<runId>/<traceId>.trace.json
      // or flat:   .tracegraph/traces/<traceId>.trace.json
      const runDirs   = entries.filter((e) => e.isDirectory());
      const flatFiles = entries.filter(
        (e) => e.isFile() && e.name.endsWith('.trace.json'),
      );

      // Run-scoped layout
      for (const runDir of runDirs) {
        const runPath    = path.join(tracesDir, runDir.name);
        const traceFiles = listTraceFiles(runPath);
        if (traceFiles.length > 0) {
          items.push(new TraceRunItem(runDir.name, runPath, traceFiles, projectName));
        }
      }

      // Flat layout (older runs / import)
      if (flatFiles.length > 0) {
        const files = flatFiles.map((e) => path.join(tracesDir, e.name));
        items.push(new TraceRunItem('(unscoped)', tracesDir, files, projectName));
      }
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
