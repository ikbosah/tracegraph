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
  // ── Build candidate signature set ────────────────────────────────────────
  const candidateHashes = new Set<string>();
  const candidateSignatureChanges: SignatureChange[] = [];

  for (const event of candidate.events) {
    if (event.type === 'trace_start' || event.type === 'trace_end') continue;
    if (event.type === 'return') continue;

    const sig  = eventToSignature(event);
    const hash = signatureToIdentityHash(sig);
    const role = classifyRole(event);

    candidateHashes.add(hash);

    // Track for "added" detection
    candidateSignatureChanges.push({
      signature: sig,
      identityHash: hash,
      role,
      critical: isSecurityCritical(event),
      eventId: event.eventId,
      eventName: event.name,
    });
  }

  // ── Build baseline signature set ─────────────────────────────────────────
  const baselineHashes = new Set<string>(
    baseline.events.map((e) => signatureToIdentityHash(e.signature)),
  );

  // ── Removed signatures: in baseline but not in candidate ─────────────────
  const removedSignatures: SignatureChange[] = [];
  for (const entry of baseline.events) {
    const hash = signatureToIdentityHash(entry.signature);
    if (!candidateHashes.has(hash)) {
      removedSignatures.push({
        signature:    entry.signature,
        identityHash: hash,
        role:         entry.role as EventRole,
        critical:     entry.critical ?? false,
      });
    }
  }

  // ── Added signatures: in candidate but not in baseline ───────────────────
  const seenAdded = new Set<string>();
  const addedSignatures: SignatureChange[] = [];
  for (const item of candidateSignatureChanges) {
    if (!baselineHashes.has(item.identityHash) && !seenAdded.has(item.identityHash)) {
      seenAdded.add(item.identityHash);
      addedSignatures.push(item);
    }
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
