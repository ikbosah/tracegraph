import React, { useState } from 'react';
import type { EvaluatedFinding, FindingSeverity, BehaviorDiff } from '@tracegraph/shared-types';

interface FindingsPanelProps {
  findings: EvaluatedFinding[];
  diffs:    BehaviorDiff[];
  onFindingHover?: (traceIds: string[]) => void;
}

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

const SEVERITY_COLORS: Record<FindingSeverity, string> = {
  critical: '#f87171',
  high:     '#fb923c',
  medium:   '#fbbf24',
  low:      '#a3e635',
  info:     '#94a3b8',
};

const SEVERITY_BADGES: Record<FindingSeverity, string> = {
  critical: 'sev-critical',
  high:     'sev-high',
  medium:   'sev-medium',
  low:      'sev-low',
  info:     'sev-info',
};

const STATUS_LABELS: Record<string, string> = {
  open:       '●',
  approved:   '✓',
  suppressed: '—',
};

export function FindingsPanel({
  findings,
  diffs,
  onFindingHover,
}: FindingsPanelProps): React.ReactElement {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<FindingSeverity | 'all'>('all');

  // Sort: open first, then by severity
  const sorted = [...findings].sort((a, b) => {
    const statusOrder = { open: 0, approved: 1, suppressed: 2 };
    const statusDiff  = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
    if (statusDiff !== 0) return statusDiff;
    return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  });

  const filtered = filterSeverity === 'all'
    ? sorted
    : sorted.filter((f) => f.severity === filterSeverity);

  // Summary counts
  const counts = SEVERITY_ORDER.reduce<Partial<Record<FindingSeverity, number>>>(
    (acc, sev) => {
      acc[sev] = findings.filter((f) => f.severity === sev && f.status === 'open').length;
      return acc;
    },
    {},
  );

  const openCount = findings.filter((f) => f.status === 'open').length;

  // Diff summary
  const totalAdded   = diffs.reduce((n, d) => n + d.addedSignatures.length, 0);
  const totalRemoved = diffs.reduce((n, d) => n + d.removedSignatures.length, 0);

  return (
    <div className="findings-panel">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="findings-header">
        <span className="findings-title">Findings</span>
        {openCount > 0 && (
          <span className="findings-open-badge">{openCount} open</span>
        )}
      </div>

      {/* ── Diff summary bar ───────────────────────────────────────────── */}
      {(totalAdded + totalRemoved) > 0 && (
        <div className="diff-summary">
          {totalAdded > 0 && (
            <span className="diff-added">+{totalAdded} added</span>
          )}
          {totalRemoved > 0 && (
            <span className="diff-removed">−{totalRemoved} removed</span>
          )}
          <span className="diff-traces">{diffs.length} trace{diffs.length !== 1 ? 's' : ''} compared</span>
        </div>
      )}

      {/* ── Severity filter chips ──────────────────────────────────────── */}
      <div className="findings-filter">
        <button
          className={`filter-chip ${filterSeverity === 'all' ? 'active' : ''}`}
          onClick={() => setFilterSeverity('all')}
        >
          All
        </button>
        {SEVERITY_ORDER.map((sev) => {
          const count = counts[sev] ?? 0;
          if (count === 0 && filterSeverity !== sev) return null;
          return (
            <button
              key={sev}
              className={`filter-chip filter-chip-${sev} ${filterSeverity === sev ? 'active' : ''}`}
              onClick={() => setFilterSeverity(sev)}
            >
              {sev} {count > 0 && <span className="chip-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* ── Finding list ───────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="findings-empty">
          {findings.length === 0
            ? 'No findings — all behaviour within expected bounds.'
            : `No ${filterSeverity} findings.`}
        </div>
      ) : (
        <ul className="findings-list">
          {filtered.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              isExpanded={expandedId === finding.id}
              onToggle={() => setExpandedId(expandedId === finding.id ? null : finding.id)}
              onHover={onFindingHover}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Finding row ──────────────────────────────────────────────────────────────

interface FindingRowProps {
  finding:   EvaluatedFinding;
  isExpanded: boolean;
  onToggle:  () => void;
  onHover?:  (traceIds: string[]) => void;
}

function FindingRow({
  finding,
  isExpanded,
  onToggle,
  onHover,
}: FindingRowProps): React.ReactElement {
  const traceIds = finding.evidence.map((e) => e.traceId);

  return (
    <li
      className={`finding-row finding-row-${finding.status}`}
      onMouseEnter={() => onHover?.(traceIds)}
      onMouseLeave={() => onHover?.([])}
    >
      <button className="finding-summary" onClick={onToggle} aria-expanded={isExpanded}>
        <span
          className={`finding-sev-dot`}
          style={{ background: SEVERITY_COLORS[finding.severity] }}
          title={finding.severity}
        />
        <span className={`finding-status-icon finding-status-${finding.status}`}>
          {STATUS_LABELS[finding.status]}
        </span>
        <span className="finding-title">{finding.title}</span>
        <span className={`finding-sev-badge ${SEVERITY_BADGES[finding.severity]}`}>
          {finding.severity}
        </span>
        <span className="finding-chevron">{isExpanded ? '▾' : '▸'}</span>
      </button>

      {isExpanded && (
        <div className="finding-detail">
          <p className="finding-description">{finding.description}</p>

          {finding.recommendation && (
            <div className="finding-recommendation">
              <span className="finding-rec-label">Recommendation</span>
              <p>{finding.recommendation}</p>
            </div>
          )}

          {finding.evidence.length > 0 && (
            <div className="finding-evidence">
              <span className="finding-rec-label">Evidence</span>
              {finding.evidence.map((ev, i) => (
                <div key={i} className="evidence-row">
                  <span className="evidence-trace">{ev.traceId}</span>
                  {ev.file && (
                    <span className="evidence-file">
                      {ev.file}{ev.line ? `:${ev.line}` : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {finding.status === 'approved' && finding.approvedReason && (
            <div className="finding-approved-note">
              ✓ Approved: {finding.approvedReason}
            </div>
          )}

          {finding.status === 'suppressed' && finding.suppressedBy && (
            <div className="finding-suppressed-note">
              — Suppressed by {finding.suppressedBy}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
