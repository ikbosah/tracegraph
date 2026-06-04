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
export declare class TraceRunItem extends vscode.TreeItem {
    readonly runId: string;
    readonly runDir: string;
    readonly traceFiles: string[];
    constructor(runId: string, runDir: string, traceFiles: string[], 
    /** Set when multiple roots are active so the user can tell runs apart. */
    projectName?: string);
}
export declare class TraceFileItem extends vscode.TreeItem {
    readonly traceFile: string;
    readonly traceId: string;
    readonly status: string;
    constructor(traceFile: string, traceId: string, status: string);
}
type TraceTreeItem = TraceRunItem | TraceFileItem;
export declare class TracesProvider implements vscode.TreeDataProvider<TraceTreeItem> {
    private roots;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<TraceTreeItem | undefined | void>;
    constructor(roots: string[]);
    setRoots(roots: string[]): void;
    refresh(): void;
    getTreeItem(element: TraceTreeItem): vscode.TreeItem;
    getChildren(element?: TraceTreeItem): vscode.ProviderResult<TraceTreeItem[]>;
    private _listRuns;
}
export {};
//# sourceMappingURL=traces-provider.d.ts.map