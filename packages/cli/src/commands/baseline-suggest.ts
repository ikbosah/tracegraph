/**
 * T-IMP6.1 — `tracegraph baseline suggest-update`
 *
 * Heuristic analysis that classifies the diff between the current trace set
 * and stored baselines into:
 *
 *   ✅ SAFE TO UPDATE    — only additions; no security concerns; likely a new feature
 *   🔄 POSSIBLE RENAME  — added + removed signatures with similar names (edit distance)
 *   ⚠️  REVIEW REQUIRED  — security-critical signature removed; do NOT auto-update
 *   📦 RESOURCE CHANGE  — DB table / resource operation counts changed
 *
 * Usage:
 *   tracegraph baseline suggest-update [--trace <file>] [--interactive] [--accept-suggestions]
 */
import fs       from 'fs';
import path     from 'path';
import readline from 'readline';
import { EXIT_CODES, SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type {
  TraceSession,
  CompactBaseline,
  BehaviorDiff,
  SignatureChange,
  ResourceChange,
  LatestPointer,
} from '@tracegraph/shared-types';
import { diffBaseline, sessionToBaseline, deriveTestId } from '@tracegraph/graph-engine';

// ─── Public API ────────────────────────────────────────────────────────────────

export type BaselineSuggestOptions = {
  /** Analyse a specific trace file instead of the latest run. */
  trace?:             string;
  /** Walk through each trace interactively and confirm before updating. */
  interactive?:       boolean;
  /** Automatically create baselines for all SAFE traces. */
  acceptSuggestions?: boolean;
  /** Name / email to record as the approver on any written baselines. */
  approvedBy?:        string;
  /** Reason to record on written baselines. */
  reason?:            string;
};

export async function baselineSuggestUpdateCommand(
  options: BaselineSuggestOptions,
): Promise<number> {
  const cwd            = process.cwd();
  const tracegraphDir  = path.join(cwd, '.tracegraph');
  const baselinesDir   = path.join(tracegraphDir, 'baselines');

  // ── Resolve trace files to analyse ────────────────────────────────────────
  const traceFiles = options.trace
    ? [path.resolve(cwd, options.trace)]
    : resolveLatestTraces(tracegraphDir);

  if (traceFiles.length === 0) {
    process.stderr.write(
      '[tracegraph] No trace files found. Run `tracegraph run -- <command>` first, ' +
      'or specify --trace <file>.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  if (!fs.existsSync(baselinesDir)) {
    process.stderr.write(
      '[tracegraph] No baselines found. Run `tracegraph baseline create` first.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  process.stdout.write(
    `[tracegraph] Analysing ${traceFiles.length} trace(s) against stored baselines...\n\n`,
  );

  // ── Load + diff each trace ──────────────────────────────────────────────────
  type AnalysisEntry = {
    session:        TraceSession;
    baseline:       CompactBaseline;
    diff:           BehaviorDiff;
    classification: DiffClassification;
  };

  const entries:   AnalysisEntry[] = [];
  let   noBaseline = 0;

  for (const traceFile of traceFiles) {
    let session: TraceSession;
    try {
      session = JSON.parse(fs.readFileSync(traceFile, 'utf8')) as TraceSession;
    } catch {
      process.stderr.write(`[tracegraph] Skipping unreadable trace: ${traceFile}\n`);
      continue;
    }

    if (session.schemaVersion !== SCHEMA_VERSIONS.trace) {
      process.stderr.write(
        `[tracegraph] Schema mismatch in ${path.basename(traceFile)} — skipping.\n`,
      );
      continue;
    }

    const testId      = deriveTestId(session.entrypoint);
    const baselinePath = path.join(baselinesDir, `${testId}.baseline.json`);

    if (!fs.existsSync(baselinePath)) {
      process.stderr.write(
        `[tracegraph] No baseline for trace ${testId} — skipping ` +
        `(run: tracegraph baseline create).\n`,
      );
      noBaseline++;
      continue;
    }

    let baseline: CompactBaseline;
    try {
      baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as CompactBaseline;
    } catch {
      process.stderr.write(`[tracegraph] Cannot read baseline for ${testId} — skipping.\n`);
      continue;
    }

    const diff           = diffBaseline(baseline, session);
    const classification = classifyDiff(diff);

    entries.push({ session, baseline, diff, classification });
  }

  if (entries.length === 0) {
    process.stdout.write('[tracegraph] No traces could be analysed.\n');
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Print analysis results ─────────────────────────────────────────────────
  printAnalysis(entries);

  // ── Summary counts ─────────────────────────────────────────────────────────
  const safe       = entries.filter((e) => e.classification.safeToUpdate);
  const review     = entries.filter((e) => e.classification.securityRemovals.length > 0);
  const renames    = entries.filter((e) => e.classification.possibleRenames.length > 0 && e.classification.safeToUpdate);
  const resources  = entries.filter((e) => e.classification.resourceChanges.length > 0 && !e.classification.safeToUpdate);
  const noChange   = entries.filter((e) => isNoChange(e.diff));

  printSummary(safe.length, review.length, renames.length, resources.length, noChange.length, noBaseline);

  // ── Interactive mode ──────────────────────────────────────────────────────
  if (options.interactive && process.stdin.isTTY) {
    const toUpdate = await runInteractive(entries);
    if (toUpdate.length > 0) {
      const approvedBy = options.approvedBy ?? gitUser() ?? process.env['USER'] ?? 'system';
      const reason     = options.reason     ?? 'Baseline updated via tracegraph baseline suggest-update';
      writeBaselines(toUpdate.map((e) => e.session), baselinesDir, approvedBy, reason);
    }
    return EXIT_CODES.SUCCESS;
  }

  // ── --accept-suggestions mode ──────────────────────────────────────────────
  if (options.acceptSuggestions) {
    if (safe.length === 0) {
      process.stdout.write('[tracegraph] No SAFE traces to update.\n');
      return EXIT_CODES.SUCCESS;
    }
    const approvedBy = options.approvedBy ?? gitUser() ?? process.env['USER'] ?? 'system';
    const reason     = options.reason     ?? 'Auto-accepted via tracegraph baseline suggest-update';
    process.stdout.write(
      `[tracegraph] Writing baselines for ${safe.length} SAFE trace(s)...\n`,
    );
    writeBaselines(safe.map((e) => e.session), baselinesDir, approvedBy, reason);
    process.stdout.write('[tracegraph] Done.\n');
  } else if (safe.length > 0) {
    process.stdout.write(
      `\nTo update SAFE baselines: tracegraph baseline create --all\n` +
      `To accept suggestions:     tracegraph baseline suggest-update --accept-suggestions\n`,
    );
  }

  return EXIT_CODES.SUCCESS;
}

// ─── Diff classification ───────────────────────────────────────────────────────

type PossibleRename = {
  removed: SignatureChange;
  added:   SignatureChange;
};

type DiffClassification = {
  safeToUpdate:      boolean;
  securityRemovals:  SignatureChange[];
  otherRemovals:     SignatureChange[];  // non-security, non-rename removals
  possibleRenames:   PossibleRename[];
  resourceChanges:   ResourceChange[];
  additions:         SignatureChange[];
};

/** Returns true when the signature is security-critical (auth, validation, critical flag). */
function isSecuritySignature(sig: SignatureChange): boolean {
  return sig.critical || sig.role === 'authorization' || sig.role === 'validation';
}

/** Get the human-readable name component from a SignatureChange for rename detection. */
function sigName(sig: SignatureChange): string {
  const s = sig.signature;
  return (s.methodName ?? s.functionName ?? s.resourceKey ?? sig.eventName ?? '').toLowerCase();
}

/** Levenshtein edit distance (O(min(m,n)) space). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      curr.push(
        a[i - 1] === b[j - 1]
          ? prev[j - 1]!
          : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!),
      );
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * For each removed signature, attempt to find an added signature with the
 * same role and a sufficiently similar name (edit distance < 50% of max length).
 * Each removed signature matches at most one added signature.
 */
function findPossibleRenames(
  removed: SignatureChange[],
  added:   SignatureChange[],
): PossibleRename[] {
  const usedAdded = new Set<string>();
  const renames:   PossibleRename[] = [];

  for (const rem of removed) {
    const nameA = sigName(rem);
    if (!nameA) continue;

    for (const add of added) {
      if (usedAdded.has(add.identityHash)) continue;
      if (rem.role !== add.role) continue;

      const nameB  = sigName(add);
      if (!nameB)  continue;

      const dist   = editDistance(nameA, nameB);
      const maxLen = Math.max(nameA.length, nameB.length);
      if (dist > 0 && dist / maxLen < 0.5) {
        renames.push({ removed: rem, added: add });
        usedAdded.add(add.identityHash);
        break;
      }
    }
  }

  return renames;
}

function classifyDiff(diff: BehaviorDiff): DiffClassification {
  const possibleRenames     = findPossibleRenames(diff.removedSignatures, diff.addedSignatures);
  const renamedRemovedHashes = new Set(possibleRenames.map((r) => r.removed.identityHash));

  const securityRemovals = diff.removedSignatures.filter((s) => isSecuritySignature(s));
  const otherRemovals    = diff.removedSignatures.filter(
    (s) => !isSecuritySignature(s) && !renamedRemovedHashes.has(s.identityHash),
  );
  const additions        = diff.addedSignatures;
  const resourceChanges  = diff.changedResources;

  // Safe = no security removals + no unrenamed non-security removals + no resource changes
  // (may have additions or pure renames)
  const safeToUpdate = securityRemovals.length === 0
    && otherRemovals.length === 0
    && resourceChanges.length === 0
    && (additions.length > 0 || possibleRenames.length > 0);

  return { safeToUpdate, securityRemovals, otherRemovals, possibleRenames, resourceChanges, additions };
}

function isNoChange(diff: BehaviorDiff): boolean {
  return diff.addedSignatures.length   === 0
    && diff.removedSignatures.length   === 0
    && diff.changedResources.length    === 0
    && !diff.responseShapeChange;
}

// ─── Output formatting ─────────────────────────────────────────────────────────

function sigLabel(sig: SignatureChange): string {
  const s    = sig.signature;
  const name = s.methodName  ? `${s.className ? s.className + '.' : ''}${s.methodName}`
             : s.functionName ? s.functionName
             : s.resourceKey  ? `${s.resourceType ?? 'db'}.${s.resourceKey} (${s.resourceOperation ?? 'op'})`
             : sig.eventName  ?? sig.identityHash.slice(0, 8);
  const type = s.routeMethod ? `${s.routeMethod} ${s.routePathPattern ?? ''}` : sig.signature.eventType;
  return `${type}: ${name}`;
}

function traceLabel(session: TraceSession): string {
  const ep = session.entrypoint;
  if (ep.type === 'http_request') return `${ep.method} ${ep.path}`;
  if (ep.type === 'test_case')    return ep.testName;
  if (ep.type === 'function')     return ep.functionName;
  return session.traceId.slice(0, 12);
}

function printAnalysis(
  entries: Array<{
    session:        TraceSession;
    baseline:       CompactBaseline;
    diff:           BehaviorDiff;
    classification: DiffClassification;
  }>,
): void {
  const HR = '─'.repeat(66);
  const HH = '═'.repeat(66);

  for (const { session, diff, classification: c } of entries) {
    const label = traceLabel(session);
    process.stdout.write(`${HR}\n`);
    process.stdout.write(` trace: ${label}  (${session.traceId.slice(0, 12)})\n`);
    process.stdout.write(`${HR}\n\n`);

    if (isNoChange(diff)) {
      process.stdout.write('  ✓ No changes detected — baseline is up to date.\n\n');
      continue;
    }

    // ── Security removals ────────────────────────────────────────────────────
    if (c.securityRemovals.length > 0) {
      process.stdout.write(
        `  ⚠️  REVIEW REQUIRED — ${c.securityRemovals.length} security signature(s) removed:\n`,
      );
      for (const s of c.securityRemovals) {
        process.stdout.write(`     - ${sigLabel(s)}  [${s.critical ? 'CRITICAL' : s.role.toUpperCase()}]\n`);
      }
      process.stdout.write(
        `     → Do NOT update this baseline until the removal is reviewed.\n` +
        `     → Run: tracegraph finding list\n\n`,
      );
    }

    // ── Possible renames ─────────────────────────────────────────────────────
    if (c.possibleRenames.length > 0) {
      process.stdout.write(
        `  🔄 POSSIBLE RENAME${c.possibleRenames.length > 1 ? 'S' : ''} — manual confirmation recommended:\n`,
      );
      for (const { removed, added } of c.possibleRenames) {
        process.stdout.write(
          `     - ${sigLabel(removed)}\n` +
          `       → ${sigLabel(added)}\n`,
        );
      }
      process.stdout.write(
        `     ℹ️  Edit distance suggests rename. Accept only if the change is intentional.\n\n`,
      );
    }

    // ── Other non-security removals ───────────────────────────────────────────
    if (c.otherRemovals.length > 0) {
      process.stdout.write(
        `  ⚠️  ${c.otherRemovals.length} removal(s) — review before updating:\n`,
      );
      for (const s of c.otherRemovals) {
        process.stdout.write(`     - ${sigLabel(s)}\n`);
      }
      process.stdout.write('\n');
    }

    // ── Resource changes ─────────────────────────────────────────────────────
    if (c.resourceChanges.length > 0) {
      process.stdout.write(
        `  📦 RESOURCE CHANGE — operation counts differ:\n`,
      );
      for (const r of c.resourceChanges) {
        process.stdout.write(
          `     ${r.type}:${r.key} (${r.operation})  baseline: ${r.baselineCount} → candidate: ${r.candidateCount}\n`,
        );
      }
      process.stdout.write('\n');
    }

    // ── Safe additions ────────────────────────────────────────────────────────
    if (c.additions.length > 0 && c.safeToUpdate) {
      process.stdout.write(
        `  ✅ SAFE TO UPDATE — ${c.additions.length} addition(s)` +
        (c.possibleRenames.length > 0 ? ` + ${c.possibleRenames.length} rename(s)` : '') +
        ` (likely new feature):\n`,
      );
      for (const s of c.additions) {
        process.stdout.write(`     + ${sigLabel(s)}\n`);
      }
      process.stdout.write('\n');
    } else if (c.additions.length > 0) {
      process.stdout.write(
        `  ℹ️  ${c.additions.length} addition(s) (also has removals — not auto-safe):\n`,
      );
      for (const s of c.additions) {
        process.stdout.write(`     + ${sigLabel(s)}\n`);
      }
      process.stdout.write('\n');
    }
  }
}

function printSummary(
  safe:      number,
  review:    number,
  renames:   number,
  resources: number,
  noChange:  number,
  noBase:    number,
): void {
  const HH = '═'.repeat(66);
  process.stdout.write(`${HH}\n`);
  process.stdout.write('Summary:\n');
  if (safe      > 0) process.stdout.write(`  ✅  ${safe} safe to update\n`);
  if (review    > 0) process.stdout.write(`  ⚠️   ${review} require review before updating\n`);
  if (renames   > 0) process.stdout.write(`  🔄  ${renames} with possible rename(s) — confirm manually\n`);
  if (resources > 0) process.stdout.write(`  📦  ${resources} with resource count changes\n`);
  if (noChange  > 0) process.stdout.write(`  ✓   ${noChange} already up to date\n`);
  if (noBase    > 0) process.stdout.write(`  ℹ️   ${noBase} trace(s) had no baseline\n`);
  process.stdout.write(`${HH}\n`);
}

// ─── Interactive mode ──────────────────────────────────────────────────────────

async function runInteractive(
  entries: Array<{
    session:        TraceSession;
    classification: DiffClassification;
    diff:           BehaviorDiff;
  }>,
): Promise<Array<{ session: TraceSession }>> {
  const toUpdate: Array<{ session: TraceSession }> = [];

  for (const entry of entries) {
    const { session, classification: c, diff } = entry;
    if (isNoChange(diff)) continue;

    const label   = traceLabel(session);
    const canUpdate = c.safeToUpdate;

    process.stdout.write(`\n─── ${label} ─────────────────────────────────────────\n`);
    if (canUpdate) {
      process.stdout.write('  Classification: ✅ SAFE TO UPDATE\n');
    } else {
      process.stdout.write('  Classification: ⚠️  REVIEW REQUIRED\n');
      if (c.securityRemovals.length > 0) {
        process.stdout.write(`  Security removals: ${c.securityRemovals.map(sigLabel).join(', ')}\n`);
      }
    }

    const prompt = canUpdate
      ? `  [U]pdate baseline  [S]kip  [Q]uit  → `
      : `  [S]kip (review required)  [Q]uit  → `;

    const answer = await askLine(prompt);

    if (answer === 'q') {
      process.stdout.write('[tracegraph] Quit.\n');
      break;
    }
    if (answer === 'u' && canUpdate) {
      toUpdate.push({ session });
      process.stdout.write('  → Marked for update.\n');
    } else {
      process.stdout.write('  → Skipped.\n');
    }
  }

  return toUpdate;
}

function askLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ─── Baseline writing ──────────────────────────────────────────────────────────

function writeBaselines(
  sessions:    TraceSession[],
  baselinesDir: string,
  approvedBy:  string,
  reason:      string,
): void {
  let written = 0;
  for (const session of sessions) {
    try {
      const baseline = sessionToBaseline(session, { approvedBy, reason });
      const outPath  = path.join(baselinesDir, `${baseline.testId}.baseline.json`);
      fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
      process.stdout.write(`  [ok] ${baseline.testId}.baseline.json\n`);
      written++;
    } catch (err) {
      process.stderr.write(
        `[tracegraph] Failed to write baseline for ${session.traceId}: ${String(err)}\n`,
      );
    }
  }
  process.stdout.write(`[tracegraph] ${written} baseline(s) written.\n`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve trace files from .tracegraph/latest.json, falling back to all traces. */
function resolveLatestTraces(tracegraphDir: string): string[] {
  const tracesDir  = path.join(tracegraphDir, 'traces');
  if (!fs.existsSync(tracesDir)) return [];

  const latestPath = path.join(tracegraphDir, 'latest.json');
  if (fs.existsSync(latestPath)) {
    try {
      const ptr = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as LatestPointer;
      const resolved = ptr.latestTraceIds
        .map((id) => path.join(tracesDir, `${id}.trace.json`))
        .filter((p) => fs.existsSync(p));
      if (resolved.length > 0) return resolved;
    } catch { /* fall through */ }
  }

  return fs.readdirSync(tracesDir)
    .filter((f) => f.endsWith('.trace.json'))
    .map((f) => path.join(tracesDir, f));
}

/** Read the git user.name for the approvedBy field. */
function gitUser(): string | null {
  try {
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const result = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: 'pipe' });
    if (result.status === 0) return (result.stdout ?? '').trim() || null;
  } catch { /* not in git repo */ }
  return null;
}
