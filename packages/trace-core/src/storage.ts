import fs from 'fs';
import path from 'path';

export type StorageConfig = {
  compressCompletedRuns?: boolean;
  maxRuns?: number;
  maxAgeDays?: number;
  maxSizeMB?: number;
  keepFailedRuns?: number;
  pruneOnRun?: boolean;
};

export const DEFAULT_STORAGE_CONFIG: Required<StorageConfig> = {
  compressCompletedRuns: false,
  maxRuns: 20,
  maxAgeDays: 7,
  maxSizeMB: 500,
  keepFailedRuns: 50,
  pruneOnRun: true,
};

export type StorageStatus = {
  runs: number;
  traces: number;
  baselines: number;
  totalSizeMB: number;
  location: string;
};

export type CleanOptions = {
  olderThan?: string;
  keepLast?: number;
  allRuns?: boolean;
};

export class StorageManager {
  private readonly cfg: Required<StorageConfig>;

  constructor(
    private readonly tracegraphDir: string,
    config: StorageConfig = {},
  ) {
    this.cfg = { ...DEFAULT_STORAGE_CONFIG, ...config };
  }

  /**
   * Auto-prune based on the storage config (called after each run when pruneOnRun: true).
   * Never prunes baselines, approvals, suppressions, or scenarios.
   */
  prune(): void {
    this.cleanRuns({ keepLast: this.cfg.maxRuns, maxAgeDays: this.cfg.maxAgeDays });
  }

  /**
   * Manual clean with explicit options.
   */
  clean(opts: CleanOptions = {}): void {
    if (opts.allRuns) {
      this.removeAllRuns();
      return;
    }
    if (opts.keepLast !== undefined) {
      this.cleanRuns({ keepLast: opts.keepLast });
      return;
    }
    if (opts.olderThan) {
      this.cleanRuns({ maxAgeDays: parseOlderThanDays(opts.olderThan) });
      return;
    }
    // No option: apply config defaults
    this.prune();
  }

  status(): StorageStatus {
    const runsDir      = path.join(this.tracegraphDir, 'runs');
    const tracesDir    = path.join(this.tracegraphDir, 'traces');
    const baselinesDir = path.join(this.tracegraphDir, 'baselines');

    const runs      = countDir(runsDir);
    const traces    = countFiles(tracesDir, '.trace.json');
    const baselines = countFiles(baselinesDir, '.baseline.json');
    const totalBytes = dirSizeBytes(this.tracegraphDir);

    return {
      runs,
      traces,
      baselines,
      totalSizeMB: roundMB(totalBytes),
      location: this.tracegraphDir,
    };
  }

  // ─── private ────────────────────────────────────────────────────────────────

  private cleanRuns(opts: { keepLast?: number; maxAgeDays?: number }): void {
    const runsDir = path.join(this.tracegraphDir, 'runs');
    if (!fs.existsSync(runsDir)) return;

    const now = Date.now();
    const maxAgeMs = (opts.maxAgeDays ?? this.cfg.maxAgeDays) * 24 * 60 * 60 * 1000;
    const keepLast = opts.keepLast ?? this.cfg.maxRuns;

    const runs = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        fullPath: path.join(runsDir, e.name),
        mtime: safeStatMtime(path.join(runsDir, e.name)),
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (run === undefined) continue;
      const tooOld  = now - run.mtime > maxAgeMs;
      const overMax = i >= keepLast;
      if (tooOld || overMax) {
        fs.rmSync(run.fullPath, { recursive: true, force: true });
      }
    }
  }

  private removeAllRuns(): void {
    const runsDir = path.join(this.tracegraphDir, 'runs');
    if (!fs.existsSync(runsDir)) return;
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        fs.rmSync(path.join(runsDir, entry.name), { recursive: true, force: true });
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countDir(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

function countFiles(dir: string, suffix: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).length;
}

function dirSizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* ignore race conditions */
      }
    }
  }
  return total;
}

function safeStatMtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function roundMB(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/** Parse "7d", "12h", "30m" → number of days */
function parseOlderThanDays(value: string): number {
  const m = value.match(/^(\d+)([dhm]?)$/);
  if (!m) return 7;
  const n = parseInt(m[1]!, 10);
  const unit = m[2] || 'd';
  if (unit === 'h') return n / 24;
  if (unit === 'm') return n / (24 * 60);
  return n;
}
