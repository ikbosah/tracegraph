import path from 'path';
import { StorageManager } from '@tracegraph/trace-core';
import { loadConfig } from '../config';

/**
 * `tracegraph storage status`
 *
 * Prints a human-readable summary of the local `.tracegraph/` directory.
 * Output goes to stdout (plain text, not JSONL protocol).
 */
export function storageStatusCommand(): void {
  const workspaceRoot = process.cwd();
  const config        = loadConfig(workspaceRoot);
  const tracegraphDir = path.join(workspaceRoot, '.tracegraph');
  const storage       = new StorageManager(tracegraphDir, config.storage);
  const status        = storage.status();

  const lines = [
    '',
    'TraceGraph Storage',
    '─'.repeat(40),
    `  Runs:        ${status.runs}`,
    `  Traces:      ${status.traces}`,
    `  Baselines:   ${status.baselines}`,
    `  Total size:  ${status.totalSizeMB} MB`,
    `  Location:    ${status.location}`,
    '',
  ];

  process.stdout.write(lines.join('\n'));
}
