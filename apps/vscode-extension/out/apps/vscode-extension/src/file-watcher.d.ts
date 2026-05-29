/**
 * T8.3 — FileWatcher
 *
 * Watches the `.tracegraph/` directory for new / modified artifact files and
 * fires typed events so the extension can refresh sidebar trees and open panels
 * automatically.
 *
 * Watched patterns:
 *   .tracegraph/traces/*.trace.json
 *   .tracegraph/reports/*.report.json
 *   .tracegraph/baselines/*.baseline.json
 *   .tracegraph/scenarios/*.scenario.json
 */
import * as vscode from 'vscode';
export type WatchedArtifactKind = 'trace' | 'report' | 'baseline' | 'scenario';
export interface ArtifactChangeEvent {
    kind: WatchedArtifactKind;
    uri: vscode.Uri;
}
export declare class FileWatcher implements vscode.Disposable {
    private readonly _onArtifactChange;
    readonly onArtifactChange: vscode.Event<ArtifactChangeEvent>;
    private readonly _disposables;
    constructor();
    private _register;
    dispose(): void;
}
//# sourceMappingURL=file-watcher.d.ts.map