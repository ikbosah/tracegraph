/**
 * T2.10 — CI Reporter
 *
 * Renders a TraceReport in various output formats:
 *   markdown            — human-readable report for PR comments / terminal
 *   json                — passthrough of report JSON
 *   github-step-summary — markdown written to $GITHUB_STEP_SUMMARY
 */
import type {
  TraceReport,
  EvaluatedFinding,
  FindingSeverity,
  FindingCategory,
  AssuranceLevel,
  AuditVerdict,
  TestDelta,
  TraceMatchingSummary,
  PrContext,
} from '@tracegraph/shared-types';

export type ReportFormat = 'markdown' | 'json' | 'github-step-summary';

export type RenderOptions = {
  format?: ReportFormat;
  /** Project name shown in the report header. */
  projectName?: string;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a `TraceReport` to the requested format.
 *
 * @param report   The report produced by `tracegraph compare`.
 * @param options  Output format and display options.
 * @returns        The rendered output as a string.
 */
export function renderReport(report: TraceReport, options: RenderOptions = {}): string {
  const { format = 'markdown' } = options;

  switch (format) {
    case 'json':               return JSON.stringify(report, null, 2);
    case 'github-step-summary':
    case 'markdown':           return renderMarkdown(report, options);
  }
}

// ─── Markdown renderer ───────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '🔵',
  info:     '⚪',
};

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

// ─── Category group helpers ───────────────────────────────────────────────────

function isSecurity(category: FindingCategory): boolean {
  return category.startsWith('security_');
}

function isReliability(category: FindingCategory): boolean {
  return (
    category === 'performance' ||
    category === 'data_integrity' ||
    category === 'race_condition' ||
    category === 'idempotency' ||
    category === 'retry_storm'
  );
}

function isPolicy(category: FindingCategory): boolean {
  return category === 'tracegraph_policy_change';
}

function isArchitecture(category: FindingCategory): boolean {
  return category === 'architecture_risk' || category === 'architecture_inferred';
}

/** G6: test evidence continuity findings (missing baselined tests). */
function isEvidenceContinuity(category: FindingCategory): boolean {
  return category === 'evidence_continuity';
}

/** G7: audit quality / meta-diagnostic findings. */
function isAuditQuality(category: FindingCategory): boolean {
  return category === 'audit_quality';
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderMarkdown(report: TraceReport, options: RenderOptions): string {
  const project = options.projectName ?? 'TraceGraph';
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`## ${project} — Behaviour Diff Report`);
  lines.push('');

  const date = new Date(report.createdAt).toUTCString();
  lines.push(`_Generated: ${date}_`);
  lines.push('');

  // ── G8: PR Context ────────────────────────────────────────────────────────
  if (report.prContext) {
    lines.push(...renderPrContextSection(report.prContext));
  }

  // ── G7: Verdict ───────────────────────────────────────────────────────────
  if (report.verdict) {
    // G14.5 + G16.2: pass prContext, findings, and testDelta so the verdict section
    // can show the test-failure warning, failed test names, and new-test context.
    lines.push(...renderVerdictSection(
      report.verdict,
      report.prContext ?? null,
      report.findings,
      report.testDelta,
    ));
  }

  // ── Summary table ─────────────────────────────────────────────────────────
  const { summary } = report;
  const openFindings = report.findings.filter((f) => f.status === 'open');

  // When a grouped auth finding exists, suppress individual auth-missing children
  // from the summary category counts — same deduplication applied by compare.ts
  // to findingsBySeverity.  Without this, "Security findings | 7" appears while
  // "Total findings | 6", which is confusing and contradictory.
  const hasGroupedAuth = openFindings.some(
    (f) => f.ruleId === 'evidence.authorization_missing.grouped'
  );
  // Count individual auth-missing children separately — used for "Affected checks" row.
  const authChildCount = openFindings.filter(
    (f) => f.ruleId === 'evidence.authorization_missing'
  ).length;
  const dedupedOpenFindings = hasGroupedAuth
    ? openFindings.filter((f) => f.ruleId !== 'evidence.authorization_missing')
    : openFindings;

  const securityCount        = dedupedOpenFindings.filter((f) => isSecurity(f.category)).length;
  const reliabilityCount     = dedupedOpenFindings.filter((f) => isReliability(f.category)).length;
  const architectureCount    = dedupedOpenFindings.filter((f) => isArchitecture(f.category)).length;
  const evidenceContCount    = dedupedOpenFindings.filter((f) => isEvidenceContinuity(f.category)).length;

  lines.push('### Summary');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Traces compared | ${summary.tracesCompared} |`);

  const totalFindings = Object.values(summary.findingsBySeverity).reduce((a, b) => a + b, 0);
  lines.push(`| Total findings | ${totalFindings} |`);

  for (const sev of SEVERITY_ORDER) {
    const count = summary.findingsBySeverity[sev] ?? 0;
    if (count > 0) {
      // When all critical findings are an auth-evidence gap, "incidents" is more
      // accurate than "findings" — the grouped finding is one incident, not a
      // confirmed vulnerability.
      const label = (sev === 'critical' && hasGroupedAuth) ? 'Critical incidents' : `${capitalise(sev)} findings`;
      lines.push(`| ${SEVERITY_EMOJI[sev]} ${label} | ${count} |`);
      // Immediately after the critical incidents row, show how many auth checks are affected.
      if (sev === 'critical' && hasGroupedAuth && authChildCount > 0) {
        lines.push(`| ↳ Affected authorization checks | ${authChildCount} |`);
      }
    }
  }

  // Security / reliability / architecture category rows are shown only when they add
  // new information beyond the severity rows above.  When hasGroupedAuth is true the
  // security count equals the critical incident count — suppress the redundant row.
  if (securityCount > 0 && !hasGroupedAuth) {
    lines.push(`| 🔐 Security findings | ${securityCount} |`);
  }
  if (reliabilityCount > 0) {
    lines.push(`| ⚙️ Reliability findings | ${reliabilityCount} |`);
  }
  if (architectureCount > 0) {
    lines.push(`| 🏗️ Architecture findings | ${architectureCount} |`);
  }
  if (evidenceContCount > 0) {
    lines.push(`| 🧪 Evidence continuity | ${evidenceContCount} missing tests |`);
  }
  if (summary.suppressionsModified) {
    lines.push(`| Suppressions file | ⚠️ Modified in this change |`);
  }

  // G3C: assurance level in summary table
  if (report.assurance) {
    const LEVEL_ICONS = ['⬜', '🔵', '🟡', '🟢', '✅', '🛡️'] as const;
    const icon = LEVEL_ICONS[report.assurance.level] ?? '⬜';
    // G6: show architecture quality level alongside assurance
    // G15.1: use ⚠️ for A0/A1 — ✅ is misleading when there are no graph edges
    const aqLevel = report.assurance.architectureQualityLevel;
    // A0/A1 = no edges → ⚠️; A2 = edges but no communities → ⚠️ limited; A3+ = ✅
    const archIcon  = (aqLevel === 'A0' || aqLevel === 'A1' || aqLevel === 'A2') ? '⚠️' : aqLevel ? '✅' : '';
    const archLabel = aqLevel === 'A2' ? 'Graph A2-limited' : aqLevel ? `Graph ${aqLevel}` : '';
    const archSuffix = archLabel ? ` · ${archIcon} ${archLabel}` : '';
    // Issue 6: qualify assurance when PR test run failed — Level 4 is technically
    // correct for matched traces but the overall run is degraded.
    const testRunFailed = (report.prContext?.testRunExitCode ?? 0) !== 0;
    const assuranceSuffix = testRunFailed
      ? ' _(partial — PR run failed)_'
      : '';
    lines.push(`| Evidence assurance | ${icon} Level ${report.assurance.level}${archSuffix}${assuranceSuffix} |`);
  }
  lines.push('');

  // ── PR-Relevant Evidence ──────────────────────────────────────────────────
  // Shown before the (potentially large) findings sections so reviewers see what
  // this PR actually changed and whether real regressions exist, without needing
  // to scroll past 100+ evidence-continuity findings to reach that conclusion.
  // Rendered only when there are new tests or an evidence-continuity-only verdict.
  {
    const prNewTests      = report.testDelta?.candidateOnlyTests ?? [];
    const openFPr         = report.findings.filter((f) => f.status === 'open');
    const evidContCountPr = openFPr.filter((f) => isEvidenceContinuity(f.category)).length;
    const behavFindingsPr = openFPr.filter(
      (f) => !isEvidenceContinuity(f.category) && !isAuditQuality(f.category),
    );
    const hasHighCritPr   = behavFindingsPr.some(
      (f) => f.severity === 'critical' || f.severity === 'high',
    );

    if (prNewTests.length > 0 || evidContCountPr > 5) {
      lines.push('### 🔎 PR-Relevant Evidence');
      lines.push('');

      // New tests — deduplicated (same test in multiple traces → one entry with count)
      if (prNewTests.length > 0) {
        const prTestGroups = new Map<string, { traceCount: number; testFile?: string }>();
        for (const t of prNewTests) {
          const label = humanTestLabel(t.testName);
          const g     = prTestGroups.get(label);
          if (g) {
            g.traceCount++;
          } else {
            prTestGroups.set(label, {
              traceCount: 1,
              testFile:   t.testFile && !t.testFile.includes('vendor/') ? t.testFile : undefined,
            });
          }
        }
        lines.push(`**New test${prTestGroups.size !== 1 ? 's' : ''} introduced by this PR:**`);
        lines.push('');
        for (const [label, g] of prTestGroups) {
          const traceTag = g.traceCount > 1 ? ` _(${g.traceCount} traces)_` : '';
          lines.push(`- ✅ \`${label}\`${traceTag}`);
          if (g.testFile) {
            lines.push(`  _File: \`${g.testFile}\`_`);
          }
        }
        lines.push('');
      }

      // Runtime verdict for the PR's own changes
      lines.push('**Runtime analysis:**');
      lines.push('');
      if (!hasHighCritPr) {
        lines.push('- ✅ No critical or high-severity behavior regressions detected in matched traces');
      }
      if (behavFindingsPr.length > 0) {
        lines.push(`- 🟡 ${behavFindingsPr.length} medium/low behavior change(s) detected — see findings below`);
      } else {
        lines.push('- ✅ No behavioral differences observed in matched traces');
      }
      if (evidContCountPr > 5) {
        const allMatch   = (report.traceMatching?.unmatchedBaseline ?? -1) === 0;
        const baselineCt = report.traceMatching?.baselineCount ?? 0;
        if (allMatch && baselineCt > 0) {
          lines.push(
            `- 🔍 ${evidContCountPr} test files from baseline not reported by the candidate runner ` +
            `(all ${baselineCt} baseline traces matched — likely a test-command scope difference, ` +
            `not a PR regression; see Evidence Continuity below)`,
          );
        } else {
          lines.push(
            `- 🟡 ${evidContCountPr} previously baselined tests not observed — see Evidence Continuity below`,
          );
        }
      }
      lines.push('');
    }
  }

  // ── Open findings ─────────────────────────────────────────────────────────
  if (openFindings.length > 0) {
    // Security section
    const securityFindings = openFindings.filter((f) => isSecurity(f.category));
    if (securityFindings.length > 0) {
      lines.push('### 🔐 Security Findings');
      lines.push('');
      for (const sev of SEVERITY_ORDER) {
        const group = securityFindings.filter((f) => f.severity === sev);
        if (group.length === 0) continue;
        lines.push(`#### ${SEVERITY_EMOJI[sev]} ${capitalise(sev)}`);
        lines.push('');
        for (const f of group) lines.push(renderFinding(f));
      }
    }

    // Reliability section
    const reliabilityFindings = openFindings.filter((f) => isReliability(f.category));
    if (reliabilityFindings.length > 0) {
      lines.push('### ⚙️ Reliability Findings');
      lines.push('');
      // G13.7: PR relevance callout when test files changed AND duplicate-request findings exist.
      // If the PR modified test files and we see duplicate-outbound findings, the findings may
      // originate from test harness behaviour rather than production code.  Flag this for reviewers.
      const hasDuplicateFindings = reliabilityFindings.some(
        (f) => f.ruleId === 'reliability.duplicate_side_effects' ||
               f.ruleId === 'reliability.duplicate_test_client_requests',
      );
      const testFilesChanged = (report.prContext?.changedFilePaths ?? []).some(
        (p) => /\.(test|spec)\.[tj]sx?$/.test(p) || /\/__tests__\//.test(p) || /\/test\//.test(p),
      );
      if (hasDuplicateFindings && testFilesChanged) {
        lines.push(
          '> ℹ️ **PR relevance note:** This PR modifies test files. Some duplicate-request ' +
          'findings may originate from test harness behaviour (e.g. a test that intentionally ' +
          'calls the same endpoint multiple times) rather than a production code regression. ' +
          'Review each finding in the context of the changed test code.',
        );
        lines.push('');
      }
      for (const sev of SEVERITY_ORDER) {
        const group = reliabilityFindings.filter((f) => f.severity === sev);
        if (group.length === 0) continue;
        lines.push(`#### ${SEVERITY_EMOJI[sev]} ${capitalise(sev)}`);
        lines.push('');
        for (const f of group) lines.push(renderFinding(f));
      }
    }

    // Architecture section (G5)
    const architectureFindings = openFindings.filter((f) => isArchitecture(f.category));
    if (architectureFindings.length > 0) {
      lines.push('### 🏗️ Architecture Findings');
      lines.push('');
      for (const sev of SEVERITY_ORDER) {
        const group = architectureFindings.filter((f) => f.severity === sev);
        if (group.length === 0) continue;
        lines.push(`#### ${SEVERITY_EMOJI[sev]} ${capitalise(sev)}`);
        lines.push('');
        for (const f of group) lines.push(renderFinding(f));
      }
    }

    // G6: Evidence continuity section (missing baselined tests)
    const evidenceContinuityFindings = openFindings.filter((f) => isEvidenceContinuity(f.category));
    if (evidenceContinuityFindings.length > 0) {
      lines.push('### 🧪 Evidence Continuity');
      lines.push('');
      lines.push(
        '> Previously baselined tests were not observed in the candidate run. ' +
        'This may be intentional (test renamed/removed) or indicate a test configuration problem.',
      );
      lines.push('');
      // When many tests are missing, individual blocks create unreadable boilerplate.
      // > 5 findings: show a mismatch diagnostic, a directory breakdown table,
      // and collapse all individual findings under a <details> element.
      if (evidenceContinuityFindings.length > 5) {
        // Determine whether this is a run-configuration mismatch vs genuine test removals.
        // When unmatchedBaseline === 0, all baseline traces ARE present in the candidate —
        // the missing-test findings come only from the test reporter's narrower file scope.
        const allBaselinesMatched = (report.traceMatching?.unmatchedBaseline ?? -1) === 0;
        const baselineTraceCount  = report.traceMatching?.baselineCount ?? 0;

        if (allBaselinesMatched && baselineTraceCount > 0) {
          lines.push(
            `> 🔍 **Likely run-configuration mismatch, not a PR regression.** ` +
            `All ${baselineTraceCount} baseline traces were matched in the candidate run. ` +
            `The ${evidenceContinuityFindings.length} missing-test findings reflect the test reporter ` +
            `observing a narrower file set than the baseline was created from ` +
            `(e.g. only the changed test file ran while the baseline covered the full suite). ` +
            `These do not indicate regressions introduced by this PR.`,
          );
        } else {
          lines.push(
            `> ⚠️ **${evidenceContinuityFindings.length} previously baselined tests not observed.** ` +
            `Check your test command scope and whether the baseline was created from broader coverage.`,
          );
        }
        lines.push('');

        // Group by directory — a table is far more scannable than 109 individual blocks
        const dirCounts = new Map<string, number>();
        for (const f of evidenceContinuityFindings) {
          const fp  = f.testIdentity?.testFile;
          const dir = fp
            ? (fp.includes('/') ? fp.slice(0, fp.lastIndexOf('/') + 1) : './')
            : '(test cases — no file info)';
          dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
        }
        const sortedDirs = [...dirCounts.entries()].sort(([, a], [, b]) => b - a);
        if (sortedDirs.length > 1) {
          lines.push('**Missing evidence by directory:**');
          lines.push('');
          lines.push('| Directory | Missing tests |');
          lines.push('|---|---|');
          for (const [dir, count] of sortedDirs) {
            lines.push(`| \`${dir}\` | ${count} |`);
          }
          lines.push('');
        }

        lines.push('<details>');
        lines.push(`<summary>All ${evidenceContinuityFindings.length} evidence continuity findings (click to expand)</summary>`);
        lines.push('');
        for (const f of evidenceContinuityFindings) lines.push(renderEvidenceContinuityFinding(f));
        lines.push('</details>');
        lines.push('');
      } else {
        for (const f of evidenceContinuityFindings) lines.push(renderEvidenceContinuityFinding(f));
      }
    }

    // Policy section
    const policyFindings = openFindings.filter((f) => isPolicy(f.category));
    if (policyFindings.length > 0) {
      lines.push('### 📋 Policy Findings');
      lines.push('');
      for (const f of policyFindings) lines.push(renderFinding(f));
    }

    // G7: Audit quality diagnostics (info-level — shown last in findings)
    const auditQualityFindings = openFindings.filter((f) => isAuditQuality(f.category));
    if (auditQualityFindings.length > 0) {
      lines.push('### ⚪ Audit Diagnostics');
      lines.push('');
      lines.push('> These are meta-diagnostic findings about the audit itself, not application behaviour.');
      lines.push('');
      for (const f of auditQualityFindings) lines.push(renderFinding(f));
    }

    // Remaining findings (behaviour changes, etc.)
    const otherFindings = openFindings.filter(
      (f) =>
        !isSecurity(f.category) &&
        !isReliability(f.category) &&
        !isArchitecture(f.category) &&
        !isPolicy(f.category) &&
        !isEvidenceContinuity(f.category) &&
        !isAuditQuality(f.category),
    );
    if (otherFindings.length > 0) {
      lines.push('### Findings');
      lines.push('');
      for (const sev of SEVERITY_ORDER) {
        const group = otherFindings.filter((f) => f.severity === sev);
        if (group.length === 0) continue;
        lines.push(`#### ${SEVERITY_EMOJI[sev]} ${capitalise(sev)}`);
        lines.push('');
        for (const f of group) lines.push(renderFinding(f));
      }
    }
  } else {
    lines.push('### Findings');
    lines.push('');
    lines.push('✅ No open findings.');
    lines.push('');
  }

  // ── Approved / suppressed findings ────────────────────────────────────────
  const nonOpen = report.findings.filter((f) => f.status !== 'open');
  if (nonOpen.length > 0) {
    lines.push('<details>');
    lines.push('<summary>Approved / suppressed findings</summary>');
    lines.push('');
    for (const f of nonOpen) {
      const badge = f.status === 'approved' ? '✅ Approved' : '🔇 Suppressed';
      lines.push(`- ${badge} — ${f.title} _(${f.ruleId})_`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // ── Behaviour changes (diffs summary) ────────────────────────────────────
  // G6: exclude test_artifact events — they are surfaced in "Evidence Continuity".
  const isAppChange = (sig: { role?: string | null }): boolean => sig.role !== 'test_artifact';

  const diffsWithChanges = report.diffs.filter(
    (d) =>
      d.addedSignatures.filter(isAppChange).length > 0 ||
      d.removedSignatures.filter(isAppChange).length > 0,
  );
  if (diffsWithChanges.length > 0) {
    // G13.6: renamed to "Observed Behaviour Changes" to clarify these are runtime observations
    lines.push('### Observed Behaviour Changes');
    lines.push('');
    // G13.6: intro blockquote to set context for reviewers
    lines.push(
      '> The following changes were observed between the baseline and candidate runs. ' +
      'Each entry represents a difference in runtime behaviour — not necessarily a bug. ' +
      'Review each change in the context of the PR diff to determine if it is intentional.',
    );
    lines.push('');

    // Pre-pass: find removal signatures present in EVERY trace that has changes.
    // When the same event is missing from all traces, show it once at the top
    // instead of repeating it once per trace.
    const removalTraceCount = new Map<string, number>();
    for (const diff of diffsWithChanges) {
      const seen = new Set<string>();
      for (const r of diff.removedSignatures.filter(isAppChange)) {
        const key = r.eventName ?? r.signature.functionName ?? r.signature.eventType ?? '';
        if (key && !seen.has(key)) { seen.add(key); removalTraceCount.set(key, (removalTraceCount.get(key) ?? 0) + 1); }
      }
    }
    // Cross-trace: removed in every diff-having trace (and more than one trace affected)
    const crossTrace = new Set<string>(
      [...removalTraceCount.entries()]
        .filter(([, n]) => n === diffsWithChanges.length && diffsWithChanges.length > 1)
        .map(([key]) => key),
    );

    if (crossTrace.size > 0) {
      const traceWord = diffsWithChanges.length === 1 ? 'trace' : `all ${diffsWithChanges.length} traces`;
      lines.push(`Removed from baseline in ${traceWord}:`);
      // Render using the first diff that contains each cross-trace removal for display metadata
      const firstDiff = diffsWithChanges[0]!;
      for (const key of crossTrace) {
        const r = firstDiff.removedSignatures.find(
          (s) => (s.eventName ?? s.signature.functionName ?? s.signature.eventType ?? '') === key,
        );
        const role = r?.role ?? 'unknown';
        lines.push(`  - ❌ \`${key}\` _(${role})_`);
      }
      lines.push('');
    }

    for (const diff of diffsWithChanges) {
      // Per-trace removals: only app-change events NOT already shown as cross-trace
      const uniqueRemovals = diff.removedSignatures.filter((r) => {
        if (!isAppChange(r)) return false;
        const key = r.eventName ?? r.signature.functionName ?? r.signature.eventType ?? '';
        return !crossTrace.has(key);
      });
      const appAdded = diff.addedSignatures.filter(isAppChange);
      const hasUniqueChanges = uniqueRemovals.length > 0 || appAdded.length > 0;
      if (!hasUniqueChanges) continue;

      // G13.5: prefer the human-readable testName; fall back to truncated traceId
      const traceHeading = diff.testName
        ? `**${diff.testName}**`
        : `**Trace \`${diff.traceId.slice(0, 12)}…\`**`;
      lines.push(traceHeading);
      lines.push('');

      if (uniqueRemovals.length > 0) {
        lines.push('Removed from baseline:');
        for (const r of uniqueRemovals) {
          const role = r.role ?? 'unknown';
          lines.push(`  - ❌ \`${r.eventName ?? r.signature.functionName ?? r.signature.eventType}\` _(${role})_`);
        }
      }
      if (appAdded.length > 0) {
        lines.push('Added vs baseline:');
        for (const a of appAdded) {
          lines.push(`  - ✅ \`${a.eventName ?? a.signature.functionName ?? a.signature.eventType}\``);
        }
      }
      lines.push('');
    }
  }

  // ── G6: Test Evidence Delta ───────────────────────────────────────────────
  if (report.testDelta) {
    lines.push(...renderTestDeltaSection(report.testDelta));
  }

  // ── G6: Trace Matching Summary ────────────────────────────────────────────
  if (report.traceMatching) {
    lines.push(...renderTraceMatchingSection(report.traceMatching));
  }

  // ── G18: Capture Level section ────────────────────────────────────────────
  lines.push('### Capture Level');
  lines.push('');
  if (summary.tracesCompared === 0) {
    lines.push('> ⚠️ No traces compared. Run `tracegraph run -- <your-test-command>` to capture a trace.');
  } else if (report.captureLevel != null) {
    const cl = report.captureLevel;
    // Icon ladder: 0=⬜ 1=🔵 2=🟡 3=🟡 4=🟢 5=✅
    const CL_ICONS = ['⬜', '🔵', '🟡', '🟡', '🟢', '✅'];
    const clIcon   = CL_ICONS[cl.overall] ?? '⬜';
    lines.push(`**${clIcon} Level ${cl.overall} — ${cl.label}**`);
    lines.push('');
    if (cl.overall <= 1) {
      lines.push('> ⚠️ Capture depth is very low — only runner metadata was recorded. Install a TraceGraph adapter for your test framework to capture runtime behaviour. Run `tracegraph diagnose` for step-by-step instructions.');
    } else if (cl.overall === 2) {
      lines.push('> ⚠️ Capture depth is limited. Consider installing a native adapter (PHPUnit extension, Vitest reporter) for deeper trace coverage. Run `tracegraph diagnose` for recommendations.');
    } else {
      lines.push('> ℹ️ Run `tracegraph diagnose` to see recommendations for improving capture depth.');
    }
  } else {
    lines.push('> ℹ️ Run `tracegraph diagnose` to see recommendations for improving capture depth.');
  }
  lines.push('');

  // ── G3C / G6: Assurance level ─────────────────────────────────────────────
  if (report.assurance) {
    const assuranceTestRunFailed = (report.prContext?.testRunExitCode ?? 0) !== 0;
    lines.push(...renderAssuranceSection(report.assurance, assuranceTestRunFailed));
  }

  // ── Do not merge block ────────────────────────────────────────────────────
  if (summary.hasOpenCritical) {
    lines.push('---');
    lines.push('');
    lines.push('> 🚫 **Do not merge** — Critical findings are open. Review and resolve before merging.');
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderFinding(f: EvaluatedFinding): string {
  const lines: string[] = [];
  lines.push(`**${f.title}**`);
  lines.push('');
  lines.push(`> ${f.description}`);
  if (f.recommendation) {
    lines.push('');
    lines.push(`_Recommendation: ${f.recommendation}_`);
  }
  lines.push('');
  const meta: string[] = [`\`fingerprint: ${f.fingerprint}\``, `\`rule: ${f.ruleId}\``];
  if (f.confidence != null) {
    meta.push(`\`confidence: ${(f.confidence * 100).toFixed(0)}%\``);
  }
  if (f.evidenceSources && f.evidenceSources.length > 0) {
    meta.push(`\`evidence: ${f.evidenceSources.join(', ')}\``);
  }
  lines.push(meta.join(' · '));
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── G3C / G6: Assurance section ─────────────────────────────────────────────

/**
 * Render the assurance level section for a CI markdown report.
 *
 * G6 additions: shows architecture quality level (A0–A5) and warns when graph
 * has nodes but no edges (A1), which means blast-radius / community analysis
 * could not run.
 */
function renderAssuranceSection(a: AssuranceLevel, testRunFailed = false): string[] {
  const lines: string[] = [];

  lines.push('### Evidence Assurance');
  lines.push('');

  const LEVEL_ICONS = ['⬜', '🔵', '🟡', '🟢', '✅', '🛡️'] as const;
  const icon = LEVEL_ICONS[a.level] ?? '⬜';
  lines.push(`**${icon} Level ${a.level} — ${a.label}**`);
  lines.push('');

  // When the PR test run failed, matched traces still reach their nominal assurance
  // level, but overall release assurance is degraded — not all code paths ran.
  if (testRunFailed) {
    lines.push(
      '> ⚠️ **Partial assurance** — matched captured traces reach Level ' + a.level + ', ' +
      'but overall release assurance is reduced because the PR test run failed. ' +
      'Fix the failing tests and re-audit to restore full assurance.',
    );
    lines.push('');
  }

  // G6: Architecture quality level label
  const ARCH_QUALITY_LABELS: Record<string, string> = {
    A0: 'A0 — No graph',
    A1: 'A1 — Nodes only (no edges)',
    A2: 'A2-limited — Nodes + edges (no communities) — god-node analysis low-confidence',
    A3: 'A3 — Full topology',
    A4: 'A4 — Centrality computed',
    A5: 'A5 — Contract-linked',
  };
  const archQualLabel = a.architectureQualityLevel
    ? ARCH_QUALITY_LABELS[a.architectureQualityLevel] ?? a.architectureQualityLevel
    : null;

  lines.push('| Component | Status |');
  lines.push('|-----------|--------|');
  // G15.1: use ⚠️ for A0/A1 — ✅ is misleading when there are no edges
  const staticGraphIcon = (() => {
    if (!a.staticGraphAvailable) return '○';
    const aq = a.architectureQualityLevel;
    if (aq === 'A0' || aq === 'A1') return '⚠️';
    return '✅';
  })();
  lines.push(
    `| Static graph | ${
      a.staticGraphAvailable
        ? archQualLabel
          ? `${staticGraphIcon} ${archQualLabel}`
          : `${staticGraphIcon} Available`
        : '○ Not built'
    } |`,
  );
  if (a.architectureNodes != null) {
    lines.push(
      `| Graph size | ${a.architectureNodes} nodes · ${a.architectureEdges ?? 0} edges${
        a.architectureCommunities != null ? ` · ${a.architectureCommunities} communities` : ''
      } |`,
    );
  }
  lines.push(`| Runtime traces | ${a.runtimeTraceAvailable ? '✅ Available' : '○ No traces'} |`);
  // G18: distinguish "not comparable (Level 0 capture)" from "not created"
  const baselineStatus = a.runtimeBaselineAvailable
    ? '✅ Approved'
    : a.allTracesLevel0
      ? '⚠️ Not comparable — PR captured at Level 0'
      : '○ Not created';
  lines.push(`| Runtime baselines | ${baselineStatus} |`);
  lines.push(`| Runtime contracts | ${a.contractAvailable ? '✅ Active' : '○ None'} |`);
  // G14.6: scale clarification — three "level N" scales are used in the report;
  // make it explicit so readers don't confuse Capture Depth, Evidence Assurance,
  // and Architecture Quality which all use "Level N" or "AN" notation.
  lines.push(
    '| _Scale note_ | _Evidence Assurance 0–5 (this table) · Architecture Quality A0–A5 · Capture Depth 0–5 are separate scales_ |',
  );
  lines.push('');

  // G6: Warn when graph exists but has no edges (A1) — blast-radius analysis unavailable
  if (a.architectureQualityLevel === 'A1') {
    lines.push(
      '> ⚠️ **Graph quality A1** — the static graph has nodes but no call edges. ' +
      'Blast-radius and community analysis could not run. ' +
      'Ensure Graphify is instrumented across service boundaries and run ' +
      '`tracegraph graph build` again.',
    );
    lines.push('');
  }

  // Contextual improvement hints for low assurance
  if (a.level < 3) {
    lines.push('> ⚠️ **Low assurance** — consider the following to strengthen evidence:');
    if (!a.staticGraphAvailable) {
      lines.push('> - Run `tracegraph graph build` to enable static architecture analysis');
    }
    if (!a.runtimeTraceAvailable) {
      lines.push('> - Run `tracegraph run -- <test-command>` to capture runtime traces');
    }
    if (!a.runtimeBaselineAvailable && !a.allTracesLevel0) {
      // Only suggest baseline create when the issue is actually missing baselines,
      // not when the PR capture was Level 0 (where creating a baseline won't help)
      lines.push('> - Run `tracegraph baseline create` to establish expected-behavior baselines');
    }
    lines.push('');
  }

  return lines;
}

// ─── G7: Verdict section ──────────────────────────────────────────────────────

const VERDICT_CONFIG: Record<
  string,
  { icon: string; label: string; badge: string }
> = {
  pass:                 { icon: '✅', label: 'Pass',                 badge: '**✅ PASS**' },
  review_required:      { icon: '🟡', label: 'Review Required',      badge: '**🟡 REVIEW REQUIRED**' },
  conditional_go:       { icon: '🟡', label: 'Conditional Go',       badge: '**🟡 CONDITIONAL GO**' },
  no_go:                { icon: '🔴', label: 'No Go',                badge: '**🔴 NO GO**' },
  insufficient_evidence:{ icon: '⬜', label: 'Insufficient Evidence', badge: '**⬜ INSUFFICIENT EVIDENCE**' },
};

function renderVerdictSection(
  verdict:    AuditVerdict,
  prContext?: PrContext | null,
  findings?:  EvaluatedFinding[],
  testDelta?: TestDelta,
): string[] {
  const lines: string[] = [];
  const cfg = VERDICT_CONFIG[verdict.status] ?? { icon: '⬜', label: verdict.status, badge: `**${verdict.status.toUpperCase()}**` };

  lines.push('### Audit Verdict');
  lines.push('');
  lines.push(`${cfg.badge}`);
  lines.push('');

  if (verdict.reasons.length > 0) {
    // For review_required driven purely by evidence continuity at scale (> 5 missing tests
    // and no high/critical behaviour findings), replace the generic "tests not observed"
    // message with one that names the count and frames this as a scope issue.
    const openF            = (findings ?? []).filter((f) => f.status === 'open');
    const evidContCount    = openF.filter((f) => f.category === 'evidence_continuity').length;
    const hasHighCritBehav = openF.some(
      (f) => (f.severity === 'critical' || f.severity === 'high') &&
             f.category !== 'evidence_continuity' && f.category !== 'audit_quality',
    );
    const onlyEvidenceTrigger =
      verdict.status === 'review_required' && evidContCount > 5 && !hasHighCritBehav;

    if (onlyEvidenceTrigger) {
      const n = evidContCount;
      lines.push(
        `- Baseline coverage mismatch — ${n} previously baselined test${n !== 1 ? 's' : ''} not ` +
        `observed in the candidate run. No critical or high-severity runtime regressions detected; ` +
        `review required only because full-suite assurance cannot be confirmed.`,
      );
    } else {
      for (const reason of verdict.reasons) {
        lines.push(`- ${reason}`);
      }
    }
    lines.push('');
  }

  // ─── BLOCKER 1: PR test run failed ────────────────────────────────────────
  // Shown FIRST when the PR branch tests exited non-zero — this is the most
  // immediately actionable blocker.  Suppressed for insufficient_evidence where
  // the boot-error block already covers the exit-code context.
  const prTestFailed = (prContext?.testRunExitCode ?? 0) !== 0;
  if (prTestFailed && verdict.status !== 'insufficient_evidence') {
    const failedTests  = (testDelta?.candidateTests ?? []).filter((t) => t.status === 'failed');
    const passedTests  = (testDelta?.candidateTests ?? []).filter((t) => t.status === 'passed');
    const skippedTests = (testDelta?.candidateTests ?? []).filter((t) => t.status === 'skipped');
    const newTests     = testDelta?.candidateOnlyTests ?? [];
    const newTestIds   = new Set(newTests.map((t) => t.identityHash));

    lines.push('---');
    lines.push('');
    lines.push('**Blocker 1 — PR test run failed**');
    lines.push('');
    lines.push(
      `> ⚠️ PR branch tests exited with code \`${prContext!.testRunExitCode}\`. ` +
      'Some code paths may not have been exercised during trace capture.',
    );
    lines.push('');

    // Test outcome summary table
    lines.push('| Test outcome | Count |');
    lines.push('|---|---|');
    if (failedTests.length > 0)  lines.push(`| ❌ Failed  | **${failedTests.length}** |`);
    if (passedTests.length > 0)  lines.push(`| ✅ Passed  | ${passedTests.length} |`);
    if (skippedTests.length > 0) lines.push(`| ⏭️ Skipped | ${skippedTests.length} |`);
    lines.push(`| 🆕 New — no baseline | ${newTests.length} |`);
    lines.push('');

    // Failed tests — only actual failures (status='failed' from per-test metadata)
    if (failedTests.length > 0) {
      lines.push(`**Failed tests (${failedTests.length}):**`);
      lines.push('');
      for (let i = 0; i < failedTests.length; i++) {
        const t      = failedTests[i]!;
        const isNew  = newTestIds.has(t.identityHash);
        const newTag = isNew ? ' _(new — no baseline yet)_' : '';
        const label  = humanTestLabel(t.testName);
        lines.push(`${i + 1}. \`${label}\`${newTag}`);
        if (t.testFile && !t.testFile.includes('vendor/')) {
          lines.push(`   _File: ${t.testFile}_`);
        }
        if (t.failureMessage) {
          lines.push(`   _Error: ${t.failureMessage}_`);
        }
      }
      lines.push('');

      // Causal note when failing new tests may explain missing baseline evidence
      if (failedTests.some((t) => newTestIds.has(t.identityHash))) {
        lines.push(
          '> 💡 **Failing new tests** may explain missing export evidence — ' +
          'when a run aborts partway through, later tests (including export flows) may not execute. ' +
          'Fix the new test failures first, then rerun the full suite.',
        );
        lines.push('');
      }

      // Rerun commands — prefer file-based targeting when test files are known
      // and not vendor paths; fall back to name-based --filter
      const knownFiles = [...new Set(
        failedTests
          .map((t) => t.testFile)
          .filter((f): f is string => !!f && !f.includes('vendor/')),
      )];
      lines.push('**Fix failing tests:**');
      lines.push('```');
      if (knownFiles.length > 0 && knownFiles.length <= 3) {
        for (const f of knownFiles) {
          lines.push(`tracegraph run -- php artisan test ${f}`);
        }
      } else {
        for (const t of failedTests.slice(0, 3)) {
          lines.push(`tracegraph run -- php artisan test --filter "${humanTestLabel(t.testName)}"`);
        }
        if (failedTests.length > 3) {
          lines.push(`# … and ${failedTests.length - 3} more`);
        }
      }
      lines.push('tracegraph audit  # re-audit after fixing');
      lines.push('```');
      lines.push('');

      // Class-not-found hint — when ALL failing tests share a "Class X not found" error
      // the most likely fix is a missing composer dependency rather than a code bug.
      const classNotFoundRe = /Class "([^"]+)" not found/;
      const classMatches = failedTests
        .map((t) => (t.failureMessage ? classNotFoundRe.exec(t.failureMessage) : null))
        .filter((m): m is RegExpExecArray => m !== null);
      if (classMatches.length === failedTests.length && classMatches.length > 0) {
        const classNames = [...new Set(classMatches.map((m) => m[1]!))];
        const composerPkg = resolveComposerPackage(classNames[0]!);
        const pkgLabel = composerPkg ?? '<vendor>/<package>';

        lines.push(
          '> 💡 **Quickest fix — missing dependency:** ' +
          `All ${failedTests.length} failure(s) share a \`Class "${classNames[0]}" not found\` error. ` +
          'This is almost certainly a missing composer dependency rather than a code bug.',
        );
        // A — Likely root cause line: names the class and the package so the developer
        // doesn't have to infer the connection.
        lines.push(
          `> **Likely root cause:** the PR uses \`${classNames[0]}\`, ` +
          `but \`${pkgLabel}\` is missing from the installed Composer dependencies.`,
        );
        lines.push('> ');
        lines.push('> ```');
        if (composerPkg) {
          lines.push(`> composer show ${composerPkg}  # verify it is installed`);
          lines.push(`> composer require ${composerPkg}  # install if missing`);
        } else {
          lines.push(`> # find which package provides ${classNames[0]!.split('\\').slice(0, 3).join('\\')}`);
          lines.push('> composer show | grep -i <vendor>');
          lines.push('> composer require <vendor>/<package>');
        }
        lines.push('> composer dump-autoload  # refresh the autoloader');
        lines.push('> ```');
        lines.push('');

        // B — Commit reminder: running composer require locally fixes the dev environment
        // but the PR must also update composer.json + composer.lock.  Only show this when
        // both files are already listed as changed — the PR author is clearly aware of them.
        const changedPaths = prContext?.changedFilePaths ?? [];
        const composerFilesChanged =
          changedPaths.some((p) => p.endsWith('composer.json')) ||
          changedPaths.some((p) => p.endsWith('composer.lock'));
        if (composerFilesChanged) {
          lines.push(
            `> ⚠️ **Commit the dependency:** if \`${pkgLabel}\` is required by the new logic, ` +
            `ensure \`composer.json\` and \`composer.lock\` include it — ` +
            `\`composer require\` fixes your local environment but the PR must also update both files.`,
          );
          lines.push('');
        }
      }
    }
  }

  // ─── BLOCKER 2 (or primary): Auth evidence missing ───────────────────────
  // Auth-evidence-missing verdict block — fires when all open critical findings are
  // of the reclassified "evidence missing" type rather than confirmed removals.
  // Replaces the generic "Critical findings require resolution" with a focused
  // narrative that explains exactly what is missing and what to do next.
  if (verdict.status === 'no_go' && findings) {
    const openCritical = findings.filter((f) => f.status === 'open' && f.severity === 'critical');
    const allAreEvidenceMissing = openCritical.length > 0 &&
      openCritical.every((f) => f.ruleId?.startsWith('evidence.authorization_missing'));

    if (allAreEvidenceMissing) {
      // Count unique missing test flows from grouped finding description
      const groupedFinding = openCritical.find((f) => f.ruleId === 'evidence.authorization_missing.grouped');
      const authCheckCount = openCritical.filter((f) => f.ruleId === 'evidence.authorization_missing').length;
      // Extract missing-test count from the grouped finding title — the title embeds
      // "across N missing test(s)". Counting `•` bullets in the description is wrong
      // because the description also contains PR-relevance bullets.
      const flowCount = (() => {
        if (!groupedFinding) return authCheckCount;
        const m = groupedFinding.title.match(/across (\d+) missing test/);
        return m ? parseInt(m[1]!, 10) : authCheckCount;
      })();

      lines.push('---');
      lines.push('');
      // When there's also a test-failure blocker (Blocker 1), label this as Blocker 2.
      const authBlockerLabel = prTestFailed ? 'Blocker 2 — ' : '';
      lines.push(`**${authBlockerLabel}Export-flow authorization evidence missing**`);
      lines.push('');
      lines.push(
        `${flowCount} missing export test(s) mean TraceGraph cannot confirm that export endpoints ` +
        `still enforce ${authCheckCount} authorization check(s) across customer, item, invoice, estimate, ` +
        `and expense export flows. ` +
        `Because this authorization evidence is missing, this audit blocks merge until the tests are ` +
        `restored, rerun, or intentionally rebaselined.`,
      );
      lines.push('');
      lines.push('This is **not yet a confirmed authorization removal.** ' +
        'It is a critical evidence gap: TraceGraph can no longer prove that these export endpoints ' +
        'still enforce the expected Gate checks.');
      lines.push('');
      lines.push('**Do not merge until:**');
      lines.push('1. The missing export tests are rerun under TraceGraph, AND');
      lines.push('2. Authorization checks are confirmed on each export endpoint, OR');
      lines.push('3. The test removal is intentionally approved and rebaselined with justification.');
      lines.push('');
      lines.push('```');
      lines.push('# After fixing failing tests, restore export evidence:');
      lines.push('tracegraph run -- php artisan test --filter "csv export"');
      lines.push('tracegraph audit  # re-audit after tests pass');
      lines.push('```');
      lines.push('');
    }
  }

  // G19: boot error block — shown when Level 0 capture + PR run failed.
  // Surfaces the raw PHP/Node/Python exception directly in the report so reviewers
  // can immediately see WHY the tests didn't run without scrolling the terminal.
  if (verdict.status === 'insufficient_evidence' && prContext?.bootError) {
    lines.push('> 💥 **Boot error detected** — the test runner crashed before capturing any traces:');
    lines.push(`> \`\`\``);
    lines.push(`> ${prContext.bootError}`);
    lines.push('> ```');
    lines.push('> Fix this boot error and re-run the audit to get a meaningful result.');
    lines.push('');
  }

  // ─── New candidate tests — separate section ───────────────────────────────
  // Show new tests in their own named block, not mixed into the failed-tests list.
  // This makes it clear these tests are additive (not a regression) and explains
  // what to do after they start passing.
  const candidateOnlyTests = testDelta?.candidateOnlyTests ?? [];
  if (candidateOnlyTests.length > 0 && verdict.status !== 'insufficient_evidence') {
    const failedCandidateIds = new Set(
      (testDelta?.candidateTests ?? [])
        .filter((t) => t.status === 'failed')
        .map((t) => t.identityHash),
    );
    lines.push('---');
    lines.push('');
    // Deduplicate by name: the same test name observed in multiple traces (two environments,
    // two run modes, watch + run, etc.) becomes one entry with a trace count rather than
    // appearing as two separate tests that look like duplicates.
    const newTestGroups: Array<{
      label:      string;
      traceCount: number;
      testFile?:  string;
      anyFailing: boolean;
    }> = [];
    const seenNewLabels = new Map<string, number>(); // label → index in newTestGroups
    for (const t of candidateOnlyTests) {
      const label = humanTestLabel(t.testName);
      const idx   = seenNewLabels.get(label);
      if (idx !== undefined) {
        newTestGroups[idx]!.traceCount++;
        if (failedCandidateIds.has(t.identityHash)) newTestGroups[idx]!.anyFailing = true;
      } else {
        seenNewLabels.set(label, newTestGroups.length);
        newTestGroups.push({
          label,
          traceCount: 1,
          testFile:   t.testFile && !t.testFile.includes('vendor/') ? t.testFile : undefined,
          anyFailing: failedCandidateIds.has(t.identityHash),
        });
      }
    }

    lines.push(`**New candidate tests — no baseline yet (${newTestGroups.length}):**`);
    lines.push('');
    lines.push(
      'These tests were added by this PR. ' +
      'No baseline exists for them yet — TraceGraph cannot detect regressions in their behaviour until they are baselined.',
    );
    lines.push('');
    for (let i = 0; i < newTestGroups.length; i++) {
      const g          = newTestGroups[i]!;
      const failingTag = g.anyFailing  ? ' _(currently failing)_' : '';
      const traceTag   = g.traceCount > 1 ? ` _(${g.traceCount} traces)_` : '';
      lines.push(`${i + 1}. \`${g.label}\`${traceTag}${failingTag}`);
      if (g.testFile) {
        lines.push(`   _File: \`${g.testFile}\`_`);
      }
    }
    lines.push('');
    lines.push('After all tests pass and the audit clears:');
    lines.push('```');
    lines.push('tracegraph baseline create --reason "New tests from PR"');
    lines.push('```');
    lines.push('');
  }

  // G16.2: "Recommended action" table for conditional_go — help reviewers know
  // exactly what to do rather than just reading the verdict label.
  if (verdict.status === 'conditional_go') {
    lines.push('#### Recommended actions');
    lines.push('');
    lines.push('| Step | Action |');
    lines.push('|------|--------|');
    lines.push('| 1 | Review each medium-severity finding below and determine if it is a genuine regression |');
    lines.push('| 2 | If a finding is a false positive or pre-existing issue, add a suppression with `tracegraph suppress` |');
    lines.push('| 3 | If a finding is a real regression, request changes from the author |');
    lines.push('| 4 | Once all medium findings are resolved or suppressed, re-run the audit to confirm **Pass** |');
    // G16.3: suppression hint when there are suppressible findings
    lines.push('');
    lines.push(
      '> 💡 **Tip:** Use `tracegraph suppress <fingerprint>` to mark known-acceptable findings. ' +
      'Suppressions are code-reviewed like any other change and appear in the Suppressions section of the report.',
    );
    lines.push('');
  }

  // G16.2: recommended actions for review_required — context-aware based on
  // what actually triggered the verdict (high findings vs. evidence continuity).
  if (verdict.status === 'review_required') {
    const openF            = (findings ?? []).filter((f) => f.status === 'open');
    const hasHighOrCrit    = openF.some((f) => f.severity === 'high' || f.severity === 'critical');
    const hasEvidenceCont  = openF.some((f) => f.category === 'evidence_continuity');

    lines.push('#### Recommended actions');
    lines.push('');
    lines.push('| Step | Action |');
    lines.push('|------|--------|');

    if (hasHighOrCrit) {
      lines.push('| 1 | Investigate each high-severity finding — these indicate behavioural regressions that need resolution |');
      if (hasEvidenceCont) {
        lines.push('| 2 | Check evidence continuity findings — missing baselined tests may indicate test configuration issues |');
      } else {
        lines.push('| 2 | Suppress findings that are false positives: `tracegraph suppress <fingerprint>` |');
      }
      lines.push('| 3 | Do not merge until all high/critical findings are resolved or suppressed with documented justification |');
    } else if (hasEvidenceCont) {
      // Evidence-continuity-only: guide reviewers toward checking missing tests
      lines.push('| 1 | Verify each missing test — was it renamed, removed, or is it failing due to an environment issue? |');
      lines.push('| 2 | If the change is intentional, re-baseline: `tracegraph baseline create --reason "..."` |');
      lines.push('| 3 | If a missing test covered security-sensitive functionality, ensure equivalent coverage exists before merging |');
    } else {
      // Generic fallback
      lines.push('| 1 | Investigate each finding and determine if it is a genuine regression |');
      lines.push('| 2 | Suppress false positives or pre-existing issues: `tracegraph suppress <fingerprint>` |');
      lines.push('| 3 | Re-run the audit after fixes to confirm the verdict improves before merging |');
    }
    lines.push('');
  }

  return lines;
}

// ─── G8: PR Context section ───────────────────────────────────────────────────

function renderPrContextSection(ctx: PrContext): string[] {
  const lines: string[] = [];

  lines.push('### PR Context');
  lines.push('');

  const titleLine = ctx.prTitle
    ? `**${ctx.prTitle}**`
    : ctx.prNumber
    ? `PR #${ctx.prNumber}`
    : 'PR';

  const metaParts: string[] = [];
  if (ctx.prNumber) metaParts.push(`#${ctx.prNumber}`);
  if (ctx.prAuthor) metaParts.push(`by @${ctx.prAuthor}`);

  if (metaParts.length > 0) {
    lines.push(`${titleLine} _(${metaParts.join(' ')})_`);
  } else {
    lines.push(titleLine);
  }
  lines.push('');

  const statParts: string[] = [];
  if (ctx.additions != null) statParts.push(`+${ctx.additions}`);
  if (ctx.deletions != null) statParts.push(`-${ctx.deletions}`);
  if (ctx.changedFiles != null) statParts.push(`${ctx.changedFiles} files changed`);
  if (statParts.length > 0) {
    lines.push(statParts.join(' · '));
    lines.push('');
  }

  // Show changed file paths in a collapsible block (capped at 20 for readability)
  if (ctx.changedFilePaths && ctx.changedFilePaths.length > 0) {
    const shown  = ctx.changedFilePaths.slice(0, 20);
    const hidden = ctx.changedFilePaths.length - shown.length;
    lines.push('<details>');
    lines.push(`<summary>Changed files (${ctx.changedFilePaths.length})</summary>`);
    lines.push('');
    for (const f of shown) lines.push(`- \`${f}\``);
    if (hidden > 0) lines.push(`- _…and ${hidden} more_`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return lines;
}

// ─── G6: Evidence Continuity finding renderer ─────────────────────────────────

/**
 * Renders an evidence_continuity finding with the run command prominently
 * displayed instead of buried in a generic "Recommendation:" line.
 */
function renderEvidenceContinuityFinding(f: EvaluatedFinding): string {
  const lines: string[] = [];
  lines.push(`**${SEVERITY_EMOJI['medium']} ${f.title}**`);
  lines.push('');
  lines.push(`> ${f.description}`);
  lines.push('');

  // Parse recommendation lines into a structured block
  if (f.recommendation) {
    // Split recommendation by newline and render as a code-style block
    const recLines = f.recommendation.split('\n');
    lines.push('**Steps to verify:**');
    lines.push('');
    lines.push('```');
    for (const l of recLines) {
      lines.push(l);
    }
    lines.push('```');
    lines.push('');
  }

  if (f.testIdentity) {
    const ti = f.testIdentity;
    const idParts: string[] = [];
    if (ti.framework) idParts.push(`framework: ${ti.framework}`);
    if (ti.className) idParts.push(`class: ${ti.className}`);
    if (ti.method)    idParts.push(`method: ${ti.method}`);
    if (idParts.length > 0) {
      lines.push(`_Test identity: ${idParts.join(' · ')}_`);
      lines.push('');
    }
  }

  const meta: string[] = [`\`fingerprint: ${f.fingerprint}\``, `\`rule: ${f.ruleId}\``];
  lines.push(meta.join(' · '));
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

// ─── G6: Test Evidence Delta section ─────────────────────────────────────────

function renderTestDeltaSection(delta: TestDelta): string[] {
  const lines: string[] = [];

  const addedCount   = delta.candidateOnlyTests.length;
  const removedCount = delta.baselineOnlyTests.length;
  const matchedCount = delta.matchedTests.length;

  // Only render if there is anything noteworthy
  if (addedCount === 0 && removedCount === 0) return lines;

  lines.push('<details>');
  lines.push(
    `<summary>🧪 Test Evidence Delta — ` +
    `${matchedCount} matched · ` +
    `${removedCount > 0 ? `${removedCount} missing from candidate · ` : ''}` +
    `${addedCount > 0 ? `${addedCount} new in candidate` : ''}</summary>`,
  );
  lines.push('');

  if (removedCount > 0) {
    lines.push(`**${removedCount} tests in baseline but NOT observed in candidate:**`);
    lines.push('');
    const shown  = delta.baselineOnlyTests.slice(0, 25);
    const hidden = delta.baselineOnlyTests.length - shown.length;
    for (const t of shown) {
      lines.push(`- ❌ \`${t.testName}\``);
    }
    if (hidden > 0) lines.push(`- _…and ${hidden} more_`);
    lines.push('');
  }

  if (addedCount > 0) {
    lines.push(`**${addedCount} tests observed in candidate but NOT in baseline:**`);
    lines.push('');
    const shown  = delta.candidateOnlyTests.slice(0, 25);
    const hidden = delta.candidateOnlyTests.length - shown.length;
    // Pre-count names to detect duplicates — show file path when the same name
    // appears more than once so readers can distinguish them.
    const deltaNameCounts = new Map<string, number>();
    for (const t of delta.candidateOnlyTests) {
      deltaNameCounts.set(t.testName, (deltaNameCounts.get(t.testName) ?? 0) + 1);
    }
    for (const t of shown) {
      const isDuplicate = (deltaNameCounts.get(t.testName) ?? 0) > 1;
      const fileSuffix  = isDuplicate && t.testFile && !t.testFile.includes('vendor/')
        ? ` _(${t.testFile})_`
        : '';
      lines.push(`- ✅ \`${t.testName}\`${fileSuffix}`);
    }
    if (hidden > 0) lines.push(`- _…and ${hidden} more_`);
    lines.push('');
  }

  lines.push('</details>');
  lines.push('');

  return lines;
}

// ─── G6: Trace Matching Summary section ──────────────────────────────────────

function renderTraceMatchingSection(tm: TraceMatchingSummary): string[] {
  const lines: string[] = [];

  const CONFIDENCE_ICON: Record<string, string> = {
    high:   '✅',
    medium: '🟡',
    low:    '🔴',
  };
  const confIcon = CONFIDENCE_ICON[tm.confidence] ?? '⬜';

  // Header: show "N runs · M baselines" — avoids the confusing "X/Y baselines
  // matched" fraction when exactMatches > baselineCount (N:1 scenarios).
  const coveredBaselines = Math.min(tm.exactMatches, tm.baselineCount);
  const baselineLabel    = tm.baselineCount === 1 ? '1 baseline' : `${tm.baselineCount} baselines`;
  const coverageLabel    = tm.unmatchedBaseline === 0
    ? `all ${baselineLabel} covered`
    : `${coveredBaselines}/${tm.baselineCount} baselines covered`;

  lines.push('<details>');
  lines.push(
    `<summary>Trace matching: ${confIcon} ${capitalise(tm.confidence)} confidence — ` +
    `${tm.candidateCount} run(s) · ${coverageLabel}</summary>`,
  );
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Baseline traces | ${tm.baselineCount} |`);
  lines.push(`| Candidate traces | ${tm.candidateCount} |`);
  lines.push(`| Baselines covered | ${coveredBaselines} of ${tm.baselineCount} |`);
  lines.push(`| Candidate runs matched | ${tm.exactMatches} of ${tm.candidateCount} |`);
  lines.push(`| Unmatched candidate | ${tm.unmatchedCandidate} |`);
  lines.push(`| Match strategy | ${tm.matchStrategy} |`);
  lines.push(`| Confidence | ${confIcon} ${capitalise(tm.confidence)} |`);
  lines.push('');

  if (tm.confidence === 'low' && tm.baselineCount > 0) {
    if (tm.comparableContent === false) {
      // G19: all candidates were Level 0 — the IDs matched but there's no behavioral content
      lines.push(
        '> ⚠️ Match is structural only — candidate traces were captured at Level 0 ' +
        '(runner metadata only, no test events). No behavioral comparison occurred. ' +
        'Fix the boot error and re-run to get a meaningful comparison.',
      );
    } else {
      lines.push(
        '> ⚠️ Low matching confidence — candidate traces are very different from the baseline. ' +
        'Check whether the test suite changed significantly or re-baseline if intentional.',
      );
    }
    lines.push('');
  }

  lines.push('</details>');
  lines.push('');

  return lines;
}


// ─── Shared label helpers ─────────────────────────────────────────────────────

/**
 * Map a fully-qualified class name to the most likely composer package that
 * provides it.  Used to generate actionable dependency-fix hints in Blocker 1.
 * Returns null when the class is unknown so callers can fall back to generic advice.
 */
function resolveComposerPackage(className: string): string | null {
  const KNOWN: Array<[RegExp, string]> = [
    [/^Symfony\\Component\\Intl\b/,          'symfony/intl'],
    [/^Symfony\\Component\\Translation\b/,   'symfony/translation'],
    [/^Symfony\\Component\\String\b/,        'symfony/string'],
    [/^Symfony\\Component\\Finder\b/,        'symfony/finder'],
    [/^Symfony\\Component\\Console\b/,       'symfony/console'],
    [/^Illuminate\\/,                        'laravel/framework'],
    [/^PhpOffice\\PhpSpreadsheet\b/,         'phpoffice/phpspreadsheet'],
    [/^Maatwebsite\\Excel\b/,               'maatwebsite/excel'],
    [/^League\\Fractal\b/,                   'league/fractal'],
    [/^League\\Csv\b/,                       'league/csv'],
    [/^Carbon\b/,                            'nesbot/carbon'],
    [/^Spatie\\/,                            'spatie/<package>'],
  ];
  for (const [pattern, pkg] of KNOWN) {
    if (pattern.test(className)) return pkg;
  }
  return null;
}

/**
 * Convert a raw (possibly Pest __pest_evaluable_*) test name to a short
 * human-readable label suitable for inline display in the verdict section.
 */
function humanTestLabel(raw: string): string {
  if (raw.includes('__pest_evaluable_')) {
    const body = raw.slice(raw.indexOf('__pest_evaluable_') + '__pest_evaluable_'.length);
    return body.replace(/_/g, ' ');
  }
  // Truncate very long names to avoid wrapping
  return raw.length > 80 ? raw.slice(0, 77) + '…' : raw;
}
