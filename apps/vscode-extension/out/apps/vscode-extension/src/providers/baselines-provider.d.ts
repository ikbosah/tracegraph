/**
 * T8.6 — Baselines sidebar provider
 *
 * Lists `.baseline.json` files in `.tracegraph/baselines/`.
 * Shows baseline ID (truncated), test name / entrypoint, and approval status.
 */
import * as vscode from 'vscode';
export declare class BaselineItem extends vscode.TreeItem {
    readonly baselineFile: string;
    constructor(baselineFile: string, label: string, description: string, approved: boolean);
}
export declare class BaselinesProvider implements vscode.TreeDataProvider<BaselineItem> {
    private readonly workspaceRoot;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<BaselineItem | undefined | void>;
    constructor(workspaceRoot: string);
    refresh(): void;
    getTreeItem(element: BaselineItem): vscode.TreeItem;
    getChildren(): vscode.ProviderResult<BaselineItem[]>;
}
//# sourceMappingURL=baselines-provider.d.ts.map