/**
 * T4.8 — Xdebug streaming parser
 *
 * Converts a readable stream of Xdebug `.xt` trace lines into an async
 * iterator of `XdebugEntry` records.  A higher-level caller (the merger)
 * converts those into `TraceEvent` objects.
 *
 * Xdebug trace format 1 (human-readable, the default):
 *
 *   TRACE START [2024-01-01 12:00:00.000000]
 *   Version: 3.x.x
 *   File format: 4
 *       0.0001     262064   -> {main}() /app/index.php:0
 *       0.0002     263088     -> SomeClass->method() /app/Svc.php:42
 *       0.0003     264016     -> tracegraph_xdebug_marker() /app/Svc.php:43
 *       0.0004     263088     <- tracegraph_xdebug_marker() /app/Svc.php:43
 *       0.0005     263088     <- SomeClass->method() /app/Svc.php:42
 *   TRACE END   [2024-01-01 12:00:00.123456]
 *
 * Notes:
 *   - Depth is inferred from the number of leading spaces / tabs (2 spaces = 1 level).
 *   - `tracegraph_xdebug_marker('<eventId>')` calls serve as correlation anchors.
 *   - Return events (`<-`) may or may not include file/line on all Xdebug versions;
 *     the parser tolerates missing trailing fields.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export type XdebugEntryKind = 'entry' | 'exit' | 'marker';

export type XdebugEntry = {
  kind:       XdebugEntryKind;
  depth:      number;          // nesting level, 0 = top
  timeIndex:  number;          // seconds since trace start (float)
  memoryBytes: number;
  fnName:     string;          // function / method name
  file?:      string;
  line?:      number;
  /** Only set for kind === 'marker': the event ID extracted from the marker call. */
  markerEventId?: string;
};

export type XdebugParseResult = {
  /** All parsed entries (entry + exit + markers) */
  entries:     XdebugEntry[];
  /** Wall-clock timestamp string from TRACE START line (if present) */
  traceStart?: string;
  /** Wall-clock timestamp string from TRACE END line (if present) */
  traceEnd?:   string;
};

// ─── Regexes ──────────────────────────────────────────────────────────────────

// Matches: optional whitespace/tabs, time, memory, -> or <-,  fn name, file:line
//   group 1: leading whitespace (for depth inference)
//   group 2: time index (float)
//   group 3: memory (integer)
//   group 4: '->' or '<-'
//   group 5: function name (may include Class->method or Class::method)
//   group 6: file path (optional)
//   group 7: line number (optional)
const LINE_RE = /^(\s*)([\d.]+)\s+(\d+)\s+(->|<-)\s+(.+?)(?:\s+(\/[^\s:]+|[A-Za-z]:[^\s:]+):(\d+))?\s*$/;

// TRACE START header
const TRACE_START_RE = /^TRACE START\s+\[(.+)\]/;
// TRACE END footer
const TRACE_END_RE   = /^TRACE END\s+\[(.+)\]/;

// Marker function name pattern
const MARKER_FN = 'tracegraph_xdebug_marker';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parses a complete Xdebug trace file string into `XdebugParseResult`.
 *
 * For large files, use `parseXdebugStream` instead to avoid loading the
 * entire file into memory.
 */
export function parseXdebugString(content: string): XdebugParseResult {
  const lines = content.split(/\r?\n/);
  return parseLinesSync(lines);
}

/**
 * Asynchronously parses an Xdebug trace file from a `ReadableStream` of
 * UTF-8 text lines (e.g., a Node.js `readline.Interface`).
 *
 * @example
 *   import { createReadStream } from 'fs';
 *   import { createInterface }  from 'readline';
 *
 *   const rl = createInterface({ input: createReadStream('trace.xt'), crlfDelay: Infinity });
 *   const result = await parseXdebugStream(rl);
 */
export async function parseXdebugStream(
  lines: AsyncIterable<string>,
): Promise<XdebugParseResult> {
  const result: XdebugParseResult = { entries: [] };

  for await (const line of lines) {
    processLine(line, result);
  }

  return result;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function parseLinesSync(lines: string[]): XdebugParseResult {
  const result: XdebugParseResult = { entries: [] };
  for (const line of lines) {
    processLine(line, result);
  }
  return result;
}

function processLine(line: string, result: XdebugParseResult): void {
  // Header / footer
  const startMatch = TRACE_START_RE.exec(line);
  if (startMatch) { result.traceStart = startMatch[1]; return; }

  const endMatch = TRACE_END_RE.exec(line);
  if (endMatch) { result.traceEnd = endMatch[1]; return; }

  // Skip metadata lines
  if (/^(Version:|File format:)/i.test(line.trim())) return;
  if (line.trim() === '') return;

  const m = LINE_RE.exec(line);
  if (!m) return;

  const [, leadingWS, timeStr, memStr, arrow, fnRaw, file, lineNum] = m;

  const depth       = inferDepth(leadingWS ?? '');
  const timeIndex   = parseFloat(timeStr ?? '0');
  const memoryBytes = parseInt(memStr ?? '0', 10);
  const isEntry     = arrow === '->';
  const fnName      = sanitizeFnName(fnRaw ?? '');

  // Only entry lines ('->' direction) are treated as markers.
  // Exit lines ('<-') for the marker function are emitted as plain 'exit' entries
  // so that depth-tracking stays correct but they don't trigger a second marker.
  const kind: XdebugEntryKind = (isEntry && fnName.startsWith(MARKER_FN))
    ? 'marker'
    : isEntry ? 'entry' : 'exit';

  const entry: XdebugEntry = {
    kind,
    depth,
    timeIndex,
    memoryBytes,
    fnName,
    file:          file  ? file.trim()          : undefined,
    line:          lineNum ? parseInt(lineNum, 10) : undefined,
  };

  // Extract marker event ID from: tracegraph_xdebug_marker('evt_abc123')
  if (kind === 'marker') {
    const idMatch = /tracegraph_xdebug_marker\(\s*'?([^')]+)'?\s*\)/.exec(fnRaw ?? '');
    if (idMatch) {
      entry.markerEventId = idMatch[1]?.trim();
    }
  }

  result.entries.push(entry);
}

/** Infer nesting depth from leading whitespace. */
function inferDepth(ws: string): number {
  // Count tabs first; if no tabs, count pairs of spaces
  const tabs = (ws.match(/\t/g) ?? []).length;
  if (tabs > 0) return tabs;
  return Math.floor(ws.length / 2);
}

/** Strip trailing `()` and normalise the function name string. */
function sanitizeFnName(raw: string): string {
  return raw.replace(/\(\s*[^)]*\)\s*$/, '').trim();
}
