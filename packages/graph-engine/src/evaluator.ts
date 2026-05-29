/**
 * T2.6 — Approval and suppression evaluator
 *
 * For each Finding, determines its effective status:
 *   "approved"   — a non-expired FindingApproval matches by fingerprint
 *   "suppressed" — a Suppression matches by ruleId + semanticTarget AND all
 *                  requiresEvidence items exist in the candidate session
 *   "open"       — no matching approval or suppression
 *
 * requiresEvidence self-invalidation:
 *   A suppression that requires `authorization_check:RolePolicy.update` is only
 *   effective when that event actually appears in the candidate trace.  If the
 *   compensating function disappears, the suppression becomes invalid and the
 *   finding surfaces as "open" (Critical if the original finding was Critical).
 */
import type {
  Finding,
  EvaluatedFinding,
  FindingApproval,
  Suppression,
  TraceSession,
  SemanticSignature,
} from '@tracegraph/shared-types';

// ─── Public API ───────────────────────────────────────────────────────────────

export function evaluateFindings(
  findings:     Finding[],
  session:      TraceSession,
  suppressions: Suppression[],
  approvals:    FindingApproval[],
): EvaluatedFinding[] {
  const now = Date.now();
  return findings.map((finding) => evaluate(finding, session, suppressions, approvals, now));
}

// ─── Core evaluation ─────────────────────────────────────────────────────────

function evaluate(
  finding:      Finding,
  session:      TraceSession,
  suppressions: Suppression[],
  approvals:    FindingApproval[],
  now:          number,
): EvaluatedFinding {
  // 1. Check approvals first (explicit per-fingerprint approval)
  for (const approval of approvals) {
    if (approval.findingFingerprint !== finding.fingerprint) continue;
    if (new Date(approval.expiresAt).getTime() < now) continue;
    return {
      ...finding,
      status:        'approved',
      approvedBy:    approval.approvedBy,
      approvedReason: approval.reason,
    };
  }

  // 2. Check suppressions (ruleId + semanticTarget match + requiresEvidence)
  for (const suppression of suppressions) {
    if (suppression.ruleId !== finding.ruleId) continue;
    if (new Date(suppression.expiresAt).getTime() < now) continue;
    if (!semanticTargetMatches(suppression.semanticTarget, finding)) continue;

    // Check all requiresEvidence items exist in the candidate session
    if (suppression.requiresEvidence && suppression.requiresEvidence.length > 0) {
      const allPresent = suppression.requiresEvidence.every((item) =>
        session.events.some(
          (e) => e.type === item.type && (item.name === '*' || e.name.includes(item.name)),
        ),
      );
      if (!allPresent) {
        // Evidence is absent → suppression self-invalidates → finding is open
        continue;
      }
    }

    return {
      ...finding,
      status:        'suppressed',
      suppressedBy:  suppression.approvedBy,
    };
  }

  // 3. Open (no matching approval or suppression)
  return { ...finding, status: 'open' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check whether a suppression's `semanticTarget` matches a finding.
 * Semantics: all specified fields in the suppressionTarget must match the
 * finding's evidence, but unspecified fields are wildcards.
 * We match against the ruleId (already checked) plus the signature fields
 * embedded in the finding's description/title (a pragmatic approximation
 * since Finding only has high-level fields).
 *
 * For M2, matching is based on ruleId (already checked) and the optional
 * `functionName` field in semanticTarget vs finding title.
 */
function semanticTargetMatches(
  target: Partial<SemanticSignature>,
  finding: Finding,
): boolean {
  // If no target fields specified → matches all findings with this ruleId
  if (Object.keys(target).length === 0) return true;

  const titleAndDesc = `${finding.title} ${finding.description}`.toLowerCase();

  if (target.functionName && !titleAndDesc.includes(target.functionName.toLowerCase())) {
    return false;
  }
  if (target.className && !titleAndDesc.includes(target.className.toLowerCase())) {
    return false;
  }
  if (target.routePathPattern && !titleAndDesc.includes(target.routePathPattern.toLowerCase())) {
    return false;
  }
  if (target.role && !titleAndDesc.includes(target.role)) {
    return false;
  }

  return true;
}
