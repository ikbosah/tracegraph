/**
 * T1.8 — `tracegraph open --html`
 *
 * Produces a self-contained HTML file from a .trace.json and optionally
 * opens it in the default browser.
 *
 * The webview bundle (apps/webview/dist/tracegraph-viewer.iife.js) is read
 * from disk and embedded directly into the HTML, making the output fully
 * self-contained and usable offline.
 *
 * Bundle resolution order:
 *  1. TRACEGRAPH_WEBVIEW_BUNDLE env var (override for CI / custom builds)
 *  2. apps/webview/dist/ relative to the monorepo root (dev mode, tsx)
 *  3. ../webview-bundle/ relative to this file (production embed placeholder)
 */
import fs   from 'fs';
import path from 'path';
import { readTrace } from '@tracegraph/trace-core';
import { EXIT_CODES } from '@tracegraph/shared-types';

export type OpenOptions = {
  out?:    string;
  noOpen?: boolean;
};

export function openCommand(traceFilePath: string, options: OpenOptions): void {
  // ── Resolve trace file ────────────────────────────────────────────────────
  const absTracePath = path.resolve(process.cwd(), traceFilePath);

  if (!fs.existsSync(absTracePath)) {
    process.stderr.write(`[tracegraph] Trace file not found: ${absTracePath}\n`);
    process.exit(EXIT_CODES.CLI_ERROR);
  }

  let trace: ReturnType<typeof readTrace>;
  try {
    trace = readTrace(absTracePath);
  } catch (err) {
    process.stderr.write(`[tracegraph] Failed to read trace: ${String(err)}\n`);
    process.exit(EXIT_CODES.CLI_ERROR);
  }

  // ── Resolve webview bundle ────────────────────────────────────────────────
  const bundlePath = resolveBundle();
  if (!bundlePath) {
    process.stderr.write(
      '[tracegraph] Webview bundle not found.\n' +
      '  Build it with: pnpm --filter @tracegraph/webview build\n' +
      '  Or set: TRACEGRAPH_WEBVIEW_BUNDLE=/path/to/tracegraph-viewer.iife.js\n',
    );
    process.exit(EXIT_CODES.CLI_ERROR);
  }

  const bundleJs  = fs.readFileSync(bundlePath, 'utf8');
  const bundleCss = readCssIfExists(bundlePath);

  // ── Build HTML ────────────────────────────────────────────────────────────
  const traceJson = JSON.stringify(trace);
  const title     = buildTitle(trace);
  const html      = buildHtml({ title, traceJson, bundleJs, bundleCss });

  // ── Write output file ─────────────────────────────────────────────────────
  const outPath = resolveOutPath(absTracePath, options.out, trace.traceId);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');

  process.stdout.write(`[tracegraph] HTML report: ${outPath}\n`);

  // ── Open in browser ───────────────────────────────────────────────────────
  if (!options.noOpen) {
    openInBrowser(outPath);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveBundle(): string | null {
  // 1. Env override
  const envPath = process.env['TRACEGRAPH_WEBVIEW_BUNDLE'];
  if (envPath && fs.existsSync(envPath)) return envPath;

  // 2. Dev mode: walk up from __dirname to find the monorepo root
  const candidates = [
    // From packages/cli/src/commands/ → ../../../../apps/webview/dist/
    path.resolve(__dirname, '../../../../apps/webview/dist/tracegraph-viewer.iife.js'),
    // From packages/cli/dist/commands/ (built) → ../../../../apps/webview/dist/
    path.resolve(__dirname, '../../../../apps/webview/dist/tracegraph-viewer.iife.js'),
    // Relative to process.cwd() (workspace root)
    path.resolve(process.cwd(), 'apps/webview/dist/tracegraph-viewer.iife.js'),
    // Production: next to the CLI entry
    path.resolve(__dirname, '../webview-bundle/tracegraph-viewer.iife.js'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function readCssIfExists(bundlePath: string): string {
  const cssPath = bundlePath.replace('.iife.js', '.css');
  if (fs.existsSync(cssPath)) {
    return fs.readFileSync(cssPath, 'utf8');
  }
  return '';
}

function buildTitle(trace: { traceId: string; entrypoint: { type: string; [k: string]: unknown } }): string {
  const ep = trace.entrypoint;
  if (ep.type === 'http_request') return `${ep.method as string} ${ep.path as string}`;
  if (ep.type === 'cli_command')  return ep.command as string;
  if (ep.type === 'test_case')    return ep.testName as string;
  return trace.traceId;
}

interface HtmlOptions {
  title:      string;
  traceJson:  string;
  bundleJs:   string;
  bundleCss:  string;
}

function buildHtml({ title, traceJson, bundleJs, bundleCss }: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TraceGraph — ${escapeHtml(title)}</title>
  <meta name="generator" content="tracegraph" />
${bundleCss ? `  <style>\n${bundleCss}\n  </style>` : ''}
</head>
<body>
  <div id="root"></div>
  <script id="tracegraph-data" type="application/json">
${traceJson}
  </script>
  <script>
${bundleJs}
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveOutPath(traceFilePath: string, out: string | undefined, traceId: string): string {
  if (out) return path.resolve(process.cwd(), out);

  // Default: .tracegraph/reports/<traceId>.html (next to the traces dir)
  const tracegraphDir = findTracegraphDir(traceFilePath);
  return path.join(tracegraphDir, 'reports', `${traceId}.html`);
}

function findTracegraphDir(traceFilePath: string): string {
  // Walk up from trace file to find .tracegraph/ directory
  let dir = path.dirname(traceFilePath);
  while (true) {
    if (path.basename(dir) === '.tracegraph') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // Fallback: next to the trace file
  return path.dirname(traceFilePath);
}

function openInBrowser(filePath: string): void {
  const url = `file://${filePath}`;
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    if (process.platform === 'win32') {
      execSync(`start "" "${filePath}"`, { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      execSync(`open "${filePath}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${filePath}"`, { stdio: 'ignore' });
    }
  } catch {
    process.stdout.write(`[tracegraph] Open in browser: ${url}\n`);
  }
}
