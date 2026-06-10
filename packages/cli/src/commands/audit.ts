/**
 * `tracegraph audit <github-url>`
 *
 * Phase 1 — Non-invasive audit workflow
 *
 * Workflow:
 *   1. Fetch open PRs from the target GitHub repo; score each for impact
 *   2. Fork the repo (via GitHub API) and clone to a local workspace
 *   3. Detect the project stack (language, framework, test runner)
 *   4. Resolve tracegraph instrumentation paths from the current installation
 *   5. Install dependencies (npm / composer / etc.)
 *   6. Run tests on the base branch with tracegraph → establish baseline
 *   7. Fetch + merge the selected PR branch
 *   8. Run tests again → tracegraph compare → tracegraph report
 *   9. Print the findings summary
 *
 * Non-invasive means: no application source files are modified.  We add
 * NODE_OPTIONS=--require to inject the CJS hook (Level 3) and absolute-path
 * reporter flags to the test command (Level 5 for Vitest/Jest) without
 * touching any file in the cloned repo.
 */

import fs       from 'fs';
import path     from 'path';
import os       from 'os';
import https    from 'https';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { EXIT_CODES } from '@tracegraph/shared-types';
import {
  detectGraphify,
  runtimeCallEdgesPath,
  importRuntimeCallEdges,
  loadOrRebuildGraphIndex,
  graphMetadataPath,
} from '@tracegraph/static-graph';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Absolute path to the CLI entry point used when spawning `tracegraph run`
 * as a subprocess during audit phases.
 *
 * In production:
 *   process.argv[1] = /path/to/bin/tracegraph.js   — compiled shim, works as-is
 *   process.argv[1] = /path/to/dist/index.js       — compiled bundle, works as-is
 *
 * In development (tsx shim like `exec tsx /path/to/packages/cli/src/index.ts`):
 *   process.argv[1] = /path/to/packages/cli/src/index.ts
 *   → spawnSync(node, [src/index.ts]) would fail: Node.js cannot parse TypeScript
 *     without tsx's loader, which is a command-line flag — not propagated to children.
 *   → Replace with the compiled dist/index.js (always present after `pnpm build`).
 *   → Fallback: bin/tracegraph.js which loads dist/ or tsx itself.
 */
const TG_BIN: string = (() => {
  const src = process.argv[1]!;
  if (!src.endsWith('.ts')) return src;          // already a JS shim or compiled bundle

  // src = .../packages/cli/src/index.ts — running via tsx in development
  const dist = src.replace(/[/\\]src[/\\]index\.ts$/, '/dist/index.js');
  if (fs.existsSync(dist)) return dist;          // compiled bundle — preferred

  const bin = src.replace(/[/\\]src[/\\]index\.ts$/, '/bin/tracegraph.js');
  if (fs.existsSync(bin)) return bin;            // shim with tsx fallback

  return src;                                    // give up — caller will fail gracefully
})();

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditOptions = {
  /** Force a specific PR number — skips scoring/auto-selection. */
  pr?:        number;
  /** Override the local workspace/clone directory. */
  workspace?: string;
  /** Clone the upstream repo directly without forking (--skip-fork). */
  skipFork?:  boolean;
  /** GitHub personal access token (falls back to $GITHUB_TOKEN or `gh auth token`). */
  token?:     string;
  /** Write the markdown report to this file in addition to stdout. */
  out?:       string;
  /** Emit machine-readable JSON summary instead of prose output. */
  json?:      boolean;
  /** Per-phase timeout in seconds (default: 300). */
  timeout?:   number;
  /** Skip Graphify static graph analysis even if Graphify is installed. */
  skipGraph?: boolean;
};

// Minimal subset of the GitHub PR list / detail response
type GhPR = {
  number:          number;
  title:           string;
  body:            string | null;
  created_at:      string;
  comments:        number;
  review_comments: number;
  labels:          Array<{ name: string }>;
  head: {
    sha:  string;
    ref:  string;
    repo: { clone_url: string; full_name: string } | null;
  };
  base: {
    ref:  string;
    repo: { clone_url: string; full_name: string; default_branch: string };
  };
  user:           { login: string };
  additions?:     number;
  deletions?:     number;
  changed_files?: number;
};

type ScoredPR = GhPR & { score: number; signals: string[] };

type RepoStack = {
  language:     string;    // 'node' | 'php' | 'java' | 'python' | 'go' | 'dotnet' | 'unknown'
  framework:    string;    // 'express' | 'laravel' | 'nestjs' | 'spring' | ...
  testRunner:   string | null;  // 'vitest' | 'jest' | 'phpunit' | 'pytest' | 'go-test' | ...
  rawTestCmd:   string;    // e.g. "vitest run" or "php artisan test"
  installCmds:  string[][];     // fatal if they fail — package manager install only
  /**
   * Optional workspace build commands run AFTER install.
   * These compile internal packages that the test suite imports.
   * Failures here are NON-FATAL: full-stack app packages (Next.js, database, etc.)
   * often fail because they need secrets we can't provide, but the library
   * packages that the test suite actually needs are usually built first by Turbo.
   */
  buildCmds:    string[][];
  captureNote:  string;    // human-readable capture level expectation
};

type TracegraphPaths = {
  /** Absolute path to register-cjs.js — injected via NODE_OPTIONS --require for Level 3. */
  registerCjs:       string | null;
  /**
   * Absolute path to register.mjs — injected via NODE_OPTIONS --import for Level 4 (ESM hook).
   * Enables tracing of ESM-native test files (.mts/.mjs) alongside the CJS hook.
   * Requires Node.js 18.19+ or 20.6+; safe to inject on older versions (flag ignored).
   */
  registerEsm:       string | null;
  /**
   * Absolute path to @tracegraph/vitest reporter CJS entry (.js).
   * Used for Vitest 1.x which loads reporters via CJS require().
   */
  vitestReporter:    string | null;
  /**
   * Absolute path to @tracegraph/vitest reporter ESM entry (.mjs).
   * Used for Vitest 2+ which loads reporters via ESM import() — when a CJS file
   * is import()'d, module.exports becomes the default export (not .default),
   * so Vitest's `new mod.default()` would fail.  The .mjs file has the correct
   * ESM default export (the class itself, not the whole exports object).
   */
  vitestReporterMjs: string | null;
  /** Absolute path to @tracegraph/jest reporter entry — for Level 5 on Jest. */
  jestReporter:      string | null;
};

// ─── GitHub API ───────────────────────────────────────────────────────────────

function githubRequest<T = unknown>(
  method:   string,
  urlPath:  string,
  token?:   string,
  body?:    unknown,
  _hops = 0,
): Promise<T> {
  if (_hops > 5) return Promise.reject(new Error('Too many redirects from GitHub API'));

  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      'Accept':     'application/vnd.github.v3+json',
      'User-Agent': 'tracegraph-cli/1.0',
    };
    if (token)   headers['Authorization']  = `Bearer ${token}`;
    if (bodyStr) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }

    const req = https.request(
      {
        hostname: 'api.github.com',
        path:     urlPath,
        method,
        headers,
        timeout: 20_000,
      },
      (res) => {
        // ── Follow 3xx redirects ──────────────────────────────────────────────
        // GitHub uses 301 when a repo is transferred to a new owner/name.
        // `https.request` does NOT follow redirects automatically.
        if (res.statusCode != null && res.statusCode >= 300 && res.statusCode < 400) {
          const location = res.headers['location'];
          res.resume(); // drain and discard the redirect response body
          if (!location) {
            return reject(new Error(`GitHub redirect (${res.statusCode}) with no Location header`));
          }
          try {
            // Location may be a full URL or an absolute path
            const newUrl  = new URL(location, 'https://api.github.com');
            const newPath = newUrl.pathname + newUrl.search;
            resolve(githubRequest<T>(method, newPath, token, body, _hops + 1));
          } catch {
            reject(new Error(`GitHub redirect to unparseable location: ${location}`));
          }
          return;
        }

        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            try { resolve(JSON.parse(data) as T); }
            catch  { resolve(data as unknown as T); }
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API timed out')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchOpenPRs(owner: string, repo: string, token?: string): Promise<GhPR[]> {
  const prs: GhPR[] = [];
  let page = 1;
  while (page <= 3) {  // cap at 3 pages = 300 PRs
    const page_data = await githubRequest<GhPR[]>(
      'GET',
      `/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(page_data) || page_data.length === 0) break;
    prs.push(...page_data);
    if (page_data.length < 100) break;
    page++;
  }
  return prs;
}

async function fetchPRDetail(
  owner: string, repo: string, prNumber: number, token?: string,
): Promise<GhPR> {
  return githubRequest<GhPR>('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`, token);
}

/**
 * G8 — Fetch the list of files changed by a PR.
 * Returns an array of relative file paths (up to 300 files).
 * Returns [] on any error (non-critical — PR context is best-effort).
 */
async function fetchPRFiles(
  owner: string, repo: string, prNumber: number, token?: string,
): Promise<string[]> {
  try {
    // GitHub caps at 300 files per PR; max 100 per page.
    const allFiles: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const items = await githubRequest<Array<{ filename: string }>>(
        'GET',
        `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
        token,
      );
      if (!Array.isArray(items) || items.length === 0) break;
      allFiles.push(...items.map((f) => f.filename));
      if (items.length < 100) break;
    }
    return allFiles;
  } catch {
    return [];
  }
}

async function forkRepo(
  owner: string, repo: string, token: string,
): Promise<{ cloneUrl: string; fullName: string }> {
  const fork = await githubRequest<{ clone_url: string; full_name: string }>(
    'POST',
    `/repos/${owner}/${repo}/forks`,
    token,
  );
  return { cloneUrl: fork.clone_url, fullName: fork.full_name };
}

async function getGithubUser(token: string): Promise<string> {
  const user = await githubRequest<{ login: string }>('GET', '/user', token);
  return user.login;
}

// ─── Token resolution ─────────────────────────────────────────────────────────

function resolveToken(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN'];

  // Try `gh auth token` as a last resort
  try {
    const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch { /* gh not installed */ }

  return undefined;
}

// ─── PR scoring ───────────────────────────────────────────────────────────────

function scorePR(pr: GhPR): ScoredPR {
  let score = 0;
  const signals: string[] = [];

  // Keyword signals — security / data / behaviour keywords in title or body
  const text = (pr.title + ' ' + (pr.body ?? '')).toLowerCase();
  const KEYWORDS = [
    'auth', 'security', 'permission', 'role',
    'migration', 'database', 'sql', 'query',
    'refactor', 'breaking', 'api', 'route', 'endpoint',
    'inject', 'vulnerability', 'fix cve',
  ];
  if (KEYWORDS.some((k) => text.includes(k))) {
    score++;
    signals.push('keyword match');
  }

  // Review activity — contested PRs are often higher-impact
  const totalComments = (pr.comments ?? 0) + (pr.review_comments ?? 0);
  if (totalComments >= 3) {
    score++;
    signals.push(`${totalComments} comments`);
  }

  // Age — long-open PRs tend to be significant
  const ageDays = (Date.now() - new Date(pr.created_at).getTime()) / 86_400_000;
  if (ageDays > 7) {
    score++;
    signals.push(`${Math.floor(ageDays)}d open`);
  }

  // Labels (GitHub returns null for labels on some PR states)
  const labels = pr.labels ?? [];
  const secLabels = ['security', 'breaking-change', 'breaking', 'major', 'database'];
  if (labels.some((l) => secLabels.some((s) => (l.name ?? '').toLowerCase().includes(s)))) {
    score++;
    signals.push(`label: ${labels.map((l) => l.name).join(', ')}`);
  }

  // Size signals (only available from the detail endpoint — may be undefined here)
  if ((pr.additions ?? 0) + (pr.deletions ?? 0) > 200) {
    score++;
    signals.push(`+${pr.additions}/-${pr.deletions} lines`);
  }
  if ((pr.changed_files ?? 0) > 5) {
    score++;
    signals.push(`${pr.changed_files} files changed`);
  }

  return { ...pr, score, signals };
}

async function selectPR(
  owner: string,
  repo:  string,
  prs:   GhPR[],
  opts:  AuditOptions,
  token?: string,
): Promise<ScoredPR | null> {
  // --pr flag: fetch that specific PR directly
  if (opts.pr != null) {
    log(`Fetching PR #${opts.pr}...`);
    const raw = await fetchPRDetail(owner, repo, opts.pr, token) as unknown;

    // GitHub returns {"message":"Not Found"} (or similar) instead of a PR object
    // when the PR doesn't exist or the token lacks pull_requests:read scope.
    if (!raw || typeof raw !== 'object' || !('number' in raw)) {
      const msg = (raw as Record<string, unknown>)?.['message'] ?? 'unexpected response';
      process.stderr.write(
        `[tracegraph audit] Could not load PR #${opts.pr}: ${msg}\n` +
        `  Possible causes:\n` +
        `    • PR #${opts.pr} does not exist on ${owner}/${repo}\n` +
        `    • Your token needs "Pull requests: Read" scope\n` +
        `      (GitHub → Settings → Developer settings → Fine-grained tokens)\n`,
      );
      return null;
    }

    return scorePR(raw as GhPR);
  }

  if (prs.length === 0) return null;

  // Score all PRs, then fetch detail for the top-5 to get additions/deletions
  const scored = prs.map(scorePR).sort((a, b) => b.score - a.score).slice(0, 5);
  log(`Fetching detail for top ${scored.length} PR(s)...`);
  for (let i = 0; i < scored.length; i++) {
    try {
      const detail = await fetchPRDetail(owner, repo, scored[i]!.number, token);
      scored[i] = scorePR(detail);
    } catch { /* use pre-scored version */ }
  }
  scored.sort((a, b) => b.score - a.score);

  // Auto-select in non-TTY mode
  if (!process.stdin.isTTY || opts.json) {
    log(`Auto-selecting highest-scored PR: #${scored[0]!.number} "${scored[0]!.title}"`);
    return scored[0] ?? null;
  }

  // Interactive selection
  process.stdout.write(`\nOpen PRs in ${owner}/${repo} — top candidates:\n\n`);
  scored.forEach((pr, i) => {
    const size = pr.additions != null
      ? `+${pr.additions}/-${pr.deletions}  ${pr.changed_files ?? '?'} files`
      : 'size unknown';
    process.stdout.write(
      `  [${i + 1}] #${pr.number}  ${pr.title}\n` +
      `      Score: ${pr.score}/6  (${pr.signals.join(', ')})\n` +
      `      ${size}  by ${pr.user.login}\n\n`,
    );
  });

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `Select a PR [1–${scored.length}] or press Enter for #${scored[0]!.number}: `,
      (answer) => {
        rl.close();
        const n = parseInt(answer.trim(), 10);
        resolve(scored[(isNaN(n) ? 1 : n) - 1] ?? scored[0] ?? null);
      },
    );
  });
}

// ─── Stack detection ──────────────────────────────────────────────────────────

/**
 * Scan a package.json scripts object for the best available test script.
 *
 * Priority:
 *  1. Explicit priority names in order: test, test:unit, test:ci, test:run,
 *     test:all, unit, spec, check, vitest, jest, mocha
 *  2. Any script whose NAME contains "test", "spec", "unit" — alphabetically
 *  3. null — caller falls back to detected runner or bare `pm test`
 *
 * No-op scripts ("echo no test", "exit 1") are always skipped.
 */
function findBestTestScript(scripts: Record<string, string>): string | null {
  const isNoOp = (v: string) => /echo.*no.?test|exit 1/i.test(v);

  // Scripts that are NOT self-contained test suites — either long-lived dev
  // servers, E2E tests, or CI/CD scripts that require secrets / external services.
  // All of these will fail or hang in the non-invasive audit environment.
  const isUnrunnable = (name: string, value: string) =>
    // Dev server / file-watcher prefixes
    /^(dev:|start:|serve:|build:|watch:)/i.test(name) ||
    // File-watcher processes in the script value
    /\b(nodemon|concurrently|chokidar)\b/i.test(value) ||
    // "dev:test-app" style — "test" used as a label, not a runner
    /\b(app|server|dev)\b/i.test(name) ||
    // E2E frameworks: need a running server + browser binary not available in audit
    /\b(playwright|cypress|nightwatch|selenium|puppeteer|webdriver)\b/i.test(value) ||
    // CI/CD scripts that require secrets (GITHUB_REF_NAME, database URLs, etc.)
    // Pattern: dotenv loading env files from outside the package (../../ path)
    /dotenv\s+.*\.\.[/\\].*\.env/i.test(value) ||
    // Scripts explicitly in CI directories (scripts/ci/, .ci/, etc.)
    /\bscripts[/\\]ci[/\\]/i.test(value) ||
    // Publish / release / deploy scripts (not test runners)
    /\b(publish|release)[\w-]*\.(ts|js|mjs|cjs)\b/i.test(value);

  // Highest-priority names checked in order.
  // test:watch is intentionally excluded — watch-mode scripts never terminate.
  const PRIORITY = [
    'test', 'test:unit', 'test:ci', 'test:run', 'test:all',
    'unit', 'spec', 'check', 'vitest', 'jest', 'mocha',
  ];

  for (const name of PRIORITY) {
    const value = scripts[name];
    if (value !== undefined && !isNoOp(value) && !isUnrunnable(name, value) && value.trim()) {
      return name;
    }
  }

  // Fallback: any script whose name looks test-related, excluding dev servers and E2E
  for (const [name, value] of Object.entries(scripts).sort()) {
    if (
      /test|spec|unit/i.test(name) &&
      !isUnrunnable(name, value) &&
      !isNoOp(value) &&
      value.trim()
    ) return name;
  }

  return null;
}

/**
 * Scan workspace subpackage package.json files for a test runner when the
 * root package.json has no direct test-runner dependency and its scripts only
 * delegate (e.g. `cd packages/vite && pnpm test` — "vitest" never appears in
 * the root).  Handles pnpm-workspace.yaml, and npm/yarn `workspaces` field.
 */
function detectTestRunnerFromWorkspacePackages(
  repoDir: string,
): 'vitest' | 'jest' | 'mocha' | null {
  const globs: string[] = [];

  // pnpm: workspaces declared in pnpm-workspace.yaml
  try {
    const yaml = fs.readFileSync(path.join(repoDir, 'pnpm-workspace.yaml'), 'utf8');
    for (const m of yaml.match(/^\s+-\s+['"]?([^'"\n]+)['"]?/gm) ?? []) {
      const g = m.replace(/^\s+-\s+['"]?/, '').replace(/['"]?\s*$/, '').trim();
      if (g) globs.push(g);
    }
  } catch { /* no pnpm-workspace.yaml */ }

  // npm / yarn: workspaces declared in package.json `workspaces` field
  if (globs.length === 0) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'),
      ) as Record<string, unknown>;
      const ws = pkg['workspaces'];
      const wsArr = Array.isArray(ws) ? ws
        : Array.isArray((ws as Record<string, unknown> | undefined)?.['packages'])
          ? (ws as Record<string, unknown[]>)['packages']!
          : [];
      for (const g of wsArr) { if (typeof g === 'string') globs.push(g); }
    } catch { /* ignore */ }
  }

  for (const glob of globs) {
    // Handle simple 'packages/*' or 'apps/*' style globs (not deep **)
    const basePart = glob.replace(/\/\*+$/, '');
    const subDir = path.join(repoDir, basePart);
    let subEntries: string[];
    try { subEntries = fs.readdirSync(subDir); } catch { continue; }

    for (const entry of subEntries) {
      const pkgPath = path.join(subDir, entry, 'package.json');
      try {
        const subPkg = JSON.parse(
          fs.readFileSync(pkgPath, 'utf8'),
        ) as Record<string, unknown>;
        const subDeps = {
          ...(subPkg['dependencies']    as Record<string, string> ?? {}),
          ...(subPkg['devDependencies'] as Record<string, string> ?? {}),
        };
        const subScripts = Object.values(
          subPkg['scripts'] as Record<string, string> ?? {},
        ).join(' ');
        if ('vitest' in subDeps || subScripts.includes('vitest')) return 'vitest';
        if ('jest'   in subDeps || subScripts.includes('jest'))   return 'jest';
        if (subScripts.includes('mocha'))                         return 'mocha';
      } catch { /* unreadable */ }
    }
  }

  return null;
}

function detectStack(repoDir: string): RepoStack {
  const entries = fs.readdirSync(repoDir);

  // ── Node.js ──────────────────────────────────────────────────────────────────
  // Skip Node.js detection when `artisan` is present — that is an unambiguous
  // Laravel indicator.  Many Laravel repos ship a package.json for their Vue /
  // React frontend assets and may even have express-adjacent npm packages, but
  // the primary language and test runner are PHP.  Let the PHP block below
  // handle them so we run `php artisan test` instead of looking for a JS runner.
  if (entries.includes('package.json') && !entries.includes('artisan')) {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    } catch { /* malformed package.json */ }

    const deps    = { ...(pkg['dependencies'] as Record<string, string> ?? {}),
                      ...(pkg['devDependencies'] as Record<string, string> ?? {}) };
    const scripts = (pkg['scripts'] as Record<string, string> | undefined) ?? {};

    // Package manager — detect before building the test command
    const pm =
      entries.includes('pnpm-lock.yaml') ? 'pnpm' :
      entries.includes('yarn.lock')      ? 'yarn' :
      'npm';

    // Detect framework
    const framework =
      'express'       in deps ? 'express'  :
      '@nestjs/core'  in deps ? 'nestjs'   :
      'fastify'       in deps ? 'fastify'  :
      'next'          in deps ? 'nextjs'   :
      'node';

    // Find the best available test script — scan all scripts by priority.
    // Many repos use test:unit, test:ci, vitest, check, etc. rather than bare "test".
    const bestScript = findBestTestScript(scripts);

    // Detect test runner from deps + the best script's value
    const scriptValue = bestScript ? (scripts[bestScript] ?? '') : '';
    const allScriptValues = Object.values(scripts).join(' ');
    let testRunner: 'vitest' | 'jest' | 'mocha' | null =
      'vitest' in deps || scriptValue.includes('vitest') || allScriptValues.includes('vitest') ? 'vitest' :
      'jest'   in deps || scriptValue.includes('jest')   || allScriptValues.includes('jest')   ? 'jest'   :
      scriptValue.includes('mocha') || allScriptValues.includes('mocha')                       ? 'mocha'  :
      null;

    // Monorepos often delegate test scripts to a sub-package (e.g.
    // `cd packages/vite && pnpm test`) where vitest/jest never appears in the
    // root scripts or deps.  Scan workspace subpackage package.json files as a
    // fallback so buildInstrumentation can still inject the reporter.
    if (!testRunner) {
      testRunner = detectTestRunnerFromWorkspacePackages(repoDir);
    }

    // Build the effective test command using the correct package manager.
    // Priority: found script → detected runner → empty (no safe fallback exists).
    // We intentionally DO NOT fall back to `pm test` when no script is found:
    // the root "test" script in many monorepos is a CI/CD orchestration script
    // that requires secrets, databases, or GitHub Actions env vars.  Running it
    // blindly produces confusing errors instead of a helpful "not supported" message.
    const effectiveTestCmd = bestScript
      ? `${pm} run ${bestScript}`
      : testRunner
        ? (pm !== 'npm' ? `${pm} exec ${testRunner} run` : `npx ${testRunner} run`)
        : '';

    const installCmds: string[][] = [
      [pm, 'install', ...(pm === 'npm' ? ['--no-audit', '--legacy-peer-deps'] : [])],
    ];

    // Monorepo build step: pnpm/yarn workspace repos often have workspace packages
    // that must be compiled before the test suite can import them.
    // These go into buildCmds (non-fatal) rather than installCmds (fatal) because:
    //   • Full-stack app packages (Next.js, web app) may need DATABASE_URL, REDIS_URL,
    //     etc. that aren't available in the audit sandbox — they'll fail at build time
    //     but the library/util packages the test suite imports will have built first.
    //   • Turbo executes in dependency order, so partial builds are common and valid.
    const buildCmds: string[][] = [];
    if (pm === 'pnpm' && entries.includes('pnpm-workspace.yaml')) {
      if ('build:all' in scripts) {
        buildCmds.push([pm, 'run', 'build:all']);
      } else if ('build' in scripts && !(scripts['build'] ?? '').includes('test')) {
        buildCmds.push([pm, 'run', 'build']);
      }
    }

    const captureNote = testRunner
      ? `Level 3–5 (${testRunner} detected — register hook + reporter injection)`
      : 'Level 3 (register hook via NODE_OPTIONS — no test runner auto-detected)';

    return { language: 'node', framework, testRunner, rawTestCmd: effectiveTestCmd,
             installCmds, buildCmds, captureNote };
  }

  // ── PHP / Laravel ────────────────────────────────────────────────────────────
  if (entries.includes('composer.json')) {
    let composer: Record<string, unknown> = {};
    try {
      composer = JSON.parse(fs.readFileSync(path.join(repoDir, 'composer.json'), 'utf8')) as Record<string, unknown>;
    } catch { /* ignore */ }

    const composerReq = {
      ...(composer['require']     as Record<string, string> ?? {}),
      ...(composer['require-dev'] as Record<string, string> ?? {}),
    };
    const isLaravel = 'laravel/framework' in composerReq;
    const hasPest   = 'pestphp/pest' in composerReq;

    // Use `php vendor/bin/...` rather than `./vendor/bin/...`.
    // The `./` prefix is a Unix convention; Windows cmd.exe treats '.' as an unknown
    // command ("'.' is not recognized") even with shell:true.  Running the script
    // explicitly with `php` works on every platform and requires no shebang support.
    const rawTestCmd = isLaravel
      ? 'php artisan test'
      : hasPest
        ? 'php vendor/bin/pest'
        : 'php vendor/bin/phpunit';

    return {
      language:    'php',
      framework:   isLaravel ? 'laravel' : 'php',
      testRunner:  hasPest ? 'pest' : 'phpunit',
      rawTestCmd,
      // --ignore-platform-reqs: skip PHP extension checks (ext-mongodb, ext-ftp, etc.).
      // Many repositories include optional adapters as dev-dependencies that need
      // extensions not installed in the audit sandbox.  The tests for those adapters
      // will fail/error individually, but core tests still run and produce diffs.
      installCmds: [['composer', 'install', '--no-interaction', '--prefer-dist', '--ignore-platform-reqs']],
      buildCmds:   [],
      captureNote: 'Level 0 (PHP adapter requires invasive mode — Phase 2)',
    };
  }

  // ── Java / Maven ─────────────────────────────────────────────────────────────
  if (entries.includes('pom.xml')) {
    return {
      language: 'java', framework: 'maven', testRunner: 'junit',
      rawTestCmd:  'mvn test -q',
      installCmds: [],  // mvn downloads deps on demand
      buildCmds:   [],
      captureNote: 'Level 0 (Java adapter M11 not yet built)',
    };
  }

  // ── Java / Gradle ────────────────────────────────────────────────────────────
  if (entries.includes('build.gradle') || entries.includes('build.gradle.kts')) {
    const gradlew = entries.includes('gradlew') ? './gradlew' : 'gradle';
    return {
      language: 'java', framework: 'gradle', testRunner: 'junit',
      rawTestCmd:  `${gradlew} test`,
      installCmds: [],
      buildCmds:   [],
      captureNote: 'Level 0 (Java adapter M11 not yet built)',
    };
  }

  // ── Python ───────────────────────────────────────────────────────────────────
  if (entries.includes('requirements.txt') ||
      entries.includes('pyproject.toml') ||
      entries.includes('setup.py')) {
    const installCmds: string[][] = [];
    if (entries.includes('requirements.txt')) {
      installCmds.push(['pip', 'install', '-r', 'requirements.txt', '-q']);
    } else if (entries.includes('pyproject.toml')) {
      installCmds.push(['pip', 'install', '-e', '.[dev,test]', '-q']);
    }
    return {
      language: 'python', framework: 'python', testRunner: 'pytest',
      rawTestCmd:  'python -m pytest -q',
      installCmds,
      buildCmds:   [],
      captureNote: 'Level 0 (Python adapter M12 not yet built)',
    };
  }

  // ── Go ───────────────────────────────────────────────────────────────────────
  if (entries.includes('go.mod')) {
    return {
      language: 'go', framework: 'go', testRunner: 'go-test',
      rawTestCmd:  'go test ./... -v -count=1',
      installCmds: [['go', 'mod', 'download']],
      buildCmds:   [],
      captureNote: 'Level 0 (Go adapter M14 not yet built)',
    };
  }

  // ── .NET ─────────────────────────────────────────────────────────────────────
  const csproj = entries.find((f) => f.endsWith('.csproj') || f.endsWith('.sln'));
  if (csproj) {
    return {
      language: 'dotnet', framework: 'dotnet', testRunner: 'xunit',
      rawTestCmd:  'dotnet test --no-build',
      installCmds: [['dotnet', 'restore']],
      buildCmds:   [],
      captureNote: 'Level 0 (.NET adapter M13 not yet built)',
    };
  }

  return {
    language: 'unknown', framework: 'unknown', testRunner: null,
    rawTestCmd: '', installCmds: [], buildCmds: [], captureNote: 'Stack not recognised',
  };
}

// ─── Tracegraph instrumentation paths ─────────────────────────────────────────

/**
 * Resolve absolute paths to the tracegraph instrumentation modules from the
 * current installation.  External repos can't install our packages directly
 * (they're not on npm yet), so we inject via absolute file paths.
 */
function resolveTracegraphPaths(): TracegraphPaths {
  const tryResolve = (id: string): string | null => {
    try {
      const p = require.resolve(id);
      return fs.existsSync(p) ? p : null;
    } catch {
      return null;
    }
  };

  // require.resolve uses the CJS 'require' exports condition, giving us the .js file.
  // We also check for a sibling .mjs file (same base name, .mjs extension) which
  // tsup generates alongside the .js file.  The .mjs file is needed for Vitest 2+
  // which loads reporters via ESM import().
  const vitestCjs = tryResolve('@tracegraph/vitest/reporter');
  const vitestMjs = vitestCjs
    ? (() => { const p = vitestCjs.replace(/\.js$/, '.mjs'); return fs.existsSync(p) ? p : null; })()
    : null;

  // ESM hook: resolve @tracegraph/trace-js/register and prefer the .mjs build.
  // Used with --import for Level 4 (ESM module instrumentation alongside Level 3 CJS hook).
  const registerEsmJs  = tryResolve('@tracegraph/trace-js/register');
  const registerEsmMjs = registerEsmJs
    ? (() => { const p = registerEsmJs.replace(/\.js$/, '.mjs'); return fs.existsSync(p) ? p : registerEsmJs; })()
    : null;

  return {
    registerCjs:       tryResolve('@tracegraph/trace-js/register-cjs'),
    registerEsm:       registerEsmMjs,
    vitestReporter:    vitestCjs,
    vitestReporterMjs: vitestMjs,
    jestReporter:      tryResolve('@tracegraph/jest'),
  };
}

/**
 * Extract the major version of a package from a repo's package.json
 * declared dependencies (works before install, no symlink assumptions).
 * e.g. "^4.0.0" → 4, "~1.6.0" → 1, "4.1.5" → 4.
 * Returns null if the package isn't declared or the version can't be parsed.
 */
function declaredMajor(repoDir: string, pkgName: string): number | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const range = { ...raw.dependencies, ...raw.devDependencies }[pkgName] ?? '';
    const m = range.match(/(\d+)/);
    if (!m) return null;
    const n = parseInt(m[1]!, 10);
    return isNaN(n) ? null : n;
  } catch { return null; }
}

// ─── PHP invasive helpers ──────────────────────────────────────────────────────

/**
 * Resolve the absolute path to packages/trace-laravel/src/ relative to the
 * currently-running CLI binary.
 *
 * TG_BIN = .../packages/cli/bin/tracegraph.js
 * Going up two levels from cli/bin/ lands in packages/, then into trace-laravel/src.
 */
function resolvePhpAdapterSrcPath(): string | null {
  const candidate = path.resolve(path.dirname(TG_BIN), '..', '..', 'trace-laravel', 'src');
  return fs.existsSync(path.join(candidate, 'Testing', 'TraceGraphPhpUnitExtension.php'))
    ? candidate
    : null;
}

/**
 * Read the installed PHPUnit major version.
 *
 * Strategy:
 *   1. composer.lock — authoritative; always written by `composer install`.
 *      Entries are under packages[] or packages-dev[]; version is like "9.6.21".
 *   2. vendor/phpunit/phpunit/composer.json — fallback; many packages omit the
 *      `version` field in their own composer.json so this often returns null.
 *
 * Returns null if PHPUnit is not installed or the version cannot be parsed.
 */
function detectPhpUnitMajor(repoDir: string): number | null {
  // 1. composer.lock — most reliable source of installed versions
  try {
    const lockPath = path.join(repoDir, 'composer.lock');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      packages?:       Array<{ name: string; version: string }>;
      'packages-dev'?: Array<{ name: string; version: string }>;
    };
    const allPkgs = [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])];
    const phpunit  = allPkgs.find((p) => p.name === 'phpunit/phpunit');
    if (phpunit?.version) {
      const m = phpunit.version.replace(/^v/, '').match(/^(\d+)/);
      if (m) {
        const n = parseInt(m[1]!, 10);
        if (!isNaN(n)) return n;
      }
    }
  } catch { /* fall through to vendor fallback */ }

  // 2. Fallback: vendor package composer.json (often missing 'version')
  try {
    const composerPath = path.join(repoDir, 'vendor', 'phpunit', 'phpunit', 'composer.json');
    const data = JSON.parse(fs.readFileSync(composerPath, 'utf8')) as { version?: string };
    const m = (data.version ?? '').match(/^(\d+)/);
    if (!m) return null;
    const n = parseInt(m[1]!, 10);
    return isNaN(n) ? null : n;
  } catch { return null; }
}

/**
 * Returns true if the repo uses Pest (which wraps PHPUnit 10/11 and is
 * compatible with our TraceGraphPhpUnitExtension).
 */
function detectPest(repoDir: string): boolean {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(repoDir, 'composer.json'), 'utf8')) as Record<string, unknown>;
    const allDeps = {
      ...(c['require']     as Record<string, string> ?? {}),
      ...(c['require-dev'] as Record<string, string> ?? {}),
    };
    return 'pestphp/pest' in allDeps;
  } catch { return false; }
}

/**
 * Extract the bootstrap= attribute from a phpunit XML string.
 * Returns null if the attribute is not present.
 */
function extractPhpBootstrap(xmlContent: string): string | null {
  const m = xmlContent.match(/\bbootstrap\s*=\s*["']([^"']+)["']/);
  return m ? (m[1] ?? null) : null;
}

/**
 * Inject the TraceGraphPhpUnitExtension into the repo's phpunit.xml.
 *
 * Steps:
 *   1. If phpunit.xml doesn't exist but phpunit.xml.dist does, copy it.
 *   2. Read phpunit.xml; extract the bootstrap= attribute.
 *   3. Write tracegraph-bootstrap.php that chains the original bootstrap
 *      and registers a PSR-4-style autoloader for the Tracegraph\ namespace.
 *   4. Patch phpunit.xml: point bootstrap to tracegraph-bootstrap.php and
 *      add our extension to the <extensions> block.
 *
 * Returns true on success, false on error.
 * Idempotent — running it twice has no additional effect.
 */
function injectPhpUnitExtension(repoDir: string, phpAdapterSrc: string): boolean {
  try {
    const xmlPath  = path.join(repoDir, 'phpunit.xml');
    const distPath = path.join(repoDir, 'phpunit.xml.dist');
    const bootPath = path.join(repoDir, 'tracegraph-bootstrap.php');

    // 1. Ensure phpunit.xml exists
    if (!fs.existsSync(xmlPath)) {
      if (!fs.existsSync(distPath)) {
        warn('No phpunit.xml or phpunit.xml.dist found — cannot inject PHPUnit extension.');
        return false;
      }
      fs.copyFileSync(distPath, xmlPath);
      log('Copied phpunit.xml.dist → phpunit.xml for invasive injection.');
    }

    // Idempotent: already injected?
    let xmlContent = fs.readFileSync(xmlPath, 'utf8');
    if (xmlContent.includes('TraceGraphPhpUnitExtension')) {
      log('PHPUnit extension already present in phpunit.xml (idempotent).');
      return true;
    }

    // 2. Extract original bootstrap path (relative to repo root)
    const originalBootstrap = extractPhpBootstrap(xmlContent);

    // 3. Write our bootstrap chainer
    // PHP strings: '\\' in PHP single-quoted source = one literal backslash.
    // In JS regular strings: '\\\\' → '\\'  which is what PHP source needs.
    const phpAdapterSrcFwd = phpAdapterSrc.replace(/\\/g, '/');
    const originalRequireLine = originalBootstrap
      ? "require_once __DIR__ . '/" + originalBootstrap.replace(/\\/g, '/') + "';"
      : '// No original bootstrap declared in phpunit.xml';

    const bootLines = [
      '<?php',
      '// Auto-generated by tracegraph audit — safe to delete',
      'declare(strict_types=1);',
      originalRequireLine,
      'spl_autoload_register(function (string $class): void {',
      "    if (strncmp($class, 'Tracegraph\\\\', 11) !== 0) return;",
      "    $relative = str_replace(['Tracegraph\\\\Laravel\\\\', '\\\\'], ['', '/'], $class);",
      "    $file = '" + phpAdapterSrcFwd + "/' . $relative . '.php';",
      "    if (file_exists($file)) { require_once $file; }",
      '}, true, true);',
      '',
    ];
    fs.writeFileSync(bootPath, bootLines.join('\n'), 'utf8');

    // 4a. Point phpunit.xml bootstrap to our chainer
    if (originalBootstrap !== null) {
      xmlContent = xmlContent.replace(
        /\bbootstrap\s*=\s*["'][^"']*["']/,
        'bootstrap="tracegraph-bootstrap.php"',
      );
    } else {
      // No existing bootstrap — add the attribute to <phpunit ...>
      xmlContent = xmlContent.replace(/(<phpunit\b)/, '$1 bootstrap="tracegraph-bootstrap.php"');
    }

    // 4b. Add our extension into <extensions> block (or create one)
    const extensionEntry = '<bootstrap class="Tracegraph\\Laravel\\Testing\\TraceGraphPhpUnitExtension"/>';
    if (xmlContent.includes('</extensions>')) {
      // Insert into existing open block
      xmlContent = xmlContent.replace('</extensions>', `    ${extensionEntry}\n    </extensions>`);
    } else if (/<extensions\s*\/>/.test(xmlContent)) {
      // Replace self-closing tag
      xmlContent = xmlContent.replace(
        /<extensions\s*\/>/,
        `<extensions>\n        ${extensionEntry}\n    </extensions>`,
      );
    } else {
      // Add a new block before </phpunit>
      const block = `\n    <extensions>\n        ${extensionEntry}\n    </extensions>`;
      xmlContent  = xmlContent.replace('</phpunit>', `${block}\n</phpunit>`);
    }

    fs.writeFileSync(xmlPath, xmlContent, 'utf8');
    log('Injected TraceGraphPhpUnitExtension into phpunit.xml.');
    return true;
  } catch (err) {
    warn(`PHP invasive injection failed: ${String(err)}`);
    return false;
  }
}

// ─── TypeScript invasive helpers ───────────────────────────────────────────────

/**
 * Find the primary vitest config file in the repo root.
 * Returns the filename (relative), or null if not found.
 */
function findVitestConfig(repoDir: string): string | null {
  const candidates = [
    'vitest.config.ts', 'vitest.config.mts',
    'vitest.config.js', 'vitest.config.mjs',
  ];
  for (const name of candidates) {
    if (fs.existsSync(path.join(repoDir, name))) return name;
  }
  return null;
}

/**
 * Write vitest.config.tracegraph.ts into the repo root.
 *
 * The file uses mergeConfig() to extend the repo's own vitest config with our
 * reporter, without touching any tracked source file.  Vitest processes its
 * own config file using its built-in TypeScript loader, so the import of
 * 'vitest/config' resolves from the repo's node_modules.
 *
 * Run the test suite with: <pm> run <script> -- --config vitest.config.tracegraph.ts
 *
 * Returns true if the file was written successfully.
 */
function writeVitestWrapperConfig(
  repoDir:        string,
  baseConfigFile: string,   // e.g. 'vitest.config.ts'
  reporterPath:   string,   // forward-slash absolute path to .mjs reporter
): boolean {
  try {
    const wrapperPath = path.join(repoDir, 'vitest.config.tracegraph.ts');
    const lines = [
      '// Auto-generated by tracegraph audit — safe to delete',
      "import { mergeConfig } from 'vitest/config';",
      `import base from './${baseConfigFile}';`,
      '',
      'export default mergeConfig(base, {',
      '  test: {',
      `    reporters: ['default', '${reporterPath}'],`,
      '  },',
      '});',
      '',
    ];
    fs.writeFileSync(wrapperPath, lines.join('\n'), 'utf8');
    log(`Wrote vitest.config.tracegraph.ts (extends ${baseConfigFile} + injects reporter).`);
    return true;
  } catch (err) {
    warn(`Failed to write vitest wrapper config: ${String(err)}`);
    return false;
  }
}

// Vitest major versions that our reporter supports.
// The reporter uses duck-typed interfaces and avoids importing from 'vitest'
// directly, so it works with all major versions ≥1.
// Vitest 2+ loads reporters via ESM import() rather than CJS require(), so we
// inject the .mjs file path instead of .js to ensure mod.default is the class.
const SUPPORTED_VITEST_MAJORS = new Set([1, 2, 3, 4]);

/**
 * Build the effective test command and NODE_OPTIONS for the given stack.
 *
 * - Level 3 (CJS hook): set NODE_OPTIONS=--require <registerCjs> for all Node stacks
 * - Level 5 (reporter): append --reporter=<abs-path> for Vitest / Jest, ONLY when the
 *   installed version matches the major our reporter was compiled against.
 *
 * `repoDir` is passed so we can inspect the already-installed node_modules.
 */
function buildInstrumentation(
  stack:   RepoStack,
  tgPaths: TracegraphPaths,
  repoDir: string,
): { testCmd: string[]; nodeOptions: string | null; captureLevel: string } {
  const baseCmd = stack.rawTestCmd.trim().split(/\s+/);
  let testCmd   = baseCmd;
  let nodeOpts  = process.env['NODE_OPTIONS'] ?? '';
  let level     = stack.captureNote;

  // pnpm, npm, and yarn all forward extra flags after the script name directly
  // to the underlying script WITHOUT adding a `--` separator. Using `--` is
  // actually wrong for pnpm v10: `pnpm run test -- --reporter=x` causes pnpm
  // to pass `-- --reporter=x` (with the literal `--`) to the script, and vitest
  // interprets everything after `--` as test-file glob patterns — so `--reporter=x`
  // becomes a file filter that matches nothing, and the reporter never loads.
  // Appending flags directly (`pnpm run test --reporter=x`) is the correct form:
  // pnpm forwards `--reporter=x` to the script as a CLI option.
  // Keep this variable for documentation / future use if a specific case needs it.
  const isPackageManagerScript = ['npm', 'pnpm', 'yarn'].includes(testCmd[0] ?? '')
    && testCmd[1] === 'run';
  void isPackageManagerScript; // intentionally unused — see comment above

  if (stack.language !== 'node') {
    return { testCmd, nodeOptions: null, captureLevel: level };
  }

  // Level 3 — CJS register hook via NODE_OPTIONS (works on all Node.js versions)
  if (tgPaths.registerCjs) {
    // NODE_OPTIONS is parsed as a shell-like string where \ is an escape character.
    // On Windows, paths use backslashes which get eaten (e.g. \t → TAB, \w → w).
    // Use forward slashes — Node.js require() accepts them on all platforms.
    const cjsPath = tgPaths.registerCjs.replace(/\\/g, '/');
    const requireFlag = `--require "${cjsPath}"`;
    nodeOpts = nodeOpts ? `${nodeOpts} ${requireFlag}` : requireFlag;
    level = 'Level 3 (CJS hook — HTTP, Express, external calls)';
  }

  // Level 4 — ESM import hook via NODE_OPTIONS --import is intentionally skipped.
  //
  // --import with an ESM module that contains esbuild's __require shim (CJS-in-ESM
  // interop) triggers a Node.js ESM/CJS loader deadlock on Node.js 20+ when the
  // flag is passed via NODE_OPTIONS to a process that also runs CJS code (pnpm,
  // vitest workers).  The process hangs indefinitely rather than crashing, meaning
  // no tests run and no output is produced.
  //
  // The CJS hook (Level 3) via --require covers HTTP / fetch tracing for both
  // CJS and ESM test files in practice, because vitest's Vite transform pipeline
  // processes all files through CJS require() regardless of their source extension.
  // Level 5 (reporter) is the primary capture mechanism for the audit flow.
  //
  // Re-enable --import once the esbuild __require shim is replaced with a pure-ESM
  // implementation of ChildEventWriter that does not use dynamic require().
  void (tgPaths.registerEsm);  // suppress unused-variable lint

  // Level 5 — reporter injection.
  // Our reporter uses duck-typed interfaces and supports Vitest 1–4.
  //
  // Path choice by version:
  //   Vitest 1.x: loads reporters via CJS require() → inject .js path
  //   Vitest 2+:  loads reporters via ESM import()  → inject .mjs path
  //               (CJS files imported via import() expose module.exports as the
  //               default, not module.exports.default, so new mod.default() fails)
  if (stack.testRunner === 'vitest' && tgPaths.vitestReporter) {
    // Read declared vitest major from the repo's package.json — reliable across
    // all package managers (no symlink assumptions, works before install).
    const vitestMajor = declaredMajor(repoDir, 'vitest');

    // Helper: append reporter flags directly to the test command.
    // pnpm/npm/yarn all forward extra flags after the script name to the underlying
    // script as-is — no `--` separator needed or wanted.
    const appendReporterArgs = (path: string): void => {
      testCmd = [...testCmd, '--reporter=default', `--reporter=${path}`];
    };

    if (vitestMajor != null && SUPPORTED_VITEST_MAJORS.has(vitestMajor)) {
      // Vitest 2+ uses ESM import() for reporters → prefer .mjs for correct default export.
      // Vitest 1.x uses CJS require() → use .js.
      const rawPath = vitestMajor >= 2 && tgPaths.vitestReporterMjs
        ? tgPaths.vitestReporterMjs
        : tgPaths.vitestReporter;
      // Forward slashes required: backslashes in --reporter= paths cause 'not found' errors
      const reporterPath = (rawPath ?? '').replace(/\\/g, '/');
      appendReporterArgs(reporterPath);
      level = `Level 5 (Vitest ${vitestMajor}.x reporter — per-test traces)`;
    } else if (vitestMajor == null) {
      // Version undeclared (unusual) — fall back to .mjs which works with ESM-first Vitest
      const rawPath = tgPaths.vitestReporterMjs ?? tgPaths.vitestReporter;
      const reporterPath = (rawPath ?? '').replace(/\\/g, '/');
      appendReporterArgs(reporterPath);
      level = 'Level 5 (Vitest reporter — version undeclared, injecting ESM reporter)';
    } else {
      // Major is known but outside our tested range (e.g. future v5+).
      // Attempt injection with the .mjs reporter anyway — our duck-typed reporter
      // is forward-compatible but we warn the user in case of unexpected breakage.
      const rawPath = tgPaths.vitestReporterMjs ?? tgPaths.vitestReporter;
      const reporterPath = (rawPath ?? '').replace(/\\/g, '/');
      warn(
        `Vitest ${vitestMajor}.x detected — reporter tested against v1–4.\n` +
        `  Injecting reporter anyway (duck-typed, likely forward-compatible).\n` +
        `  If tests fail to start, rerun with TRACEGRAPH_NO_INJECT=1 to skip reporter.`,
      );
      appendReporterArgs(reporterPath);
      level = `Level 5 (Vitest ${vitestMajor}.x reporter — untested version, injected)`;
    }
  } else if (stack.testRunner === 'jest' && tgPaths.jestReporter) {
    const jestPath = tgPaths.jestReporter.replace(/\\/g, '/');
    testCmd = [...testCmd, '--reporters=default', `--reporters=${jestPath}`];
    level = 'Level 5 (Jest reporter — per-test traces)';
  }

  // Mocha: inject --exit so the process calls process.exit() when all tests finish.
  // Without this, supertest's HTTP keep-alive sockets prevent the event loop from
  // draining naturally, causing the process to hang indefinitely after the test
  // summary is printed.
  //
  // npm and yarn require `--` to forward extra args through `npm run` / `yarn run`
  // to the underlying script.  pnpm forwards extra args directly (no separator).
  // Direct invocations (npx mocha, bare binary path) also need no separator.
  if (stack.testRunner === 'mocha') {
    const needsSeparator = testCmd[0] === 'npm' || testCmd[0] === 'yarn';
    testCmd = needsSeparator
      ? [...testCmd, '--', '--exit']
      : [...testCmd, '--exit'];
    log('Mocha detected — adding --exit to force process exit after tests.');
  }

  return {
    testCmd,
    nodeOptions: nodeOpts || null,
    captureLevel: level,
  };
}

// ─── Process / git helpers ────────────────────────────────────────────────────

/**
 * Returns true when the current process is running inside WSL (Windows Subsystem
 * for Linux).  Used to give WSL-specific guidance when a Windows-only tool (PHP,
 * Composer) is not found in the Linux PATH.
 */
function isWsl(): boolean {
  try {
    const v = fs.readFileSync('/proc/version', 'utf8');
    return /microsoft|wsl/i.test(v);
  } catch { return false; }
}

function log(msg: string): void {
  process.stdout.write(`[tracegraph audit] ${msg}\n`);
}

function warn(msg: string): void {
  process.stderr.write(`[tracegraph audit] ⚠  ${msg}\n`);
}

/**
 * Run an external command synchronously, streaming stdio to the terminal.
 * Returns the exit code.
 */
function run(
  cmd:     string[],
  cwd:     string,
  opts?:   { env?: Record<string, string>; timeoutMs?: number; silent?: boolean },
): number {
  const [bin, ...args] = cmd;
  if (!bin) return 1;
  const result = spawnSync(bin, args, {
    cwd,
    stdio:   opts?.silent ? 'pipe' : 'inherit',
    env:     opts?.env ?? (process.env as Record<string, string>),
    timeout: opts?.timeoutMs,
    shell:   process.platform === 'win32',  // needed on Windows for npm.cmd etc.
  });
  return result.status ?? 1;
}

/**
 * Run tracegraph as a subprocess with cwd set to the audit workspace.
 * Passes TRACEGRAPH_NO_INJECT=1 so run.ts skips its own reporter injection
 * (we have already injected via absolute paths in testCmd).
 */
/** Sentinel exit code returned by runTracegraph when the subprocess timed out. */
export const EXIT_TIMEOUT = 124;

function runTracegraph(
  args:      string[],
  cwd:       string,
  extraEnv?: Record<string, string>,
  timeoutMs = 600_000,  // 10 minutes — Express test suites with HTTP capture can be slow
): number {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TRACEGRAPH_NO_INJECT: '1',
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, [TG_BIN, ...args], {
    cwd,
    stdio:   'inherit',
    env,
    timeout: timeoutMs,
    shell:   false,
  });
  // Distinguish timeout (signal, status null) from normal non-zero exit
  if (result.signal === 'SIGTERM' && result.status == null) {
    process.stderr.write(
      `[tracegraph audit] ⚠  Command timed out after ${timeoutMs / 1000}s: ${args.join(' ')}\n` +
      `  Increase --timeout (default ${timeoutMs / 1000}s) if the test suite needs more time.\n`,
    );
    return EXIT_TIMEOUT;
  }
  return result.status ?? 1;
}

/**
 * G19: Like `runTracegraph` but TEEs stdout+stderr to a temp file while still
 * streaming them to the terminal in real-time.  Returns the exit code AND the
 * captured combined output for post-run analysis (e.g. boot-error extraction).
 *
 * On Unix/Linux (the primary deployment platform): uses `bash -c "... 2>&1 | tee FILE;
 * exit ${PIPESTATUS[0]}"` so the first command's exit code is preserved.
 *
 * On Windows: falls back to spawnSync with stdio:pipe — output appears all at once
 * after the run completes (acceptable since Windows is not a primary target).
 */
function runTracegraphCapturing(
  args:      string[],
  cwd:       string,
  extraEnv?: Record<string, string>,
  timeoutMs = 600_000,
): { status: number; captured: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TRACEGRAPH_NO_INJECT: '1',
    ...extraEnv,
  };

  if (process.platform !== 'win32') {
    // Unix: tee-based real-time capture
    const tmpFile = path.join(os.tmpdir(), `tg_capture_${Date.now()}.txt`);
    // Escape each argument for shell inclusion
    const shellArgs = [process.execPath, TG_BIN, ...args]
      .map((a) => `"${a.replace(/"/g, '\\"')}"`)
      .join(' ');
    const cmd = `${shellArgs} 2>&1 | tee "${tmpFile}"; exit \${PIPESTATUS[0]}`;
    const result = spawnSync(cmd, [], {
      cwd,
      stdio:   'inherit',
      env,
      timeout: timeoutMs,
      shell:   '/bin/bash',
    });
    let captured = '';
    try {
      captured = fs.readFileSync(tmpFile, 'utf8');
      fs.unlinkSync(tmpFile);
    } catch { /* temp file missing is non-fatal */ }
    if (result.signal === 'SIGTERM' && result.status == null) {
      process.stderr.write(
        `[tracegraph audit] ⚠  Command timed out after ${timeoutMs / 1000}s: ${args.join(' ')}\n`,
      );
      return { status: EXIT_TIMEOUT, captured };
    }
    return { status: result.status ?? 1, captured };
  } else {
    // Windows fallback: capture stdio, display after run
    const result = spawnSync(process.execPath, [TG_BIN, ...args], {
      cwd,
      stdio:    ['inherit', 'pipe', 'pipe'],
      env,
      timeout:  timeoutMs,
      encoding: 'utf8',
      shell:    false,
    });
    const captured = ((result.stdout as string | null) ?? '') + ((result.stderr as string | null) ?? '');
    if (result.stdout) process.stdout.write(result.stdout as string);
    if (result.stderr) process.stderr.write(result.stderr as string);
    if (result.signal === 'SIGTERM' && result.status == null) {
      process.stderr.write(
        `[tracegraph audit] ⚠  Command timed out after ${timeoutMs / 1000}s: ${args.join(' ')}\n`,
      );
      return { status: EXIT_TIMEOUT, captured };
    }
    return { status: result.status ?? 1, captured };
  }
}

/**
 * G19: Extract the first meaningful boot/startup error from captured test-run
 * output.  Returns the error message as a single string, or null if no
 * recognisable error pattern is found.
 *
 * Patterns recognised:
 *   PHP artisan:   "In <file> line <n>:\n\n  <message>"
 *   PHP fatal:     "PHP Fatal error:  <message>"
 *   PHP exception: "  [<ExceptionType>]\n  <message>"
 *   Node.js:       "Error: <message>"  /  "Cannot find module '<name>'"
 *   Python:        "ModuleNotFoundError: ..."  / traceback last line
 *   Ruby:          "<file>:<n>:in `...': <message>"
 */
function extractBootError(output: string): string | null {
  const lines = output.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // ── PHP artisan "In <file> line <n>:" error block ─────────────────────────
    // The error message appears 1–2 lines after the "In X line N:" header.
    if (/^\s*In .+ line \d+:/.test(line)) {
      // Skip blank lines to reach the message
      let msg = '';
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const candidate = (lines[j] ?? '').trim();
        if (candidate) { msg = candidate; break; }
      }
      if (msg) return msg;
    }

    // ── PHP Fatal / Parse error ────────────────────────────────────────────────
    const phpFatal = line.match(/PHP (?:Fatal|Parse) error:\s+(.+)/);
    if (phpFatal) return phpFatal[1]!.trim();

    // ── PHP artisan exception box "[SomeException]\n  message" ────────────────
    const phpExBox = line.match(/^\s+\[(\w+(?:Exception|Error))\]\s*$/);
    if (phpExBox) {
      const nextLine = lines[i + 1]?.trim() ?? '';
      if (nextLine) return `${phpExBox[1]}: ${nextLine}`;
    }

    // ── Node.js "Error: ..." or "Cannot find module" ──────────────────────────
    const nodeErr = line.match(/^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError): (.+)/);
    if (nodeErr) return line.trim();

    const nodeModule = line.match(/Cannot find module '([^']+)'/);
    if (nodeModule) return line.trim();

    // ── Python ────────────────────────────────────────────────────────────────
    const pyErr = line.match(/^(ModuleNotFoundError|ImportError|SyntaxError|RuntimeError): (.+)/);
    if (pyErr) return line.trim();

    // ── Ruby ─────────────────────────────────────────────────────────────────
    const rbErr = line.match(/:.+:in `.+': (.+) \(\w+Error\)/);
    if (rbErr) return line.trim().slice(0, 200);
  }

  return null;
}

function gitCmd(args: string[], cwd: string): { ok: boolean; out: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout:  60_000,
    shell:    process.platform === 'win32',
  });
  return { ok: result.status === 0, out: (result.stdout ?? '') + (result.stderr ?? '') };
}

// ─── Graphifyignore constants ─────────────────────────────────────────────────

/**
 * Minimal .graphifyignore written before EVERY graphify run during an audit.
 *
 * Must always exclude .tracegraph/ — by Phase B, this directory contains
 * baselines, trace files, graph index JSON, and other audit artifacts.
 * Graphify will parse JSON files (tree-sitter can extract keys as symbols),
 * creating hundreds of false nodes from TraceGraph's own output.
 * node_modules/ and vendor/ (Composer) are always excluded — third-party
 * packages are noise-only and scanning them can cause timeout on large repos.
 */
const BASE_GRAPHIFYIGNORE = `# Auto-generated by TraceGraph audit — safe to delete.
# Excludes TraceGraph's own output directories from graphify scanning.
.tracegraph/
graphify-out/
node_modules/
vendor/
`;

/**
 * Full code-only .graphifyignore written when `graph build` fails because
 * non-code files (docs, images, YAML, HTML…) require an LLM API key.
 * Replaces the BASE_GRAPHIFYIGNORE on retry so graphify runs on source only
 * (tree-sitter, no key needed).
 * Includes all BASE_GRAPHIFYIGNORE exclusions.
 */
const CODE_ONLY_GRAPHIFYIGNORE = `# Auto-generated by TraceGraph — code-only mode (no API key available).
# Excludes non-code files so Graphify can run without an LLM backend.
# Delete this file and set ANTHROPIC_API_KEY (or GEMINI_API_KEY) to include docs.

# ── TraceGraph output directories (always excluded) ───────────────────────────
.tracegraph/
graphify-out/
node_modules/

# ── Docs / text ───────────────────────────────────────────────────────────────
*.md
*.markdown
*.txt
*.rst
*.adoc
*.asciidoc

# ── HTML & templates (Graphify docs category) ─────────────────────────────────
*.html
*.htm
*.xhtml
*.ejs
*.pug
*.jade
*.hbs
*.handlebars
*.mustache
*.njk
*.jinja
*.jinja2
*.twig

# ── YAML / XML / SVG (Graphify docs category) ─────────────────────────────────
*.yaml
*.yml
*.xml
*.svg

# ── Stylesheets ───────────────────────────────────────────────────────────────
*.css
*.scss
*.sass
*.less
*.styl

# ── PDFs and office docs ──────────────────────────────────────────────────────
*.pdf
*.docx
*.pptx
*.xlsx
*.odt
*.ods
*.odp
*.pages
*.numbers
*.key
*.epub

# ── Images ────────────────────────────────────────────────────────────────────
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.ico
*.bmp
*.tiff
*.tif
*.avif
*.heic
*.eps
*.psd
*.ai

# ── Audio / video ─────────────────────────────────────────────────────────────
*.mp4
*.mp3
*.wav
*.mov
*.avi
*.mkv
*.webm
*.ogg
*.flac
*.m4a

# ── MDX / rich-text formats ──────────────────────────────────────────────────
*.mdx
*.tex
*.bib
*.ipynb

# ── Config / schema formats that graphify may classify as docs ────────────────
*.toml
*.graphql
*.gql
*.lock
*.snap
*.map

# ── Common no-extension documentation files ───────────────────────────────────
LICENSE
LICENCE
CHANGELOG
AUTHORS
NOTICE
COPYING
CONTRIBUTING
ROADMAP
SECURITY
CODEOWNERS

# ── Common non-code directories ───────────────────────────────────────────────
docs/
documentation/
doc/
papers/
assets/
images/
media/
static/
.github/

# ── Laravel / PHP-specific ────────────────────────────────────────────────────
# vendor/           — Composer third-party packages (same as node_modules/).
#   Can contain thousands of PHP files; scanning them causes timeouts and adds
#   noise.  Always excluded — already in BASE_GRAPHIFYIGNORE but listed here
#   for clarity when this file replaces it.
vendor/
# resources/views/  — Blade templates (*.blade.php): tree-sitter parses them as
#   PHP but Graphify may classify them as HTML/doc files requiring semantic
#   extraction.  Exclude the entire views directory in code-only mode.
resources/views/
# lang/             — Translation strings (PHP arrays / JSON).  No business
#   logic; thousands of string constants add noise to the graph.
lang/
# public/           — Front-end compiled assets, images, favicons, etc.
public/
# storage/          — Laravel logs, cached blade views, uploaded user files.
storage/
# bootstrap/cache/  — Compiled config/route caches, not source code.
bootstrap/cache/
`.trimStart();

/**
 * Reads the actual capture-level.json from the most-recently-written run
 * directory under `.tracegraph/runs/`.  Returns a display string like
 * "Level 5 — PHPUnit extension (per-test traces + test structure + results)"
 * or null if nothing is found.
 *
 * Call this after `tracegraph run` completes so the audit summary reflects
 * what was *actually* captured rather than the pre-run configured level.
 */
function readActualCaptureLevel(repoDir: string): string | null {
  // ── Primary path: runs/<runId>/capture-level.json ────────────────────────
  // Written by the reporter when the test suite completes normally.
  const runsDir = path.join(repoDir, '.tracegraph', 'runs');
  if (fs.existsSync(runsDir)) {
    let latestMtime = -1;
    let latestRun   = '';
    try {
      for (const entry of fs.readdirSync(runsDir)) {
        const full = path.join(runsDir, entry);
        if (!fs.statSync(full).isDirectory()) continue;
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime > latestMtime) { latestMtime = mtime; latestRun = full; }
      }
    } catch { /* fall through to trace-file fallback */ }

    if (latestRun) {
      const clPath = path.join(latestRun, 'capture-level.json');
      if (fs.existsSync(clPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(clPath, 'utf8')) as { overall?: number; label?: string };
          if (typeof data.overall === 'number') {
            const label = data.label ? ` — ${data.label}` : '';
            return `Level ${data.overall}${label}`;
          }
        } catch { /* fall through */ }
      }
    }
  }

  // ── Fallback: read captureLevel from the most recent trace file ───────────
  // capture-level.json is only written when the PHPUnit/Jest extension runs to
  // completion.  When tests fail at bootstrap (0 assertions, DB errors, etc.)
  // the extension never fires its finished-subscriber, so the file is absent.
  // The trace file itself always records the achieved captureLevel because the
  // CLI finalises it regardless of how the test process exits.
  const tracesDir = path.join(repoDir, '.tracegraph', 'traces');
  if (!fs.existsSync(tracesDir)) return null;

  let latestTraceMtime = -1;
  let latestTraceFile  = '';
  try {
    for (const f of fs.readdirSync(tracesDir)) {
      if (!f.endsWith('.trace.json')) continue;
      const full  = path.join(tracesDir, f);
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > latestTraceMtime) { latestTraceMtime = mtime; latestTraceFile = full; }
    }
  } catch { return null; }
  if (!latestTraceFile) return null;

  try {
    const data = JSON.parse(fs.readFileSync(latestTraceFile, 'utf8')) as {
      captureLevel?: { overall?: number; label?: string };
    };
    const cl = data.captureLevel;
    if (!cl || typeof cl.overall !== 'number') return null;
    const label = cl.label ? ` — ${cl.label}` : '';
    return `Level ${cl.overall}${label}`;
  } catch { return null; }
}

/**
 * Run `tracegraph graph build --quiet` with automatic code-only retry.
 *
 * If the first attempt fails because non-code files require an LLM API key,
 * this function:
 *   1. Writes a temporary .graphifyignore excluding all doc/image types
 *   2. Clears graphify-out/ (Graphify's SHA256 file cache) so it rescans
 *   3. Retries graph build — succeeds with code files only
 *   4. Removes the temporary .graphifyignore
 *
 * Returns true if graph build succeeded (either attempt).
 */
function runGraphBuild(
  repoDir:   string,
  extraEnv:  Record<string, string>,
  timeoutMs: number,
  log:       (s: string) => void,
  warn:      (s: string) => void,
): boolean {
  // Static graph builds are I/O-bound tree-sitter passes over all source files.
  // Large repos (invoiceninja, akaunting) regularly need 5–10 minutes.
  // Use the larger of the user's --timeout or a 600s floor so the graph build
  // isn't killed by a short timeout set for the test phase.
  const graphBuildTimeoutMs = Math.max(timeoutMs, 600_000);

  const ignorePath     = path.join(repoDir, '.graphifyignore');
  const hadIgnore      = fs.existsSync(ignorePath);
  const graphifyOutDir = path.join(repoDir, 'graphify-out');

  // ── Write base .graphifyignore before every first attempt ─────────────────
  // Always exclude .tracegraph/ so graphify never scans our JSON artifacts
  // (baselines, trace files, graph index) as source code.  This is critical
  // for Phase B runs where .tracegraph/ is fully populated from Phase A.
  if (!hadIgnore) {
    fs.writeFileSync(ignorePath, BASE_GRAPHIFYIGNORE, 'utf8');
  }

  // ── First attempt ──────────────────────────────────────────────────────────
  const firstExit = runTracegraph(['graph', 'build', '--quiet'], repoDir, extraEnv, graphBuildTimeoutMs);

  if (firstExit === 0) {
    // Remove the temp ignore — leave user's own .graphifyignore untouched.
    if (!hadIgnore) {
      try { fs.unlinkSync(ignorePath); } catch { /* non-fatal */ }
    }
    return true;
  }

  // ── Retry: expand to full code-only ignore + clear stale cache ────────────
  warn('Graph build failed — retrying in code-only mode (excluding non-code files)...');

  // Always write CODE_ONLY_GRAPHIFYIGNORE for the retry — even when the repo
  // already has its own .graphifyignore.  That file is what caused the first
  // attempt to fail (its exclusions weren't broad enough to skip all the
  // doc/image files that require an LLM key).  Save the original and restore
  // it after the retry so future graph build runs aren't affected.
  let savedIgnore: string | null = null;
  if (hadIgnore) {
    try { savedIgnore = fs.readFileSync(ignorePath, 'utf8'); } catch { /* best-effort */ }
  }
  fs.writeFileSync(ignorePath, CODE_ONLY_GRAPHIFYIGNORE, 'utf8');

  // Clear Graphify's SHA256 file cache so it rescans with the new ignore rules.
  if (fs.existsSync(graphifyOutDir)) {
    try { fs.rmSync(graphifyOutDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }

  const retryExit = runTracegraph(['graph', 'build', '--quiet'], repoDir, extraEnv, graphBuildTimeoutMs);

  // Restore original .graphifyignore (or remove the temp file we wrote).
  if (hadIgnore && savedIgnore !== null) {
    try { fs.writeFileSync(ignorePath, savedIgnore, 'utf8'); } catch { /* best-effort */ }
  } else if (!hadIgnore) {
    try { fs.unlinkSync(ignorePath); } catch { /* non-fatal */ }
  }

  if (retryExit === 0) {
    log('Static graph built (code files only — set an API key env var to include docs).');
    return true;
  }

  // ── Diagnostic: find graph.json anywhere in the repo ─────────────────────
  // The retry exited non-zero.  Search shallow (depth 4, skip node_modules)
  // to find where (if anywhere) Graphify actually wrote graph.json.
  const graphJsonFound = findFileShallow(repoDir, 'graph.json', 4);
  if (graphJsonFound) {
    warn(`graph.json found at unexpected path: ${graphJsonFound}`);
    warn('Set staticGraph.buildCommand in tracegraph.config.json to target that directory.');
  } else {
    warn('graph.json not found anywhere in the repo after retry — graphify produced no output.');
    // Show what is in graphify-out/ if it was created
    const gOut = path.join(repoDir, 'graphify-out');
    if (fs.existsSync(gOut)) {
      const contents = (() => { try { return fs.readdirSync(gOut).join(', '); } catch { return '(unreadable)'; } })();
      warn(`graphify-out/ exists but contains: ${contents || '(empty)'}`);
    } else {
      warn('graphify-out/ was not created — graphify may have found no processable files.');
    }
  }

  return false;
}

/** Recursively search for a file, skipping node_modules/.git/.tracegraph. Max depth. */
function findFileShallow(dir: string, name: string, depth: number): string | null {
  if (depth <= 0) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name === name) return path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git' && e.name !== '.tracegraph') {
        const found = findFileShallow(path.join(dir, e.name), name, depth - 1);
        if (found) return found;
      }
    }
  } catch { /* permission error etc */ }
  return null;
}

function hasTraces(repoDir: string): boolean {
  const tracesDir = path.join(repoDir, '.tracegraph', 'traces');
  if (!fs.existsSync(tracesDir)) return false;
  return fs.readdirSync(tracesDir).some((f) => f.endsWith('.trace.json'));
}

/**
 * Like `runTracegraph` but captures stdout (stderr still flows to terminal).
 * Used to capture `--json` output from sub-commands while still showing
 * human-readable stderr output to the user.
 */
function captureTracegraph(
  args:      string[],
  cwd:       string,
  extraEnv?: Record<string, string>,
  timeoutMs = 60_000,
): { status: number; stdout: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TRACEGRAPH_NO_INJECT: '1',
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, [TG_BIN, ...args], {
    cwd,
    stdio:    ['inherit', 'pipe', 'inherit'],
    env,
    timeout:  timeoutMs,
    encoding: 'utf8',
    shell:    false,
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout as string | null) ?? '',
  };
}

/**
 * Read static graph metadata counts from the repo's .tracegraph/static-graph/
 * directory after a successful `graph build`.
 */
function readGraphMeta(repoDir: string): {
  nodeCount: number; edgeCount: number; communityCount: number; godNodeCount: number;
  runtimeEdgeCount?: number;
} | null {
  try {
    const p = path.join(repoDir, '.tracegraph', 'static-graph', 'graph_metadata.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      nodeCount: number; edgeCount: number; communityCount: number; godNodeCount: number;
      runtimeEdgeCount?: number;
    };
    return raw;
  } catch { return null; }
}

// ─── Phase 2: runtime call-edge collection ─────────────────────────────────────

/**
 * Read `call_edges.json` from the most recently modified run directory under
 * `.tracegraph/runs/`.  Call this immediately after each `tracegraph run`
 * invocation — at that point the newest run dir is the one we just created.
 *
 * Returns an empty array when Phase 2 was not active (no call_edges.json)
 * or when the run directory cannot be found.
 */
function collectCallEdgesFromLatestRun(
  repoDir: string,
): Array<{ caller: string; callee: string }> {
  const runsDir = path.join(repoDir, '.tracegraph', 'runs');
  if (!fs.existsSync(runsDir)) return [];

  let latestMtime = -1;
  let latestRun   = '';
  try {
    for (const entry of fs.readdirSync(runsDir)) {
      const full = path.join(runsDir, entry);
      if (!fs.statSync(full).isDirectory()) continue;
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > latestMtime) { latestMtime = mtime; latestRun = full; }
    }
  } catch { return []; }

  if (!latestRun) return [];

  const edgesPath = path.join(latestRun, 'call_edges.json');
  if (!fs.existsSync(edgesPath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(edgesPath, 'utf8')) as Array<{
      caller: string;
      callee: string;
    }>;
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

/**
 * Resolve accumulated raw PHP call edges (caller/callee FQN pairs) through the
 * GraphIndex and write the resolved NormalizedEdge array to
 * `.tracegraph/static-graph/runtime_call_edges.json`.
 *
 * Also patches `graph_metadata.json` with `runtimeEdgeCount` so compare.ts
 * can know how many runtime edges were resolved without re-reading the file.
 *
 * No-ops (with a logged warning) when the graph index cannot be loaded.
 */
function writeRuntimeCallEdgesIfAny(
  repoDir:   string,
  rawEdges:  Array<{ caller: string; callee: string }>,
  log:       (msg: string) => void,
  warn:      (msg: string) => void,
): void {
  if (rawEdges.length === 0) return;

  const graphIndex = loadOrRebuildGraphIndex(repoDir);
  if (!graphIndex) {
    warn('Phase 2: graph index not available — runtime call edges will not be resolved.');
    return;
  }

  const result = importRuntimeCallEdges(rawEdges, graphIndex);

  if (result.edges.length === 0) {
    warn(
      `Phase 2: ${rawEdges.length} raw call edges collected but 0 resolved to graph nodes.\n` +
      `  Unmatched: ${result.unmatchedCount}. ` +
      `  This usually means graphify used different FQN formats than debug_backtrace() produces.\n` +
      `  Check that graphify extracted method-level nodes (not file-level only).`,
    );
    return;
  }

  // Write runtime_call_edges.json
  const outPath = runtimeCallEdgesPath(repoDir);
  try {
    fs.writeFileSync(
      outPath,
      JSON.stringify(result.edges, null, 2) + '\n',
      'utf8',
    );
    log(
      `Phase 2: ${result.edges.length} runtime call edges resolved ` +
      `(${result.unmatchedCount} unmatched) → ${path.relative(repoDir, outPath)}`,
    );
  } catch (err) {
    warn(`Phase 2: failed to write runtime_call_edges.json: ${String(err)}`);
    return;
  }

  // Patch graph_metadata.json with runtimeEdgeCount
  try {
    const metaPath = graphMetadataPath(repoDir);
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      meta['runtimeEdgeCount'] = result.edges.length;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    }
  } catch (err) {
    warn(`Phase 2: failed to patch graph_metadata.json with runtimeEdgeCount: ${String(err)}`);
  }
}

// ─── Main command ─────────────────────────────────────────────────────────────

export async function auditCommand(
  githubUrl: string,
  opts:      AuditOptions,
): Promise<number> {
  const timeoutMs = (opts.timeout ?? 300) * 1000;

  // ── 1. Parse the GitHub URL ──────────────────────────────────────────────────
  const urlMatch = githubUrl.match(
    /github\.com[/:](?<owner>[^/]+)\/(?<repo>[^/.]+?)(?:\.git)?(?:[/#?]|$)/,
  );
  if (!urlMatch?.groups) {
    process.stderr.write(
      '[tracegraph audit] Invalid GitHub URL.\n' +
      '  Expected: https://github.com/<owner>/<repo>\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }
  let { owner, repo } = urlMatch.groups as { owner: string; repo: string };
  log(`Target: ${owner}/${repo}`);

  // ── 2. Resolve GitHub token ──────────────────────────────────────────────────
  const token = resolveToken(opts.token);
  if (!token) {
    warn(
      'No GitHub token found — rate limits apply (60 req/hr) and forking is disabled.\n' +
      '  Set $GITHUB_TOKEN or pass --token <pat> for fork support.',
    );
  }

  // ── 2.5. Canonicalize repo — follow any ownership transfers ──────────────────
  // GitHub returns 301 when a repo has been transferred to a new owner.
  // Resolve the canonical owner/repo now so all subsequent API calls and
  // git operations use the correct location.
  try {
    const meta = await githubRequest<{ full_name?: string; clone_url?: string }>(
      'GET', `/repos/${owner}/${repo}`, token,
    );
    if (meta?.full_name && meta.full_name !== `${owner}/${repo}`) {
      const [newOwner, newRepo] = meta.full_name.split('/');
      if (newOwner && newRepo) {
        log(`Repo transferred: ${owner}/${repo} → ${meta.full_name}`);
        owner = newOwner;
        repo  = newRepo;
      }
    }
  } catch {
    // Non-fatal — continue with the original owner/repo
  }

  // ── 3. Fetch and select a PR ──────────────────────────────────────────────────
  log('Fetching open pull requests...');
  let prs: GhPR[] = [];
  try {
    prs = await fetchOpenPRs(owner, repo, token);
  } catch (err) {
    process.stderr.write(`[tracegraph audit] Failed to fetch PRs: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }
  log(`Found ${prs.length} open PR(s).`);

  if (prs.length === 0 && opts.pr == null) {
    warn(
      'No open PRs returned. If this repo has open PRs, your token may be missing scope.\n' +
      '  Fine-grained PATs need "Pull requests: Read" — check:\n' +
      '  github.com → Settings → Developer settings → Fine-grained tokens → your token',
    );
  }

  const selectedPR = await selectPR(owner, repo, prs, opts, token);
  if (!selectedPR) {
    process.stderr.write('[tracegraph audit] No eligible PRs found.\n');
    return EXIT_CODES.CLI_ERROR;
  }
  log(`Selected PR #${selectedPR.number}: "${selectedPR.title}" (score ${selectedPR.score}/6)`);
  log(`  Signals: ${selectedPR.signals.join(', ') || 'none'}`);
  log(`  Base branch: ${selectedPR.base?.ref ?? 'unknown'}`);

  // ── 4. Set up workspace ────────────────────────────────────────────────────
  const workspaceBase = opts.workspace
    ? path.resolve(opts.workspace)
    : path.join(os.homedir(), '.tracegraph', 'audits');
  const workspaceDir = path.join(workspaceBase, `${owner}__${repo}__pr${selectedPR.number}`);

  if (fs.existsSync(workspaceDir)) {
    warn(`Workspace already exists: ${workspaceDir}`);
    warn('Delete it to start fresh, or use --workspace to choose a different directory.');
    return EXIT_CODES.CLI_ERROR;
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  log(`Workspace: ${workspaceDir}`);

  // ── 5. Fork (optional) ────────────────────────────────────────────────────────
  let cloneUrl = `https://github.com/${owner}/${repo}.git`;

  if (!opts.skipFork && token) {
    log(`Forking ${owner}/${repo} to your account...`);
    try {
      const fork = await forkRepo(owner, repo, token);
      cloneUrl = fork.cloneUrl;
      log(`Fork created: ${fork.fullName}`);
      // GitHub needs a few seconds to replicate the fork before it's cloneable
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      warn(`Fork failed (${String(err)}). Cloning upstream instead.`);
    }
  } else if (!token) {
    log('Cloning upstream directly (no token → forking skipped).');
  } else {
    log('--skip-fork: cloning upstream directly.');
  }

  // ── 6. Clone ────────────────────────────────────────────────────────────────
  const repoDir = path.join(workspaceDir, repo);
  log(`Cloning ${cloneUrl}...`);
  let cloneOk = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      log(`Clone attempt ${attempt}/3 (retrying after network interruption)...`);
      await new Promise((r) => setTimeout(r, 5_000));
      // Remove the partial clone directory before retrying
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const depth = attempt === 1 ? 50 : 1;
    const cloneResult = run(
      ['git', 'clone', `--depth=${depth}`, cloneUrl, repoDir],
      workspaceDir,
      { timeoutMs: 180_000 },
    );
    if (cloneResult === 0) { cloneOk = true; break; }
    warn(`git clone failed (attempt ${attempt}/3).`);
  }
  if (!cloneOk) {
    process.stderr.write('[tracegraph audit] git clone failed after 3 attempts.\n');
    return EXIT_CODES.CLI_ERROR;
  }

  // Add upstream remote when we cloned a fork
  if (cloneUrl !== `https://github.com/${owner}/${repo}.git`) {
    gitCmd(['remote', 'add', 'upstream', `https://github.com/${owner}/${repo}.git`], repoDir);
    log('Added upstream remote.');
  }

  // ── 7. Detect stack ──────────────────────────────────────────────────────────
  const stack = detectStack(repoDir);
  log(`Stack detected: ${stack.language}/${stack.framework}  test runner: ${stack.testRunner ?? 'unknown'}`);
  log(`Test command: ${stack.rawTestCmd || '(none detected)'}`);

  // ── G-series state — detect Graphify BEFORE abort decisions ──────────────
  // When Graphify is available, a failing install or missing test suite degrades
  // to static-only mode (A0 → B → D1) rather than aborting the audit entirely.
  let graphifyAvailable = false;
  let graphBuildBaseOk  = false;
  let archBaselineOk    = false;
  let graphBuildPrOk    = false;
  let graphMeta: { nodeCount: number; edgeCount: number; communityCount: number; godNodeCount: number; runtimeEdgeCount?: number } | null = null;
  let archDiffResult: {
    totalChanges: number; hasCriticalChanges: boolean; newCrossEdges: number; newGodNodes: number;
    /** Edge count in the current (PR-branch) graph. 0 = A1 quality. */
    currentEdgeCount: number;
    /** G15: Node count of the base-branch graph for base→PR comparison in the banner. */
    baselineNodeCount: number;
  } | null = null;
  // G14: test run exit codes — lifted to outer scope so banner + pr-context can read them
  let baselineRunCode = 0;
  let prRunCode       = 0;
  // G19: captured output from the PR run (for boot-error extraction); null until set
  let prRunCaptured: string | null = null;
  // Phase 2: accumulated raw PHP call edges from all test runs (base + PR branch).
  // Each entry is a {caller, callee} FQN pair collected from debug_backtrace().
  // Resolved to NormalizedEdge objects and written to runtime_call_edges.json
  // after Phase C (before compare).
  const accumulatedCallEdges: Array<{ caller: string; callee: string }> = [];

  if (!opts.skipGraph) {
    const gDetect = detectGraphify();
    graphifyAvailable = gDetect.found;
    if (graphifyAvailable) {
      log(`Graphify ${gDetect.version ?? '(version unknown)'} detected — architecture analysis enabled`);
    } else {
      log('Graphify not found — architecture analysis skipped  (install: uv tool install graphifyy)');
    }
  }

  // ── Testing availability ──────────────────────────────────────────────────
  // testingAvailable=false → Phases A/C/D are skipped; A0/B/D1 still run.
  // Set to false when there is no test infrastructure but Graphify can still
  // deliver static architecture value (install fails, no test script, etc.).
  let testingAvailable  = true;
  let testingSkipReason = '';

  if (stack.language === 'unknown') {
    if (!graphifyAvailable) {
      warn('Unrecognised project stack. Cannot run tests without a known test command.');
      return EXIT_CODES.CLI_ERROR;
    }
    testingAvailable  = false;
    testingSkipReason = 'unrecognised project stack';
    warn('Unrecognised project stack — runtime analysis skipped. Static architecture analysis will continue.');
  }

  if (!stack.rawTestCmd && testingAvailable) {
    if (!graphifyAvailable) {
      warn(
        'No self-contained test script found in this repository.\n' +
        '  The audit command requires a test suite that:\n' +
        '    ✓  Runs without a live database, browser, or external services\n' +
        '    ✓  Exits automatically when done (no file watchers / dev servers)\n' +
        '    ✓  Does not require CI-specific env vars (GITHUB_REF_NAME etc.)\n' +
        '\n' +
        '  This repo may be:\n' +
        '    • A monorepo whose root "test" is a CI orchestration script\n' +
        '    • A project with database-dependent integration tests only\n' +
        '    • An E2E-only project (Playwright / Cypress)\n' +
        '\n' +
        '  Candidates we detected but skipped:\n' +
        `    ${Object.keys((JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')) as Record<string, Record<string, string>>)['scripts'] ?? {})
            .filter((k) => /test|spec|unit/i.test(k))
            .join(', ') || '(none)'}\n` +
        '\n' +
        '  Phase 2 of tracegraph audit (with service stubs) will handle these repos.',
      );
      return EXIT_CODES.CLI_ERROR;
    }
    testingAvailable  = false;
    testingSkipReason = 'no self-contained test script found';
    warn(
      'No self-contained test script found — runtime analysis will be skipped.\n' +
      '  Static architecture analysis (Phases A0, B graph rebuild, D1) will continue.',
    );
  }

  // ── 7b. Runtime pre-flight checks (only when tests will run) ─────────────
  if (testingAvailable && stack.language === 'php') {
    const phpCheck = spawnSync('php', ['--version'], {
      encoding: 'utf8',
      timeout:  5_000,
      shell:    process.platform === 'win32',
    });
    if (phpCheck.status !== 0 || phpCheck.error) {
      const wslHint = isWsl()
        ? '\n  This shell is running under WSL where PHP is not installed.\n' +
          '  PHP audits must be run from Windows PowerShell where PHP 8.4 is available:\n' +
          '    node packages/cli/bin/tracegraph.js audit <url> --skip-fork'
        : '\n  Install PHP 8.1+ and ensure `php` is in your PATH.';
      process.stderr.write(
        `[tracegraph audit] PHP not found in PATH (exit ${phpCheck.status ?? 127}).\n` +
        '  PHP is required to run composer install and the PHPUnit test suite.\n' +
        wslHint + '\n',
      );
      return EXIT_CODES.CLI_ERROR;
    }
    const phpVersion = (phpCheck.stdout as string).split('\n')[0]?.trim() ?? 'unknown';
    log(`PHP runtime: ${phpVersion}`);

    // Check pdo_sqlite — needed for Laravel's default in-memory SQLite test DB.
    // Missing pdo_sqlite causes every test to fail with "could not find driver"
    // before PHPUnit even starts executing, resulting in captureLevel 0.
    const sqliteCheck = spawnSync(
      'php',
      ['-r', "new PDO('sqlite::memory:'); echo 'ok';"],
      { encoding: 'utf8', timeout: 5_000, shell: process.platform === 'win32' },
    );
    if ((sqliteCheck.stdout as string).trim() !== 'ok') {
      warn(
        'PHP pdo_sqlite extension is not available.\n' +
        '  Most Laravel / PHPUnit test suites use SQLite :memory: as the test database.\n' +
        '  Without pdo_sqlite, all tests fail immediately with "could not find driver"\n' +
        '  and no traces are captured (capture level stays at 0).\n' +
        '  Install on Debian/Ubuntu:  sudo apt-get install php-sqlite3\n' +
        '  Install on RHEL/CentOS:    sudo yum install php-pdo_sqlite\n' +
        '  Continuing — some tests may still produce useful traces if they use another DB.',
      );
    }
  }

  // ── 8. Resolve tracegraph instrumentation paths (only when tests will run) ─
  let testCmd: string[]         = [];
  let nodeOptions: string | null = null;
  let captureLevel               = 'N/A (runtime analysis unavailable)';
  const extraEnv: Record<string, string> = {};

  // Hoisted so invasive-injection block (9c) can reference it when testingAvailable is true.
  let tgPaths: ReturnType<typeof resolveTracegraphPaths> | null = null;

  if (testingAvailable) {
    tgPaths       = resolveTracegraphPaths();
    const instr   = buildInstrumentation(stack, tgPaths, repoDir);
    testCmd      = instr.testCmd;
    nodeOptions  = instr.nodeOptions;
    captureLevel = instr.captureLevel;
    log(`Capture level (pre-injection): ${captureLevel}`);

    if (nodeOptions) {
      log(`NODE_OPTIONS: ${nodeOptions}`);
      // NODE_OPTIONS is intentionally NOT added to extraEnv here.
      // extraEnv is passed to every runTracegraph call — graph build, scan,
      // compare, architecture baseline, etc.  Those internal subprocesses must
      // NOT inherit the CJS interceptor hook, because loading register-cjs.js
      // inside tracegraph's own subprocesses activates the tracer, which causes
      // tracegraph scan (and others) to misbehave and can trigger Phase A0 to run
      // twice.  The hook is only needed by the actual test-runner subprocess —
      // see testEnv below, which is used only for `tracegraph run -- <testCmd>`.
    }
  }

  // ── 9. Install dependencies (only when tests will run) ───────────────────
  // When testingAvailable=false (no test script / install already failed) skip
  // the entire install step — Graphify runs directly on source files.
  if (testingAvailable) {
    // pnpm 10+ "Secure Builds": new packages with build scripts require interactive
    // approval.  In the non-interactive audit environment, pre-configure the repo's
    // .npmrc to disable the check.  This is safe because we're already running the
    // repo's test suite, so executing build scripts is within the audit's scope.
    const usesPnpm = stack.installCmds.some((cmd) => cmd[0] === 'pnpm');
    if (usesPnpm && stack.language === 'node') {
      const npmrcPath = path.join(repoDir, '.npmrc');
      const AUDIT_ENTRY = 'allow-build-scripts-check=false';
      const existing = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, 'utf8') : '';
      if (!existing.includes(AUDIT_ENTRY)) {
        fs.appendFileSync(npmrcPath, `\n# Added by tracegraph audit\n${AUDIT_ENTRY}\n`, 'utf8');
      }
    }

    for (const installCmd of stack.installCmds) {
      log(`Installing dependencies: ${installCmd.join(' ')}`);
      const rc = run(installCmd, repoDir, { timeoutMs: 300_000 });
      if (rc !== 0) {
        // When Graphify is available, a failed install degrades to static-only mode
        // instead of aborting — architecture analysis can still run on source files.
        if (graphifyAvailable) {
          warn(
            `Dependency install failed (exit ${rc}) — runtime analysis skipped.\n` +
            '  Static architecture analysis (Phases A0, B graph rebuild, D1) will continue.\n' +
            '  To enable runtime analysis, resolve the install failure above.',
          );
          testingAvailable  = false;
          testingSkipReason = `dependency install failed (exit ${rc})`;
          captureLevel      = 'N/A (runtime analysis unavailable)';
          break;
        }
        // Node.js and PHP: a failed install is fatal when no Graphify fallback exists.
        //   Node.js: devDependencies (vitest, jest, mocha) won't be in node_modules/.bin
        //   PHP:     vendor/bin/phpunit won't exist and we can't detect PHPUnit version
        if (stack.language === 'node') {
          process.stderr.write(
            `[tracegraph audit] Dependency install failed (exit ${rc}).\n` +
            '  Tests cannot run without installed devDependencies.\n' +
            '  Common causes:\n' +
            '    • Peer dependency conflicts — check npm output above\n' +
            '    • This is a monorepo root; the test runner lives in a sub-package\n' +
            '    • Private registry or authentication required\n' +
            '    • Node.js version mismatch (check .nvmrc or engines field)\n',
          );
          return EXIT_CODES.CLI_ERROR;
        }
        if (stack.language === 'php') {
          process.stderr.write(
            `[tracegraph audit] composer install failed (exit ${rc}).\n` +
            '  Tests cannot run without the vendor/ directory.\n' +
            '  Common causes:\n' +
            '    • PHP version mismatch — check composer.json "require" → "php" constraint\n' +
            '    • Private Packagist repository or authentication required\n' +
            '    • Composer itself is missing or not in PATH\n',
          );
          return EXIT_CODES.CLI_ERROR;
        }
        warn(`Dependency install returned non-zero (exit ${rc}). Continuing.`);
      }
    }
  }

  // ── 9b. Optional workspace build step (only when tests will run) ──────────
  let phpAdapterSrc:   string | null = null;
  let phpInjected      = false;
  let invasiveTsConfig = false;

  if (testingAvailable) {
    // Compiles internal workspace packages needed by the test suite.
    for (const buildCmd of stack.buildCmds) {
      log(`Building workspace packages: ${buildCmd.join(' ')}`);
      const rc = run(buildCmd, repoDir, { timeoutMs: 600_000 });
      if (rc !== 0) {
        warn(
          `Workspace build returned non-zero (exit ${rc}).\n` +
          '  Some packages may have failed to build (e.g. Next.js app needing secrets).\n' +
          '  Continuing — the test suite may still work if the required packages built.',
        );
      }
    }
  }

  // ── 9c. Invasive instrumentation injection (only when tests will run) ─────
  if (testingAvailable && stack.language === 'php') {
    phpAdapterSrc = resolvePhpAdapterSrcPath();
    if (!phpAdapterSrc) {
      warn(
        'PHP adapter source (packages/trace-laravel/src/) not found relative to CLI binary.\n' +
        '  Invasive injection skipped — running without PHP trace capture.',
      );
    } else {
      const phpUnitMajor = detectPhpUnitMajor(repoDir);
      if (phpUnitMajor === null) {
        warn(
          'Could not detect installed PHPUnit version from vendor/phpunit/phpunit/composer.json.\n' +
          '  Invasive injection skipped.',
        );
      } else if (phpUnitMajor < 10) {
        warn(
          `PHPUnit ${phpUnitMajor}.x detected — TraceGraph extension requires PHPUnit ≥10.\n` +
          '  PHPUnit 10 introduced the Extension event-subscriber API our extension relies on.\n' +
          '  Trace capture skipped for this PHP repo.',
        );
      } else {
        if (detectPest(repoDir)) {
          log('Pest detected — PHPUnit extension compatible (Pest wraps PHPUnit 10/11).');
        }
        log(`PHPUnit ${phpUnitMajor}.x — injecting TraceGraphPhpUnitExtension...`);
        phpInjected = injectPhpUnitExtension(repoDir, phpAdapterSrc);
        if (phpInjected) {
          captureLevel = `Level 5 invasive (PHPUnit ${phpUnitMajor}.x extension — per-test traces)`;
          // Phase 2: enable call-edge capture via debug_backtrace() in EventWriter::write().
          // TRACEGRAPH_INVASIVE=2 activates CallEdgeCapture.php and makes
          // TestPreparedSubscriber register TraceServiceProvider before each test so
          // application events (http_request, db_query, auth_check) fire during tests.
          extraEnv['TRACEGRAPH_INVASIVE'] = '2';
          log('Phase 2 invasive: TRACEGRAPH_INVASIVE=2 — runtime call-edge capture enabled.');
        }
      }
    }
  } else if (testingAvailable && stack.language === 'node' && stack.testRunner === 'vitest') {
    const baseConfig   = findVitestConfig(repoDir);
    // tgPaths is guaranteed non-null here: testingAvailable=true means the block above ran.
    const reporterPath = tgPaths!.vitestReporterMjs ?? tgPaths!.vitestReporter;
    if (baseConfig && reporterPath) {
      const reporterFwd = reporterPath.replace(/\\/g, '/');

      // ── Guard 1: workspace config ─────────────────────────────────────────
      // mergeConfig() is incompatible with defineWorkspace() output.
      let isWorkspaceConfig = false;
      try {
        const configSrc = fs.readFileSync(path.join(repoDir, baseConfig), 'utf8');
        isWorkspaceConfig = configSrc.includes('defineWorkspace');
      } catch { /* unreadable — treat as normal config */ }

      // ── Guard 2: test command doesn't call vitest directly ────────────────
      // The invasive `--config` approach requires that `--config /path` reaches
      // vitest on the command line.  When the test command is a package-manager
      // script wrapper (`pnpm run test`, `npm test`, `yarn test`), the flag must
      // pass through two layers: the outer pnpm/npm invocation and then the
      // script body.  This is unreliable because:
      //
      //   • `pnpm run test -- --config x` → script body gets `--config x`
      //     If the script body is `pnpm run -r test`, inner pnpm may interpret
      //     `--config` as its own CLI flag (pnpm has --config.key=value syntax).
      //
      //   • vitest's `--` separator is also fragile: some npm-like tools pass
      //     `-- --config x` to the script literally, so vitest receives `--`
      //     and treats `--config` as test-file arguments, not a CLI option.
      //
      // When the test command calls vitest directly (`vitest`, `npx vitest`,
      // `./node_modules/.bin/vitest`) invasive injection is safe and preferred.
      // Otherwise fall back to the non-invasive `--reporter=` flags that
      // buildInstrumentation already put in testCmd — those travel as simple
      // script arguments and are reliably forwarded by all package managers.
      const rawTestParts = stack.rawTestCmd.trim().split(/\s+/);
      const testCmdHasVitest = rawTestParts.some((p) => /\bvitest\b/i.test(p));

      if (!testCmdHasVitest) {
        log('Test command wraps a package manager (vitest not called directly).');
        log('  Non-invasive --reporter flag injection will be used (more reliable for this pattern).');
      }

      if (isWorkspaceConfig) {
        log(`${baseConfig} uses defineWorkspace — skipping invasive mergeConfig injection.`);
        log('  Non-invasive --reporter flag injection (from buildInstrumentation) will be used instead.');
      } else if (testCmdHasVitest) {
        invasiveTsConfig = writeVitestWrapperConfig(repoDir, baseConfig, reporterFwd);
      }
      if (invasiveTsConfig) {
        // Override test command to use the wrapper config.
        // Use an absolute path so vitest can locate the file regardless of CWD.
        // No `--` separator: invasive injection only fires when the test command
        // calls vitest directly (testCmdHasVitest=true), so `--config` is a
        // plain vitest CLI option and must NOT be preceded by `--` (vitest
        // interprets `-- args` as arguments passed to the test files, not
        // as its own CLI flags).
        const wrapperAbsPath = path.join(repoDir, 'vitest.config.tracegraph.ts').replace(/\\/g, '/');
        const rawParts   = stack.rawTestCmd.trim().split(/\s+/);
        testCmd          = [...rawParts, '--config', wrapperAbsPath];
        const vitestMajor = declaredMajor(repoDir, 'vitest') ?? '?';
        captureLevel     = `Level 3–5 invasive (Vitest ${vitestMajor}.x wrapper config + per-test traces)`;
        log(`Test command updated for invasive injection: ${testCmd.join(' ')}`);
      }
    } else if (!baseConfig) {
      log('No vitest.config.* in repo root — using non-invasive reporter-flag injection.');
    } else {
      log('Vitest reporter path unavailable — using non-invasive reporter-flag injection.');
    }
  }

  log(`Capture level: ${captureLevel}`);

  // ── A0. Static graph + architecture snapshot (base branch) ────────────────
  if (graphifyAvailable) {
    log(`\n${'─'.repeat(60)}`);
    log('PHASE A0 — Static graph + architecture snapshot (base branch)');
    log(`${'─'.repeat(60)}`);

    // G17.1 — Pre-flight LLM API key check.
    // Graphify uses an LLM to extract call-graph edges (relationships between
    // nodes).  Without a key, it produces a node-only (A1) graph which has no
    // edges and therefore no community or cross-community-edge data.  Warn early
    // so the user can act before a long build completes with 0 edges.
    const hasAnthropicKey = !!process.env['ANTHROPIC_API_KEY'];
    const hasGeminiKey    = !!process.env['GEMINI_API_KEY'];
    if (!hasAnthropicKey && !hasGeminiKey) {
      warn(
        'No LLM API key detected (ANTHROPIC_API_KEY / GEMINI_API_KEY).\n' +
        '  Graphify will build a node-only graph (A1 quality) — call-graph edges\n' +
        '  require an LLM key for relationship extraction.\n' +
        '  Set one of the above environment variables to enable full graph analysis.',
      );
    }

    log('Building static graph...');
    graphBuildBaseOk = runGraphBuild(repoDir, extraEnv, timeoutMs, log, warn);

    if (graphBuildBaseOk) {
      graphMeta = readGraphMeta(repoDir);
      if (graphMeta) {
        log(
          `  Graph: ${graphMeta.nodeCount.toLocaleString()} nodes  |  ` +
          `${graphMeta.edgeCount.toLocaleString()} edges  |  ` +
          `${graphMeta.communityCount} communities  |  ` +
          `${graphMeta.godNodeCount} god nodes`,
        );
        // G17.2 — Post-build edge-count diagnostic.
        // A graph with nodes but zero edges means edge extraction failed, which is
        // almost always due to a missing LLM API key.  Log early so CI output is
        // easy to grep without waiting for the final banner.
        if (graphMeta.edgeCount === 0 && graphMeta.nodeCount > 0) {
          const hasKey = !!(process.env['ANTHROPIC_API_KEY'] || process.env['GEMINI_API_KEY']);
          if (!hasKey) {
            warn(
              `Graph has ${graphMeta.nodeCount.toLocaleString()} nodes but 0 edges — ` +
              'edge extraction requires an LLM API key.\n' +
              '  Set ANTHROPIC_API_KEY or GEMINI_API_KEY and re-run to enable full analysis.',
            );
          } else {
            warn(
              `Graph has ${graphMeta.nodeCount.toLocaleString()} nodes but 0 edges.\n` +
              '  Run `graphify . --verbose` in the repo to diagnose relationship extraction.',
            );
          }
        }
      }
      log('Creating architecture baseline...');
      archBaselineOk = runTracegraph(
        ['architecture', 'baseline', 'create', '--quiet'],
        repoDir, extraEnv,
      ) === 0;

      log('Running baseline-free risk scan...');
      runTracegraph(['scan'], repoDir, extraEnv);
    } else {
      warn('Graph build failed — architecture analysis skipped for this audit.');
    }
  }

  // ── 10. Baseline run on the base branch ───────────────────────────────────
  // testEnv extends extraEnv with NODE_OPTIONS for the test-runner subprocess ONLY.
  // All internal tracegraph subprocesses (graph build, scan, compare, etc.) use
  // extraEnv directly, which does NOT carry NODE_OPTIONS.
  const testEnv: Record<string, string> = nodeOptions
    ? { ...extraEnv, NODE_OPTIONS: nodeOptions }
    : extraEnv;

  log(`\n${'─'.repeat(60)}`);
  log(`PHASE A — Baseline run on ${selectedPR.base?.ref ?? 'main'}`);
  log(`${'─'.repeat(60)}`);

  if (!testingAvailable) {
    log(`⚠  Runtime baseline skipped (${testingSkipReason}).`);
    log('  Architecture compare (Phase D1) will still run.');
  } else {
    log(`Running: tracegraph run -- ${testCmd.join(' ')}`);

    baselineRunCode = runTracegraph(
      ['run', '--', ...testCmd],
      repoDir,
      testEnv,   // testEnv carries NODE_OPTIONS; extraEnv (used everywhere else) does not
      timeoutMs,
    );

    // Exit 127 = shell "command not found" — test runner binary not installed.
    if (baselineRunCode === 127) {
      process.stderr.write(
        '[tracegraph audit] Test runner binary not found (exit 127).\n' +
        `  Command: ${testCmd.join(' ')}\n` +
        '  Dependency install may have failed — see npm/yarn output above.\n',
      );
      return EXIT_CODES.CLI_ERROR;
    }

    // EXIT_TIMEOUT = tracegraph run was killed because the test suite exceeded the timeout.
    if (baselineRunCode === EXIT_TIMEOUT) {
      return EXIT_CODES.CLI_ERROR;
    }

    if (!hasTraces(repoDir)) {
      warn(
        'No traces were captured on the base branch.\n' +
        '  This may be because:\n' +
        '    • The test suite requires environment setup (DB, secrets, etc.)\n' +
        '    • The test command failed to run (check output above)\n' +
        '    • The project stack requires invasive instrumentation (Phase 2)',
      );
      return EXIT_CODES.CLI_ERROR;
    }

    // Read the actual capture level achieved — may differ from the configured level
    // when tests fail early (e.g. missing pdo_sqlite, boot errors).
    const actualBaseLevel = readActualCaptureLevel(repoDir);
    if (actualBaseLevel !== null) {
      if (actualBaseLevel.startsWith('Level 0') && !captureLevel.startsWith('Level 0')) {
        warn(
          `Actual capture level on base branch: ${actualBaseLevel}\n` +
          `  Configured level was: ${captureLevel}\n` +
          '  This usually means the tests failed before PHPUnit/Jest could run\n' +
          '  (e.g. missing PHP extension, DB connection error, framework boot failure).\n' +
          '  Check the test output above for "could not find driver" or similar errors.',
        );
      }
      captureLevel = actualBaseLevel;
    }

    if (baselineRunCode !== 0) {
      warn(`Tests returned exit code ${baselineRunCode} on the base branch.`);
      warn('Continuing — baseline will be created from whatever traces were captured.');
    }

    log('Creating baseline...');
    const baselineCode = runTracegraph(
      ['baseline', 'create', '--reason', `PR #${selectedPR.number} audit baseline`, '--all'],
      repoDir,
      extraEnv,
    );
    if (baselineCode !== 0) {
      warn('Baseline create returned non-zero. Continuing.');
    }

    if (graphBuildBaseOk) {
      log('Enriching base branch traces with static metadata...');
      runTracegraph(['graph', 'enrich', '--all', '--quiet'], repoDir, extraEnv);
      log('Deriving runtime edges from base branch traces...');
      runTracegraph(['graph', 'derive-edges', '--quiet'], repoDir, extraEnv);
    }

    // Phase 2: collect call edges from this (base-branch) run.
    // Must be done BEFORE Phase B checkout since the run dir is in .tracegraph/runs/
    // which persists across branch checkouts.
    const baseCallEdges = collectCallEdgesFromLatestRun(repoDir);
    if (baseCallEdges.length > 0) {
      log(`Phase 2: collected ${baseCallEdges.length} call edges from base-branch run.`);
      accumulatedCallEdges.push(...baseCallEdges);
    }
  }

  // ── 11. Apply the PR ──────────────────────────────────────────────────────
  log(`\n${'─'.repeat(60)}`);
  log(`PHASE B — Applying PR #${selectedPR.number}`);
  log(`${'─'.repeat(60)}`);

  // Determine the correct remote for fetching the PR head.
  // When we cloned a fork, the upstream remote points to the original repo.
  // When we cloned the original directly (--skip-fork), 'origin' is the source.
  const prRemote = cloneUrl === `https://github.com/${owner}/${repo}.git`
    ? 'origin'
    : 'upstream';

  log(`Fetching PR #${selectedPR.number} from ${prRemote}...`);
  const fetchResult = gitCmd(
    ['fetch', prRemote, `pull/${selectedPR.number}/head:pr-${selectedPR.number}`],
    repoDir,
  );
  if (!fetchResult.ok) {
    process.stderr.write(`[tracegraph audit] git fetch failed:\n${fetchResult.out}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  // Checkout the PR branch directly — no merge commit required.
  // The .tracegraph/ directory is untracked, so baselines created on the
  // base branch persist across the checkout and are available to compare.
  //
  // Before switching branches, discard any modifications to tracked files
  // that the install step may have introduced (e.g. .npmrc entries added by
  // the pnpm secure-builds workaround, or lock file timestamps).
  // `git checkout -- .` only affects tracked files — untracked files like
  // .tracegraph/ are left completely untouched.
  const statusResult = gitCmd(['status', '--porcelain'], repoDir);
  if (statusResult.out.trim()) {
    log('Discarding install-time modifications to tracked files before PR checkout...');
    gitCmd(['checkout', '--', '.'], repoDir);
  }

  log(`Checking out PR branch pr-${selectedPR.number}...`);
  const checkoutResult = gitCmd(['checkout', `pr-${selectedPR.number}`], repoDir);
  if (!checkoutResult.ok) {
    process.stderr.write(
      `[tracegraph audit] git checkout failed:\n${checkoutResult.out}\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }
  log('Checked out PR branch.');

  // PHP re-injection: git checkout -- . above may have reverted phpunit.xml if it
  // was a tracked file in the repo (existed before our injection).  Re-run injection
  // so the extension is present on the PR branch.  injectPhpUnitExtension() is
  // idempotent — if phpunit.xml is untracked (created from .dist) it survived
  // checkout unchanged and this call detects and skips the duplicate.
  if (phpInjected && phpAdapterSrc) {
    log('Re-injecting PHPUnit extension after PR branch checkout...');
    phpInjected = injectPhpUnitExtension(repoDir, phpAdapterSrc);
  }

  // TypeScript: vitest.config.tracegraph.ts is untracked — it survived checkout.
  // No re-injection needed.

  // G-series: rebuild static graph for the PR branch code.
  // The graph was built on the base branch in Phase A0; rebuilding here gives us
  // the PR branch's architecture so architecture compare can diff them.
  if (graphBuildBaseOk) {
    log('Rebuilding static graph for PR branch...');
    graphBuildPrOk = runGraphBuild(repoDir, extraEnv, timeoutMs, log, warn);
    if (!graphBuildPrOk) {
      warn('PR branch graph build failed — architecture compare will be skipped.');
    } else {
      // G15.2 — Re-read graphMeta after the PR-branch graph build.
      // graphMeta was set from the *base* branch build (Phase A0) and reflected
      // base-branch node/edge counts.  Now that the PR branch has been built,
      // update graphMeta so that the final banner shows PR-branch metrics and
      // the base→PR node-count delta is accurate.
      graphMeta = readGraphMeta(repoDir) ?? graphMeta;
    }
  }

  // ── 12. Run tests on the PR branch ───────────────────────────────────────
  log(`\n${'─'.repeat(60)}`);
  log(`PHASE C — Running tests on PR #${selectedPR.number}`);
  log(`${'─'.repeat(60)}`);

  if (!testingAvailable) {
    log(`⚠  Runtime tests skipped (${testingSkipReason}).`);
  } else {
    log(`Running: tracegraph run -- ${testCmd.join(' ')}`);

    // G19: use the tee-capturing variant so we can extract boot errors from the
    // output while still streaming everything to the terminal in real-time.
    const prRunResult = runTracegraphCapturing(
      ['run', '--', ...testCmd],
      repoDir,
      testEnv,   // testEnv carries NODE_OPTIONS; extraEnv (used everywhere else) does not
      timeoutMs,
    );
    prRunCode      = prRunResult.status;
    prRunCaptured  = prRunResult.captured;

    // Update captureLevel with what was actually captured on the PR branch.
    // Phase C level takes precedence — it's the run we're comparing against.
    const actualPrLevel = readActualCaptureLevel(repoDir);
    if (actualPrLevel !== null) {
      if (actualPrLevel.startsWith('Level 0') && !captureLevel.startsWith('Level 0')) {
        warn(
          `Actual capture level on PR branch: ${actualPrLevel}\n` +
          `  Configured level was: ${captureLevel}\n` +
          '  Tests likely failed before the PHPUnit/Jest reporter ran.\n' +
          '  Check the PR branch test output above for framework boot errors\n' +
          '  (e.g. "Call to undefined method", "Class not found").',
        );
      }
      captureLevel = actualPrLevel;
    }

    if (prRunCode !== 0) {
      warn(`Tests returned exit code ${prRunCode} on the PR branch.`);
      warn('Continuing with compare — findings are still valid.');
    }

    if (graphBuildPrOk) {
      log('Enriching PR branch traces with static metadata...');
      runTracegraph(['graph', 'enrich', '--all', '--quiet'], repoDir, extraEnv);
      log('Deriving runtime edges from PR branch traces...');
      runTracegraph(['graph', 'derive-edges', '--quiet'], repoDir, extraEnv);
    }

    // Phase 2: collect call edges from this (PR-branch) run.
    const prCallEdges = collectCallEdgesFromLatestRun(repoDir);
    if (prCallEdges.length > 0) {
      log(`Phase 2: collected ${prCallEdges.length} call edges from PR-branch run.`);
      accumulatedCallEdges.push(...prCallEdges);
    }
  }

  // Phase 2: resolve and write accumulated runtime call edges.
  // Must happen before pr-context.json so graph_metadata.json is up-to-date
  // and compare.ts can use runtimeEdgeCount when building the quality finding.
  if (accumulatedCallEdges.length > 0) {
    log(`Phase 2: resolving ${accumulatedCallEdges.length} accumulated call edges...`);
    writeRuntimeCallEdgesIfAny(repoDir, accumulatedCallEdges, log, warn);
    // Refresh graphMeta now that runtimeEdgeCount has been patched in
    graphMeta = readGraphMeta(repoDir) ?? graphMeta;
  }

  // ── G8: Write pr-context.json before compare so compare.ts can load it ────
  {
    const prChangedFiles = await fetchPRFiles(owner, repo, selectedPR.number, token);
    // Warn if the file-listing API returned empty despite the PR metadata reporting changed files.
    // This usually means a rate-limit or auth error was silently swallowed by fetchPRFiles.
    if (prChangedFiles.length === 0 && (selectedPR.changed_files ?? 0) > 0) {
      warn(
        `PR #${selectedPR.number} reports ${selectedPR.changed_files} changed file(s) ` +
        `but the GitHub files API returned none.\n` +
        `  Changed-file relevance analysis will be unavailable in the report.\n` +
        `  Possible causes: API rate limit, missing token scope, or a transient network error.`,
      );
    }
    const prContextPath  = path.join(repoDir, '.tracegraph', 'pr-context.json');
    try {
      // Build the context object.  G13.4: include the detected language so
      // compare.ts can use prContext.language rather than guessing from sessions.
      // G14.2: include test run exit codes so the CI report can surface test failures.
      const prContextPayload: Record<string, unknown> = {
        prNumber:         selectedPR.number,
        prTitle:          selectedPR.title,
        prAuthor:         selectedPR.user.login,
        additions:        selectedPR.additions,
        deletions:        selectedPR.deletions,
        changedFiles:     selectedPR.changed_files,
        changedFilePaths: prChangedFiles,
        language:         stack.language,
      };
      if (baselineRunCode !== 0) {
        prContextPayload['baselineRunExitCode'] = baselineRunCode;
      }
      if (prRunCode !== 0) {
        prContextPayload['testRunExitCode'] = prRunCode;
      }
      // G19: when the PR run produced Level 0 traces (boot failure), try to
      // extract the first meaningful error from the captured run output.
      // This surfaces the root cause (e.g. "Call to undefined method...") in the
      // report rather than leaving reviewers to scroll through terminal output.
      const prActualLevel = readActualCaptureLevel(repoDir);
      if (prRunCode !== 0 && prActualLevel?.startsWith('Level 0') && prRunCaptured !== null) {
        const bootErr = extractBootError(prRunCaptured);
        if (bootErr) {
          prContextPayload['bootError'] = bootErr;
        }
      }
      fs.writeFileSync(
        prContextPath,
        JSON.stringify(prContextPayload, null, 2) + '\n',
        'utf8',
      );
      log(`  PR context written (${prChangedFiles.length} changed file paths).`);
    } catch {
      /* non-fatal — compare will run without PR context */
    }
  }

  // ── 13. Compare ────────────────────────────────────────────────────────────
  log(`\n${'─'.repeat(60)}`);
  log('PHASE D — Comparing against baseline');
  log(`${'─'.repeat(60)}`);

  if (!testingAvailable) {
    log(`⚠  Runtime compare skipped (${testingSkipReason}) — no runtime baseline available.`);
    log('  See Phase D1 below for static architecture comparison.');
  } else {
    runTracegraph(['compare'], repoDir, extraEnv);
  }

  // ── D1. Architecture compare (PR branch graph vs base branch baseline) ─────
  if (archBaselineOk && graphBuildPrOk) {
    log(`\n${'─'.repeat(60)}`);
    log('PHASE D1 — Architecture compare (PR vs base branch)');
    log(`${'─'.repeat(60)}`);

    // Human-readable output: architecture compare writes text to stderr
    runTracegraph(['architecture', 'compare'], repoDir, extraEnv);

    // JSON capture: same command with --json; stdout captured, stderr still
    // flows to terminal (there's no stderr when --json is active, so no duplication)
    const archJsonResult = captureTracegraph(['architecture', 'compare', '--json'], repoDir, extraEnv);
    if (archJsonResult.stdout.trim()) {
      try {
        const parsed = JSON.parse(archJsonResult.stdout) as {
          baseline?: { nodeCount?: number };
          current?:  { edgeCount?: number };
          diff: {
            totalChanges:           number;
            hasCriticalChanges:     boolean;
            newCrossCommunityEdges: unknown[];
            newGodNodes:            unknown[];
          };
        };
        archDiffResult = {
          totalChanges:       parsed.diff.totalChanges,
          hasCriticalChanges: parsed.diff.hasCriticalChanges,
          newCrossEdges:      parsed.diff.newCrossCommunityEdges.length,
          newGodNodes:        parsed.diff.newGodNodes.length,
          currentEdgeCount:   parsed.current?.edgeCount ?? 0,
          // G15.3: base-branch node count for base→PR banner comparison
          baselineNodeCount:  parsed.baseline?.nodeCount ?? 0,
        };
      } catch { /* parse failure — summary will omit architecture counts */ }
    }
  }

  // ── 14. Generate report ────────────────────────────────────────────────────
  log(`\n${'─'.repeat(60)}`);
  log('PHASE E — Generating report');
  log(`${'─'.repeat(60)}`);

  const reportFormat = opts.json ? 'json' : 'markdown';
  if (testingAvailable) {
    runTracegraph(['report', '--format', reportFormat], repoDir, extraEnv);
  }

  // ── Cleanup invasive files ─────────────────────────────────────────────────
  // Remove untracked files we created during the audit so the workspace is clean.
  // These files are never in .gitignore — they're safe to delete.
  if (invasiveTsConfig) {
    try {
      fs.unlinkSync(path.join(repoDir, 'vitest.config.tracegraph.ts'));
      log('Removed vitest.config.tracegraph.ts (invasive injection cleanup).');
    } catch { /* non-fatal — file may have already been removed */ }
  }
  // PHP bootstrap is left in place (it's a useful audit artifact alongside phpunit.xml).

  // ── 15. Print summary ──────────────────────────────────────────────────────
  const reportsDir = path.join(repoDir, '.tracegraph', 'reports');
  const reportFiles = fs.existsSync(reportsDir)
    ? fs.readdirSync(reportsDir)
        .filter((f) => f.endsWith('.report.json'))
        .map((f) => path.join(reportsDir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];

  const W = 62;
  process.stdout.write(`\n${'═'.repeat(W)}\n`);
  process.stdout.write(`TraceGraph Audit — ${owner}/${repo}  PR #${selectedPR.number}\n`);
  process.stdout.write(`"${selectedPR.title}"\n`);
  process.stdout.write(`Author: ${selectedPR.user.login}  |  `);
  if (selectedPR.additions != null) {
    process.stdout.write(`+${selectedPR.additions}/-${selectedPR.deletions}  ${selectedPR.changed_files} files\n`);
  } else {
    process.stdout.write('\n');
  }
  process.stdout.write(`${'─'.repeat(W)}\n`);
  // G14.4: renamed "Capture level:" → "Capture depth:" to match the three-tier terminology
  process.stdout.write(`Capture depth:    ${captureLevel}\n`);

  // G14.3: Test run status line — surfaces non-zero exit codes prominently
  if (testingAvailable) {
    const baseOk = baselineRunCode === 0;
    const prOk   = prRunCode === 0;
    if (baseOk && prOk) {
      process.stdout.write(`Test status:      ✅ Passed (base exit:0  PR exit:0)\n`);
    } else if (!baseOk && !prOk) {
      process.stdout.write(`Test status:      ⚠️  Both runs failed  (base exit:${baselineRunCode}  PR exit:${prRunCode})\n`);
    } else if (!baseOk) {
      process.stdout.write(`Test status:      ⚠️  Baseline run failed  (exit:${baselineRunCode}  PR exit:0)\n`);
    } else {
      process.stdout.write(`Test status:      ⚠️  PR run failed  (base exit:0  PR exit:${prRunCode})\n`);
    }
  }

  // Static graph summary
  if (graphifyAvailable) {
    if (graphMeta) {
      // Effective edge count = static edges + Phase 2 runtime edges (if any)
      const runtimeEdges       = graphMeta.runtimeEdgeCount ?? 0;
      const effectiveEdgeCount = graphMeta.edgeCount + runtimeEdges;
      // Use ⚠️ when graph has nodes but no edges (A1 quality) — ✅ would be misleading
      const graphIcon = effectiveEdgeCount === 0 && graphMeta.nodeCount > 0 ? '⚠️' : '✅';
      // G15.3: show base→PR node count when the graph was rebuilt for the PR branch
      const baseNodeCount = archDiffResult?.baselineNodeCount ?? 0;
      const nodeLabel = (baseNodeCount > 0 && baseNodeCount !== graphMeta.nodeCount)
        ? `${baseNodeCount.toLocaleString()} → ${graphMeta.nodeCount.toLocaleString()} nodes`
        : `${graphMeta.nodeCount.toLocaleString()} nodes`;
      // Show effective edge count; when Phase 2 contributed edges, annotate with "(+N runtime)"
      const edgeLabel = runtimeEdges > 0
        ? `${effectiveEdgeCount.toLocaleString()} edges  (+${runtimeEdges} runtime)`
        : `${effectiveEdgeCount.toLocaleString()} edges`;
      process.stdout.write(
        `Static graph:     ${graphIcon} ` +
        `${nodeLabel}  |  ` +
        `${edgeLabel}  |  ` +
        `${graphMeta.communityCount} communities  |  ` +
        `${graphMeta.godNodeCount} god nodes\n`,
      );
      // G17.4: explicit edge-warning line when 0 edges, so CI logs are easy to grep
      if (effectiveEdgeCount === 0 && graphMeta.nodeCount > 0) {
        const hasKey = !!(process.env['ANTHROPIC_API_KEY'] || process.env['GEMINI_API_KEY']);
        process.stdout.write(
          hasKey
            ? 'Graph edges:      ⚠️  0 — run `graphify . --verbose` to diagnose extraction\n'
            : 'Graph edges:      ⚠️  0 — set ANTHROPIC_API_KEY or GEMINI_API_KEY for call-graph extraction\n',
        );
      }
    } else if (graphBuildBaseOk) {
      process.stdout.write('Static graph:     ✅ Built (metadata unavailable)\n');
    } else {
      process.stdout.write('Static graph:     ⚠️  Build failed (see output above)\n');
    }

    // Architecture diff summary
    if (archDiffResult != null) {
      // A1-quality graph (0 edges): "No drift" is meaningless — both baseline and
      // current lack edges, so comparing them tells us nothing about architecture.
      if (archDiffResult.currentEdgeCount === 0) {
        process.stdout.write('Architecture:     ⚠️  A1 quality — no edges; comparison unavailable\n');
      } else if (archDiffResult.totalChanges === 0) {
        process.stdout.write('Architecture:     ✅ No drift — graph matches baseline\n');
      } else {
        // A2-limited (edges present, 0 communities): god-node detection has no community
        // structure to anchor it, so all god-node "changes" are low-confidence.
        // When the only changes are god nodes in an A2-limited graph, say so explicitly
        // rather than showing a raw change count that implies high confidence.
        const isA2Limited = graphMeta.communityCount === 0 && graphMeta.edgeCount > 0;
        const onlyGodNodeChanges =
          archDiffResult.newGodNodes > 0 &&
          archDiffResult.newCrossEdges === 0 &&
          !archDiffResult.hasCriticalChanges;
        if (isA2Limited && onlyGodNodeChanges) {
          process.stdout.write(
            `Architecture:     ⚠️  A2-limited — low-confidence god-node changes ` +
            `(+${archDiffResult.newGodNodes} god node${archDiffResult.newGodNodes !== 1 ? 's' : ''})\n`,
          );
        } else {
          const critFlag = archDiffResult.hasCriticalChanges ? '  🔴 CRITICAL' : '';
          process.stdout.write(
            `Architecture:     ⚠️  ${archDiffResult.totalChanges} change${archDiffResult.totalChanges !== 1 ? 's' : ''}` +
            (archDiffResult.newCrossEdges > 0
              ? `  (${archDiffResult.newCrossEdges} new cross-community edge${archDiffResult.newCrossEdges !== 1 ? 's' : ''})`
              : '') +
            (archDiffResult.newGodNodes > 0
              ? `  (+${archDiffResult.newGodNodes} god node${archDiffResult.newGodNodes !== 1 ? 's' : ''})`
              : '') +
            `${critFlag}\n`,
          );
        }
      }
    } else if (archBaselineOk && graphBuildPrOk) {
      process.stdout.write('Architecture:     (compare output above)\n');
    } else if (!graphBuildBaseOk) {
      process.stdout.write('Architecture:     ○ Skipped (graph build failed)\n');
    } else if (!archBaselineOk) {
      process.stdout.write('Architecture:     ○ Skipped (baseline create failed)\n');
    } else {
      process.stdout.write('Architecture:     ○ Skipped (PR branch graph build failed)\n');
    }
  } else {
    process.stdout.write('Static graph:     ○ Skipped  (install Graphify: uv tool install graphifyy)\n');
  }

  if (!testingAvailable) {
    process.stdout.write(
      `Runtime:          ○ Skipped  (${testingSkipReason})\n` +
      '                  Install deps and re-run for runtime behaviour diff.\n',
    );
  }

  process.stdout.write(`${'─'.repeat(W)}\n`);
  process.stdout.write(`Workspace: ${repoDir}\n`);

  if (reportFiles[0]) {
    // Print path to the markdown report if generated
    const mdFiles = fs.readdirSync(reportsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(reportsDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    if (mdFiles[0]) {
      process.stdout.write(`Report: ${mdFiles[0]}\n`);

      // If --out specified, copy the report there
      if (opts.out) {
        try {
          fs.copyFileSync(mdFiles[0], opts.out);
          log(`Report copied to ${opts.out}`);
        } catch (err) {
          warn(`Could not copy report to ${opts.out}: ${String(err)}`);
        }
      }
    }

    process.stdout.write(`JSON: ${reportFiles[0]}\n`);
  }

  process.stdout.write(`${'═'.repeat(W)}\n`);

  return EXIT_CODES.SUCCESS;
}
