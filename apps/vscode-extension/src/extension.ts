/**
 * TraceGraph VS Code Extension — entry point
 *
 * T8.1 — Extension manifest + activation
 * T8.2 — CliRunner wiring
 * T8.3 — FileWatcher wiring
 *
 * Activation:
 *   workspaceContains:.tracegraph/**
 *
 * Registers:
 *   - Commands: runLatest, compareLatest, openTrace, viewReport,
 *               createBaseline, generatePack, refresh
 *   - Views: tracegraphTraces, tracegraphFindings, tracegraphBaselines,
 *            tracegraphScenarios
 *   - File watcher → auto-refresh sidebar trees
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
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return; // no workspace open

  // ── Output channel ─────────────────────────────────────────────────────────
  const outputChannel = vscode.window.createOutputChannel('TraceGraph');
  context.subscriptions.push(outputChannel);

  // ── Sidebar providers ───────────────────────────────────────────────────────
  const tracesProvider    = new TracesProvider(workspaceRoot);
  const baselinesProvider = new BaselinesProvider(workspaceRoot);
  const findingsProvider  = new FindingsProvider(workspaceRoot);
  const scenariosProvider = new ScenariosProvider(workspaceRoot);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('tracegraphTraces',    tracesProvider),
    vscode.window.registerTreeDataProvider('tracegraphBaselines', baselinesProvider),
    vscode.window.registerTreeDataProvider('tracegraphFindings',  findingsProvider),
    vscode.window.registerTreeDataProvider('tracegraphScenarios', scenariosProvider),
  );

  // ── File watcher → auto-refresh ─────────────────────────────────────────────
  const watcher = new FileWatcher();
  context.subscriptions.push(watcher);

  watcher.onArtifactChange((e) => {
    const cfg = vscode.workspace.getConfiguration('tracegraph');
    if (!cfg.get<boolean>('autoRefresh', true)) return;

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

  async function runCli(
    args:    string[],
    label:   string,
  ): Promise<number> {
    outputChannel.clear();
    outputChannel.show(true);
    outputChannel.appendLine(`▶ tracegraph ${args.join(' ')}`);

    const runner = new CliRunner(workspaceRoot);
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

      const cmd = cfg.get<string>('runCommand') ?? '';
      const args = ['run', '--', ...cmd.split(/\s+/).filter(Boolean)];

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TraceGraph: running...', cancellable: true },
        async (_progress, token) => {
          token.onCancellationRequested(() => activeRunner?.cancel());
          await runCli(args, 'run');
          refreshAll();
        },
      );
    }),
  );

  // tracegraph.compareLatest
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.compareLatest', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TraceGraph: comparing...', cancellable: true },
        async (_progress, token) => {
          token.onCancellationRequested(() => activeRunner?.cancel());
          await runCli(['compare', '--latest'], 'compare');
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
      await runCli(['baseline', 'create', '--reason', reason], 'baseline create');
      baselinesProvider.refresh();
    }),
  );

  // tracegraph.generatePack
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.generatePack', async () => {
      await runCli(['pack'], 'pack');
      vscode.window.showInformationMessage('TraceGraph: AI context packs generated.');
    }),
  );

  // tracegraph.openTrace — opens a trace file in the webview panel
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.openTrace', (traceFile?: string) => {
      // traceFile is passed from the tree item's command argument
      // or can be called without an argument (prompt user to pick)
      if (traceFile && fs.existsSync(traceFile)) {
        _openTraceInPanel(traceFile, context.extensionUri, workspaceRoot);
        return;
      }

      // Quick-pick from available trace files
      const tracesDir = path.join(workspaceRoot, '.tracegraph', 'traces');
      const files     = findTraceFiles(tracesDir);
      if (files.length === 0) {
        vscode.window.showInformationMessage(
          'No trace files found in .tracegraph/traces/. Run tracing first.',
        );
        return;
      }

      vscode.window.showQuickPick(
        files.map((f) => ({
          label:       path.basename(f, '.trace.json'),
          description: path.relative(workspaceRoot, f),
          file:        f,
        })),
        { placeHolder: 'Select a trace to open' },
      ).then((picked) => {
        if (picked) {
          _openTraceInPanel(picked.file, context.extensionUri, workspaceRoot);
        }
      });
    }),
  );

  // tracegraph.viewReport — opens the latest report
  context.subscriptions.push(
    vscode.commands.registerCommand('tracegraph.viewReport', () => {
      const reportFile = resolveLatestReport(workspaceRoot);
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
      TraceGraphPanel.open(context.extensionUri, workspaceRoot, {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
  const latestPtr = path.join(workspaceRoot, '.tracegraph', 'latest.json');
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

  const reportsDir = path.join(workspaceRoot, '.tracegraph', 'reports');
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
