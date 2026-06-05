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

// ─── Constants ────────────────────────────────────────────────────────────────

/** Absolute path to the currently-running tracegraph CLI entry point. */
const TG_BIN = process.argv[1]!;

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

function detectStack(repoDir: string): RepoStack {
  const entries = fs.readdirSync(repoDir);

  // ── Node.js ──────────────────────────────────────────────────────────────────
  if (entries.includes('package.json')) {
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
    const testRunner =
      'vitest' in deps || scriptValue.includes('vitest') || allScriptValues.includes('vitest') ? 'vitest' :
      'jest'   in deps || scriptValue.includes('jest')   || allScriptValues.includes('jest')   ? 'jest'   :
      scriptValue.includes('mocha') || allScriptValues.includes('mocha')                       ? 'mocha'  :
      null;

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

  // Level 4 — ESM import hook via NODE_OPTIONS --import (Node.js 18.19+ / 20.6+).
  // Works alongside Level 3: --require handles CJS modules, --import handles ESM.
  // Together they give full coverage of both module systems.  Safe on older Node
  // versions where the flag is unknown — Node will emit a warning but still run.
  if (tgPaths.registerEsm) {
    const esmPath = tgPaths.registerEsm.replace(/\\/g, '/');
    const importFlag = `--import "${esmPath}"`;
    nodeOpts = nodeOpts ? `${nodeOpts} ${importFlag}` : importFlag;
    level = level.startsWith('Level 3') ? level.replace('Level 3', 'Level 3–4') : level;
  }

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

    if (vitestMajor != null && SUPPORTED_VITEST_MAJORS.has(vitestMajor)) {
      // Vitest 2+ uses ESM import() for reporters → prefer .mjs for correct default export.
      // Vitest 1.x uses CJS require() → use .js.
      const rawPath = vitestMajor >= 2 && tgPaths.vitestReporterMjs
        ? tgPaths.vitestReporterMjs
        : tgPaths.vitestReporter;
      // Forward slashes required: backslashes in --reporter= paths cause 'not found' errors
      const reporterPath = (rawPath ?? '').replace(/\\/g, '/');
      testCmd = [...testCmd, '--reporter=default', `--reporter=${reporterPath}`];
      level = `Level 5 (Vitest ${vitestMajor}.x reporter — per-test traces)`;
    } else if (vitestMajor == null) {
      // Version undeclared (unusual) — fall back to .mjs which works with ESM-first Vitest
      const rawPath = tgPaths.vitestReporterMjs ?? tgPaths.vitestReporter;
      const reporterPath = (rawPath ?? '').replace(/\\/g, '/');
      testCmd = [...testCmd, '--reporter=default', `--reporter=${reporterPath}`];
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
      testCmd = [...testCmd, '--reporter=default', `--reporter=${reporterPath}`];
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
  if (stack.testRunner === 'mocha') {
    // When running via a package-manager script (npm run test / pnpm run test),
    // use `--` to pass extra flags through to the underlying mocha invocation.
    // When running mocha directly, just append the flag.
    const isPackageScript = ['npm', 'pnpm', 'yarn'].includes(testCmd[0] ?? '');
    testCmd = isPackageScript
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

function gitCmd(args: string[], cwd: string): { ok: boolean; out: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout:  60_000,
    shell:    process.platform === 'win32',
  });
  return { ok: result.status === 0, out: (result.stdout ?? '') + (result.stderr ?? '') };
}

function hasTraces(repoDir: string): boolean {
  const tracesDir = path.join(repoDir, '.tracegraph', 'traces');
  if (!fs.existsSync(tracesDir)) return false;
  return fs.readdirSync(tracesDir).some((f) => f.endsWith('.trace.json'));
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
  const cloneResult = run(['git', 'clone', '--depth=50', cloneUrl, repoDir], workspaceDir,
    { timeoutMs: 120_000 });
  if (cloneResult !== 0) {
    process.stderr.write('[tracegraph audit] git clone failed.\n');
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
  log(`Test command: ${stack.rawTestCmd}`);

  if (stack.language === 'unknown') {
    warn('Unrecognised project stack. Cannot run tests without a known test command.');
    return EXIT_CODES.CLI_ERROR;
  }
  if (!stack.rawTestCmd) {
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

  // ── 7b. Runtime pre-flight checks ───────────────────────────────────────────
  // Verify that the required runtime is reachable before spending time on install.
  // PHP is only available on Windows (not in WSL on this machine) — give a clear,
  // actionable error rather than a cryptic "php: not found" from composer.
  if (stack.language === 'php') {
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
  }

  // ── 8. Resolve tracegraph instrumentation paths ──────────────────────────────
  const tgPaths = resolveTracegraphPaths();
  // eslint-disable-next-line prefer-const
  let { testCmd, nodeOptions, captureLevel } = buildInstrumentation(stack, tgPaths, repoDir);
  log(`Capture level (pre-injection): ${captureLevel}`);
  if (nodeOptions) log(`NODE_OPTIONS: ${nodeOptions}`);

  const extraEnv: Record<string, string> = {};
  if (nodeOptions) extraEnv['NODE_OPTIONS'] = nodeOptions;

  // ── 9. Install dependencies ────────────────────────────────────────────────

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
      // Node.js and PHP: a failed install is always fatal.
      //   Node.js: devDependencies (vitest, jest, mocha) won't be in node_modules/.bin
      //   PHP:     vendor/bin/phpunit won't exist and we can't detect PHPUnit version
      // Abort early rather than silently producing empty Level 0 traces.
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

  // ── 9b. Optional workspace build step ─────────────────────────────────────
  // Compiles internal workspace packages needed by the test suite.
  // This is NON-FATAL: full-stack app packages (Next.js web, databases) often
  // fail here because they need secrets (DATABASE_URL, REDIS_URL, etc.) that
  // aren't available in the audit sandbox.  Turbo / nx build in dependency
  // order, so library packages that tests import will have built successfully
  // before the app package fails.  We warn and continue.
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

  // ── 9c. Invasive instrumentation injection ────────────────────────────────
  //
  // PHP repos:  modify phpunit.xml to register our PHPUnit 10/11 extension.
  //             Done AFTER install so vendor/phpunit/phpunit/composer.json exists
  //             and we can detect the major version before injecting.
  //
  // TypeScript/Vitest repos:  write vitest.config.tracegraph.ts (untracked) that
  //             extends the repo's own config with our reporter, then override the
  //             test command to pass --config to vitest through the package script.
  //             Done AFTER install so node_modules/vitest is available.
  //
  // Both approaches only create untracked files or modify phpunit.xml (which is
  // either a new untracked copy of .dist, or gets re-injected before Phase C).

  let phpAdapterSrc:    string | null = null;
  let phpInjected       = false;
  let invasiveTsConfig  = false;

  if (stack.language === 'php') {
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
        }
      }
    }
  } else if (stack.language === 'node' && stack.testRunner === 'vitest') {
    const baseConfig   = findVitestConfig(repoDir);
    const reporterPath = tgPaths.vitestReporterMjs ?? tgPaths.vitestReporter;
    if (baseConfig && reporterPath) {
      const reporterFwd = reporterPath.replace(/\\/g, '/');
      invasiveTsConfig  = writeVitestWrapperConfig(repoDir, baseConfig, reporterFwd);
      if (invasiveTsConfig) {
        // Override test command to use the wrapper config.
        // Appending `-- --config` passes the flag through the package manager script
        // to vitest (works for npm/pnpm/yarn run; bypasses --reporter= CLI flag for
        // Turbo repos where extra flags are otherwise swallowed).
        const rawParts   = stack.rawTestCmd.trim().split(/\s+/);
        testCmd          = [...rawParts, '--', '--config', 'vitest.config.tracegraph.ts'];
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

  // ── 10. Baseline run on the base branch ───────────────────────────────────
  log(`\n${'─'.repeat(60)}`);
  log(`PHASE A — Baseline run on ${selectedPR.base?.ref ?? 'main'}`);
  log(`${'─'.repeat(60)}`);
  log(`Running: tracegraph run -- ${testCmd.join(' ')}`);

  const baselineRunCode = runTracegraph(
    ['run', '--', ...testCmd],
    repoDir,
    extraEnv,
    timeoutMs,
  );

  // Exit 127 = shell "command not found" — test runner binary not installed.
  // Exit 127 = shell "command not found" (test runner not installed)
  if (baselineRunCode === 127) {
    process.stderr.write(
      '[tracegraph audit] Test runner binary not found (exit 127).\n' +
      `  Command: ${testCmd.join(' ')}\n` +
      '  Dependency install may have failed — see npm/yarn output above.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // EXIT_TIMEOUT = tracegraph run was killed because the test suite exceeded the timeout.
  // Partial traces may exist but are unreliable — abort with guidance.
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

  // ── 12. Run tests on the PR branch ───────────────────────────────────────
  log(`\n${'─'.repeat(60)}`);
  log(`PHASE C — Running tests on PR #${selectedPR.number}`);
  log(`${'─'.repeat(60)}`);
  log(`Running: tracegraph run -- ${testCmd.join(' ')}`);

  const prRunCode = runTracegraph(
    ['run', '--', ...testCmd],
    repoDir,
    extraEnv,
    timeoutMs,
  );
  if (prRunCode !== 0) {
    warn(`Tests returned exit code ${prRunCode} on the PR branch.`);
    warn('Continuing with compare — findings are still valid.');
  }

  // ── 13. Compare ────────────────────────────────────────────────────────────
  log(`\n${'─'.repeat(60)}`);
  log('PHASE D — Comparing against baseline');
  log(`${'─'.repeat(60)}`);

  runTracegraph(['compare'], repoDir, extraEnv);

  // ── 14. Generate report ────────────────────────────────────────────────────
  log(`\n${'─'.repeat(60)}`);
  log('PHASE E — Generating report');
  log(`${'─'.repeat(60)}`);

  const reportFormat = opts.json ? 'json' : 'markdown';
  runTracegraph(['report', '--format', reportFormat], repoDir, extraEnv);

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

  process.stdout.write(`\n${'═'.repeat(60)}\n`);
  process.stdout.write(`TraceGraph Audit — ${owner}/${repo}  PR #${selectedPR.number}\n`);
  process.stdout.write(`"${selectedPR.title}"\n`);
  process.stdout.write(`Author: ${selectedPR.user.login}  |  `);
  if (selectedPR.additions != null) {
    process.stdout.write(`+${selectedPR.additions}/-${selectedPR.deletions}  ${selectedPR.changed_files} files\n`);
  } else {
    process.stdout.write('\n');
  }
  process.stdout.write(`Capture level: ${captureLevel}\n`);
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

  process.stdout.write(`${'═'.repeat(60)}\n`);

  return EXIT_CODES.SUCCESS;
}
