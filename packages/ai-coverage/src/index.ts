/**
 * @tracegraph/ai-coverage — M7A
 *
 * Exports:
 *  - `parseDiff()`        — extract changed functions from a unified diff
 *  - `computeCoverage()`  — T7A.1: map changed functions → runtime traces
 *  - `buildPromptPacks()` — T7A.3: generate AI context packs (Cursor / Claude Code / Copilot / MCP)
 */

export { parseDiff }                  from './diff-parser';
export { scanTracesForCoverage,
         eventMatchesFunction }       from './trace-scanner';
export type { CoverageMatch }         from './trace-scanner';
export { computeCoverage, getDiff }   from './coverage';
export type { CoverageOptions }       from './coverage';
export { buildPromptPacks }           from './prompt-pack';
export type { PromptPackOptions }     from './prompt-pack';
