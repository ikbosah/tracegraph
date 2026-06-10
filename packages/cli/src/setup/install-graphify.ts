/**
 * Shared Graphify installation utility.
 *
 * Used by:
 *   - bin/postinstall.js  (best-effort silent install on npm install)
 *   - commands/init.ts    (interactive prompt during tracegraph init)
 *   - commands/graph.ts   (tracegraph graph doctor --install)
 */
import { spawnSync } from 'child_process';

// ─── Types ────────────────────────────────────────────────────────────────────

export type GraphifyInstallResult = {
  ok:                boolean;
  alreadyInstalled?: boolean;
  installedWith?:    string;
  error?:            string;
};

// ─── Checks ───────────────────────────────────────────────────────────────────

export function isGraphifyAvailable(): boolean {
  try {
    const r = spawnSync('graphify', ['--version'], {
      encoding: 'utf8', timeout: 5_000, stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    return r.status === 0;
  } catch { return false; }
}

/** Returns the Python version string (e.g. "3.12.1"), or null if Python is not found. */
export function getPythonVersion(): string | null {
  for (const bin of ['python3', 'python', 'py']) {
    try {
      const r = spawnSync(bin, ['--version'], {
        encoding: 'utf8', timeout: 5_000, stdio: 'pipe',
        shell: process.platform === 'win32',
      });
      const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
      const m   = out.match(/Python (\S+)/);
      if (r.status === 0 && m) return m[1] ?? out;
    } catch { /* try next */ }
  }
  return null;
}

// ─── Install ──────────────────────────────────────────────────────────────────

/**
 * Attempt to install Graphify using whichever package manager is available.
 *
 * PyPI package name: graphifyy  (double-y)
 * CLI command:       graphify   (single-y)
 *
 * Installer priority: uv → pipx → pip → pip3 → py -m pip
 * uv is first because it is the tool's own recommended installer and is
 * significantly faster than pip.
 *
 * @param quiet  Suppress subprocess stdout/stderr (used in postinstall).
 */
export function installGraphify(opts: { quiet?: boolean } = {}): GraphifyInstallResult {
  if (isGraphifyAvailable()) {
    return { ok: true, alreadyInstalled: true };
  }

  const stdio = opts.quiet ? 'pipe' : 'inherit';
  const q     = opts.quiet ? ['-q'] : [];

  const installers: Array<{ bin: string; args: string[] }> = [
    // uv: recommended by Graphify's own docs ("uv tool install graphifyy")
    { bin: 'uv',   args: ['tool', 'install', 'graphifyy'] },
    // pipx: isolated env, PEP-recommended for CLI tools
    { bin: 'pipx', args: ['install', 'graphifyy'] },
    // pip / pip3 with --user so no sudo/admin required
    { bin: 'pip',  args: ['install', 'graphifyy', '--user', ...q] },
    { bin: 'pip3', args: ['install', 'graphifyy', '--user', ...q] },
    // Windows py launcher
    { bin: 'py',   args: ['-m', 'pip', 'install', 'graphifyy', '--user', ...q] },
  ];

  for (const { bin, args } of installers) {
    try {
      const r = spawnSync(bin, args, {
        encoding: 'utf8',
        timeout:  120_000,
        stdio,
        shell: process.platform === 'win32',
      });
      if (r.status === 0 && isGraphifyAvailable()) {
        return { ok: true, installedWith: bin };
      }
    } catch { /* installer not found — try next */ }
  }

  return {
    ok:    false,
    error: 'No working Python package manager found (tried uv, pipx, pip, pip3, py -m pip).\n' +
           'Install manually: uv tool install graphifyy  OR  pip install graphifyy',
  };
}
