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

export type WatchedArtifactKind =
  | 'trace'
  | 'report'
  | 'baseline'
  | 'scenario';

export interface ArtifactChangeEvent {
  kind: WatchedArtifactKind;
  uri:  vscode.Uri;
}

export class FileWatcher implements vscode.Disposable {
  private readonly _onArtifactChange = new vscode.EventEmitter<ArtifactChangeEvent>();
  readonly onArtifactChange: vscode.Event<ArtifactChangeEvent> =
    this._onArtifactChange.event;

  private readonly _disposables: vscode.Disposable[] = [];

  constructor() {
    this._register('**/.tracegraph/traces/*.trace.json',    'trace');
    this._register('**/.tracegraph/reports/*.report.json',  'report');
    this._register('**/.tracegraph/baselines/*.baseline.json', 'baseline');
    this._register('**/.tracegraph/scenarios/*.scenario.json', 'scenario');
  }

  private _register(globPattern: string, kind: WatchedArtifactKind): void {
    const watcher = vscode.workspace.createFileSystemWatcher(globPattern);

    const handler = (uri: vscode.Uri): void => {
      this._onArtifactChange.fire({ kind, uri });
    };

    this._disposables.push(
      watcher,
      watcher.onDidCreate(handler),
      watcher.onDidChange(handler),
    );
  }

  dispose(): void {
    this._onArtifactChange.dispose();
    for (const d of this._disposables) d.dispose();
  }
}
