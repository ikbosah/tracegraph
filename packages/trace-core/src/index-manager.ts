import fs from 'fs';
import path from 'path';
import type { TraceIndex, TraceIndexEntry } from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';

/**
 * Atomically prepend an entry to `.tracegraph/index.json`.
 * Newest entries are first (index 0).
 * The file is written via a .tmp → rename to avoid partial reads.
 */
export function updateTraceIndex(tracegraphDir: string, entry: TraceIndexEntry): void {
  const indexPath = path.join(tracegraphDir, 'index.json');
  const tmpPath   = indexPath + '.tmp';

  let index: TraceIndex = { schemaVersion: SCHEMA_VERSIONS.index, traces: [] };

  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as TraceIndex;
    } catch {
      // Corrupt index — reset to empty
    }
  }

  index.traces.unshift(entry);

  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf8');
  fs.renameSync(tmpPath, indexPath);
}
