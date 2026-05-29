/**
 * T8.6 — Findings sidebar provider
 *
 * Reads the latest `.report.json` (resolving the pointer from
 * `.tracegraph/latest.json`) and lists open findings grouped by severity.
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import type { EvaluatedFinding, TraceReport } from '@tracegraph/shared-types';

// ─── Tree items ───────────────────────────────────────────────────────────────

export class SeverityGroupItem extends vscode.TreeItem {
  constructor(
    public readonly severity: string,
    public readonly findings: EvaluatedFinding[],
  ) {
    super(
      capitalize(severity),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.description  = `${findings.length}`;
    this.contextValue = 'findingSeverityGroup';
    this.iconPath     = severityIcon(severity);
  }
}

export class FindingItem extends vscode.TreeItem {
  constructor(public readonly finding: EvaluatedFinding) {
    super(finding.title, vscode.TreeItemCollapsibleState.None);
    this.description  = finding.ruleId;
    this.tooltip      = `[${finding.severity.toUpperCase()}] ${finding.title}\n${finding.description}`;
    this.contextValue = 'finding';
    this.iconPath     = severityIcon(finding.severity);
  }
}

type FindingTreeItem = SeverityGroupItem | FindingItem;

// ─── Provider ────────────────────────────────────────────────────────────────

export class FindingsProvider implements vscode.TreeDataProvider<FindingTreeItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<FindingTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<FindingTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  constructor(private readonly workspaceRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FindingTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FindingTreeItem): vscode.ProviderResult<FindingTreeItem[]> {
    if (element instanceof SeverityGroupItem) {
      return element.findings.map((f) => new FindingItem(f));
    }

    // Root: load report and group by severity
    const report = this._loadLatestReport();
    if (!report) return [];

    const open = report.findings.filter((f) => f.status === 'open');
    if (open.length === 0) return [];

    const ORDER = ['critical', 'high', 'medium', 'low', 'info'];
    const grouped = new Map<string, EvaluatedFinding[]>();
    for (const sev of ORDER) grouped.set(sev, []);

    for (const f of open) {
      const bucket = grouped.get(f.severity) ?? [];
      bucket.push(f);
      grouped.set(f.severity, bucket);
    }

    const groups: SeverityGroupItem[] = [];
    for (const sev of ORDER) {
      const bucket = grouped.get(sev) ?? [];
      if (bucket.length > 0) {
        groups.push(new SeverityGroupItem(sev, bucket));
      }
    }
    return groups;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _loadLatestReport(): TraceReport | null {
    const tracegraphDir = path.join(this.workspaceRoot, '.tracegraph');

    // Try resolving via latest.json pointer first
    const latestPtr = path.join(tracegraphDir, 'latest.json');
    if (fs.existsSync(latestPtr)) {
      try {
        const ptr = JSON.parse(fs.readFileSync(latestPtr, 'utf8')) as Record<string, unknown>;
        if (ptr.reportFile && typeof ptr.reportFile === 'string') {
          const reportPath = path.isAbsolute(ptr.reportFile)
            ? ptr.reportFile
            : path.join(this.workspaceRoot, ptr.reportFile);
          if (fs.existsSync(reportPath)) {
            return JSON.parse(fs.readFileSync(reportPath, 'utf8')) as TraceReport;
          }
        }
      } catch { /* fall through */ }
    }

    // Fallback: most recent .report.json
    const reportsDir = path.join(tracegraphDir, 'reports');
    if (!fs.existsSync(reportsDir)) return null;

    try {
      const reports = fs
        .readdirSync(reportsDir)
        .filter((f) => f.endsWith('.report.json'))
        .map((f) => ({
          file:    path.join(reportsDir, f),
          mtime:   fs.statSync(path.join(reportsDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      const first = reports[0];
      if (!first) return null;
      return JSON.parse(fs.readFileSync(first.file, 'utf8')) as TraceReport;
    } catch {
      return null;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function severityIcon(severity: string): vscode.ThemeIcon {
  switch (severity) {
    case 'critical': return new vscode.ThemeIcon('error',   new vscode.ThemeColor('errorForeground'));
    case 'high':     return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
    case 'medium':   return new vscode.ThemeIcon('info',    new vscode.ThemeColor('editorInfo.foreground'));
    case 'low':      return new vscode.ThemeIcon('info');
    default:         return new vscode.ThemeIcon('circle-outline');
  }
}
