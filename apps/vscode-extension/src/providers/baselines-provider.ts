/**
 * T8.6 — Baselines sidebar provider
 *
 * Lists `.baseline.json` files in `.tracegraph/baselines/`.
 * Shows baseline ID (truncated), test name / entrypoint, and approval status.
 *
 * Monorepo support:
 *   Accepts an array of roots and aggregates baselines from every root.
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';

// ─── Tree item ────────────────────────────────────────────────────────────────

export class BaselineItem extends vscode.TreeItem {
  constructor(
    public readonly baselineFile: string,
    label:       string,
    description: string,
    approved:    boolean,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description  = description;
    this.tooltip      = baselineFile;
    this.contextValue = 'baseline';
    this.iconPath     = new vscode.ThemeIcon(approved ? 'verified-filled' : 'unverified');
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class BaselinesProvider implements vscode.TreeDataProvider<BaselineItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<BaselineItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<BaselineItem | undefined | void> =
    this._onDidChangeTreeData.event;

  constructor(private roots: string[]) {}

  setRoots(roots: string[]): void {
    this.roots = roots;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: BaselineItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<BaselineItem[]> {
    const items: BaselineItem[] = [];

    for (const root of this.roots) {
      const dir = path.join(root, '.tracegraph', 'baselines');
      if (!fs.existsSync(dir)) continue;

      let files: string[];
      try {
        files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.baseline.json'))
          .map((f) => path.join(dir, f));
      } catch {
        continue;
      }

      for (const f of files) {
        const meta     = tryReadBaselineMeta(f);
        const id       = meta?.baselineId ?? path.basename(f, '.baseline.json');
        const label    = id.slice(0, 14);
        const desc     = meta?.testId ?? meta?.entrypoint ?? '';
        const approved = meta?.approved ?? false;
        items.push(new BaselineItem(f, label, desc, approved));
      }
    }

    return items;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryReadBaselineMeta(file: string): {
  baselineId?: string;
  testId?:     string;
  entrypoint?: string;
  approved?:   boolean;
} | null {
  try {
    const raw  = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      baselineId: data.baselineId != null ? String(data.baselineId) : undefined,
      testId:     data.testId     != null ? String(data.testId)     : undefined,
      entrypoint: data.entrypoint != null ? String(data.entrypoint) : undefined,
      approved:   typeof data.approved === 'boolean' ? data.approved : false,
    };
  } catch {
    return null;
  }
}
