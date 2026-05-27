/**
 * T1.9 — `tracegraph init`
 *
 * One-command project setup. Detects the package manager and test runner,
 * adds four scripts to package.json, creates tracegraph.config.json,
 * and updates .gitignore (idempotently).
 */
import fs   from 'fs';
import path from 'path';

export function initCommand(): void {
  const cwd = process.cwd();

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
    'trace:compare':  'tracegraph compare --baseline .tracegraph/baselines --candidate .tracegraph/latest',
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
