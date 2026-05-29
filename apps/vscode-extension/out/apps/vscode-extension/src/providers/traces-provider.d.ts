/**
 * T8.6 — Traces sidebar provider
 *
 * Lists `.trace.json` files found in `.tracegraph/traces/`, grouped by run ID
 * (derived from the file path pattern `<runId>/<traceId>.trace.json`).
 */
import * as vscode from 'vscode';
export declare class TraceRunItem extends vscode.TreeItem {
    readonly runId: string;
    readonly runDir: string;
    readonly traceFiles: string[];
    constructor(runId: string, runDir: string, traceFiles: string[]);
}
export declare class TraceFileItem extends vscode.TreeItem {
    readonly traceFile: string;
    readonly traceId: string;
    readonly status: string;
    constructor(traceFile: string, traceId: string, status: string);
}
type TraceTreeItem = TraceRunItem | TraceFileItem;
export declare class TracesProvider implements vscode.TreeDataProvider<TraceTreeItem> {
    private readonly workspaceRoot;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<TraceTreeItem | undefined | void>;
    constructor(workspaceRoot: string);
    refresh(): void;
    getTreeItem(element: TraceTreeItem): vscode.TreeItem;
    getChildren(element?: TraceTreeItem): vscode.ProviderResult<TraceTreeItem[]>;
    private _listRuns;
}
export {};
//# sourceMappingURL=traces-provider.d.ts.map