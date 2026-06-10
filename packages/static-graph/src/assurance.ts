/**
 * G3C — Assurance Level Model
 *
 * Computes the overall evidence quality for a project, route, or function.
 * Used in `tracegraph scan`, `tracegraph compare`, and `tracegraph coverage`
 * to be honest about how strong the findings evidence is.
 *
 * Levels:
 *   0 = Unknown        — no static graph, no runtime trace
 *   1 = Static-known   — appears in Graphify graph
 *   2 = Risk-classified — god-node, community, blast-radius computed
 *   3 = Runtime-observed — at least one runtime trace exercised it
 *   4 = Runtime-baselined — expected behavior approved and stored
 *   5 = Contract-protected — runtime contract enforces must-call/must-not
 */
import type { AssuranceLevel, AssuranceLevelValue, ArchitectureQualityLevel } from '@tracegraph/shared-types';

export type AssuranceLevelInput = {
  staticGraphAvailable:     boolean;
  riskClassified:           boolean;
  runtimeTraceAvailable:    boolean;
  runtimeBaselineAvailable: boolean;
  contractAvailable:        boolean;
  // G6: architecture quality metadata
  architectureQualityLevel?: ArchitectureQualityLevel;
  architectureNodes?:        number;
  architectureEdges?:        number;
  architectureCommunities?:  number;
  /**
   * G18: True when all candidate traces were captured at Level 0. Passed through
   * to AssuranceLevel so the CI reporter can distinguish "baseline not created"
   * from "baseline not comparable (PR captured nothing)".
   */
  allTracesLevel0?:          boolean;
};

const LEVEL_LABELS: Record<AssuranceLevelValue, string> = {
  0: 'Unknown — no static graph, no runtime trace',
  1: 'Static-known — architecture mapped',
  2: 'Risk-classified — god nodes and communities computed',
  3: 'Runtime-observed — code exercised at least once',
  4: 'Runtime-baselined — expected behavior approved',
  5: 'Contract-protected — must-call/must-not enforced',
};

export function computeAssuranceLevel(opts: AssuranceLevelInput): AssuranceLevel {
  let level: AssuranceLevelValue = 0;
  if (opts.staticGraphAvailable)     level = Math.max(level, 1) as AssuranceLevelValue;
  if (opts.riskClassified)           level = Math.max(level, 2) as AssuranceLevelValue;
  if (opts.runtimeTraceAvailable)    level = Math.max(level, 3) as AssuranceLevelValue;
  if (opts.runtimeBaselineAvailable) level = Math.max(level, 4) as AssuranceLevelValue;
  if (opts.contractAvailable)        level = Math.max(level, 5) as AssuranceLevelValue;

  return {
    level,
    label:                    LEVEL_LABELS[level],
    staticGraphAvailable:     opts.staticGraphAvailable,
    runtimeTraceAvailable:    opts.runtimeTraceAvailable,
    runtimeBaselineAvailable: opts.runtimeBaselineAvailable,
    contractAvailable:        opts.contractAvailable,
    // G18: pass through so the CI reporter can distinguish "not created" from
    // "not comparable" (baselines exist but PR capture was Level 0)
    ...(opts.allTracesLevel0 !== undefined
      ? { allTracesLevel0: opts.allTracesLevel0 }
      : {}),
    // G6: pass through architecture quality fields (undefined = not applicable)
    ...(opts.architectureQualityLevel !== undefined
      ? { architectureQualityLevel: opts.architectureQualityLevel }
      : {}),
    ...(opts.architectureNodes !== undefined
      ? { architectureNodes: opts.architectureNodes }
      : {}),
    ...(opts.architectureEdges !== undefined
      ? { architectureEdges: opts.architectureEdges }
      : {}),
    ...(opts.architectureCommunities !== undefined
      ? { architectureCommunities: opts.architectureCommunities }
      : {}),
  };
}

/** Human-readable representation for CLI output. */
export function formatAssuranceLevel(a: AssuranceLevel): string {
  const ticks = [
    a.staticGraphAvailable     ? '✅ Static graph' : '○  Static graph',
    a.runtimeTraceAvailable    ? '✅ Runtime traces' : '○  Runtime traces',
    a.runtimeBaselineAvailable ? '✅ Runtime baselines' : '○  Runtime baselines',
    a.contractAvailable        ? '✅ Contracts' : '○  Contracts',
  ];
  return `Level ${a.level} — ${a.label}\n  ${ticks.join('  ')}`;
}
