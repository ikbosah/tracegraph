/**
 * T8.6 — Findings sidebar provider
 *
 * Reads the latest `.report.json` (resolving the pointer from
 * `.tracegraph/latest.json`) and lists open findings grouped by severity.
 */
import * as vscode from 'vscode';
import type { EvaluatedFinding } from '@tracegraph/shared-types';
export declare class SeverityGroupItem extends vscode.TreeItem {
    readonly severity: string;
    readonly findings: EvaluatedFinding[];
    constructor(severity: string, findings: EvaluatedFinding[]);
}
export declare class FindingItem extends vscode.TreeItem {
    readonly finding: EvaluatedFinding;
    constructor(finding: EvaluatedFinding);
}
type FindingTreeItem = SeverityGroupItem | FindingItem;
export declare class FindingsProvider implements vscode.TreeDataProvider<FindingTreeItem> {
    private readonly workspaceRoot;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<FindingTreeItem | undefined | void>;
    constructor(workspaceRoot: string);
    refresh(): void;
    getTreeItem(element: FindingTreeItem): vscode.TreeItem;
    getChildren(element?: FindingTreeItem): vscode.ProviderResult<FindingTreeItem[]>;
    private _loadLatestReport;
}
export {};
//# sourceMappingURL=findings-provider.d.ts.map