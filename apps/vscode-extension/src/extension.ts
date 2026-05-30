/**
 * TraceGraph VS Code Extension — entry point
 *
 * T8.1 — Extension manifest + activation
 * T8.2 — CliRunner wiring
 * T8.3 — FileWatcher wiring
 *
 * Activation: workspaceContains:.tracegraph (root-level and monorepo
 *   subfolders — see activationEvents in package.json).
 *
 * Monorepo support:
 *   findTracegraphRoots() scans each workspace folder and its immediate
 *   children for a `.tracegraph/` directory.  All providers receive the
 *   full list of roots so they aggregate data across every sub-project.
 *
 * Registers:
 *   - Commands: runLatest, compareLatest, openTrace, viewReport,
 *               createBaseline, generatePack, refresh
 *   - Views: tracegraphTraces, tracegraphFindings, tracegraphBaselines,
 *            tracegraphScenarios
 *   - File watcher and auto-refresh sidebar trees
 *   - Output channel for CLI stdout/stderr
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';

import { CliRunner }          from './cli-runner';
import { FileWatcher }        from './file-watcher';
import { TraceGraphPanel, loadTraceFile, loadReportFile } from './webview-panel';
import { TracesProvider }     from './providers/traces-provider';
import { BaselinesProvider }  from './providers/baselines-provider';
import { FindingsProvider }   from './providers/findings-provider';
import { ScenariosProvider }  from './providers/scenarios-provider';

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Find all project roots that contain a .tracegraph directory.
  // Re-evaluated on workspace folder changes.
  let roots = findTracegraphRoots();

  if (roots.length === 0) {
    // No .tracegraph found yet — still register everything so commands work
    // once the user runs tracing for the first time.
    roots = getWorkspaceFolderPaths();
  }

  // ── Output channel ─────────────────────────────────────────────────────────
  const outputChannel = vscode.window.createOutputChannel('TraceGraph');
  context.subscriptions.push(outputChannel);

  // ── Sidebar providers ───────────────────────────────────────────────────────
  const tracesProvider    = new TracesProvider(roots);
  const baselinesProvider = new BaselinesProvider(roots);
  const findingsProvider  = new FindingsProvider(roots);
  const scenariosProvider = new ScenariosProvider(roots);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('tracegraphTraces',    tracesProvider),
    vscode.window.registerTreeDataProvider('tracegraphBaselines', baselinesProvider),
    vscode.window.registerTreeDataProvider('tracegraphFindings',  findingsProvider),
    vscode.window.registerTreeDataProvider('tracegraphScenarios', scenariosProvider),
  );

  // Re-scan roots if workspace folders change (monorepo: folder added/removed)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const newRoots = findTracegraphRoots();
      const effective = newRoots.length > 0 ? newRoots : getWorkspaceFolderPaths();
      tracesProvider.setRoots(effective);
      baselinesProvider.setRoots(effective);
      findingsProvider.setRoots(effective);
      scenariosProvider.setRoots(effective);
      refreshAll();
    }),
  );

  // ── File watcher → auto-refresh ─────────────────────────────────────────────
  const watcher = new FileWatcher();
  context.subscriptions.push(watcher);

  watcher.onArtifactChange((e) => {
    const cfg = vscode.workspace.getConfiguration('tracegraph');
    if (!cfg.get<boolean>('autoRefresh', true)) return;

    // A new trace file was detected — rescan roots in case this is the first
    // run in a previously-unseen subfolder.
    const latestRoots = findTracegraphRoots();
    if (latestRoots.length > 0) {
      tracesProvider.setRoots(latestRoots);
      baselinesProvider.setRoots(latestRoots);
      findingsProvider.setRoots(latestRoots);
      scenariosProvider.setRoots(latestRoots);
    }

    switch (e.kind) {
      case 'trace':    tracesProvider.refresh();    break;
      case 'report':   findingsProvider.refresh();  break;
      case 'baseline': baselinesProvider.refresh(); break;
      case 'scenario': scenariosProvider.refresh(); break;
    }
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function refreshAll(): void {
    tracesProvider.refresh();
    baselinesProvider.refresh();
    findingsProvider.refresh();
    scenariosProvider.refresh();
  }

  let activeRunner: CliRunner | undefined;

  /**
   * Run a CLI command from `cwd`.  When multiple roots exist, the caller
   * should pass the root relevant to the operation; otherwise defaults to the
   * first root.
   */
  async function runCli(
    args:  string[],
    label: string,
    cwd?:  string,
  ): Promise<number> {
    const effectiveCwd = cwd ?? roots[0] ?? getWorkspaceFolderPaths()[0] ?? '';
    outputChannel.clear();
    outputChannel.show(true);
    outputChannel.appendLine(`▶ tracegraph ${args.join(' ')}  (cwd: ${effectiveCwd})`);

    const runner = new CliRunner(effectiveCwd);
    activeRunner = runner;

    runner.onStderr((line) => outputChannel.append(line));

    const code = await runner.run(args);
    activeRunner = undefined;

    outputChannel.appendLine(
      code === 0 ? `✓ ${label} completed.` : `✗ ${label} exited with code ${code}.`,
    );
    return code;
  }

  // ── Commands ─────────────────────────────────────────────────────────────────

  // tracegraph.refresh
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.refresh', () => {
      // Re-scan in case new .tracegraph dirs appeared since activation
      const latest = findTracegraphRoots();
      if (latest.length > 0) {
        tracesProvider.setRoots(latest);
        baselinesProvider.setRoots(latest);
        findingsProvider.setRoots(latest);
        scenariosProvider.setRoots(latest);
      }
      refreshAll();
    }),
  );

  // tracegraph.runLatest
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.runLatest', async () => {
      const cfg        = vscode.workspace.getConfiguration('tracegraph');
      const runCommand = cfg.get<string>('runCommand');

      if (!runCommand || runCommand.trim() === '') {
        const entered = await vscode.window.showInputBox({
          prompt:      'Enter the command to run with tracing (e.g. npx vitest run)',
          placeHolder: 'npx vitest run',
        });
        if (!entered) return;
        await cfg.update('runCommand', entered, vscode.ConfigurationTarget.Workspace);
      }

      const cmd  = cfg.get<string>('runCommand') ?? '';
      const args = ['run', '--', ...cmd.split(/\s+/).filter(Boolean)];

      // If multiple roots exist, ask which project to run in.
      const cwd = await pickRoot(roots, 'Select the project to run tracing in');
      if (!cwd) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TraceGraph: running...', cancellable: true },
        async (_progress, token) => {
          token.onCancellationRequested(() => activeRunner?.cancel());
          await runCli(args, 'run', cwd);
          refreshAll();
        },
      );
    }),
  );

  // tracegraph.compareLatest
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.compareLatest', async () => {
      const cwd = await pickRoot(roots, 'Select the project to compare');
      if (!cwd) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TraceGraph: comparing...', cancellable: true },
        async (_progress, token) => {
          token.onCancellationRequested(() => activeRunner?.cancel());
          await runCli(['compare', '--latest'], 'compare', cwd);
          findingsProvider.refresh();
        },
      );
    }),
  );

  // tracegraph.createBaseline
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.createBaseline', async () => {
      const reason = await vscode.window.showInputBox({
        prompt:      'Approval reason for this baseline',
        placeHolder: 'Reviewed and approved',
      });
      if (!reason) return;
      const cwd = await pickRoot(roots, 'Select the project to baseline');
      if (!cwd) return;
      await runCli(['baseline', 'create', '--reason', reason], 'baseline create', cwd);
      baselinesProvider.refresh();
    }),
  );

  // tracegraph.generatePack
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.generatePack', async () => {
      const cwd = await pickRoot(roots, 'Select the project');
      if (!cwd) return;
      await runCli(['pack'], 'pack', cwd);
      vscode.window.showInformationMessage('TraceGraph: AI context packs generated.');
    }),
  );

  // tracegraph.openTrace — opens a trace file in the webview panel
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.openTrace', (traceFile?: string) => {
      // traceFile is passed from the tree item's command argument
      if (traceFile && fs.existsSync(traceFile)) {
        const traceRoot = resolveRootForFile(traceFile, roots);
        _openTraceInPanel(traceFile, context.extensionUri, traceRoot);
        return;
      }

      // Quick-pick from all trace files across all roots
      const allFiles: Array<{ label: string; description: string; file: string }> = [];
      for (const root of roots) {
        const tracesDir = path.join(root, '.tracegraph', 'traces');
        for (const f of findTraceFiles(tracesDir)) {
          allFiles.push({
            label:       path.basename(f, '.trace.json'),
            description: path.relative(
              vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? root,
              f,
            ),
            file: f,
          });
        }
      }

      if (allFiles.length === 0) {
        vscode.window.showInformationMessage(
          'No trace files found. Run tracing first.',
        );
        return;
      }

      vscode.window.showQuickPick(allFiles, { placeHolder: 'Select a trace to open' })
        .then((picked) => {
          if (picked) {
            const traceRoot = resolveRootForFile(picked.file, roots);
            _openTraceInPanel(picked.file, context.extensionUri, traceRoot);
          }
        });
    }),
  );

  // tracegraph.viewReport — opens the latest report
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.viewReport', async () => {
      const cwd = await pickRoot(roots, 'Select the project');
      if (!cwd) return;
      const reportFile = resolveLatestReport(cwd);
      if (!reportFile) {
        vscode.window.showInformationMessage(
          'No report found. Run `tracegraph compare --latest` first.',
        );
        return;
      }
      const report = loadReportFile(reportFile);
      if (!report) {
        vscode.window.showErrorMessage(`TraceGraph: could not read report ${reportFile}`);
        return;
      }
      TraceGraphPanel.open(context.extensionUri, cwd, {
        kind: 'report',
        data: report,
      });
    }),
  );
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  // Nothing to clean up — subscriptions are handled by the context
}

// ─── Root discovery ───────────────────────────────────────────────────────────

/**
 * Find every directory within the current workspace that contains a
 * `.tracegraph/` subdirectory.
 *
 * Searches:
 *   - Each workspace folder directly (level 0)
 *   - Each immediate child of each workspace folder (level 1)
 *
 * Level-1 search handles the common monorepo pattern:
 *   <workspace>/
 *     backend/   ← has .tracegraph/
 *     frontend/
 *
 * Skips hidden dirs, node_modules, and vendor.
 */
export function findTracegraphRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return [];

  const roots = new Set<string>();
  const SKIP  = new Set([
    'node_modules', 'vendor', '.git', '.svn', 'dist', 'build', 'out',
    '.next', '.nuxt', 'coverage', '__pycache__',
  ]);

  for (const folder of folders) {
    const base = folder.uri.fsPath;

    // Level 0
    if (fs.existsSync(path.join(base, '.tracegraph'))) {
      roots.add(base);
    }

    // Level 1 — only if not already found at level 0 (avoids double counting)
    if (!roots.has(base)) {
      try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
          const child = path.join(base, entry.name);
          if (fs.existsSync(path.join(child, '.tracegraph'))) {
            roots.add(child);
          }
        }
      } catch { /* ignore permission errors */ }
    }
  }

  return [...roots];
}

function getWorkspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * If there is only one root, return it immediately (no picker needed).
 * If there are multiple roots, show a quick-pick and return the chosen one.
 * Returns undefined if the user cancels.
 */
async function pickRoot(roots: string[], placeHolder: string): Promise<string | undefined> {
  if (roots.length === 0) return undefined;
  if (roots.length === 1) return roots[0];

  const workspaceBase = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const items = roots.map((r) => ({
    label:       path.basename(r),
    description: path.relative(workspaceBase, r) || r,
    root:        r,
  }));

  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  return picked?.root;
}

/**
 * Given a file path, return the root whose `.tracegraph` directory it belongs to.
 * Falls back to the first root if no match.
 */
function resolveRootForFile(filePath: string, roots: string[]): string {
  for (const root of roots) {
    if (filePath.startsWith(root)) return root;
  }
  return roots[0] ?? path.dirname(filePath);
}

function _openTraceInPanel(
  traceFile:     string,
  extensionUri:  vscode.Uri,
  workspaceRoot: string,
): void {
  const trace = loadTraceFile(traceFile);
  if (!trace) {
    vscode.window.showErrorMessage(`TraceGraph: could not read trace file ${traceFile}`);
    return;
  }
  TraceGraphPanel.open(extensionUri, workspaceRoot, { kind: 'trace', data: trace });
}

function resolveLatestReport(workspaceRoot: string): string | null {
  const tracegraphDir = path.join(workspaceRoot, '.tracegraph');
  const latestPtr     = path.join(tracegraphDir, 'latest.json');

  if (fs.existsSync(latestPtr)) {
    try {
      const ptr = JSON.parse(fs.readFileSync(latestPtr, 'utf8')) as Record<string, unknown>;
      if (ptr.reportFile && typeof ptr.reportFile === 'string') {
        const p = path.isAbsolute(ptr.reportFile)
          ? ptr.reportFile
          : path.join(workspaceRoot, String(ptr.reportFile));
        if (fs.existsSync(p)) return p;
      }
    } catch { /* fall through */ }
  }

  const reportsDir = path.join(tracegraphDir, 'reports');
  if (!fs.existsSync(reportsDir)) return null;

  try {
    const reports = fs
      .readdirSync(reportsDir)
      .filter((f) => f.endsWith('.report.json'))
      .map((f) => ({ file: path.join(reportsDir, f), mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return reports[0]?.file ?? null;
  } catch {
    return null;
  }
}

function findTraceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...findTraceFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.trace.json')) {
        result.push(full);
      }
    }
  } catch { /* ignore */ }
  return result.sort();
}
