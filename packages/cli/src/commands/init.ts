/**
 * T1.9 — `tracegraph init`
 *
 * One-command project setup. Detects the package manager and test runner,
 * adds four scripts to package.json, creates tracegraph.config.json,
 * and updates .gitignore (idempotently).
 */
import fs            from 'fs';
import path          from 'path';
import { spawnSync } from 'child_process';

export function initCommand(): void {
  const cwd = process.cwd();

  // ── Pre-flight environment checks ─────────────────────────────────────────
  runPreflightChecks(cwd);

  const pm         = detectPackageManager(cwd);
  const testRunner = detectTestRunner(cwd);
  const framework  = detectFramework(cwd);

  process.stdout.write('[tracegraph] Initialising project...\n\n');

  // ── Add scripts to package.json ───────────────────────────────────────────
  addPackageJsonScripts(cwd, pm, testRunner);

  // ── Create tracegraph.config.json ─────────────────────────────────────────
  createConfig(cwd, framework);

  // ── Update .gitignore ─────────────────────────────────────────────────────
  updateGitignore(cwd);

  // ── Summary ───────────────────────────────────────────────────────────────
  process.stdout.write('\n[tracegraph] Done! Next steps:\n\n');
  process.stdout.write(`  1. Install the adapter:  ${pm} add -D @tracegraph/trace-js\n`);
  process.stdout.write(`  2. Add middleware:        app.use(traceExpress())  // before routes\n`);
  process.stdout.write(`  3. Run a trace:          ${pm} run trace:test\n`);
  process.stdout.write(`  4. View the graph:       ${pm} run trace:report\n\n`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

function detectPackageManager(cwd: string): PackageManager {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock')))       return 'yarn';
  if (fs.existsSync(path.join(cwd, 'bun.lockb')))       return 'bun';
  return 'npm';
}

function detectTestRunner(cwd: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      dependencies?:    Record<string, string>;
    };
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if ('vitest'     in all) return 'vitest run';
    if ('jest'       in all) return 'jest';
    if ('playwright' in all) return 'playwright test';
    if ('mocha'      in all) return 'mocha';
  } catch { /* no package.json */ }
  return 'test';
}

function detectFramework(cwd: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};
    if ('express'   in deps) return 'express';
    if ('fastify'   in deps) return 'fastify';
    if ('next'      in deps) return 'nextjs';
    if ('@nestjs/core' in deps) return 'nestjs';
  } catch { /* no package.json */ }
  return 'plain';
}

function addPackageJsonScripts(cwd: string, pm: PackageManager, testRunner: string): void {
  const pkgPath = path.join(cwd, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    process.stderr.write('[tracegraph] No package.json found — skipping script injection\n');
    return;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    process.stderr.write('[tracegraph] Failed to parse package.json — skipping script injection\n');
    return;
  }

  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  const added: string[] = [];

  const newScripts: Record<string, string> = {
    'trace:test':     `tracegraph run -- ${pm} run ${testRunner}`,
    'trace:baseline': 'tracegraph baseline create',
    'trace:compare':  'tracegraph compare',
    'trace:report':   'tracegraph open --html .tracegraph/reports/latest.report.json',
  };

  for (const [key, value] of Object.entries(newScripts)) {
    if (!scripts[key]) {
      scripts[key] = value;
      added.push(key);
    } else {
      process.stdout.write(`  [skip] ${key} already exists in package.json\n`);
    }
  }

  pkg.scripts = scripts;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  if (added.length > 0) {
    process.stdout.write(`  [ok] Added scripts to package.json: ${added.join(', ')}\n`);
  }
}

function createConfig(cwd: string, framework: string): void {
  const configPath = path.join(cwd, 'tracegraph.config.json');

  if (fs.existsSync(configPath)) {
    process.stdout.write('  [skip] tracegraph.config.json already exists\n');
    return;
  }

  const config = {
    language:  'typescript',
    framework,
    sanitize: {
      redactKeys:      [],
      maxDepth:        4,
      maxStringLength: 500,
      maxArrayLength:  50,
    },
    storage: {
      maxRuns:         20,
      maxAgeDays:      7,
      maxSizeMB:       500,
      keepFailedRuns:  50,
      pruneOnRun:      true,
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  process.stdout.write('  [ok] Created tracegraph.config.json\n');
}

const GITIGNORE_ENTRIES = [
  '# TraceGraph',
  '.tracegraph/runs/',
  '.tracegraph/traces/',
  '.tracegraph/reports/',
  '.tracegraph/bundles/',
  '.tracegraph/index.json',
];

// ─── Pre-flight environment checks ───────────────────────────────────────────

type CheckResult = { label: string; value: string; ok: boolean; hint?: string };

function runPreflightChecks(cwd: string): void {
  process.stdout.write('[tracegraph] Checking your environment...\n\n');

  const results: CheckResult[] = [];

  // Node.js version (required ≥18)
  const nodeVersion = process.versions.node ?? '0.0.0';
  const nodeMajor   = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  results.push({
    label: 'Node.js',
    value: nodeVersion,
    ok:    nodeMajor >= 18,
    hint:  nodeMajor < 18 ? 'Upgrade to Node.js 18+ (https://nodejs.org)' : undefined,
  });

  // npm / pnpm / yarn
  const pm = detectPackageManager(cwd);
  const pmVersion = runVersionCmd(pm, ['--version']);
  results.push({ label: pm, value: pmVersion ?? '?', ok: pmVersion !== null });

  // PHP (only if composer.json exists)
  if (fs.existsSync(path.join(cwd, 'composer.json'))) {
    const phpVersion = runVersionCmd('php', ['--version'], /PHP (\S+)/);
    results.push({
      label: 'PHP',
      value: phpVersion ?? 'not found',
      ok:    phpVersion !== null,
      hint:  phpVersion === null ? 'Install PHP 8.1+ (https://www.php.net/downloads)' : undefined,
    });

    // Xdebug
    const xdebugVersion = runVersionCmd('php', ['-r', "echo phpversion('xdebug');"], /^(\S+)/);
    const xdebugOk = xdebugVersion !== null && xdebugVersion !== '' && xdebugVersion !== 'false';
    results.push({
      label: 'Xdebug',
      value: xdebugOk ? (xdebugVersion ?? '') : 'not found',
      ok:    xdebugOk,
      hint:  !xdebugOk
        ? 'PHP traces will be capture level 1 only. Install: pecl install xdebug (https://xdebug.org)'
        : undefined,
    });
  }

  // Python (only if requirements.txt or pyproject.toml exists)
  if (
    fs.existsSync(path.join(cwd, 'requirements.txt')) ||
    fs.existsSync(path.join(cwd, 'pyproject.toml'))
  ) {
    const pyVersion = runVersionCmd('python3', ['--version'], /Python (\S+)/)
      ?? runVersionCmd('python', ['--version'], /Python (\S+)/);
    results.push({
      label: 'Python',
      value: pyVersion ?? 'not found',
      ok:    pyVersion !== null,
      hint:  pyVersion === null ? 'Install Python 3.10+ (https://www.python.org)' : undefined,
    });
  }

  // Java (only if pom.xml or build.gradle exists)
  if (
    fs.existsSync(path.join(cwd, 'pom.xml')) ||
    fs.existsSync(path.join(cwd, 'build.gradle')) ||
    fs.existsSync(path.join(cwd, 'build.gradle.kts'))
  ) {
    const javaVersion = runVersionCmd('java', ['-version'], /version "([^"]+)"/);
    results.push({
      label: 'Java',
      value: javaVersion ?? 'not found',
      ok:    javaVersion !== null,
      hint:  javaVersion === null ? 'Install JDK 17+ (https://adoptium.net)' : undefined,
    });
  }

  // Git
  const gitVersion = runVersionCmd('git', ['--version'], /git version (.+)/);
  results.push({
    label: 'Git',
    value: gitVersion ?? 'not found',
    ok:    gitVersion !== null,
    hint:  gitVersion === null ? 'Git is needed for `approvedBy` attribution. Install git.' : undefined,
  });

  // Print results
  let hasWarnings = false;
  for (const r of results) {
    const icon = r.ok ? '  ✓' : '  ✗';
    process.stdout.write(`${icon}  ${r.label.padEnd(12)} ${r.value}\n`);
    if (!r.ok && r.hint) {
      process.stdout.write(`        → ${r.hint}\n`);
      hasWarnings = true;
    }
  }
  process.stdout.write('\n');

  if (hasWarnings) {
    process.stdout.write(
      '[tracegraph] Some checks failed — TraceGraph will still work but capture may be limited.\n\n',
    );
  }

  // Persist environment snapshot for `tracegraph diagnose`
  persistEnvironmentJson(cwd, results);
}

function runVersionCmd(
  cmd:     string,
  args:    string[],
  pattern?: RegExp,
): string | null {
  try {
    const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32' });
    if (result.error || result.status !== 0) {
      // Some tools write version to stderr (e.g. java -version)
      const output = (result.stdout ?? '') + (result.stderr ?? '');
      if (!pattern || !output) return null;
      const m = output.match(pattern);
      return m ? (m[1] ?? m[0] ?? null) : null;
    }
    const out = (result.stdout ?? '').trim() + (result.stderr ?? '').trim();
    if (!out) return null;
    if (!pattern) return out.split('\n')[0] ?? out;
    const m = out.match(pattern);
    return m ? (m[1] ?? m[0] ?? null) : null;
  } catch {
    return null;
  }
}

function persistEnvironmentJson(cwd: string, results: CheckResult[]): void {
  const tracegraphDir = path.join(cwd, '.tracegraph');
  try {
    fs.mkdirSync(tracegraphDir, { recursive: true });
    const env: Record<string, string | null> = {};
    for (const r of results) {
      env[r.label.toLowerCase()] = r.ok ? r.value : null;
    }
    env['checkedAt'] = new Date().toISOString();
    fs.writeFileSync(
      path.join(tracegraphDir, 'environment.json'),
      JSON.stringify(env, null, 2) + '\n',
      'utf8',
    );
  } catch { /* non-fatal */ }
}

function updateGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const existing      = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';

  const toAdd = GITIGNORE_ENTRIES.filter(
    (entry) => !entry.startsWith('#') && !existing.includes(entry),
  );

  if (toAdd.length === 0) {
    process.stdout.write('  [skip] .gitignore already contains TraceGraph entries\n');
    return;
  }

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const addition  = separator + GITIGNORE_ENTRIES.join('\n') + '\n';
  fs.appendFileSync(gitignorePath, addition, 'utf8');
  process.stdout.write('  [ok] Updated .gitignore\n');
}
