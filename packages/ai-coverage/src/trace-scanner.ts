/**
 * M7A T7A.1 — Trace scanner
 *
 * Scans a directory of `.trace.json` files and matches trace events against
 * a list of changed functions produced by the diff parser.
 *
 * Matching strategy (in order of confidence):
 *  1. file + functionName/methodName match in the trace event
 *  2. className + methodName match (event.className + event.methodName)
 *  3. "ClassName.methodName" in event.name or event.displayName
 *  4. functionName match alone (lower confidence, but included)
 * 
 * 
 */

import * as fs   from 'fs';
import * as path from 'path';
import type { TraceSession, TraceEvent, ChangedFunction } from '@tracegraph/shared-types';

// ─── Public types ─────────────────────────────────────────────────────────────

export type CoverageMatch = {
  changed:   ChangedFunction;
  traceId:   string;
  eventId:   string;
  traceFile: string;
};

// ─── File utilities ───────────────────────────────────────────────────────────

function listTraceFiles(traceDir: string): string[] {
  if (!fs.existsSync(traceDir)) return [];
  try {
    return fs.readdirSync(traceDir)
      .filter(f => f.endsWith('.trace.json'))
      .map(f => path.join(traceDir, f));
  } catch {
    return [];
  }
}

function loadTrace(traceFile: string): TraceSession | null {
  try {
    const raw = fs.readFileSync(traceFile, 'utf8');
    return JSON.parse(raw) as TraceSession;
  } catch {
    return null;
  }
}

// ─── Matching helpers ─────────────────────────────────────────────────────────

/** Normalise a file path to forward-slash, lowercase for comparison. */
function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Returns true if the event's file attribute can be matched to the changed file.
 * Handles absolute vs. relative, and different OS path separators.
 */
function fileMatches(eventFile: string | undefined, changedFile: string): boolean {
  if (!eventFile) return false;
  const ef = normalisePath(eventFile);
  const cf = normalisePath(changedFile);
  // Match if one ends with the other (handles absolute vs relative)
  return ef === cf || ef.endsWith('/' + cf) || cf.endsWith('/' + ef);
}

/**
 * Returns true if `candidate` equals `target` or if the last `.`-separated
 * segment of `candidate` equals `target` (handles "ClassName.methodName" format).
 */
function nameMatches(candidate: string | undefined, target: string): boolean {
  if (!candidate) return false;
  if (candidate === target) return true;
  const segments = candidate.split('.');
  return segments[segments.length - 1] === target;
}

// ─── Event match logic ────────────────────────────────────────────────────────

/** Event types that can map to user-defined functions or methods. */
const MATCHABLE_TYPES = new Set([
  'function_call',
  'method_call',
  'http_request',   // handler field sometimes names the function
]);

export function eventMatchesFunction(
  event:   TraceEvent,
  changed: ChangedFunction,
): boolean {
  if (!MATCHABLE_TYPES.has(event.type)) return false;

  if (changed.className && changed.methodName) {
    // ─── Class method matching ────────────────────────────────────────────────

    // Direct class + method fields
    const classOk  = event.className === changed.className;
    const methodOk = nameMatches(event.functionName, changed.methodName) ||
                     nameMatches(event.name, changed.methodName);

    if (classOk && methodOk) return true;

    // "ClassName.methodName" in name or displayName
    const combined = `${changed.className}.${changed.methodName}`;
    if (event.name === combined || event.displayName === combined) return true;

    // File + method match (class name might differ in trace, e.g. mangled)
    if (fileMatches(event.file, changed.file) && methodOk) return true;
  }

  if (changed.functionName) {
    // ─── Standalone function matching ────────────────────────────────────────

    const nameOk = event.functionName === changed.functionName ||
                   nameMatches(event.name, changed.functionName);

    if (nameOk) return true;

    // File + name match
    if (fileMatches(event.file, changed.file) && nameOk) return true;
  }

  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan all `.trace.json` files in `traceDir` and return matches for each
 * changed function.  One match per (changed function × trace) pair — multiple
 * events within the same trace for the same function are collapsed to one match.
 */
export function scanTracesForCoverage(
  traceDir:         string,
  changedFunctions: ChangedFunction[],
): CoverageMatch[] {
  if (changedFunctions.length === 0) return [];

  const traceFiles = listTraceFiles(traceDir);
  const matches:    CoverageMatch[] = [];

  for (const traceFile of traceFiles) {
    const session = loadTrace(traceFile);
    if (!session) continue;

    const relFile = path.relative(process.cwd(), traceFile).replace(/\\/g, '/');

    // Index events by type for fast lookup
    for (const event of session.events) {
      for (const changed of changedFunctions) {
        if (!eventMatchesFunction(event, changed)) continue;

        // Collapse to one match per (changed × trace)
        const alreadyMatched = matches.some(
          m => m.changed === changed && m.traceId === session.traceId,
        );
        if (alreadyMatched) continue;

        matches.push({
          changed,
          traceId:   session.traceId,
          eventId:   event.eventId,
          traceFile: relFile,
        });
      }
    }
  }

  return matches;
}
