/**
 * T8.6 — Scenarios sidebar provider
 *
 * Lists `.scenario.json` files found in `.tracegraph/scenarios/`.
 */
import * as vscode from 'vscode';
export declare class ScenarioItem extends vscode.TreeItem {
    readonly scenarioFile: string;
    constructor(scenarioFile: string, label: string, description: string);
}
export declare class ScenariosProvider implements vscode.TreeDataProvider<ScenarioItem> {
    private readonly workspaceRoot;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<ScenarioItem | undefined | void>;
    constructor(workspaceRoot: string);
    refresh(): void;
    getTreeItem(element: ScenarioItem): vscode.TreeItem;
    getChildren(): vscode.ProviderResult<ScenarioItem[]>;
}
//# sourceMappingURL=scenarios-provider.d.ts.map