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
