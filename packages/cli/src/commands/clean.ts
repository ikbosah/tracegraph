import path from 'path';
import { StorageManager } from '@tracegraph/trace-core';
import type { CleanOptions } from '@tracegraph/trace-core';
import { loadConfig } from '../config';

export type CleanCommandOptions = {
  olderThan?: string;
  keepLast?: number;
  allRuns?: boolean;
};

/**
 * `tracegraph clean [--older-than <age>] [--keep-last <n>] [--all-runs]`
 *
 * Removes runs from `.tracegraph/runs/`. Never removes:
 *   - baselines/
 *   - approvals/
 *   - suppressions/
 *   - scenarios/
 */
export function cleanCommand(options: CleanCommandOptions): void {
  const workspaceRoot  = process.cwd();
  const config         = loadConfig(workspaceRoot);
  const tracegraphDir  = path.join(workspaceRoot, '.tracegraph');
  const storage        = new StorageManager(tracegraphDir, config.storage);

  const cleanOpts: CleanOptions = {};
  if (options.allRuns)               cleanOpts.allRuns   = true;
  if (options.keepLast !== undefined) cleanOpts.keepLast  = options.keepLast;
  if (options.olderThan)              cleanOpts.olderThan = options.olderThan;

  storage.clean(cleanOpts);

  const status = storage.status();
  process.stderr.write(
    `[tracegraph] clean: done. Runs remaining: ${status.runs}. ` +
    `Total size: ${status.totalSizeMB} MB\n`,
  );
}
