/**
 * G2 — Runtime trace enricher
 *
 * Attaches static architecture metadata (event.static) to runtime TraceEvents
 * by running the resolver over function_call and method_call events.
 *
 * Enrichment is:
 *   - Post-run only: never at capture time
 *   - Idempotent: re-running produces the same result
 *   - Non-destructive: events without a match are left completely unchanged
 *   - Atomic: file writes use a .tmp → rename pattern to avoid corruption
 *
 * Event types enriched (by default):
 *   function_call, method_call, auth_check, authorization_check
 */
import * as fs        from 'fs';
import * as path      from 'path';
import type { TraceSession } from '@tracegraph/shared-types';
import type { GraphIndex }   from './indexer';
import { resolveEvent, resultToStaticMeta } from './resolver';
import type { ResolverConfig } from './resolver';

// ─── Configuration ─────────────────────────────────────────────────────────────

/** Event types that are candidates for static enrichment. */
const ENRICHABLE_TYPES = new Set([
  'function_call',
  'method_call',
  'auth_check',
  'authorization_check',
  // HTTP events — enriched via URL→route-handler matching (confidence ≤ 0.75).
  // Enables derive-edges to build route-level call graphs from Level 3-4 JS/TS traces.
  'http_request',
  'external_http_call',
]);

// ─── Session enricher ─────────────────────────────────────────────────────────

export type EnrichStats = {
  /** Number of events that received a static metadata attachment. */
  enrichedCount: number;
  /** Number of events that were candidates but had no match above confidence. */
  skippedCount:  number;
  /** Total events inspected. */
  totalEvents:   number;
};

/**
 * Enrich a `TraceSession` in-place.
 * Mutates `session.events` directly (adds `event.static` where resolved).
 * Returns enrichment statistics.
 */
export function enrichSession(
  session: TraceSession,
  index:   GraphIndex,
  config:  ResolverConfig = {},
): EnrichStats {
  let enrichedCount = 0;
  let skippedCount  = 0;

  for (const event of session.events) {
    if (!ENRICHABLE_TYPES.has(event.type)) continue;

    const result = resolveEvent(event, index, config);
    if (result) {
      // Idempotent: only update if there's no existing match or this one is better
      const existing = event.static;
      if (!existing || (result.confidence > (existing.matchConfidence ?? 0))) {
        event.static = resultToStaticMeta(result);
        enrichedCount++;
      }
    } else {
      skippedCount++;
    }
  }

  return { enrichedCount, skippedCount, totalEvents: session.events.length };
}

// ─── File-level enricher ──────────────────────────────────────────────────────

export type FileEnrichResult =
  | { ok: true;  stats: EnrichStats; path: string }
  | { ok: false; error: string; path: string };

/**
 * Read a `.trace.json` file, enrich it with static metadata, and write it
 * back atomically (via `.tmp` → rename).
 *
 * @param traceFilePath Absolute path to the `.trace.json` file.
 * @param index         Pre-built graph index.
 * @param config        Resolver configuration.
 */
export function enrichTraceFile(
  traceFilePath: string,
  index:         GraphIndex,
  config:        ResolverConfig = {},
): FileEnrichResult {
  // Read
  let session: TraceSession;
  try {
    session = JSON.parse(fs.readFileSync(traceFilePath, 'utf8')) as TraceSession;
  } catch (err) {
    return { ok: false, error: `Cannot read trace: ${String(err)}`, path: traceFilePath };
  }

  // Validate schema version (don't corrupt unexpected files)
  if (session.schemaVersion !== 'tracegraph.trace.v1') {
    return {
      ok:    false,
      error: `Unexpected schema version: ${session.schemaVersion}`,
      path:  traceFilePath,
    };
  }

  // Enrich in-place
  const stats = enrichSession(session, index, config);

  // Write back atomically
  const tmpPath = `${traceFilePath}.enrich.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, traceFilePath);
  } catch (err) {
    // Clean up tmp file if rename failed
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { ok: false, error: `Cannot write trace: ${String(err)}`, path: traceFilePath };
  }

  return { ok: true, stats, path: traceFilePath };
}

// ─── Batch enricher ───────────────────────────────────────────────────────────

export type BatchEnrichResult = {
  files:         number;
  enriched:      number;
  eventMatches:  number;
  errors:        number;
};

/**
 * Enrich all `.trace.json` files in a directory.
 * Non-fatal on individual file errors.
 *
 * @param tracesDir     Directory containing `.trace.json` files.
 * @param index         Pre-built graph index.
 * @param config        Resolver configuration.
 * @param onProgress    Optional per-file progress callback.
 */
export function enrichTracesDir(
  tracesDir:   string,
  index:       GraphIndex,
  config:      ResolverConfig = {},
  onProgress?: (msg: string) => void,
): BatchEnrichResult {
  const result: BatchEnrichResult = { files: 0, enriched: 0, eventMatches: 0, errors: 0 };

  if (!fs.existsSync(tracesDir)) return result;

  const files = fs.readdirSync(tracesDir).filter((f) => f.endsWith('.trace.json'));

  for (const file of files) {
    result.files++;
    const fullPath = path.join(tracesDir, file);
    const r = enrichTraceFile(fullPath, index, config);
    if (r.ok) {
      if (r.stats.enrichedCount > 0) {
        result.enriched++;
        result.eventMatches += r.stats.enrichedCount;
        onProgress?.(`  ✅  ${file}  (+${r.stats.enrichedCount} matches)`);
      } else {
        onProgress?.(`  ○   ${file}  (no matches)`);
      }
    } else {
      result.errors++;
      onProgress?.(`  ❌  ${file}  ${r.error}`);
    }
  }

  return result;
}

/**
 * Enrich a specific list of trace file paths (used by run.ts after a run).
 * Returns a compact summary for logging.
 */
export function enrichTraceFiles(
  traceFilePaths: string[],
  index:          GraphIndex,
  config:         ResolverConfig = {},
): BatchEnrichResult {
  const result: BatchEnrichResult = { files: 0, enriched: 0, eventMatches: 0, errors: 0 };

  for (const filePath of traceFilePaths) {
    if (!fs.existsSync(filePath)) continue;
    result.files++;
    const r = enrichTraceFile(filePath, index, config);
    if (r.ok) {
      if (r.stats.enrichedCount > 0) {
        result.enriched++;
        result.eventMatches += r.stats.enrichedCount;
      }
    } else {
      result.errors++;
    }
  }

  return result;
}
