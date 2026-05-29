/**
 * @tracegraph/trace-xdebug — Xdebug trace file parser and Laravel merger.
 *
 * @example
 *   import { parseXdebugString, mergeXdebugTrace } from '@tracegraph/trace-xdebug';
 *
 *   const parsed = parseXdebugString(fs.readFileSync('trace.xt', 'utf8'));
 *   const merged = mergeXdebugTrace(semanticEvents, parsed, Date.now());
 */
export {
  parseXdebugString,
  parseXdebugStream,
  type XdebugEntry,
  type XdebugEntryKind,
  type XdebugParseResult,
} from './parser';

export {
  mergeXdebugTrace,
  mergedTraceToEvents,
  type XdebugDetailEvent,
  type XdebugDetailStream,
  type MergedTrace,
} from './merger';
