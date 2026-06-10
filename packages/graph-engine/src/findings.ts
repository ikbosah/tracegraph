/**
 * T2.5 — Finding generator
 *
 * Converts a BehaviorDiff into a list of Findings.
 *
 * Severity rules:
 *   - Authorization event removed    → Critical
 *   - Validation event removed       → High
 *   - Business logic event removed   → Medium
 *   - Any security-critical event removed → Critical (overrides role)
 *   - Event added (auth-related)     → Medium (added checks are often security improvements)
 *   - Resource operation count change → Medium
 *   - Response shape: field removed  → Low
 *   - Response shape: field added    → info
 *
 * Finding fingerprint:
 *   sha256(ruleId + ':' + role + ':' + routePathPattern + ':' +
 *          className + ':' + methodName + ':' + functionName + ':' + resourceOperation)
 *   .slice(0, 16)
 *
 * Fingerprints are stable across file moves (no file path included).
 */
import { createHash } from 'node:crypto';
import type {
  BehaviorDiff,
  Finding,
  FindingSeverity,
  FindingCategory,
  SignatureChange,
  TestIdentity,
} from '@tracegraph/shared-types';

// ─── Rule IDs ─────────────────────────────────────────────────────────────────

const RULES = {
  AUTHORIZATION_REMOVED:        'behavior.authorization.removed',
  MIDDLEWARE_REMOVED:           'security.authorization.middleware_removed',
  VALIDATION_REMOVED:           'behavior.validation.removed',
  BUSINESS_LOGIC_REMOVED:       'behavior.business_logic.removed',
  AUTHORIZATION_ADDED:          'behavior.authorization.added',
  RESOURCE_COUNT_CHANGED:       'behavior.resource_count.changed',
  RESPONSE_FIELD_REMOVED:       'behavior.response_shape.field_removed',
  RESPONSE_FIELD_ADDED:         'behavior.response_shape.field_added',
  // G6: evidence continuity
  TEST_EVIDENCE_UNMATCHED:      'evidence.test_case.unmatched',
  TEST_FILE_UNMATCHED:          'evidence.test_file.unmatched',
} as const;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert a `BehaviorDiff` into a list of `Finding` objects.
 */
export function diffToFindings(diff: BehaviorDiff): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>(); // deduplicate by fingerprint

  // ── Removed signatures ────────────────────────────────────────────────────
  for (const removed of diff.removedSignatures) {
    const classified = classifyRemovedSignature(removed);
    // null = intentionally skipped (e.g. Pest eval'd virtual file)
    if (classified === null) continue;
    const { ruleId, severity, category, title, description, recommendation, testIdentity } =
      classified;

    const fingerprint = computeFingerprint({
      ruleId,
      removed,
    });

    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const routeStr = [
      removed.signature.routeMethod ?? '',
      removed.signature.routePathPattern ?? '',
    ].join(' ').trim() || undefined;

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity,
      category,
      title,
      description,
      evidence:    [{ traceId: diff.traceId, eventIds: [] }],
      recommendation,
      route:       routeStr,
      // G6: carry test identity for evidence_continuity findings
      ...(testIdentity ? { testIdentity } : {}),
    });
  }

  // ── Added security-critical signatures (auth checks added) ────────────────
  for (const added of diff.addedSignatures) {
    if (added.role !== 'authorization' && !added.critical) continue;

    const ruleId = RULES.AUTHORIZATION_ADDED;
    const fingerprint = computeFingerprint({ ruleId, removed: added });

    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const addedRouteStr = [
      added.signature.routeMethod ?? '',
      added.signature.routePathPattern ?? '',
    ].join(' ').trim() || undefined;

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity:    'medium',
      category:    'behavior_change',
      title:       `Authorization check added: ${sigLabel(added)}`,
      description: `A new authorization check appears in the candidate run but was absent in the ` +
                   `baseline: "${added.eventName ?? sigLabel(added)}". ` +
                   `This may indicate a security improvement, or a capture-depth mismatch between ` +
                   `baseline and candidate (baseline created at a lower instrumentation level).`,
      evidence:    [{ traceId: diff.traceId, eventIds: added.eventId ? [added.eventId] : [] }],
      recommendation:
        'Verify whether this authorization check is intentional. Adding authorization is often ' +
        'a security improvement. If the PR does not touch this code path and the baseline was ' +
        'created with lower instrumentation, consider regenerating the baseline at the same ' +
        'capture level as the candidate.',
      route:       addedRouteStr,
    });
  }

  // ── Resource operation count changes ─────────────────────────────────────
  for (const rc of diff.changedResources) {
    const ruleId = RULES.RESOURCE_COUNT_CHANGED;
    const fingerprint = createHash('sha256')
      .update(`${ruleId}:${rc.type}:${rc.key}:${rc.operation}`)
      .digest('hex')
      .slice(0, 16);

    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity:    'medium',
      category:    'behavior_change',
      title:       `Resource operation count changed: ${rc.type}.${rc.operation}`,
      description: `The number of ${rc.operation} operations on "${rc.type}:${rc.key}" changed ` +
                   `from ${rc.baselineCount} (baseline) to ${rc.candidateCount} (candidate).`,
      evidence:    [{ traceId: diff.traceId, eventIds: [] }],
      recommendation: 'Verify the change in operation count is expected.',
    });
  }

  // ── Response shape changes ─────────────────────────────────────────────────
  if (diff.responseShapeChange) {
    const rsc = diff.responseShapeChange;

    for (const field of rsc.removedFields) {
      const fingerprint = createHash('sha256')
        .update(`${RULES.RESPONSE_FIELD_REMOVED}:${diff.baselineId}:${field}`)
        .digest('hex')
        .slice(0, 16);

      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        findings.push({
          id:          `find_${fingerprint}`,
          fingerprint,
          ruleId:      RULES.RESPONSE_FIELD_REMOVED,
          severity:    'low',
          category:    'behavior_change',
          title:       `Response field removed: "${field}"`,
          description: `The field "${field}" was present in the baseline response shape but is absent in the candidate.`,
          evidence:    [{ traceId: diff.traceId, eventIds: [] }],
          recommendation: 'Verify this is a planned API change and update dependent clients.',
        });
      }
    }

    for (const field of rsc.addedFields) {
      const fingerprint = createHash('sha256')
        .update(`${RULES.RESPONSE_FIELD_ADDED}:${diff.baselineId}:${field}`)
        .digest('hex')
        .slice(0, 16);

      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        findings.push({
          id:          `find_${fingerprint}`,
          fingerprint,
          ruleId:      RULES.RESPONSE_FIELD_ADDED,
          severity:    'info',
          category:    'behavior_change',
          title:       `Response field added: "${field}"`,
          description: `The field "${field}" is present in the candidate response but was absent in the baseline.`,
          evidence:    [{ traceId: diff.traceId, eventIds: [] }],
        });
      }
    }
  }

  return findings;
}

/**
 * Compute a stable 16-hex-char fingerprint for a finding.
 * Never includes file path, line, or column.
 */
export function computeFingerprint(input: {
  ruleId:  string;
  removed: SignatureChange;
}): string {
  const { ruleId, removed: sig } = input;
  const s = sig.signature;
  const parts = [
    ruleId,
    s.role              ?? '',
    s.routePathPattern  ?? '',
    s.routeMethod       ?? '',
    s.className         ?? '',
    s.methodName        ?? '',
    s.functionName      ?? '',
    s.resourceOperation ?? '',
    s.resourceType      ?? '',
    s.resourceKey       ?? '',
  ];
  return createHash('sha256').update(parts.join('\x00')).digest('hex').slice(0, 16);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classifyRemovedSignature(removed: SignatureChange): null | {
  ruleId:         string;
  severity:       FindingSeverity;
  category:       FindingCategory;
  title:          string;
  description:    string;
  recommendation: string;
  testIdentity?:  TestIdentity;
} {
  const label = sigLabel(removed);

  const eventLabel = removed.eventName ?? label;

  // G6 — Test artifact evidence: test_file and test_run events are not
  // application business logic.  When they disappear from the candidate run it
  // means a previously baselined test was not observed — which is an evidence
  // continuity finding, not a behaviour removal.
  if (removed.role === 'test_artifact') {
    const isFileEvent = removed.signature.eventType === 'test_file';
    const ruleId     = isFileEvent ? RULES.TEST_FILE_UNMATCHED : RULES.TEST_EVIDENCE_UNMATCHED;

    // Reconstruct as much human-readable identity as the signature carries.
    const className  = removed.signature.className ?? undefined;
    const method     = removed.signature.functionName ?? undefined;
    const framework  = removed.signature.framework ?? undefined;

    // ── Pest: eval'd virtual file detection ──────────────────────────────────
    // Pest generates test cases via eval() — the resulting "file" identity is a
    // virtual path like:
    //   "vendor/pestphp/pest/src/Factories/TestCaseFactory.php(175) : eval()'d code"
    // This is NOT a real user-authored test file. Skip the file-level finding;
    // individual test cases from that file will have their own case-level findings.
    if (isFileEvent) {
      const filePath = removed.signature.functionName ?? '';
      if (filePath.includes("eval()'d code")) {
        return null;  // Pest internal virtual file — not a user test file
      }
    }

    // ── Pest: decode __pest_evaluable_ method names ───────────────────────────
    // Pest internally names eval'd it() closures as __pest_evaluable_<snake_case>.
    // E.g.: __pest_evaluable_it_strips_SSRF_vectors_injected_via_address_template_placeholders
    // Decode these to produce human-readable names and usable verification commands.
    let pestHumanName: string | null = null;
    if (!isFileEvent && method?.startsWith('__pest_evaluable_')) {
      const body    = method.slice('__pest_evaluable_'.length); // "it_strips_SSRF_vectors..."
      const decoded = body.replace(/_/g, ' ');                  // "it strips SSRF vectors..."
      pestHumanName = decoded.startsWith('it ')
        ? `it('${decoded.slice(3)}')`                           // "it('strips SSRF vectors...')"
        : decoded;
    }

    let displayName: string;
    if (isFileEvent) {
      // functionName holds the relative file path for test_file events
      displayName = removed.signature.functionName ?? eventLabel;
    } else if (pestHumanName) {
      displayName = pestHumanName;
    } else {
      displayName = className && method
        ? `${className}::${method}`
        : (method ?? eventLabel);
    }

    const testIdentity: TestIdentity = {
      testName:     displayName,
      testFile:     isFileEvent ? (removed.signature.functionName ?? undefined) : undefined,
      className,
      method:       isFileEvent ? undefined : method,  // keep raw for fingerprint stability
      framework,
      identityHash: removed.identityHash,
    };

    // ── Framework-aware text fragments ───────────────────────────────────────
    // "excluded by PHPUnit config" is PHPUnit-specific — use the right config name per framework.
    const configRef =
      framework === 'phpunit' || framework === 'pest' ? 'PHPUnit config' :
      framework === 'vitest'                          ? 'vitest config' :
      framework === 'jest'                            ? 'jest config' :
      'test runner config';

    // Config file name for step 3 of the verification checklist.
    const configFile =
      framework === 'phpunit' || framework === 'pest' ? 'phpunit.xml' :
      framework === 'vitest'                          ? 'vitest.config.ts / vite.config.ts' :
      framework === 'jest'                            ? 'jest.config.js / jest.config.ts' :
      'test runner config';

    // ── Build a framework-specific run command ────────────────────────────────
    let runCmd: string;
    if (framework === 'phpunit' || framework === 'pest') {
      const bin = framework === 'pest' ? 'pest' : 'phpunit';
      if (pestHumanName) {
        // Decoded Pest it() test — use artisan with the human-readable filter
        const filterStr = pestHumanName.startsWith("it('")
          ? pestHumanName.slice(4, -2)  // extract from it('...')
          : pestHumanName;
        runCmd = `php artisan test --filter "${filterStr}"`;
      } else if (isFileEvent) {
        runCmd = `php vendor/bin/${bin} ${testIdentity.testFile ?? displayName}`;
      } else {
        runCmd = `php vendor/bin/${bin} --filter '${method ?? displayName}'`;
      }
    } else if (framework === 'jest' || framework === 'vitest') {
      if (isFileEvent) {
        // For FILE findings: pass the path directly as a positional argument.
        // --testNamePattern matches test *names*, not file paths — it would silently
        // match nothing when given a file path string.
        const filePath = testIdentity.testFile ?? displayName;
        runCmd = framework === 'vitest'
          ? `npx vitest run ${filePath}`  // `run` prevents watch mode
          : `npx jest ${filePath}`;
      } else {
        // For CASE findings: -t / --testNamePattern filters by test name
        runCmd = `npx ${framework} --testNamePattern '${method ?? displayName}'`;
      }
    } else {
      runCmd = isFileEvent
        ? `# Run test file: ${displayName}`
        : `# Run test: ${displayName}`;
    }

    // ── "Check if it still exists" command ───────────────────────────────────
    // For test FILES: check disk presence (grep for its own path is nonsensical).
    // For test CASES: search for the test name string inside the test source tree.
    const grepTerm = pestHumanName
      ? (pestHumanName.startsWith("it('") ? pestHumanName.slice(4, -2) : pestHumanName)
      : (method ?? displayName);
    const existsCmd = isFileEvent
      ? `ls ${testIdentity.testFile ?? displayName}`
      : `grep -r '${grepTerm}' tests/`;

    const titlePrefix = isFileEvent
      ? 'Previously baselined test file not observed'
      : 'Previously baselined test not observed';

    return {
      ruleId,
      severity:    'medium',
      category:    'evidence_continuity',
      title:       `${titlePrefix}: ${displayName}`,
      description: `The ${isFileEvent ? 'test file' : 'test case'} \`${displayName}\` was present in ` +
                   `the approved baseline evidence but was not observed in the candidate run. ` +
                   `This may mean the test was removed, renamed, skipped, excluded by ${configRef}, ` +
                   `or the candidate run executed a different test subset.`,
      recommendation:
        `Verify this change is intentional:\n` +
        `  1. Run the missing test directly:\n` +
        `       ${runCmd}\n` +
        `  2. Check if it still exists:\n` +
        `       ${existsCmd}\n` +
        `  3. Check whether ${configFile} excludes this path.\n` +
        `  4. If intentional: re-baseline with:\n` +
        `       tracegraph baseline create --reason "Test renamed/replaced"`,
      testIdentity,
    };
  }

  const eventLabel2 = eventLabel; // alias for clarity below

  // M5.2 — Route-level authorization middleware removed (more severe than a
  // function-level auth check because it gates every request to that route).
  if (
    removed.role === 'authorization' &&
    removed.signature.routePathPattern &&
    !removed.critical
  ) {
    return {
      ruleId:         RULES.MIDDLEWARE_REMOVED,
      severity:       'critical',
      category:       'security_authorization',
      title:          `Authorization middleware removed: ${eventLabel2}`,
      description:    `A route-level authorization middleware "${eventLabel2}" that guarded ` +
                      `"${removed.signature.routeMethod ?? ''} ${removed.signature.routePathPattern}" ` +
                      `in the baseline is absent in the candidate trace. Removing route middleware ` +
                      `exposes every request to that route to unauthenticated or unauthorized access.`,
      recommendation: 'Restore the middleware or confirm the route is now protected by an equivalent mechanism.',
    };
  }

  if (removed.critical || removed.role === 'authorization') {
    return {
      ruleId:         RULES.AUTHORIZATION_REMOVED,
      severity:       'critical',
      category:       'security_authorization',
      title:          `Authorization check removed: ${eventLabel2}`,
      description:    `An authorization check "${eventLabel2}" that was present in the baseline is no longer present in the candidate trace. This may indicate a security regression.`,
      recommendation: 'Restore the authorization check or confirm this removal is intentional and safe.',
    };
  }

  if (removed.role === 'validation') {
    return {
      ruleId:         RULES.VALIDATION_REMOVED,
      severity:       'high',
      category:       'behavior_change',
      title:          `Validation step removed: ${eventLabel2}`,
      description:    `A validation step "${eventLabel2}" present in the baseline is absent in the candidate trace. Input may no longer be validated before processing.`,
      recommendation: 'Verify validation is still performed (possibly in a different location) or restore the validation step.',
    };
  }

  return {
    ruleId:         RULES.BUSINESS_LOGIC_REMOVED,
    severity:       'medium',
    category:       'behavior_change',
    title:          `Behaviour change: ${eventLabel2} removed`,
    description:    `The event "${eventLabel2}" was present in the baseline but is absent in the candidate trace.`,
    recommendation: 'Verify this change is intentional.',
  };
}

function sigLabel(change: SignatureChange): string {
  const s = change.signature;
  if (s.className && s.methodName) return `${s.className}.${s.methodName}`;
  if (s.functionName) return s.functionName;
  if (s.routePathPattern) return `${s.routeMethod ?? ''} ${s.routePathPattern}`.trim();
  return s.eventType;
}
