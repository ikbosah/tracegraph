/**
 * T2.4 — BehaviorDiff engine — Structure mode
 *
 * Compares a CompactBaseline against a candidate TraceSession to produce
 * a BehaviorDiff describing:
 *   - Signatures present in baseline but absent in candidate (removedSignatures)
 *   - Signatures present in candidate but absent in baseline (addedSignatures)
 *   - Resource operation count changes
 *   - Response shape changes (added/removed fields, type changes)
 *
 * Volatile values in candidate event outputs are normalised before comparison
 * so that changing IDs (INV-001 vs INV-523) do not produce false diffs.
 */
import type {
  CompactBaseline,
  TraceSession,
  BehaviorDiff,
  SignatureChange,
  ResourceChange,
  ResponseShapeChange,
  JsonShape,
  EventRole,
} from '@tracegraph/shared-types';
import { normaliseForDiff } from '@tracegraph/trace-sanitizer';
import { eventToSignature, signatureToIdentityHash, classifyRole } from './signature';
import { extractShape } from './baseline';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Diff a `CompactBaseline` against a candidate `TraceSession`.
 *
 * The candidate's event outputs are normalised via `normaliseForDiff()` before
 * shape comparison so that volatile values (UUIDs, IDs, timestamps) do not
 * produce noise findings.
 */
export function diffBaseline(
  baseline: CompactBaseline,
  candidate: TraceSession,
): BehaviorDiff {
  // ── Build candidate signature counts (multiset) ───────────────────────────
  // IMP-5.1: Use count-aware multiset comparison instead of set membership.
  // This prevents false negatives when the same signature appears multiple
  // times in the baseline (e.g. validateInput called 3× → called 1×).
  const candidateCounts   = new Map<string, number>();
  const candidateSigIndex = new Map<string, SignatureChange>();

  for (const event of candidate.events) {
    if (event.type === 'trace_start' || event.type === 'trace_end') continue;
    if (event.type === 'return') continue;

    const sig  = eventToSignature(event);
    const hash = signatureToIdentityHash(sig);
    const role = classifyRole(event);

    candidateCounts.set(hash, (candidateCounts.get(hash) ?? 0) + 1);

    // Keep first occurrence for output metadata
    if (!candidateSigIndex.has(hash)) {
      candidateSigIndex.set(hash, {
        signature:    sig,
        identityHash: hash,
        role,
        critical:     isSecurityCritical(event),
        eventId:      event.eventId,
        eventName:    event.name,
      });
    }
  }

  // ── Build baseline signature counts (from stored .count field) ───────────
  const baselineCounts   = new Map<string, number>();
  const baselineSigIndex = new Map<string, { sig: typeof baseline.events[0]['signature']; role: string; critical: boolean }>();

  for (const entry of baseline.events) {
    const hash = signatureToIdentityHash(entry.signature);
    // Baseline entries are already aggregated; sum in case of duplicates
    baselineCounts.set(hash, (baselineCounts.get(hash) ?? 0) + entry.count);
    if (!baselineSigIndex.has(hash)) {
      baselineSigIndex.set(hash, {
        sig:      entry.signature,
        role:     entry.role,
        critical: entry.critical ?? false,
      });
    }
  }

  // ── Removed signatures: baseline count exceeds candidate count ───────────
  // One SignatureChange per distinct hash regardless of how much the count
  // decreased (avoids flooding the findings list for high-count signatures).
  const removedSignatures: SignatureChange[] = [];
  for (const [hash, baselineCount] of baselineCounts) {
    const candidateCount = candidateCounts.get(hash) ?? 0;
    if (baselineCount <= candidateCount) continue; // not reduced

    const entry = baselineSigIndex.get(hash)!;
    removedSignatures.push({
      signature:    entry.sig,
      identityHash: hash,
      role:         entry.role as EventRole,
      critical:     entry.critical,
    });
  }

  // ── Added signatures: candidate count exceeds baseline count ─────────────
  const addedSignatures: SignatureChange[] = [];
  for (const [hash, candidateCount] of candidateCounts) {
    const baselineCount = baselineCounts.get(hash) ?? 0;
    if (candidateCount <= baselineCount) continue; // not increased

    const change = candidateSigIndex.get(hash)!;
    addedSignatures.push(change);
  }

  // ── Resource changes ──────────────────────────────────────────────────────
  const candidateResources = buildResourceMap(candidate);
  const changedResources: ResourceChange[] = [];

  const allResourceKeys = new Set([
    ...baseline.resources.map((r) => `${r.type}:${r.key}:${r.operation}`),
    ...Object.keys(candidateResources),
  ]);

  for (const key of allResourceKeys) {
    const [type, rKey, operation] = key.split(':') as [string, string, string];
    const baselineCount  = baseline.resources.find(
      (r) => `${r.type}:${r.key}:${r.operation}` === key,
    )?.count ?? 0;
    const candidateCount = candidateResources[key] ?? 0;

    if (baselineCount !== candidateCount) {
      changedResources.push({ type, key: rKey, operation, baselineCount, candidateCount });
    }
  }

  // ── Response shape changes ────────────────────────────────────────────────
  const responseShapeChange = diffResponseShapes(baseline, candidate);

  return {
    traceId:           candidate.traceId,
    baselineId:        baseline.baselineId,
    addedSignatures,
    removedSignatures,
    changedResources,
    ...(responseShapeChange ? { responseShapeChange } : {}),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isSecurityCritical(event: { type: string; security?: unknown }): boolean {
  return event.type === 'auth_check'
    || event.type === 'authorization_check'
    || Boolean((event.security as Record<string, unknown> | undefined)?.['critical']);
}

function buildResourceMap(session: TraceSession): Record<string, number> {
  const map: Record<string, number> = {};
  for (const event of session.events) {
    if (event.type === 'db_query' && event.resource) {
      const key = `${event.resource.type}:${event.resource.key}:${event.resource.operation}`;
      map[key] = (map[key] ?? 0) + 1;
    }
  }
  return map;
}

function diffResponseShapes(
  baseline: CompactBaseline,
  candidate: TraceSession,
): ResponseShapeChange | null {
  // Find the response shape from the candidate
  let candidateShape: JsonShape = { type: 'unknown' };
  for (const event of candidate.events) {
    if (event.type === 'http_response' && event.output) {
      const normalised = normaliseForDiff(event.output);
      candidateShape = extractShape(normalised);
      break;
    }
  }

  const baselineShape = baseline.responseShape;

  // Only compare object shapes (skip unknown/null/primitive shapes)
  if (baselineShape.type !== 'object' || candidateShape.type !== 'object') {
    return null;
  }

  const baselineFields  = new Set(Object.keys(baselineShape.properties  ?? {}));
  const candidateFields = new Set(Object.keys(candidateShape.properties ?? {}));

  const addedFields   = [...candidateFields].filter((f) => !baselineFields.has(f));
  const removedFields = [...baselineFields].filter((f)  => !candidateFields.has(f));

  const typeChanges: ResponseShapeChange['typeChanges'] = [];
  for (const field of baselineFields) {
    if (!candidateFields.has(field)) continue;
    const bType = (baselineShape.properties ?? {})[field]?.type;
    const cType = (candidateShape.properties ?? {})[field]?.type;
    if (bType !== cType && bType && cType) {
      typeChanges.push({ field, from: String(bType), to: String(cType) });
    }
  }

  if (addedFields.length === 0 && removedFields.length === 0 && typeChanges.length === 0) {
    return null;
  }

  return { addedFields, removedFields, typeChanges };
}
