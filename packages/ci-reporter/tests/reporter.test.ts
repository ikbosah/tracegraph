/**
 * T2.10 — CI reporter unit tests.
 */
import { describe, it, expect } from 'vitest';
import type { TraceReport, EvaluatedFinding } from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import { renderReport } from '../src/index';

function makeReport(overrides: Partial<TraceReport> = {}): TraceReport {
  const base: TraceReport = {
    schemaVersion:  SCHEMA_VERSIONS.report,
    reportId:       'report_001',
    createdAt:      1_700_000_000_000,
    baselineDir:    '.tracegraph/baselines',
    candidateFiles: ['.tracegraph/traces/trace_001.trace.json'],
    diffs:          [],
    findings:       [],
    summary: {
      tracesCompared:     1,
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      hasOpenCritical:    false,
      suppressionsModified: false,
    },
    ...overrides,
  };
  return base;
}

function makeOpenFinding(overrides: Partial<EvaluatedFinding> = {}): EvaluatedFinding {
  return {
    id:           'find_abc',
    fingerprint:  'abc123def456ghi7',
    ruleId:       'behavior.validation.removed',
    severity:     'high',
    category:     'behavior_change',
    title:        'Validation step removed: validateCouponExpiry',
    description:  'Function validateCouponExpiry was removed.',
    evidence:     [],
    status:       'open',
    recommendation: 'Restore the validation.',
    ...overrides,
  };
}

describe('renderReport()', () => {
  describe('markdown format', () => {
    it('contains the header', () => {
      const md = renderReport(makeReport(), { format: 'markdown', projectName: 'MyApp' });
      expect(md).toContain('MyApp — Behaviour Diff Report');
    });

    it('shows "No open findings" when there are none', () => {
      const md = renderReport(makeReport());
      expect(md).toContain('No open findings');
    });

    it('includes finding title and severity emoji for open findings', () => {
      const report = makeReport({
        findings: [makeOpenFinding()],
        summary: { tracesCompared: 1, findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, hasOpenCritical: false, suppressionsModified: false },
      });
      const md = renderReport(report, { format: 'markdown' });
      expect(md).toContain('validateCouponExpiry');
      expect(md).toContain('🟠'); // high severity emoji
    });

    it('includes "Do not merge" block for critical findings', () => {
      const report = makeReport({
        findings: [makeOpenFinding({ severity: 'critical' })],
        summary: {
          tracesCompared: 1,
          findingsBySeverity: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
          hasOpenCritical: true,
          suppressionsModified: false,
        },
      });
      const md = renderReport(report, { format: 'markdown' });
      expect(md).toContain('Do not merge');
    });

    it('does NOT include "Do not merge" when no critical findings', () => {
      const md = renderReport(makeReport());
      expect(md).not.toContain('Do not merge');
    });

    it('lists suppressed/approved findings in a collapsible section', () => {
      const report = makeReport({
        findings: [makeOpenFinding({ status: 'suppressed', suppressedBy: 'bob' })],
      });
      const md = renderReport(report);
      expect(md).toContain('Suppressed');
    });

    it('shows suppression file warning when suppressionsModified is true', () => {
      const report = makeReport({
        summary: {
          tracesCompared: 1,
          findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          hasOpenCritical: false,
          suppressionsModified: true,
        },
      });
      const md = renderReport(report);
      expect(md).toContain('Suppressions file');
      expect(md).toContain('Modified');
    });

    it('includes fingerprint and ruleId for each finding', () => {
      const report = makeReport({
        findings: [makeOpenFinding()],
        summary: { tracesCompared: 1, findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, hasOpenCritical: false, suppressionsModified: false },
      });
      const md = renderReport(report);
      expect(md).toContain('abc123def456ghi7');
      expect(md).toContain('behavior.validation.removed');
    });
  });

  // ── G3C: Assurance level ─────────────────────────────────────────────────

  describe('G3C: assurance level section', () => {
    it('omits assurance section when report.assurance is absent', () => {
      const md = renderReport(makeReport());
      expect(md).not.toContain('Evidence Assurance');
    });

    it('renders assurance section when report.assurance is present', () => {
      const report = makeReport({
        assurance: {
          level:                    4,
          label:                    'Runtime-baselined — expected behavior approved',
          staticGraphAvailable:     true,
          runtimeTraceAvailable:    true,
          runtimeBaselineAvailable: true,
          contractAvailable:        false,
        },
      });
      const md = renderReport(report);
      expect(md).toContain('Evidence Assurance');
      expect(md).toContain('Level 4');
      expect(md).toContain('Runtime-baselined');
    });

    it('shows ✅ for available components', () => {
      const report = makeReport({
        assurance: {
          level:                    3,
          label:                    'Runtime-observed',
          staticGraphAvailable:     true,
          runtimeTraceAvailable:    true,
          runtimeBaselineAvailable: false,
          contractAvailable:        false,
        },
      });
      const md = renderReport(report);
      expect(md).toContain('✅ Available');     // static graph
      expect(md).toContain('○ Not created');   // baselines
      expect(md).toContain('○ None');           // contracts
    });

    it('shows low-assurance hints when level < 3', () => {
      const report = makeReport({
        assurance: {
          level:                    1,
          label:                    'Static-known — architecture mapped',
          staticGraphAvailable:     true,
          runtimeTraceAvailable:    false,
          runtimeBaselineAvailable: false,
          contractAvailable:        false,
        },
      });
      const md = renderReport(report);
      expect(md).toContain('Low assurance');
      expect(md).toContain('tracegraph run');
      expect(md).toContain('tracegraph baseline create');
    });

    it('does NOT show low-assurance hints when level >= 3', () => {
      const report = makeReport({
        assurance: {
          level:                    4,
          label:                    'Runtime-baselined',
          staticGraphAvailable:     true,
          runtimeTraceAvailable:    true,
          runtimeBaselineAvailable: true,
          contractAvailable:        false,
        },
      });
      const md = renderReport(report);
      expect(md).not.toContain('Low assurance');
    });

    it('includes assurance level in summary table', () => {
      const report = makeReport({
        assurance: {
          level:                    2,
          label:                    'Risk-classified',
          staticGraphAvailable:     true,
          runtimeTraceAvailable:    false,
          runtimeBaselineAvailable: false,
          contractAvailable:        false,
        },
      });
      const md = renderReport(report);
      // Summary table row for assurance
      expect(md).toContain('Evidence assurance');
      expect(md).toContain('Level 2');
    });

    it('uses correct icon for each level', () => {
      const icons = ['⬜', '🔵', '🟡', '🟢', '✅', '🛡️'];
      for (let lvl = 0; lvl <= 5; lvl++) {
        const report = makeReport({
          assurance: {
            level:                    lvl as 0|1|2|3|4|5,
            label:                    `Level ${lvl}`,
            staticGraphAvailable:     lvl >= 1,
            runtimeTraceAvailable:    lvl >= 3,
            runtimeBaselineAvailable: lvl >= 4,
            contractAvailable:        lvl >= 5,
          },
        });
        const md = renderReport(report);
        expect(md).toContain(icons[lvl]);
      }
    });
  });

  // ── G5: Architecture findings section ───────────────────────────────────

  describe('G5: architecture findings section', () => {
    function makeArchFinding(overrides: Partial<EvaluatedFinding> = {}): EvaluatedFinding {
      return {
        id:          'find_arch001',
        fingerprint: 'arch001arch001ab',
        ruleId:      'architecture.surprise_edge',
        severity:    'high',
        category:    'architecture_risk',
        title:       'Unexpected cross-community runtime call: payments → auth',
        description: 'At runtime, PaymentService called AuthCheck across community boundaries.',
        evidence:    [{ traceId: 'trace_001', eventIds: ['evt_01'] }],
        status:      'open',
        recommendation: 'Update architecture baseline if intentional.',
        confidence:     0.85,
        evidenceSources: ['runtime_trace', 'static_graph'],
        ...overrides,
      };
    }

    it('renders architecture section when architecture_risk findings are present', () => {
      const report = makeReport({
        findings: [makeArchFinding()],
        summary: {
          tracesCompared: 1,
          findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          hasOpenCritical: false,
          suppressionsModified: false,
        },
      });
      const md = renderReport(report);
      expect(md).toContain('🏗️ Architecture Findings');
      expect(md).toContain('Unexpected cross-community runtime call');
    });

    it('shows confidence percentage in finding metadata', () => {
      const report = makeReport({
        findings: [makeArchFinding()],
        summary: {
          tracesCompared: 1,
          findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          hasOpenCritical: false,
          suppressionsModified: false,
        },
      });
      const md = renderReport(report);
      expect(md).toContain('confidence: 85%');
    });

    it('shows evidence sources in finding metadata', () => {
      const report = makeReport({
        findings: [makeArchFinding()],
        summary: {
          tracesCompared: 1,
          findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          hasOpenCritical: false,
          suppressionsModified: false,
        },
      });
      const md = renderReport(report);
      expect(md).toContain('evidence: runtime_trace, static_graph');
    });

    it('omits confidence and evidence when absent', () => {
      const report = makeReport({
        findings: [makeOpenFinding()],   // no confidence/evidenceSources
        summary: {
          tracesCompared: 1,
          findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          hasOpenCritical: false,
          suppressionsModified: false,
        },
      });
      const md = renderReport(report);
      expect(md).not.toContain('confidence:');
      expect(md).not.toContain('evidence:');
    });

    it('includes architecture count in summary table', () => {
      const report = makeReport({
        findings: [makeArchFinding()],
        summary: {
          tracesCompared: 1,
          findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          hasOpenCritical: false,
          suppressionsModified: false,
        },
      });
      const md = renderReport(report);
      expect(md).toContain('Architecture findings');
      expect(md).toContain('1');
    });

    it('architecture findings do NOT appear in the generic Findings section', () => {
      const report = makeReport({
        findings: [makeArchFinding()],
        summary: {
          tracesCompared: 1,
          findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          hasOpenCritical: false,
          suppressionsModified: false,
        },
      });
      const md = renderReport(report);
      // Should be in architecture section, not generic Findings
      const archIdx    = md.indexOf('🏗️ Architecture Findings');
      const genericIdx = md.indexOf('\n### Findings\n');
      expect(archIdx).toBeGreaterThan(-1);
      // generic section should not appear (only arch finding present)
      expect(genericIdx).toBe(-1);
    });
  });

  describe('json format', () => {
    it('returns the report as formatted JSON', () => {
      const report = makeReport();
      const json   = renderReport(report, { format: 'json' });
      const parsed = JSON.parse(json) as TraceReport;
      expect(parsed.reportId).toBe('report_001');
    });
  });

  describe('github-step-summary format', () => {
    it('renders as markdown (same as markdown format)', () => {
      const report = makeReport();
      const gss  = renderReport(report, { format: 'github-step-summary' });
      const md   = renderReport(report, { format: 'markdown' });
      expect(gss).toBe(md);
    });
  });
});
