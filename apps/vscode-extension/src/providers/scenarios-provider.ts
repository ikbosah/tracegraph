/**
 * T8.6 — Scenarios sidebar provider
 *
 * Lists `.scenario.json` files found in `.tracegraph/scenarios/`.
 *
 * Monorepo support:
 *   Accepts an array of roots and aggregates scenarios from every root.
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';

// ─── Tree item ────────────────────────────────────────────────────────────────

export class ScenarioItem extends vscode.TreeItem {
  constructor(
    public readonly scenarioFile: string,
    label:       string,
    description: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description  = description;
    this.tooltip      = scenarioFile;
    this.contextValue = 'scenario';
    this.iconPath     = new vscode.ThemeIcon('play-circle');
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class ScenariosProvider implements vscode.TreeDataProvider<ScenarioItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<ScenarioItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<ScenarioItem | undefined | void> =
    this._onDidChangeTreeData.event;

  constructor(private roots: string[]) {}

  setRoots(roots: string[]): void {
    this.roots = roots;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ScenarioItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<ScenarioItem[]> {
    const items: ScenarioItem[] = [];

    for (const root of this.roots) {
      const dir = path.join(root, '.tracegraph', 'scenarios');
      if (!fs.existsSync(dir)) continue;

      let files: string[];
      try {
        files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.scenario.json'))
          .map((f) => path.join(dir, f));
      } catch {
        continue;
      }

      for (const f of files) {
        const meta  = tryReadScenarioMeta(f);
        const label = meta?.name ?? path.basename(f, '.scenario.json');
        const desc  = meta?.description ?? '';
        items.push(new ScenarioItem(f, label, desc));
      }
    }

    return items;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryReadScenarioMeta(file: string): {
  name?:        string;
  description?: string;
} | null {
  try {
    const raw  = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      name:        data.name        != null ? String(data.name)        : undefined,
      description: data.description != null ? String(data.description) : undefined,
    };
  } catch {
    return null;
  }
}
