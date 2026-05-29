/**
 * T8.5 — Source navigation
 *
 * Handles `OPEN_SOURCE` messages posted from the webview via
 * `acquireVsCodeApi().postMessage({ command: 'OPEN_SOURCE', file, line })`.
 *
 * Opens the file in the active editor group and scrolls to the requested line.
 * Tries an absolute path first; falls back to a workspace-relative lookup so
 * traces captured on a CI machine (absolute paths differ) still resolve.
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';

export async function openSource(
  rawFile:          string,
  line:             number,
  workspaceRoot:    string,
): Promise<void> {
  const resolvedPath = resolvePath(rawFile, workspaceRoot);
  if (!resolvedPath) {
    vscode.window.showWarningMessage(
      `TraceGraph: could not locate file "${rawFile}" in the workspace.`,
    );
    return;
  }

  const uri     = vscode.Uri.file(resolvedPath);
  const lineIdx = Math.max(0, line - 1); // VS Code lines are 0-indexed

  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    preview:    false,
    viewColumn: vscode.ViewColumn.One,
  });

  const pos   = new vscode.Position(lineIdx, 0);
  const range = new vscode.Range(pos, pos);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  editor.selection = new vscode.Selection(pos, pos);
}

// ─── Path resolver ────────────────────────────────────────────────────────────

/**
 * Try to find the file on disk:
 *   1. Absolute path as-is
 *   2. Relative to workspaceRoot
 *   3. Search all workspace folders for a file whose name ends with the basename
 */
function resolvePath(rawFile: string, workspaceRoot: string): string | null {
  // 1. Absolute
  if (path.isAbsolute(rawFile) && fs.existsSync(rawFile)) return rawFile;

  // 2. Relative to workspace root
  const joined = path.join(workspaceRoot, rawFile);
  if (fs.existsSync(joined)) return joined;

  // 3. Search workspace folders by basename
  const basename = path.basename(rawFile);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = findFileInFolder(folder.uri.fsPath, basename);
    if (candidate) return candidate;
  }

  return null;
}

/** Recursive search limited to two directory levels to avoid scanning node_modules. */
function findFileInFolder(dir: string, basename: string, depth = 0): string | null {
  if (depth > 2) return null;
  const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'vendor', '.tracegraph']);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === basename) return full;
    if (entry.isDirectory()) {
      const found = findFileInFolder(full, basename, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
