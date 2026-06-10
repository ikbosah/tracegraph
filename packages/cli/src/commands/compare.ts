/**
 * T2.8 — `tracegraph compare`
 *
 * Compares a candidate trace (or set of traces) against stored baselines and
 * produces a TraceReport.
 *
 * Usage:
 *   tracegraph compare --baseline .tracegraph/baselines
 *                      --candidate .tracegraph/traces/latest.trace.json
 *                      [--out .tracegraph/reports/report.json]
 *                      [--fail-on-critical]
 */
import fs   from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { EXIT_CODES, SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type {
  TraceBundle,
  TraceSession,
  TraceReport,
  BehaviorDiff,
  EvaluatedFinding,
  Finding,
  FindingSeverity,
  SuppressionsFile,
  FindingApprovalsFile,
  LatestPointer,
  CompactBaseline,
  // G6/G7/G8
  TestIdentity,
  TestDelta,
  TraceMatchingSummary,
  ArchitectureQualityLevel,
  AuditVerdict,
  AuditVerdictStatus,
  PrContext,
} from '@tracegraph/shared-types';
import { diffBaseline, diffToFindings, evaluateFindings, analyseTraceFindings, deriveTestId } from '@tracegraph/graph-engine';
import { findBaselineForSession } from './baseline';
import { emit } from '../protocol';
import type { TracegraphConfig, AssuranceLevel } from '@tracegraph/shared-types';
import {
  loadOrRebuildGraphIndex,
  computeAssuranceLevel,
  formatAssuranceLevel,
  loadArchitectureBaseline,
  detectSurpriseEdge,
  runtimeCallEdgesPath,
} from '@tracegraph/static-graph';

export type CompareOptions = {
  baseline?:       string;
  candidate?:      string;
  /**
   * Path to a TraceBundle JSON file.  When supplied, all traces listed in the
   * bundle are loaded and compared instead of using --candidate or latest.json.
   */
  bundle?:         string;
  out?:            string;
  failOnCritical?: boolean;
  /** Use traces from the most recent run recorded in .tracegraph/latest.json. */
  latest?:         boolean;
  /** IMP-3.3: Print remediation snippets below each open finding. */
  verbose?:        boolean;
  /**
   * G5 TG5.4: Skip runtime baseline diff; run only trace-level analysis and
   * architecture findings. Useful before any baselines are created. Reports
   * assurance level 3 (runtime-observed).
   */
  baselineLite?:   boolean;
};

export function compareCommand(options: CompareOptions): number {
  const cwd           = process.cwd();
  const tracegraphDir = path.join(cwd, '.tracegraph');
  const baselinesDir  = options.baseline
    ? path.resolve(cwd, options.baseline)
    : path.join(tracegraphDir, 'baselines');

  // IMP-3.1: Load tracegraph.config.json for rule configuration overrides
  const ruleConfig = loadTracegraphConfig(cwd);

  // ── Resolve candidate trace files ────────────────────────────────────────
  const candidateFiles = options.bundle
    ? resolveBundleTraceFiles(options.bundle, tracegraphDir, cwd)
    : resolveCandidateFiles(options.candidate, tracegraphDir, cwd, options.latest);
  if (candidateFiles.length === 0) {
    process.stderr.write(
      '[tracegraph] No candidate traces found. ' +
      'Run `tracegraph run -- <command>` first, or specify --candidate.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Load suppressions and approvals ──────────────────────────────────────
  const suppressions = loadSuppressions(tracegraphDir);
  const approvals    = loadApprovals(tracegraphDir);

  // ── G6: Read all stored baselines for test-delta computation ────────────────
  // Done before the comparison loop so we know the full baseline population.
  const allStoredBaselines = loadAllBaselines(baselinesDir);
  const storedBaselineTestIds = new Set(allStoredBaselines.map((b) => b.testId));

  // ── Compare each candidate against its baseline ───────────────────────────
  const diffs:    BehaviorDiff[]    = [];
  const allEvaluated: EvaluatedFinding[] = [];
  let   tracesCompared    = 0;
  // G6: trace matching counters
  let   exactMatches      = 0;
  const matchedCandidateTestIds = new Set<string>();

  // Track fingerprints that have already been emitted as protocol events.
  // The same finding (e.g. a missing test) can fire once per trace when it is
  // absent from every trace — without deduplication the user sees 6× the same
  // finding for a 6-trace run.  Per-trace diff detail is still preserved in
  // `diffs`; only the finding events and the final report are deduplicated.
  const emittedFingerprints = new Set<string>();

  // ── Baseline parity tracking ──────────────────────────────────────────────
  // Detects when the candidate was captured at a significantly higher level
  // than the stored baselines.  When the baseline has no auth/resource events
  // but the candidate has many, the diff "additions" are artifacts of depth
  // difference, not real PR regressions.
  let parityBaselinesMissingBehavior = 0;  // matched baselines with 0 auth events AND 0 resources
  let parityCandidatesWithBehavior   = 0;  // candidates that have auth/db behavioral events
  let parityAddedAuthCount           = 0;  // cumulative added auth signatures across all diffs

  // Collected for the G5 architecture findings pipeline (TG5.3)
  const candidateSessions: TraceSession[] = [];

  if (options.baselineLite) {
    process.stderr.write(
      '[tracegraph] --baseline-lite: skipping runtime baseline diff; ' +
      'running trace analysis and architecture findings only.\n',
    );
  }

  for (const candidateFile of candidateFiles) {
    let session: TraceSession;
    try {
      session = JSON.parse(fs.readFileSync(candidateFile, 'utf8')) as TraceSession;
    } catch (err) {
      process.stderr.write(`[tracegraph] Skipping unreadable trace: ${candidateFile}\n`);
      continue;
    }

    if (session.schemaVersion !== SCHEMA_VERSIONS.trace) {
      process.stderr.write(
        `[tracegraph] Schema mismatch: ${path.basename(candidateFile)} — ` +
        `expected ${SCHEMA_VERSIONS.trace}, got ${session.schemaVersion}\n`,
      );
      continue;
    }

    // Collect for architecture pipeline regardless of baseline mode
    candidateSessions.push(session);

    if (options.baselineLite) {
      // TG5.4: baseline-lite — skip diff, run trace-level analysis only
      tracesCompared++;
      const rawFindings = analyseTraceFindings(session, ruleConfig?.rules);
      const evaluated   = evaluateFindings(rawFindings, session, suppressions, approvals);
      allEvaluated.push(...evaluated);

      for (const f of evaluated.filter((e) => e.status === 'open')) {
        if (emittedFingerprints.has(f.fingerprint)) continue;
        emittedFingerprints.add(f.fingerprint);
        emit({
          type: 'finding',
          runId: session.runId,
          payload: { fingerprint: f.fingerprint, ruleId: f.ruleId, severity: f.severity, title: f.title },
        });
      }
      continue;
    }

    // Normal mode: require a matching baseline
    const baseline = findBaselineForSession(baselinesDir, session);
    if (!baseline) {
      // Silently collect — these are new tests added by the PR.  We emit a single
      // constructive post-loop summary rather than a per-trace warning (Issue 5).
      continue;
    }

    // G6: track exact match
    const candidateTestId = deriveTestId(session.entrypoint);
    exactMatches++;
    matchedCandidateTestIds.add(candidateTestId);
    tracesCompared++;

    // Diff
    const diff = diffBaseline(baseline, session);
    // G13.2: populate testName from the candidate session's entrypoint for human-readable
    // behaviour-change headings in the CI report instead of the opaque traceId.
    if (!diff.testName) {
      const ep = session.entrypoint;
      if (ep.type === 'http_request') {
        diff.testName = `${ep.method ?? 'HTTP'} ${ep.path ?? ep.url ?? ''}`.trim();
      } else if (ep.type === 'test_case') {
        diff.testName = ep.testName ?? ep.description ?? undefined;
      } else if (ep.type === 'cli_command') {
        diff.testName = ep.command ?? undefined;
      }
    }
    diffs.push(diff);

    // ── Parity tracking: update per-baseline/candidate counts ─────────────
    {
      const baselineAuthCount = baseline.events.filter((e) => e.role === 'authorization').length;
      const baselineResourceCount = baseline.resources.length;
      const candidateAddedAuth = diff.addedSignatures.filter((s) => s.role === 'authorization').length;

      // Candidate has auth events in the diff
      const candidateAuthEvents = session.events.filter(
        (e) => (e as { role?: string }).role === 'authorization',
      ).length;
      const candidateResourceEvents = session.events.filter(
        (e) => e.type === 'db_query' || e.type === 'cache_operation' || e.type === 'resource_operation',
      ).length;

      if (baselineAuthCount === 0 && baselineResourceCount === 0) {
        parityBaselinesMissingBehavior++;
      }
      if (candidateAuthEvents > 0 || candidateAddedAuth > 0 || candidateResourceEvents > 0) {
        parityCandidatesWithBehavior++;
      }
      parityAddedAuthCount += candidateAddedAuth;
    }

    // Generate findings: diff-based (M2) + trace-level analysis (M5 + IMP-3.1 rule config)
    const rawFindings = [
      ...diffToFindings(diff),
      ...analyseTraceFindings(session, ruleConfig?.rules),
    ];

    // Evaluate (apply suppressions + approvals)
    const evaluated = evaluateFindings(rawFindings, session, suppressions, approvals);
    allEvaluated.push(...evaluated);

    // Emit findings over stdout (for VS Code extension and CI)
    for (const f of evaluated.filter((e) => e.status === 'open')) {
      if (emittedFingerprints.has(f.fingerprint)) continue;
      emittedFingerprints.add(f.fingerprint);
      emit({
        type: 'finding',
        runId: session.runId,
        payload: {
          fingerprint: f.fingerprint,
          ruleId:      f.ruleId,
          severity:    f.severity,
          title:       f.title,
        },
      });
    }
  }

  // ── Baseline parity diagnostic ────────────────────────────────────────────
  // When a substantial proportion of baselines have zero behavioral events
  // (no auth checks, no resources) but candidates have many, the findings
  // are almost certainly depth artifacts rather than real regressions.
  // Emit a single audit-quality finding to surface this context prominently.
  if (exactMatches > 0) {
    const missingRatio = parityBaselinesMissingBehavior / exactMatches;
    // Trigger when: ≥5 added-auth signatures across the run
    //           AND ≥30 % of matched baselines have no behavioral events
    if (parityAddedAuthCount >= 5 && missingRatio >= 0.3) {
      const parityFinding = buildBaselineParityFinding({
        addedAuthCount:           parityAddedAuthCount,
        baselinesMissingBehavior: parityBaselinesMissingBehavior,
        totalMatched:             exactMatches,
        candidatesWithBehavior:   parityCandidatesWithBehavior,
      });
      allEvaluated.push({ ...parityFinding, status: 'open' });
      if (!emittedFingerprints.has(parityFinding.fingerprint)) {
        emittedFingerprints.add(parityFinding.fingerprint);
        emit({
          type:   'finding',
          runId:  `parity_${Date.now()}`,
          payload: {
            fingerprint: parityFinding.fingerprint,
            ruleId:      parityFinding.ruleId,
            severity:    parityFinding.severity,
            title:       parityFinding.title,
          },
        });
      }
    }
  }

  // ── New-test onboarding summary (Issue 5) ────────────────────────────────
  // Candidate sessions without a baseline are new tests added by the PR.
  // Report them as a constructive onboarding note rather than per-trace warnings.
  {
    const newTestSessions = candidateSessions.filter(
      (s) => s.entrypoint.type === 'test_case' &&
             !matchedCandidateTestIds.has(deriveTestId(s.entrypoint)),
    );
    if (newTestSessions.length > 0) {
      const names = newTestSessions
        .map((s) => (s.entrypoint as { testName?: string }).testName ?? s.traceId)
        .slice(0, 5)
        .map((n) => `  • ${n}`)
        .join('\n');
      const more = newTestSessions.length > 5 ? `\n  … and ${newTestSessions.length - 5} more` : '';
      process.stderr.write(
        `[tracegraph] ${newTestSessions.length} new candidate test(s) detected — no baseline exists yet.\n` +
        `  These tests were added by the PR and need to be baselined after they pass:\n` +
        `${names}${more}\n` +
        `  Run: tracegraph baseline create --reason "New tests from PR"\n`,
      );
    }
  }

  // ── G5 TG5.3: Architecture findings pipeline ──────────────────────────────
  // Runs when: static graph + architecture baseline + at least one enriched trace.
  // Silently skipped when any precondition is missing.
  {
    const archBaseline = loadArchitectureBaseline(cwd);
    const enrichedSessions = candidateSessions.filter(
      (s) => s.events.some((e) => e.static != null),
    );

    if (archBaseline && enrichedSessions.length > 0) {
      const sensitivePats =
        ruleConfig?.staticGraph?.sensitiveCommunities ??
        ['auth', 'billing', 'payments', 'identity'];

      const archFindings = detectSurpriseEdge(enrichedSessions, archBaseline, sensitivePats);

      for (const f of archFindings) {
        // Architecture findings are project-level — push directly as open.
        // Fingerprint-based suppression/approval still works via the normal workflow.
        allEvaluated.push({ ...f, status: 'open' });
        if (emittedFingerprints.has(f.fingerprint)) continue;
        emittedFingerprints.add(f.fingerprint);
        emit({
          type: 'finding',
          runId: `arch_${Date.now()}`,
          payload: { fingerprint: f.fingerprint, ruleId: f.ruleId, severity: f.severity, title: f.title },
        });
      }
    }
  }

  // ── Suppression file change detection (M5.5) ─────────────────────────────
  const suppressionsModified = checkSuppressionsFileModified(tracegraphDir);

  // Emit a structured policy finding when the suppressions file has uncommitted
  // changes so that it appears in the report alongside other findings.
  if (suppressionsModified) {
    const policyFinding = buildSuppressionsModifiedFinding();
    // Policy findings are always "open" — they cannot be suppressed away.
    allEvaluated.push({ ...policyFinding, status: 'open' });
  }

  // ── G3C: Compute assurance level + G6: architecture quality ──────────────
  const staticGraphMetaPath = path.join(tracegraphDir, 'static-graph', 'graph_metadata.json');
  const staticGraphAvailable = fs.existsSync(staticGraphMetaPath);
  const graphIndex = staticGraphAvailable ? loadOrRebuildGraphIndex(cwd) : null;

  // G6: read raw graph metrics to determine architecture quality tier
  let graphMeta: {
    nodeCount: number; edgeCount: number; communityCount: number; godNodeCount: number;
    /** Phase 2: runtime-derived call edges from PHP debug_backtrace() (may be absent). */
    runtimeEdgeCount?: number;
  } | null = null;
  if (staticGraphAvailable) {
    try {
      graphMeta = JSON.parse(fs.readFileSync(staticGraphMetaPath, 'utf8')) as typeof graphMeta;
    } catch { /* non-fatal */ }
  }
  // Phase 2: effective edge count = static edges + runtime-captured edges.
  // When graphify finds 0 edges (common for PHP dynamic dispatch), runtime_call_edges.json
  // may supply edges derived from debug_backtrace() during test execution.
  const staticEdgeCount  = graphMeta?.edgeCount        ?? 0;
  const runtimeEdgeCount = graphMeta?.runtimeEdgeCount ?? (() => {
    // Also check runtime_call_edges.json file directly in case graph_metadata.json
    // was not patched (e.g., graph was built before Phase 2 ran).
    if (!staticGraphAvailable) return 0;
    const rcePath = runtimeCallEdgesPath(cwd);
    if (!fs.existsSync(rcePath)) return 0;
    try {
      const arr = JSON.parse(fs.readFileSync(rcePath, 'utf8')) as unknown[];
      return Array.isArray(arr) ? arr.length : 0;
    } catch { return 0; }
  })();
  const effectiveEdgeCount = staticEdgeCount + runtimeEdgeCount;
  const archQualityLevel: ArchitectureQualityLevel = computeArchQualityLevel(graphMeta, effectiveEdgeCount);

  // G8 / G16: Load PR context early — used for language detection (G15.4),
  // verdict enrichment (G16.1), and report rendering (G14.5, G16.2).
  // Must be loaded before any use of prContext below.
  const prContext = loadPrContext(tracegraphDir);

  // ── Vacuous-pass detection ────────────────────────────────────────────────
  // Must be computed before finding finalisation so we can:
  //   1. Add the audit.test_boot_failed finding (HIGH severity)
  //   2. Suppress evidence_continuity findings (artifacts of Level 0 capture)
  //   3. Cap runtimeTraceAvailable for the assurance level
  //   4. Block a false PASS verdict in computeVerdict
  const allTracesLevel0 = candidateSessions.length > 0 &&
    candidateSessions.every((s) => s.captureLevel.overall === 0 && s.status !== 'passed');

  // G7: Emit an audit_quality finding when the static graph has nodes but no
  // edges/communities — architecture analysis is A1 (node list only).
  // G15.4: Use prContext.language as the authoritative language source so that
  // Node.js repositories (language:'node') get the correct hint rather than
  // falling through to the PHP / generic default.
  // Phase 2: suppress A1 finding when runtime call edges are available.
  if (graphMeta && graphMeta.nodeCount > 50 && effectiveEdgeCount === 0) {
    const detectedLanguage = prContext?.language ?? candidateSessions[0]?.language ?? null;
    const aqFinding = buildGraphQualityFinding(
      graphMeta.nodeCount, graphMeta.communityCount, detectedLanguage,
    );
    allEvaluated.push({ ...aqFinding, status: 'open' });
  }

  // G19: Boot failure finding — fires when ALL candidate traces are Level 0 and
  // the PR test run failed.  This is a first-class HIGH severity audit_quality
  // finding that dominates the report, making it clear that runtime comparison
  // is not meaningful and WHY the application didn't run.
  if (allTracesLevel0 && (prContext?.testRunExitCode ?? 0) !== 0) {
    const bootFinding = buildBootFailureFinding(prContext);
    allEvaluated.push({ ...bootFinding, status: 'open' });
  }

  // G19: Evidence continuity findings are NOT independent issues when Level 0
  // capture occurred — they are pure artifacts of "nothing ran."  Every baselined
  // test would appear missing because zero test events were captured.  Suppressing
  // them avoids noisy medium findings under the much more important boot failure.
  if (allTracesLevel0) {
    for (let i = allEvaluated.length - 1; i >= 0; i--) {
      if (allEvaluated[i]!.category === 'evidence_continuity') {
        allEvaluated.splice(i, 1);
      }
    }
  }

  // ── Deduplicate findings by fingerprint ──────────────────────────────────
  // The same finding can be generated for every trace it is absent from.
  // Keep per-trace diff detail in `diffs`; deduplicate findings so each
  // unique issue appears exactly once in the report and summary counts.
  const uniqueFindings: EvaluatedFinding[] = [];
  {
    const seen = new Set<string>();
    for (const f of allEvaluated) {
      if (!seen.has(f.fingerprint)) {
        seen.add(f.fingerprint);
        uniqueFindings.push(f);
      }
    }
  }

  // ── G6: Compute testDelta and traceMatching ──────────────────────────────
  // Moved before findingsBySeverity so post-processing can use testDelta.
  const testDelta     = computeTestDelta(allStoredBaselines, candidateSessions, matchedCandidateTestIds);
  const traceMatching = computeTraceMatching(
    allStoredBaselines.length,
    candidateSessions.length,
    exactMatches,
    allTracesLevel0,
  );

  // ── Post-processing: A/B/C auth reclassification + D/E finding aggregation ─
  //
  // A/B/C: "Authorization check removed" is a high-alarm title.  When the test
  // flow that exercises the auth check is ABSENT from the candidate run, the
  // correct description is "Authorization evidence missing" — we cannot confirm
  // the check was removed; we only know it wasn't observed.
  //
  // D/E: Aggregate small DB-event-removed and resource-count-changed findings
  // into a single summary finding so the report is not dominated by proportional
  // noise from missing tests.
  {
    const missingTestNames = testDelta.baselineOnlyTests
      .map((t) => (t.testName ?? '').toLowerCase());

    // ── A/B/C: Auth reclassification ────────────────────────────────────────
    const authMissingFlowMap: Record<string, string[]> = {};

    for (const f of uniqueFindings) {
      if (f.ruleId !== 'behavior.authorization.removed') continue;
      const gateMatch = f.title.match(/Authorization check removed:\s*(.+)$/);
      if (!gateMatch) continue;
      const gateName = gateMatch[1]!.trim();
      const related  = findRelatedMissingTests(gateName, missingTestNames);
      if (related.length === 0) continue;

      // In-place reclassification — severity stays Critical, title/description change.
      f.ruleId      = 'evidence.authorization_missing';
      f.title       = `Authorization evidence missing: ${gateName}`;
      f.description =
        `The authorization check "${gateName}" was present in the approved baseline but was ` +
        `not observed in the candidate run. ` +
        `The test flow(s) that exercise this authorization path were also absent from the ` +
        `candidate — this is "evidence missing", not a confirmed authorization removal.\n\n` +
        `Associated missing flow(s): ${related.map(humanTestName).join(', ')}`;
      f.recommendation =
        'Investigate why the export tests did not run:\n' +
        related.map((n) => `  • tracegraph run -- php artisan test --filter "${humanTestName(n)}"`).join('\n') + '\n\n' +
        'If authorization was genuinely removed from the endpoint, that is a security regression.\n' +
        'If the tests were intentionally removed, approve and rebaseline with a reason.';
      authMissingFlowMap[gateName] = related;
    }

    // Grouped attribution finding: one block that maps each flow to its auth checks.
    if (Object.keys(authMissingFlowMap).length >= 2) {
      const flowLines = Object.entries(authMissingFlowMap)
        .map(([gate, tests]) => `  • ${gate} ← ${tests.map(humanTestName).join(', ')}`)
        .join('\n');

      // PR relevance: compare changed file set against missing export resources.
      // Also pass new candidate tests (no baseline yet) and whether the run failed
      // so the relevance block can explain the evidence gap more accurately.
      const newCandidateTestNames = testDelta.candidateOnlyTests
        .map((t) => t.testName);
      const testRunFailed = (prContext?.testRunExitCode ?? 0) !== 0;
      const prRelevanceBlock = prContext?.changedFilePaths
        ? buildPrRelevanceText(
            prContext.changedFilePaths,
            Object.keys(authMissingFlowMap),
            { newCandidateTests: newCandidateTestNames, testRunFailed },
          )
        : undefined;

      const groupFinding = buildAuthMissingGroupFinding(
        flowLines,
        Object.keys(authMissingFlowMap).length,
        missingTestNames.length,
        prRelevanceBlock,
      );
      uniqueFindings.unshift({ ...groupFinding, status: 'open' });
    }

    // ── D: Aggregate DB-event-removed findings when ≥ 3 exist ───────────────
    const dbRemovedFindings = uniqueFindings.filter(
      (f) => f.ruleId === 'behavior.business_logic.removed' &&
             f.status === 'open' &&
             /^Behaviour change: DB::/.test(f.title),
    );
    if (dbRemovedFindings.length >= 3) {
      const tableEntries = dbRemovedFindings.map((f) => {
        const m = f.title.match(/^Behaviour change: DB::(\w+)\s+(\S+)\s+removed$/);
        return m ? `${m[2]} ${m[1]}` : f.title.replace('Behaviour change: ', '').replace(' removed', '');
      });
      const aggDb = buildDbRemovedAggregatedFinding(
        tableEntries, dbRemovedFindings.length, missingTestNames.length,
      );
      const toRemoveDb = new Set(dbRemovedFindings.map((f) => f.fingerprint));
      for (let i = uniqueFindings.length - 1; i >= 0; i--) {
        if (toRemoveDb.has(uniqueFindings[i]!.fingerprint)) uniqueFindings.splice(i, 1);
      }
      uniqueFindings.push({ ...aggDb, status: 'open' });
    }

    // ── F: Aggregate export-route-removed findings ──────────────────────────
    // GET api/v1/*/export route-removed findings come in pairs (request event +
    // response event) for each export endpoint.  They are a direct consequence
    // of the same missing export-flow tests as the auth findings, so folding
    // them into one aggregated finding reduces noise significantly.
    const exportRouteFindings = uniqueFindings.filter(
      (f) => f.ruleId === 'behavior.business_logic.removed' &&
             f.status === 'open' &&
             /GET api\/v1\/[^/\s]+\/export/.test(f.title),
    );
    if (exportRouteFindings.length >= 2) {
      // Collect unique resource names (e.g. 'customers', 'invoices')
      const routeSet = new Set<string>();
      for (const f of exportRouteFindings) {
        const m = f.title.match(/GET api\/v1\/([^/\s]+)\/export/);
        if (m) routeSet.add(m[1]!);
      }
      const routes = [...routeSet].sort();
      const aggExport = buildExportRoutesRemovedFinding(
        routes, exportRouteFindings.length, missingTestNames.length,
      );
      const toRemoveExport = new Set(exportRouteFindings.map((f) => f.fingerprint));
      for (let i = uniqueFindings.length - 1; i >= 0; i--) {
        if (toRemoveExport.has(uniqueFindings[i]!.fingerprint)) uniqueFindings.splice(i, 1);
      }
      uniqueFindings.push({ ...aggExport, status: 'open' });
    }

    // ── E: Aggregate minor resource-count-changed findings ──────────────────
    // Keep individual findings for: |delta| > 50, percentage > 25%, or baseline = 0.
    // Aggregate the rest into a single summary.
    const resourceCountFindings = uniqueFindings.filter(
      (f) => f.ruleId === 'behavior.resource_count.changed' && f.status === 'open',
    );
    if (resourceCountFindings.length >= 3) {
      const significant: EvaluatedFinding[] = [];
      const minor:       EvaluatedFinding[] = [];
      for (const f of resourceCountFindings) {
        const m = f.description.match(/from (\d+) \(baseline\) to (\d+) \(candidate\)/);
        if (!m) { significant.push(f); continue; }
        const bCount   = parseInt(m[1]!, 10);
        const cCount   = parseInt(m[2]!, 10);
        const absDelta = Math.abs(bCount - cCount);
        const pctDelta = bCount > 0 ? (absDelta / bCount) * 100 : 100;
        // Keep as individual finding only when the change is BOTH large in
        // absolute terms AND meaningful in percentage — OR when the percentage
        // alone is large (≥25%) regardless of absolute size, OR when baseline
        // is zero (any new count is noteworthy).
        //
        // Tiny-denominator guard: when the baseline count is very small (< 5)
        // and the absolute delta is tiny (< 3), a high percentage is misleading
        // (e.g. notes update: 2→1 = 50% but delta = 1).  Move these to minor
        // to avoid crying wolf over single-operation baseline fluctuations.
        const isTinyDenominator = bCount >= 1 && bCount < 5 && absDelta < 3;
        if (!isTinyDenominator && ((absDelta > 50 && pctDelta > 10) || pctDelta > 25 || bCount === 0)) {
          significant.push(f);
        } else {
          minor.push(f);
        }
      }
      if (minor.length >= 2) {
        // Sort minor changes by absolute delta (largest first) for the summary
        const sorted = [...minor].sort((a, b) => {
          const delta = (f: EvaluatedFinding): number => {
            const m = f.description.match(/from (\d+) .+ to (\d+)/);
            return m ? Math.abs(parseInt(m[1]!, 10) - parseInt(m[2]!, 10)) : 0;
          };
          return delta(b) - delta(a);
        });
        const topEntries = sorted.slice(0, 5).map((f) => {
          const m = f.description.match(/on "([^"]+)" changed from (\d+) .+ to (\d+)/);
          if (!m) return `  • ${f.title}`;
          const delta = parseInt(m[2]!, 10) - parseInt(m[3]!, 10);
          return `  • ${m[1]}: ${delta > 0 ? '-' : '+'}${Math.abs(delta)}`;
        });
        const aggRc = buildResourceCountAggregatedFinding(
          minor.length, resourceCountFindings.length, topEntries, missingTestNames.length,
        );
        const toRemoveRc = new Set(minor.map((f) => f.fingerprint));
        for (let i = uniqueFindings.length - 1; i >= 0; i--) {
          if (toRemoveRc.has(uniqueFindings[i]!.fingerprint)) uniqueFindings.splice(i, 1);
        }
        uniqueFindings.push({ ...aggRc, status: 'open' });
      }
    }
  }

  // ── Build summary ─────────────────────────────────────────────────────────
  const findingsBySeverity: Record<FindingSeverity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };
  // When a grouped "evidence.authorization_missing.grouped" finding exists, it
  // already represents all individual auth-missing children as a single incident.
  // Skip the children when counting by severity so the summary table shows
  // "1 critical" (the incident) rather than "7 critical" (1 group + 6 children).
  const hasGroupedAuthFinding = uniqueFindings.some(
    (f) => f.status === 'open' && f.ruleId === 'evidence.authorization_missing.grouped'
  );
  for (const f of uniqueFindings) {
    if (f.status === 'open') {
      if (hasGroupedAuthFinding && f.ruleId === 'evidence.authorization_missing') continue;
      findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] ?? 0) + 1;
    }
  }
  const hasOpenCritical = (findingsBySeverity.critical ?? 0) > 0;

  const assurance: AssuranceLevel = computeAssuranceLevel({
    staticGraphAvailable,
    riskClassified:           staticGraphAvailable && graphIndex != null,
    // G19: Level 0 traces contain only runner metadata — they do NOT represent
    // "code exercised at least once" (assurance Level 3 / Runtime-observed).
    // Treat them as no runtime observation so assurance stays at Level 2 or below,
    // which is honest: we have a static graph but zero runtime evidence.
    runtimeTraceAvailable:    candidateSessions.length > 0 && !allTracesLevel0,
    // baseline-lite mode deliberately has no runtime baseline → level 3 (observed only).
    // When all traces are Level 0, baselines were created from empty runs — they are not
    // meaningful approvals, so cap at level 3 (observed) rather than level 4 (baselined).
    runtimeBaselineAvailable: !options.baselineLite && tracesCompared > 0 && !allTracesLevel0,
    contractAvailable:        false,   // M9C not yet implemented
    // G18: surface to CI reporter so it can distinguish "not created" vs "not comparable"
    allTracesLevel0,
    // G6: architecture quality
    architectureQualityLevel: staticGraphAvailable ? archQualityLevel : undefined,
    architectureNodes:        graphMeta?.nodeCount,
    // Phase 2: report effective edge count (static + runtime) so the CI report
    // shows the true relationship coverage, not just graphify's static count.
    architectureEdges:        effectiveEdgeCount > 0 ? effectiveEdgeCount : graphMeta?.edgeCount,
    architectureCommunities:  graphMeta?.communityCount,
  });

  // ── G7: Compute verdict ───────────────────────────────────────────────────
  // prContext already loaded above (early load for G15.4 language detection).
  const verdict = computeVerdict(uniqueFindings, tracesCompared, assurance, traceMatching, prContext, allTracesLevel0);

  // ── Build report ──────────────────────────────────────────────────────────

  // G18: derive the overall capture level from the candidate sessions.
  // Use the minimum (worst case) across all sessions — if any session has low
  // capture, reviewers should know the evidence is incomplete.
  let reportCaptureLevel: Pick<import('@tracegraph/shared-types').CaptureLevel, 'overall' | 'label'> | undefined;
  if (candidateSessions.length > 0) {
    const minSession = candidateSessions.reduce((min, s) =>
      s.captureLevel.overall < min.captureLevel.overall ? s : min,
    );
    reportCaptureLevel = { overall: minSession.captureLevel.overall, label: minSession.captureLevel.label };
  }

  const report: TraceReport = {
    schemaVersion:  SCHEMA_VERSIONS.report,
    reportId:       `report_${createHash('sha256').update(Date.now().toString()).digest('hex').slice(0, 12)}`,
    createdAt:      Date.now(),
    baselineDir:    path.relative(cwd, baselinesDir),
    candidateFiles: candidateFiles.map((f) => path.relative(cwd, f)),
    diffs,
    findings:       uniqueFindings,
    summary: {
      tracesCompared,
      findingsBySeverity,
      hasOpenCritical,
      suppressionsModified,
    },
    assurance,
    verdict,
    testDelta,
    traceMatching,
    ...(prContext ? { prContext } : {}),
    ...(reportCaptureLevel ? { captureLevel: reportCaptureLevel } : {}),
  };

  // ── Write report file ─────────────────────────────────────────────────────
  const outPath = resolveOutPath(options.out, tracegraphDir, report.reportId, cwd);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  process.stdout.write(`[tracegraph] Report: ${path.relative(cwd, outPath)}\n`);

  // Use the deduplicated count (same source as findingsBySeverity) so the log
  // line and the summary table always agree.  Raw uniqueFindings still contains
  // all findings (individual auth children are kept for the detailed report
  // section); only the headline counts deduplicate them.
  const openCount    = Object.values(findingsBySeverity).reduce((a, b) => a + b, 0);
  const openFindings = uniqueFindings.filter((f) => f.status === 'open');

  if (openCount > 0) {
    process.stdout.write(
      `[tracegraph] ${openCount} open finding(s): ` +
      SEVERITY_ORDER.filter((s) => (findingsBySeverity[s] ?? 0) > 0)
        .map((s) => `${findingsBySeverity[s]} ${s}`)
        .join(', ') +
      '\n',
    );

    // IMP-3.3: --verbose prints remediation snippets below each finding
    if (options.verbose) {
      process.stdout.write('\n');
      for (const f of openFindings) {
        const sevIcon: Record<string, string> = {
          critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪',
        };
        process.stdout.write(
          `  ${sevIcon[f.severity] ?? '●'} [${f.severity.toUpperCase()}] ${f.title}\n` +
          `     ${f.description}\n`,
        );
        if (f.remediation) {
          process.stdout.write(`\n  → ${f.remediation.text}\n`);
          if (f.remediation.code) {
            for (const [framework, snippet] of Object.entries(f.remediation.code)) {
              if (!snippet) continue;  // Partial<Record<...>> values may be undefined
              process.stdout.write(`\n  [${framework}]\n`);
              for (const line of snippet.split('\n')) {
                process.stdout.write(`    ${line}\n`);
              }
            }
          }
          if (f.remediation.docs) {
            process.stdout.write(`\n  Docs: ${f.remediation.docs}\n`);
          }
        }
        process.stdout.write('\n');
      }
    }
  } else {
    process.stdout.write('[tracegraph] No open findings.\n');
  }

  // Emit report.created
  emit({
    type:  'report.created',
    runId: `compare_${Date.now()}`,
    payload: {
      file:             path.relative(cwd, outPath),
      openFindings:     openCount,
      hasOpenCritical,
    },
  });

  // ── Write back reportId to latest.json ───────────────────────────────────
  updateLatestReport(tracegraphDir, report.reportId);

  // ── G3C: Terminal assurance output ───────────────────────────────────────
  process.stdout.write(
    `[tracegraph] Assurance: ${formatAssuranceLevel(assurance)}\n`,
  );

  // ── G3C: Assurance CI gate ────────────────────────────────────────────────
  // Check assurance.minLevel from tracegraph.config.json
  const minLevel = ruleConfig?.assurance?.minLevel;
  if (minLevel != null && assurance.level < minLevel) {
    process.stderr.write(
      `[tracegraph] Assurance level ${assurance.level} is below the configured ` +
      `minimum of ${minLevel}.\n` +
      `  Current: ${assurance.label}\n` +
      `  To improve:\n` +
      (!assurance.staticGraphAvailable
        ? `    • Run \`tracegraph graph build\` to enable static graph enrichment\n`
        : '') +
      (!assurance.runtimeBaselineAvailable
        ? `    • Run \`tracegraph baseline create\` to establish runtime baselines\n`
        : '') +
      (!assurance.contractAvailable
        ? `    • Add runtime contracts (M9C) for the highest-risk flows\n`
        : ''),
    );
    return EXIT_CODES.ASSURANCE_INSUFFICIENT;
  }

  // Exit codes
  if (suppressionsModified) return EXIT_CODES.POLICY_REVIEW;
  if (hasOpenCritical && options.failOnCritical) return EXIT_CODES.FINDINGS_THRESHOLD;
  return EXIT_CODES.SUCCESS;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Update latest.json with the reportId produced by this compare run. */
function updateLatestReport(tracegraphDir: string, reportId: string): void {
  const latestPath = path.join(tracegraphDir, 'latest.json');
  try {
    let existing: LatestPointer = {
      latestRunId:    '',
      latestTraceIds: [],
      latestReportId: null,
      updatedAt:      Date.now(),
    };
    if (fs.existsSync(latestPath)) {
      existing = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as LatestPointer;
    }
    existing.latestReportId = reportId;
    existing.updatedAt      = Date.now();
    fs.writeFileSync(latestPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch {
    // Non-fatal
  }
}

/**
 * Resolve trace file paths from a TraceBundle JSON file.
 *
 * Bundle trace entries use paths relative to `.tracegraph/` (e.g. `traces/<id>.trace.json`).
 * Entries whose files cannot be found on disk are skipped with a warning.
 */
function resolveBundleTraceFiles(
  bundleArg: string,
  tracegraphDir: string,
  cwd: string,
): string[] {
  const abs = path.resolve(cwd, bundleArg);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`[tracegraph] Bundle file not found: ${abs}\n`);
    return [];
  }

  let bundle: TraceBundle;
  try {
    bundle = JSON.parse(fs.readFileSync(abs, 'utf8')) as TraceBundle;
  } catch (err) {
    process.stderr.write(`[tracegraph] Cannot parse bundle file: ${abs} — ${String(err)}\n`);
    return [];
  }

  if (!Array.isArray(bundle.traces)) {
    process.stderr.write(`[tracegraph] Bundle has no traces array: ${abs}\n`);
    return [];
  }

  const resolved: string[] = [];
  for (const entry of bundle.traces) {
    // bundle.traces[].file is relative to .tracegraph/
    const tracePath = path.join(tracegraphDir, entry.file);
    if (fs.existsSync(tracePath)) {
      resolved.push(tracePath);
    } else {
      process.stderr.write(
        `[tracegraph] Bundle trace file not found, skipping: ${entry.file}\n`,
      );
    }
  }

  if (resolved.length > 0) {
    process.stderr.write(
      `[tracegraph] Bundle "${bundle.scenarioId}" — ` +
      `${resolved.length}/${bundle.traces.length} trace(s) resolved.\n`,
    );
  }

  return resolved;
}

function resolveCandidateFiles(
  candidateArg: string | undefined,
  tracegraphDir: string,
  cwd: string,
  useLatest?: boolean,
): string[] {
  if (candidateArg) {
    const abs = path.resolve(cwd, candidateArg);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isDirectory()) {
      return fs.readdirSync(abs)
        .filter((f) => f.endsWith('.trace.json'))
        .map((f) => path.join(abs, f));
    }
    return [abs];
  }

  const tracesDir = path.join(tracegraphDir, 'traces');

  // --latest or no explicit candidate: prefer latest.json's trace IDs
  if (useLatest || !candidateArg) {
    const latestPath = path.join(tracegraphDir, 'latest.json');
    if (fs.existsSync(latestPath)) {
      try {
        const ptr = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as LatestPointer;
        const resolved = ptr.latestTraceIds
          .map((id) => path.join(tracesDir, `${id}.trace.json`))
          .filter((p) => fs.existsSync(p));
        if (resolved.length > 0) {
          process.stderr.write(
            `[tracegraph] Using latest run ${ptr.latestRunId} (${resolved.length} trace(s)).\n` +
            `  Pass --candidate <dir> to compare a different set.\n`,
          );
          return resolved;
        }
      } catch { /* fall through to full scan */ }
    }
  }

  // Fallback: all traces in .tracegraph/traces/
  if (!fs.existsSync(tracesDir)) return [];
  return fs.readdirSync(tracesDir)
    .filter((f) => f.endsWith('.trace.json'))
    .map((f) => path.join(tracesDir, f));
}

function loadSuppressions(tracegraphDir: string) {
  const suppressionFile = path.join(tracegraphDir, 'suppressions', 'tracegraph.suppressions.json');
  if (!fs.existsSync(suppressionFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(suppressionFile, 'utf8')) as SuppressionsFile;
    return data.suppressions ?? [];
  } catch {
    return [];
  }
}

function loadApprovals(tracegraphDir: string) {
  const approvalFile = path.join(tracegraphDir, 'approvals', 'findings.json');
  if (!fs.existsSync(approvalFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(approvalFile, 'utf8')) as FindingApprovalsFile;
    return data.approvals ?? [];
  } catch {
    return [];
  }
}

/**
 * Returns true when the suppressions file has uncommitted changes in git.
 *
 * Uses `git status --porcelain` on the suppressions file path. If git is not
 * available, or the directory is not a git repository, returns false (safe
 * default — does not block the workflow on non-git setups).
 *
 * Exit code 4 (POLICY_REVIEW) is emitted when this returns true, forcing
 * human review before results are trusted.
 */
function checkSuppressionsFileModified(tracegraphDir: string): boolean {
  const suppressionFile = path.join(
    tracegraphDir, 'suppressions', 'tracegraph.suppressions.json',
  );
  if (!fs.existsSync(suppressionFile)) return false;

  try {
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const result = spawnSync(
      'git',
      ['status', '--porcelain', suppressionFile],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // spawnSync returns error if git is not found; status !== 0 means not a repo
    if (result.error || result.status !== 0) return false;
    return (result.stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}

function resolveOutPath(
  outArg: string | undefined,
  tracegraphDir: string,
  reportId: string,
  cwd: string,
): string {
  if (outArg) return path.resolve(cwd, outArg);
  return path.join(tracegraphDir, 'reports', `${reportId}.report.json`);
}

/** IMP-3.1: Load tracegraph.config.json from the project root. */
function loadTracegraphConfig(cwd: string): TracegraphConfig | null {
  const configPath = path.join(cwd, 'tracegraph.config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as TracegraphConfig;
  } catch {
    return null;
  }
}

/**
 * M5.5 — Build a structured Finding for a modified suppressions file.
 *
 * Suppressions control which findings are silenced. Uncommitted changes to the
 * suppressions file mean a reviewer has not yet signed off on the change,
 * introducing a policy risk that must surface in the report.
 */
// ─── A/B/C: Auth-evidence reclassification helpers ───────────────────────────

/**
 * Returns the subset of `missingTestNames` (already lowercased) that exercise
 * the given Gate check, based on resource-name matching in the test name.
 *
 *   Gate::view-customer  → tests containing "customer" + "export"
 *   Gate::viewAny        → any test containing "export"
 *   Gate::view-invoice   → tests containing "invoice" + "export"
 */
function findRelatedMissingTests(gateName: string, missingTestNames: string[]): string[] {
  if (missingTestNames.length === 0) return [];
  const gateL = gateName.toLowerCase();
  // viewAny matches any export flow
  if (gateL === 'gate::viewany') {
    return missingTestNames.filter((n) => n.includes('export'));
  }
  // view-<resource> or view<resource>
  const match = gateL.match(/gate::view-?(.+)$/);
  if (!match) return [];
  const resource = match[1]!;           // e.g. "customer", "invoice", "expense"
  return missingTestNames.filter((n) => n.includes(resource) && n.includes('export'));
}

/**
 * Convert a raw (possibly Pest __pest_evaluable_*) test name to a human-readable label.
 * Strips the prefix and converts underscores to spaces.
 */
function humanTestName(raw: string): string {
  if (raw.includes('__pest_evaluable_')) {
    const body = raw.slice(raw.indexOf('__pest_evaluable_') + '__pest_evaluable_'.length);
    return body.replace(/_/g, ' ');
  }
  return raw;
}

/**
 * Builds a single grouped finding that maps each reclassified auth check
 * back to the missing test flows that exercise it.  This gives reviewers
 * the full picture in one block rather than having to correlate six individual
 * findings with the Test Evidence Delta table.
 *
 * @param prRelevanceBlock  Optional PR relevance paragraph generated by
 *   `buildPrRelevanceText` — appended to the description when supplied.
 */
function buildAuthMissingGroupFinding(
  flowLines:          string,
  reclassifiedCount:  number,
  missingTestCount:   number,
  prRelevanceBlock?:  string,
): Finding {
  const ruleId      = 'evidence.authorization_missing.grouped';
  const fingerprint = createHash('sha256')
    .update(`${ruleId}:${reclassifiedCount}:${missingTestCount}`)
    .digest('hex')
    .slice(0, 16);

  const prBlock = prRelevanceBlock ? `\n\n${prRelevanceBlock}` : '';

  return {
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId,
    severity:    'critical',
    category:    'security_authorization',
    title:
      `Export-flow authorization evidence missing — ${reclassifiedCount} checks unobserved ` +
      `across ${missingTestCount} missing test(s)`,
    description:
      `${reclassifiedCount} authorization check(s) that were present in the approved baseline ` +
      `were not observed in the candidate run. All of them belong to API export flows whose ` +
      `corresponding tests also did not run in the candidate.\n\n` +
      `Authorization check → missing test flow mapping:\n${flowLines}\n\n` +
      `Confidence: Critical severity / Medium confidence. The checks may still be in place — ` +
      `the export tests simply did not execute.` +
      prBlock,
    evidence:    [{ traceId: 'evidence_missing', eventIds: [] }],
    recommendation:
      'Rerun the missing export tests to confirm authorization is still enforced:\n' +
      '  1. tracegraph run -- php artisan test --filter "csv export"\n' +
      '  2. Verify each export endpoint still requires Gate::view-* authorization.\n' +
      '  3. If tests were intentionally removed, approve and rebaseline with a justification.\n' +
      '  4. If authorization was genuinely removed, treat as a security regression.',
  };
}

/**
 * Generates a concise PR relevance paragraph comparing the PR's changed file
 * set against the missing authorization flows.  Helps reviewers avoid
 * over-attributing backend security evidence gaps to an unrelated frontend change.
 */
function buildPrRelevanceText(
  changedFilePaths:   string[],
  missingGateChecks:  string[],
  opts?: {
    newCandidateTests?: string[];  // human-readable names of candidate-only tests
    testRunFailed?:     boolean;   // true when test run exit code !== 0
  },
): string {
  if (changedFilePaths.length === 0) return '';

  // Classify changed files by language/layer
  const frontendPaths = changedFilePaths.filter((p) =>
    /\.(js|ts|tsx|jsx|vue|svelte)$/.test(p) &&
    /^(resources|frontend|assets|src\/(pages|components|views|stores))/.test(p),
  );
  const phpPaths = changedFilePaths.filter((p) => /\.php$/.test(p));

  // Extract resource keywords from gate check names: "Gate::view-customer" → "customer"
  const exportResources = missingGateChecks
    .map((g) => g.match(/gate::view-?(.+)$/i)?.[1])
    .filter((r): r is string => r != null && r !== 'any');

  // Check for direct file path overlap with export resource names
  const directOverlap = changedFilePaths.filter((p) => {
    const pl = p.toLowerCase();
    return exportResources.some((r) => pl.includes(r)) &&
           (pl.includes('export') || pl.includes('controller') || pl.includes('api'));
  });

  const { newCandidateTests = [], testRunFailed = false } = opts ?? {};
  const lines: string[] = ['PR relevance analysis:'];

  // Changed-file classification
  if (frontendPaths.length > 0 && phpPaths.length === 0) {
    const sample = frontendPaths.slice(0, 2).join(', ');
    const more   = frontendPaths.length > 2 ? ` (+${frontendPaths.length - 2} more)` : '';
    lines.push(`  • The PR changes ${frontendPaths.length === 1 ? 'a' : frontendPaths.length} frontend file(s): ${sample}${more}.`);
    lines.push('  • Missing evidence affects backend API export endpoints.');
  } else if (phpPaths.length > 0) {
    const sample = phpPaths.slice(0, 2).join(', ');
    lines.push(`  • The PR changes ${phpPaths.length} PHP file(s): ${sample}.`);
    if (frontendPaths.length > 0) {
      lines.push(`  • Also changes ${frontendPaths.length} frontend file(s).`);
    }
  } else {
    lines.push(`  • Changed file(s): ${changedFilePaths.slice(0, 3).join(', ')}.`);
  }

  // Direct file ↔ export route overlap
  if (directOverlap.length > 0) {
    lines.push(`  • Direct file overlap detected: ${directOverlap.join(', ')}.`);
  } else {
    lines.push('  • Direct file overlap: none detected.');
  }

  // New candidate tests — check if they relate to the changed files
  if (newCandidateTests.length > 0) {
    // Heuristic: a new test relates to a changed file when any keyword from the
    // file path appears in the test name (e.g. "Address" in "AddressLocalizationTest")
    const changedKeywords = changedFilePaths.flatMap((p) =>
      path.basename(p, path.extname(p))
        .replace(/([A-Z])/g, ' $1')   // split CamelCase
        .toLowerCase()
        .split(/[\s_-]+/)
        .filter((w) => w.length > 3),  // skip short words
    );
    const prRelevantNewTests = newCandidateTests.filter((n) =>
      changedKeywords.some((kw) => n.toLowerCase().includes(kw)),
    );
    if (prRelevantNewTests.length > 0) {
      lines.push(
        `  • ${prRelevantNewTests.length} new candidate test(s) are directly related to the PR changes ` +
        `(e.g. ${humanTestName(prRelevantNewTests[0]!)}).`,
      );
    }
    if (newCandidateTests.length > prRelevantNewTests.length) {
      lines.push(
        `  • Missing export-flow tests appear unrelated to the changed files — ` +
        `likely a pre-existing test selection issue.`,
      );
    }
  } else if (missingGateChecks.length > 0) {
    lines.push('  • Missing export-flow tests appear unrelated to the changed files.');
  }

  // Test run failure caution
  if (testRunFailed) {
    lines.push(
      '  • Because the PR test run failed, missing baseline tests may be a consequence of ' +
      'incomplete test execution. Rerun after fixing failures before treating missing tests as intentional removal.',
    );
  }

  // Final recommendation
  if (frontendPaths.length > 0 && phpPaths.length === 0) {
    lines.push('  • Recommendation: first verify whether test selection changed before treating this as a backend authorization regression.');
  } else if (newCandidateTests.length > 0) {
    lines.push('  • Recommendation: fix failing new tests first, then rerun the full suite to restore missing export evidence.');
  } else {
    lines.push('  • Recommendation: review the changed files against the missing export flows to assess impact.');
  }

  return lines.join('\n');
}

// ─── D/E: DB and resource-count aggregation helpers ──────────────────────────

/**
 * Aggregate export-route-removed findings (request + response pairs) into a
 * single medium-severity summary.  These findings always appear in pairs and
 * always stem from the same missing export-flow tests as the auth findings.
 */
function buildExportRoutesRemovedFinding(
  routes:           string[],
  findingCount:     number,
  missingTestCount: number,
): Finding {
  const ruleId      = 'behavior.business_logic.export_routes_removed';
  const fingerprint = createHash('sha256')
    .update(`${ruleId}:${routes.join(',')}`)
    .digest('hex')
    .slice(0, 16);

  const routeList   = routes.map((r) => `  • GET api/v1/${r}/export`).join('\n');
  const missingNote = missingTestCount > 0
    ? `These removals are consistent with ${missingTestCount} export-flow test(s) not running in the candidate: ` +
      `when export tests don't execute, their routes don't appear in the candidate trace aggregate.`
    : `These routes were present in the baseline but absent in the candidate trace.`;

  return {
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId,
    severity:    'medium',
    category:    'behavior_change',
    title:       `Export API route traces removed — ${routes.length} endpoint(s), ${findingCount} event(s)`,
    description:
      `${findingCount} behaviour-removed event(s) across ${routes.length} export API endpoint(s) ` +
      `were present in the baseline but absent in the candidate.\n\n` +
      `Affected routes:\n${routeList}\n\n` +
      missingNote,
    evidence:    [{ traceId: 'suite_aggregate', eventIds: [] }],
    recommendation:
      `These are a consequence of the missing export-flow tests, not a code-level route removal. ` +
      `Rerun the missing export tests to confirm these routes are still reachable.`,
  };
}

/**
 * Aggregate N "Behaviour change: DB::read/write X removed" findings into
 * a single medium-severity summary when they all stem from missing tests
 * (proportional reduction rather than a genuine application change).
 */
function buildDbRemovedAggregatedFinding(
  tables:           string[],
  count:            number,
  missingTestCount: number,
): Finding {
  const ruleId      = 'behavior.db_operations.suite_aggregate';
  const fingerprint = createHash('sha256')
    .update(`${ruleId}:${count}:${tables.slice(0, 5).join(',')}`)
    .digest('hex')
    .slice(0, 16);

  const topTables = tables.slice(0, 8).map((t) => `  • ${t}`).join('\n');
  const moreNote  = tables.length > 8 ? `\n  … and ${tables.length - 8} more` : '';

  return {
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId,
    severity:    'medium',
    category:    'behavior_change',
    title:       `Database operations removed from suite trace — ${count} table(s) affected`,
    description:
      `${count} database operation type(s) were present in the baseline suite trace but absent ` +
      `in the candidate. These removals are consistent with ${missingTestCount} test(s) not ` +
      `running in the candidate: when fewer tests execute, fewer DB operations appear in the ` +
      `aggregate trace.\n\n` +
      `Affected operations:\n${topTables}${moreNote}`,
    evidence:    [{ traceId: 'suite_aggregate', eventIds: [] }],
    recommendation:
      'These are likely proportional to missing tests rather than genuine application changes. ' +
      'Rerun the full test suite or rebaseline after confirming the missing tests are resolved.',
  };
}

/**
 * Aggregate minor resource-count-changed findings (below the significance threshold)
 * into one summary finding, showing only the top-N largest changes.
 */
function buildResourceCountAggregatedFinding(
  minorCount:       number,
  totalCount:       number,
  topEntries:       string[],
  missingTestCount: number,
): Finding {
  const ruleId      = 'behavior.resource_count.suite_aggregate';
  const fingerprint = createHash('sha256')
    .update(`${ruleId}:${minorCount}:${totalCount}`)
    .digest('hex')
    .slice(0, 16);

  const significantCount = totalCount - minorCount;
  const topBlock = topEntries.join('\n');

  return {
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId,
    severity:    'medium',
    category:    'behavior_change',
    title:
      `Resource operation counts proportionally reduced — ${minorCount} minor change(s) ` +
      `below threshold` + (significantCount > 0 ? ` (${significantCount} significant kept separate)` : ''),
    description:
      `${minorCount} resource operation count change(s) showed small proportional reductions ` +
      `(change is proportionally small relative to baseline — below the significance threshold). These are consistent with ` +
      `${missingTestCount} test(s) not running in the candidate rather than a code-level regression.\n\n` +
      `Largest reductions (top ${Math.min(topEntries.length, 5)}):\n${topBlock}`,
    evidence:    [{ traceId: 'suite_aggregate', eventIds: [] }],
    recommendation:
      `Verify that the count reductions are proportional to the missing tests. ` +
      `If all ${missingTestCount} missing test(s) are restored, these counts should return to baseline.`,
  };
}

// ─── Baseline parity diagnostic helper ───────────────────────────────────────

/**
 * Builds a single audit-quality finding that surfaces a probable baseline/candidate
 * capture-depth mismatch — i.e. the baseline was created at Level 1/2 (no auth
 * or resource events) while the candidate was captured at Level 4/5.  Without this
 * diagnostic the analyst sees hundreds of "Authorization check added" findings and
 * must infer the root cause on their own.
 */
function buildBaselineParityFinding(params: {
  addedAuthCount:           number;
  baselinesMissingBehavior: number;
  totalMatched:             number;
  candidatesWithBehavior:   number;
}): Finding {
  const { addedAuthCount, baselinesMissingBehavior, totalMatched, candidatesWithBehavior } = params;
  const ruleId      = 'evidence.baseline_capture_mismatch';
  const fingerprint = createHash('sha256')
    .update(`${ruleId}:${addedAuthCount}:${baselinesMissingBehavior}:${totalMatched}`)
    .digest('hex')
    .slice(0, 16);

  const pct = Math.round((baselinesMissingBehavior / totalMatched) * 100);

  return {
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId,
    severity:    'medium',
    category:    'audit_quality',
    title:       'Baseline quality mismatch — findings may reflect instrumentation depth, not PR behaviour',
    description:
      `${baselinesMissingBehavior} of ${totalMatched} matched baselines (${pct}%) contain no ` +
      `authorization or resource events, while ${candidatesWithBehavior} candidate trace(s) captured ` +
      `${addedAuthCount} added authorization signature(s). ` +
      `This pattern strongly suggests the baselines were created at a lower instrumentation level ` +
      `(e.g. Level 1–2) while the candidate run was captured at Level 4–5. ` +
      `Many "Authorization check added" and "Resource count changed" findings in this report ` +
      `are likely depth artifacts rather than real PR regressions.`,
    evidence:    [{ traceId: 'audit_quality', eventIds: [] }],
    recommendation:
      'Regenerate baselines at the same capture level as the candidate:\n' +
      '  tracegraph baseline create --reason "Rebaseline at full instrumentation depth"\n' +
      'Then re-run the audit to obtain a clean finding set that reflects actual PR behaviour.',
  };
}

function buildSuppressionsModifiedFinding(): Finding {
  const ruleId      = 'policy.suppressions_modified';
  const fingerprint = createHash('sha256')
    .update(`${ruleId}:tracegraph.suppressions.json`)
    .digest('hex')
    .slice(0, 16);

  return {
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId,
    severity:    'high',
    category:    'tracegraph_policy_change',
    title:       'Suppressions file modified in this change',
    description: 'The file .tracegraph/suppressions/tracegraph.suppressions.json has uncommitted ' +
                 'changes. Modifications to the suppressions file alter which findings are silenced, ' +
                 'which is a policy-level change that requires explicit human review.',
    evidence:    [{ traceId: 'policy', eventIds: [] }],
    recommendation:
      'Commit and review the suppressions change separately, or revert it if unintentional. ' +
      'Suppressions should be version-controlled and reviewed like code.',
  };
}

// ─── G6: TestDelta and TraceMatchingSummary helpers ──────────────────────────

/**
 * Load all stored baselines from baselinesDir.
 * Returns [] when the directory doesn't exist or is empty.
 */
function loadAllBaselines(baselinesDir: string): CompactBaseline[] {
  if (!fs.existsSync(baselinesDir)) return [];
  const result: CompactBaseline[] = [];
  for (const file of fs.readdirSync(baselinesDir)) {
    if (!file.endsWith('.baseline.json')) continue;
    try {
      const b = JSON.parse(
        fs.readFileSync(path.join(baselinesDir, file), 'utf8'),
      ) as CompactBaseline;
      result.push(b);
    } catch { /* skip unreadable file */ }
  }
  return result;
}

/** Convert a TraceEntrypoint into a human-readable TestIdentity. */
function sessionToTestIdentity(session: TraceSession): TestIdentity {
  const ep   = session.entrypoint;
  const hash = deriveTestId(ep);

  switch (ep.type) {
    case 'test_case': {
      // For per-test traces, derive pass/fail status from the test_run event's
      // metadata.testStatus ('pass' | 'fail' | 'skip').  This is the per-test
      // outcome written by the test-framework reporter (Vitest, PHPUnit).
      //
      // We deliberately do NOT use session.status here: when any test in the
      // suite fails, the overall CLI run exits non-zero and every trace file in
      // the run gets session.status='failed' — even passing ones.  That causes
      // the verdict section to list all 277 tests as failed instead of just the
      // handful that actually failed.
      const testRunEvent = session.events.find((e) => e.type === 'test_run');
      const rawStatus    = testRunEvent?.metadata?.['testStatus'] as string | undefined;
      const perTestStatus: TestIdentity['status'] =
        rawStatus === 'pass' ? 'passed'  :
        rawStatus === 'fail' ? 'failed'  :
        rawStatus === 'skip' ? 'skipped' : undefined;

      // First non-empty line of the assertion/error message — only for failures.
      // The test_run event's error.message contains the full assertion text; we
      // show just the first line so it fits in the verdict block without clutter.
      const rawMsg = rawStatus === 'fail' ? testRunEvent?.error?.message : undefined;
      const failureMessage = rawMsg
        ? rawMsg.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
        : undefined;

      return {
        testName:     ep.testName,
        testFile:     ep.testFile,
        identityHash: hash,
        framework:    session.framework ?? undefined,
        ...(perTestStatus   !== undefined ? { status:         perTestStatus   } : {}),
        ...(failureMessage  !== undefined ? { failureMessage: failureMessage  } : {}),
      };
    }
    case 'http_request':
      // HTTP-request traces are runner-level; don't surface their status as
      // individual test pass/fail — it would conflate probe failures with test failures.
      return { testName: `${ep.method} ${ep.path}`, identityHash: hash };
    case 'cli_command':
      // CLI-command traces represent the overall test-runner invocation, not an
      // individual test.  Omit status so the CLI trace never appears in the
      // "Failed tests" list that is shown to reviewers.
      return { testName: ep.command, identityHash: hash };
    default:
      return { testName: JSON.stringify(ep), identityHash: hash };
  }
}

/** Convert a stored CompactBaseline into a TestIdentity. */
function baselineToTestIdentity(b: CompactBaseline): TestIdentity {
  const ep = b.entrypoint;
  switch (ep.type) {
    case 'test_case':
      return {
        testName:     ep.testName,
        testFile:     ep.testFile,
        identityHash: b.testId,
        framework:    undefined,
      };
    case 'http_request':
      return { testName: `${ep.method} ${ep.path}`, identityHash: b.testId };
    case 'cli_command':
      return { testName: ep.command, identityHash: b.testId };
    default:
      return { testName: JSON.stringify(ep), identityHash: b.testId };
  }
}

/** G6: Compute the full test-set delta between stored baselines and candidate run. */
function computeTestDelta(
  allBaselines:             CompactBaseline[],
  candidateSessions:        TraceSession[],
  matchedCandidateTestIds:  Set<string>,
): TestDelta {
  const candidateIdentities  = candidateSessions.map(sessionToTestIdentity);
  const candidateTestIdSet   = new Set(candidateIdentities.map((i) => i.identityHash));

  const baselineIdentities   = allBaselines.map(baselineToTestIdentity);

  const matchedTests:        TestIdentity[] = [];
  const baselineOnlyTests:   TestIdentity[] = [];
  const candidateOnlyTests:  TestIdentity[] = [];

  for (const bi of baselineIdentities) {
    if (candidateTestIdSet.has(bi.identityHash)) {
      matchedTests.push(bi);
    } else {
      baselineOnlyTests.push(bi);
    }
  }
  for (const ci of candidateIdentities) {
    if (!matchedCandidateTestIds.has(ci.identityHash)) {
      candidateOnlyTests.push(ci);
    }
  }

  return {
    baselineTests:      baselineIdentities,
    candidateTests:     candidateIdentities,
    matchedTests,
    baselineOnlyTests,
    candidateOnlyTests,
  };
}

/** G6: Compute the trace matching summary and overall confidence. */
function computeTraceMatching(
  baselineCount:   number,
  candidateCount:  number,
  exactMatches:    number,
  allTracesLevel0?: boolean,
): TraceMatchingSummary {
  // Clamp first — in N:1 scenarios (many candidate runs against one baseline)
  // exactMatches can exceed baselineCount, producing negative unclamped values.
  const unmatchedBaseline  = Math.max(0, baselineCount  - exactMatches);
  const unmatchedCandidate = Math.max(0, candidateCount - exactMatches);

  let confidence: 'high' | 'medium' | 'low';
  if (exactMatches === 0) {
    confidence = baselineCount === 0 ? 'medium' : 'low';
  } else if (unmatchedBaseline === 0 && unmatchedCandidate === 0) {
    // All baselines were covered and all candidates matched.
    // G19: when all candidates are Level 0 the "match" is structural (same test IDs)
    // but carries no behavioral content — "high confidence" is misleading.
    confidence = allTracesLevel0 ? 'low' : 'high';
  } else {
    confidence = 'medium';
  }

  return {
    baselineCount,
    candidateCount,
    exactMatches,
    unmatchedBaseline,
    unmatchedCandidate,
    matchStrategy: 'exact',
    confidence,
    // G19: false signals the CI reporter that the match is structural only —
    // no behavioral comparison occurred because all traces were at Level 0.
    ...(allTracesLevel0 !== undefined ? { comparableContent: !allTracesLevel0 } : {}),
  };
}

// ─── G6: Architecture quality level ──────────────────────────────────────────

function computeArchQualityLevel(
  meta: { nodeCount: number; edgeCount: number; communityCount: number; godNodeCount: number } | null,
  effectiveEdgeCount?: number,
): ArchitectureQualityLevel {
  if (!meta || meta.nodeCount === 0) return 'A0';
  // Phase 2: use effectiveEdgeCount (static + runtime) when supplied so that
  // PHP projects with 0 graphify edges but > 0 runtime call edges don't get A1.
  const edges = effectiveEdgeCount ?? meta.edgeCount;
  if (edges === 0)               return 'A1';
  if (meta.communityCount === 0) return 'A2';
  if (meta.godNodeCount === 0)   return 'A3';
  return 'A4';
}

// ─── G7: Audit quality finding ───────────────────────────────────────────────

/**
 * Generate an audit_quality finding when the static graph has nodes but no
 * edges or communities — architecture drift detection is severely limited.
 *
 * @param language  Detected project language from trace sessions (null if unknown).
 *                  Used to generate targeted language-specific remediation advice.
 */
function buildGraphQualityFinding(
  nodeCount:      number,
  communityCount: number,
  language:       string | null,
): Finding {
  const ruleId      = 'audit.graph_quality.low';
  const fingerprint = createHash('sha256')
    .update(`${ruleId}:edges_zero`)
    .digest('hex')
    .slice(0, 16);

  const langHint = graphQualityLangHint(language);

  return {
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId,
    severity:    'info',
    category:    'audit_quality',
    title:       'Static graph has no relationships — architecture analysis limited (A1)',
    description:
      `The static graph contains ${nodeCount.toLocaleString()} node${nodeCount !== 1 ? 's' : ''} ` +
      `but 0 edges${communityCount === 0 ? ' and 0 communities' : ''}. ` +
      `Architecture analysis is limited to node-count comparison — blast radius, god-node detection, ` +
      `community drift, and cross-community edge detection are unavailable.`,
    evidence:    [{ traceId: 'static_graph', eventIds: [] }],
    recommendation:
      'Run `tracegraph graph build --verbose` to diagnose relationship extraction.\n' +
      langHint,
  };
}

/**
 * Return a language-specific remediation hint for the A1 graph-quality finding.
 * Falls back to a generic tip when the language is unknown or not specifically handled.
 */
function graphQualityLangHint(language: string | null): string {
  switch (language) {
    case 'php':
      return (
        'For PHP projects, ensure `composer dump-autoload` has been run so Graphify ' +
        'can resolve class imports and call chains. ' +
        'Set ANTHROPIC_API_KEY (or GEMINI_API_KEY) for full LLM-assisted edge extraction.'
      );
    case 'node':
    case 'typescript':
    case 'javascript':
      return (
        'For Node.js/TypeScript projects, ensure a `tsconfig.json` or `package.json` ' +
        'is present at the project root so Graphify can resolve module imports. ' +
        'Set ANTHROPIC_API_KEY (or GEMINI_API_KEY) for full LLM-assisted edge extraction. ' +
        'If already set, run `graphify . --verbose` to see why edge extraction produced 0 results.'
      );
    case 'python':
      return (
        'For Python projects, ensure `__init__.py` files exist and imports use package paths ' +
        'so Graphify can trace call edges. ' +
        'Set ANTHROPIC_API_KEY (or GEMINI_API_KEY) for full LLM-assisted edge extraction.'
      );
    default:
      return (
        'Set ANTHROPIC_API_KEY (or GEMINI_API_KEY) for full call-graph extraction — ' +
        'Graphify requires an LLM to resolve cross-file edges. ' +
        'Run `graphify . --verbose` to diagnose why 0 edges were produced.'
      );
  }
}

// ─── G19: Boot failure finding ───────────────────────────────────────────────

/** Dependency-file basenames that indicate package-level changes. */
const DEP_FILE_NAMES = new Set([
  'composer.json', 'composer.lock',
  'package.json',  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Gemfile',       'Gemfile.lock',
  'requirements.txt', 'pyproject.toml', 'Pipfile', 'Pipfile.lock',
]);

/**
 * Build a high-severity audit_quality finding for a boot failure.
 *
 * Fires when ALL candidate traces are Level 0 (runner metadata only) and the
 * PR test run exited with a non-zero code.  This represents a framework startup
 * crash — the app never reached any test, so runtime comparison is meaningless.
 *
 * When the PR changes dependency files, a dependency-drift diagnosis block is
 * appended so reviewers know what commands to run to investigate.
 */
function buildBootFailureFinding(prContext: PrContext | null | undefined): Finding {
  const ruleId      = 'audit.test_boot_failed';
  const fingerprint = createHash('sha256')
    .update(ruleId)
    .digest('hex')
    .slice(0, 16);

  const bootError    = prContext?.bootError;
  const changedPaths = prContext?.changedFilePaths ?? [];

  // Detect dependency-file changes (e.g. composer.lock, package.json)
  const changedDepFiles = changedPaths.filter((f) => {
    const base = f.split('/').pop() ?? '';
    return DEP_FILE_NAMES.has(base);
  });
  const hasDependencyChanges = changedDepFiles.length > 0;

  // ── Title ────────────────────────────────────────────────────────────────
  let title: string;
  if (bootError) {
    const firstLine = bootError.split('\n')[0] ?? bootError;
    title = `Boot failure: ${firstLine.slice(0, 120)}`;
  } else {
    title = 'Application failed to boot before tests could run';
  }

  // ── Description ──────────────────────────────────────────────────────────
  let description =
    'The PR branch application crashed during startup before the test framework ' +
    'executed any test cases. Runtime comparison is not meaningful — no behavioral ' +
    'evidence was captured.\n\n' +
    'All evidence continuity findings (missing baselined tests) are suppressed — they ' +
    'are artifacts of the boot failure, not independent issues.';

  if (bootError) {
    description +=
      `\n\nBoot error:\n\`\`\`\n${bootError}\n\`\`\``;
  }

  if (hasDependencyChanges) {
    const depList = changedDepFiles.map((f) => f.split('/').pop()).join(', ');
    description +=
      `\n\nThis PR modifies dependency files (${depList}). ` +
      'The boot error may be caused by a dependency API change, removed method, ' +
      'or incompatible package version introduced by this change.';
  }

  // ── Recommendation ───────────────────────────────────────────────────────
  let recommendation: string;
  if (hasDependencyChanges) {
    recommendation =
      'Investigate the dependency changes in this PR:\n' +
      '  1. Check for breaking changes in the updated packages\n' +
      '  2. Run `composer show --outdated` to identify version conflicts\n' +
      '  3. Run `composer why <package-name>` to trace a specific dependency\n' +
      '  4. Fix the boot error, then re-run the audit.';
  } else {
    recommendation =
      'Fix the boot error in the PR branch, then re-run the audit to get ' +
      'meaningful runtime evidence.';
  }

  return {
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId,
    severity:    'high',
    category:    'audit_quality',
    title,
    description,
    recommendation,
  };
}

// ─── G7: Verdict computation ─────────────────────────────────────────────────

/**
 * G7 — Compute the audit verdict from findings, evidence, and trace matching.
 *
 * Rules (highest precedence first):
 *   insufficient_evidence — no runtime traces compared at all
 *   no_go                 — critical application findings
 *   review_required       — high application findings, evidence continuity gaps,
 *                           or low trace-matching confidence with baselines
 *   conditional_go        — only medium / low findings
 *   pass                  — no open application findings with adequate evidence
 */
function computeVerdict(
  uniqueFindings:  EvaluatedFinding[],
  tracesCompared:  number,
  assurance:       AssuranceLevel,
  traceMatching:   TraceMatchingSummary,
  prContext?:      PrContext | null,
  allTracesLevel0?: boolean,
): AuditVerdict {
  const openFindings = uniqueFindings.filter((f) => f.status === 'open');

  // Exclude audit_quality and policy findings from application verdict signals —
  // they surface as info/context, not as blockers or evidence of a regression.
  const appFindings = openFindings.filter(
    (f) => f.category !== 'audit_quality' && f.category !== 'tracegraph_policy_change',
  );

  const hasCritical           = appFindings.some((f) => f.severity === 'critical');
  const hasHigh               = appFindings.some((f) => f.severity === 'high');
  const hasEvidenceContinuity = appFindings.some((f) => f.category === 'evidence_continuity');

  // G16.1: surface test failure in verdict context when tests failed
  const prTestFailed       = (prContext?.testRunExitCode ?? 0) !== 0;
  const baselineTestFailed = (prContext?.baselineRunExitCode ?? 0) !== 0;

  // 0. Vacuous pass guard — ALL traces were at Level 0 (runner metadata only, no test events).
  // When every candidate session failed at Level 0, the diff compared two empty event sets
  // and produced clean results not because the PR is safe but because nothing was observed.
  // This is insufficient evidence, not a pass — returning pass would be a false green.
  if (allTracesLevel0 && tracesCompared > 0) {
    const reasons: string[] = [
      'All traces were captured at Level 0 (runner metadata only) — no test events were recorded.',
      'The diff compared empty traces and found no changes, which does not mean the PR is safe.',
    ];
    if (prTestFailed) {
      reasons.push(
        `PR branch tests exited with code ${prContext!.testRunExitCode} — ` +
        'test failures prevented the capture of any runtime behaviour.',
      );
    }
    if (baselineTestFailed) {
      reasons.push(
        `Baseline tests also failed (exit:${prContext!.baselineRunExitCode}) — ` +
        'the baseline itself was captured from a failing run.',
      );
    }
    reasons.push(
      'Fix the test environment (database, missing extensions, boot errors) and re-run ' +
      'the audit to get a meaningful result.',
    );
    return { status: 'insufficient_evidence', reasons };
  }

  // 1. Insufficient evidence — no runtime comparison happened
  if (tracesCompared === 0 && assurance.level <= 1) {
    const reasons: string[] = [
      'No runtime traces were compared against baselines.',
      assurance.level === 0
        ? 'No static graph and no runtime traces available.'
        : 'Only a static graph is available — no runtime behaviour was observed.',
    ];
    if (prTestFailed) {
      reasons.push(
        `PR branch tests exited with code ${prContext!.testRunExitCode} — ` +
        'test failures may have prevented trace capture.',
      );
    }
    return { status: 'insufficient_evidence', reasons };
  }

  // 2. No-go — critical security or application findings
  if (hasCritical) {
    const openCritical = appFindings.filter((f) => f.severity === 'critical' && f.status === 'open');

    // When a grouped "evidence.authorization_missing.grouped" finding exists it
    // already summarises all individual auth-missing children.  Exclude the
    // individual children from the reasons list so we don't repeat the same
    // information 6+ times in the verdict header.
    const hasGroupedAuth = openCritical.some((f) => f.ruleId === 'evidence.authorization_missing.grouped');
    const critForReasons = hasGroupedAuth
      ? openCritical.filter((f) => f.ruleId !== 'evidence.authorization_missing')
      : openCritical;

    const critTitles = critForReasons.map((f) => `• ${f.title}`);
    // When all criticals are auth-evidence gaps, "findings" implies a confirmed
    // vulnerability — use "evidence gap" to reflect the actual nature of the block.
    const leadReason = hasGroupedAuth
      ? 'Critical evidence gap requires resolution before merge.'
      : 'Critical findings require resolution before merge.';
    return {
      status:  'no_go',
      reasons: [leadReason, ...critTitles],
    };
  }

  // 3. Review required
  const reviewReasons: string[] = [];
  if (hasHigh) {
    const highTitles = appFindings
      .filter((f) => f.severity === 'high' && f.status === 'open')
      .map((f) => `• ${f.title}`);
    reviewReasons.push(
      'High-severity application behavior findings detected.',
      ...highTitles,
    );
  }
  if (hasEvidenceContinuity) {
    reviewReasons.push(
      'Previously baselined test evidence was not observed in the candidate run.',
    );
  }
  if (traceMatching.confidence === 'low' && traceMatching.baselineCount > 0) {
    reviewReasons.push(
      'Trace matching confidence is low — candidate and baseline may cover different test subsets.',
    );
  }
  // NOTE: prTestFailed does NOT by itself trigger review_required.
  // The test failure warning is shown prominently via the G14.5 blockquote in
  // renderVerdictSection.  Escalating the verdict on test failure alone would
  // produce false review_required verdicts when tests fail for infrastructure
  // reasons (missing env vars, port conflicts) unrelated to code regressions.
  if (reviewReasons.length > 0) {
    return { status: 'review_required', reasons: reviewReasons };
  }

  // 4. Conditional go — medium / low findings only
  if (appFindings.length > 0) {
    const medFindings = appFindings.filter((f) => f.severity === 'medium');
    const lowFindings = appFindings.filter((f) => f.severity === 'low' || f.severity === 'info');
    const reasons: string[] = ['No critical or high-severity findings detected.'];

    if (medFindings.length > 0) {
      reasons.push(
        `${medFindings.length} medium-severity finding${medFindings.length !== 1 ? 's' : ''} ` +
        `require review: ${medFindings.slice(0, 2).map((f) => f.title).join('; ')}` +
        (medFindings.length > 2 ? ` … and ${medFindings.length - 2} more` : '.'),
      );
    }
    if (lowFindings.length > 0) {
      reasons.push(
        `${lowFindings.length} low/info finding${lowFindings.length !== 1 ? 's' : ''} noted ` +
        '(non-blocking but worth reviewing).',
      );
    }
    if (baselineTestFailed) {
      reasons.push(
        `Baseline tests also failed (exit:${prContext!.baselineRunExitCode}) — ` +
        'some medium findings may be pre-existing rather than caused by this PR.',
      );
    }
    return { status: 'conditional_go', reasons };
  }

  // 5. Pass
  if (assurance.level >= 3) {
    return {
      status:  'pass',
      reasons: [
        'No open application findings detected.',
        `Evidence assurance: Level ${assurance.level} — ${assurance.label}.`,
      ],
    };
  }

  // Fallback: no findings but limited evidence
  const fallbackReasons: string[] = [
    'No application findings detected, but evidence coverage is limited.',
    `Evidence assurance: Level ${assurance.level} — ${assurance.label}.`,
  ];
  if (prTestFailed) {
    fallbackReasons.push(
      `PR branch tests exited with code ${prContext!.testRunExitCode} — ` +
      'limited trace coverage may mean some changes were not exercised.',
    );
  }
  return { status: 'conditional_go', reasons: fallbackReasons };
}

// ─── G8: PR context ───────────────────────────────────────────────────────────

/**
 * G8 — Load the PR context file written by `tracegraph audit` before calling compare.
 * Returns null when running outside of `tracegraph audit` (standalone `tracegraph compare`).
 */
function loadPrContext(tracegraphDir: string): PrContext | null {
  const ctxPath = path.join(tracegraphDir, 'pr-context.json');
  if (!fs.existsSync(ctxPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(ctxPath, 'utf8')) as PrContext;
  } catch {
    return null;
  }
}
