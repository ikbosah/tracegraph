import fs from 'fs';
import type { TraceSession, TraceIndex } from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS, EXIT_CODES } from '@tracegraph/shared-types';

export class SchemaVersionError extends Error {
  constructor(
    public readonly file: string,
    public readonly found: string,
    public readonly expected: string,
  ) {
    super(
      `Schema version mismatch in ${file}: found "${found}", expected "${expected}". ` +
      `Run: tracegraph baseline migrate`,
    );
    this.name = 'SchemaVersionError';
  }

  readonly exitCode = EXIT_CODES.SCHEMA_MIGRATION;
}

/**
 * Read and validate a finalised trace file.
 * Throws SchemaVersionError (exit 5) if schemaVersion does not match.
 */
export function readTrace(filePath: string): TraceSession {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<TraceSession>;

  if (parsed.schemaVersion !== SCHEMA_VERSIONS.trace) {
    throw new SchemaVersionError(
      filePath,
      parsed.schemaVersion ?? '(missing)',
      SCHEMA_VERSIONS.trace,
    );
  }

  return parsed as TraceSession;
}

/**
 * Read the trace index. Returns an empty index if the file does not exist.
 */
export function readTraceIndex(tracegraphDir: string): TraceIndex {
  const indexPath = require('path').join(tracegraphDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    return { schemaVersion: SCHEMA_VERSIONS.index, traces: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as TraceIndex;
  } catch {
    return { schemaVersion: SCHEMA_VERSIONS.index, traces: [] };
  }
}
