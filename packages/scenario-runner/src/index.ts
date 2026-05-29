/**
 * @tracegraph/scenario-runner — public API
 *
 * M6: Scenario Runner + TraceBundle
 */

// ── Orchestrator ──────────────────────────────────────────────────────────────
export { runScenario, loadScenarioDefinition } from './runner';
export type { ScenarioRunOptions }              from './runner';

// ── Server lifecycle ──────────────────────────────────────────────────────────
export { ServerManager }   from './server-manager';
export type { ServerHandle } from './server-manager';

// ── HTTP step executor ─────────────────────────────────────────────────────────
export { executeStep }      from './http-runner';
export type { StepContext } from './http-runner';

// ── Bundle linker ──────────────────────────────────────────────────────────────
export { createBundle } from './bundle-linker';
