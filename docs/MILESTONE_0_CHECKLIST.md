# Milestone 0 — Implementation Checklist

> **Scope:** File protocol, schema types, JSONL event writer, atomic finalisation,
> storage management, CLI skeleton, and the integration test that proves the protocol
> end-to-end. No adapter code. No graph rendering. No VS Code.
>
> **Exit criterion:** `milestone0-cli-file-protocol.integration.test.ts` passes in CI.

---

## Package responsibilities

| Package | What is built in M0 |
|---------|---------------------|
| `packages/shared-types` | All canonical TypeScript types |
| `packages/trace-core` | Trace writer, reader, atomic finaliser, storage manager |
| `packages/cli` | `tracegraph run`, `tracegraph clean`, `tracegraph storage status` |
| `schemas/` | JSON schema files for trace, baseline, bundle, report, suppressions |

---

## 1. Schema Types (`packages/shared-types/src/index.ts`)

Define and export every type. No implementation logic in this package.

```typescript
// ─── Schema versions ────────────────────────────────────────────────────────
export const SCHEMA_VERSIONS = {
  trace:        "tracegraph.trace.v1",
  event:        "tracegraph.event.v1",
  baseline:     "tracegraph.baseline.v1",
  bundle:       "tracegraph.bundle.v1",
  report:       "tracegraph.report.v1",
  diff:         "tracegraph.diff.v1",
  suppression:  "tracegraph.suppressions.v1",
  findingApproval: "tracegraph.finding-approvals.v1",
  scenario:     "tracegraph.scenario.v1",
} as const;

// ─── TraceEntrypoint ────────────────────────────────────────────────────────
export type TraceEntrypoint =
  | { type: "http_request";  method: string; path: string; handler?: string }
  | { type: "test_case";     testName: string; testFile?: string }
  | { type: "function";      functionName: string; file?: string; line?: number }
  | { type: "cli_command";   command: string };

// ─── CaptureLevel ───────────────────────────────────────────────────────────
export type CaptureLevel = {
  overall: 0 | 1 | 2 | 3 | 4 | 5;
  label: string;
  adapters: Record<string, AdapterCaptureInfo>;
};

export type AdapterCaptureInfo = {
  level: number;
  mode: string;
  captured: string[];
  notCaptured: string[];
  recommendation?: string;
};

// ─── TraceEvent ─────────────────────────────────────────────────────────────
export type TraceEventType =
  | "trace_start" | "trace_end"
  | "http_request" | "http_response"
  | "function_call" | "method_call"
  | "db_query"
  | "external_http_call"
  | "file_operation" | "cache_operation"
  | "queue_event"
  | "log" | "error"
  | "branch" | "return"
  | "auth_check" | "authorization_check"
  | "rate_limit_check"
  | "lock_acquire" | "lock_release"
  | "transaction_start" | "transaction_commit" | "transaction_rollback";

export type ConcurrencyType =
  | "sequential" | "parallel" | "promise_all" | "race" | "background";

export type EventRef = { traceId: string; eventId: string };

export type TraceEvent = {
  schemaVersion: "tracegraph.event.v1";
  eventId: string;
  traceId: string;
  parentEventId?: string | null;
  causalParentEventId?: string | null;
  causalParentRef?: EventRef | null;
  asyncGroupId?: string;
  branchId?: string;
  concurrencyType?: ConcurrencyType;
  type: TraceEventType;
  language: "typescript" | "javascript" | "php";
  name: string;
  displayName?: string;
  file?: string;
  line?: number;
  column?: number;
  className?: string;
  functionName?: string;
  moduleName?: string;
  framework?: "express" | "nestjs" | "nextjs" | "fastify" | "laravel" | "symfony" | "plain";
  startTime: number;
  endTime?: number;
  durationMs?: number;
  input?: SanitizedValue;
  output?: SanitizedValue;
  error?: TraceError;
  resource?: TraceResource;
  security?: SecurityMetadata;
  reliability?: ReliabilityMetadata;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type SanitizedValue = Record<string, unknown> | unknown[] | string | number | null;
export type TraceError = { type: string; message: string; stack?: string };
export type TraceResource = { type: string; key: string; operation: string };
export type SecurityMetadata  = Record<string, unknown>;
export type ReliabilityMetadata = Record<string, unknown>;

// ─── DetailStreams ───────────────────────────────────────────────────────────
export type DetailStreams = {
  xdebug?: {
    events: TraceEvent[];
    attachedTo: Record<string, string[]>; // semanticEventId → xdebug eventIds
  };
};

// ─── TraceSession ────────────────────────────────────────────────────────────
export type TraceSession = {
  schemaVersion: "tracegraph.trace.v1";
  traceId: string;
  sessionId: string;
  runId: string;
  scenarioId?: string;
  projectId?: string;
  workspaceRoot: string;
  language: "typescript" | "javascript" | "php";
  framework?: string;
  entrypoint: TraceEntrypoint;
  startedAt: number;
  endedAt?: number;
  status: "running" | "passed" | "failed" | "error";
  captureLevel: CaptureLevel;
  events: TraceEvent[];
  detailStreams?: DetailStreams;
  metadata?: Record<string, unknown>;
};

// ─── TraceBundle ─────────────────────────────────────────────────────────────
export type TraceBundle = {
  schemaVersion: "tracegraph.bundle.v1";
  bundleId: string;
  scenarioId: string;
  createdAt: number;
  traces: Array<{
    language: "typescript" | "javascript" | "php";
    traceId: string;
    file: string;
  }>;
  links: Array<{
    source: EventRef;
    target: EventRef;
    type: "causes" | "correlates" | "spawns";
    correlationId: string;
  }>;
};

// ─── CLI protocol ────────────────────────────────────────────────────────────
export type CliEventType =
  | "run.started" | "run.progress" | "run.completed"
  | "trace.started" | "trace.progress" | "trace.completed"
  | "finding" | "report.created" | "approval.required" | "error";

export type CliEventEnvelope = {
  protocol: "tracegraph.cli.v1";
  type: CliEventType;
  runId: string;
  traceId?: string;
  timestamp: number;
  captureLevel?: Pick<CaptureLevel, "overall" | "label">;
  payload?: Record<string, unknown>;
};

// ─── SemanticSignature ───────────────────────────────────────────────────────
export type EventRole =
  | "validation" | "authorization" | "business_logic" | "db" | "external_call";

export type SemanticSignature = {
  eventType: string;
  language: "typescript" | "javascript" | "php";
  framework?: string;
  className?: string;
  methodName?: string;
  functionName?: string;
  moduleName?: string;
  routeMethod?: string;
  routePathPattern?: string;
  resourceType?: string;
  resourceKey?: string;
  resourceOperation?: "read" | "write" | "update" | "delete";
  role?: EventRole;
};

// ─── CompactBaseline ─────────────────────────────────────────────────────────
export type JsonShape = {
  type: "string" | "number" | "boolean" | "object" | "array" | "null" | "unknown";
  properties?: Record<string, JsonShape>;
  items?: JsonShape;
};

export type CompactBaseline = {
  schemaVersion: "tracegraph.baseline.v1";
  baselineId: string;
  testId: string;
  entrypoint: TraceEntrypoint;
  approvedAt: number;
  approvedBy: string;
  reason: string;
  captureLevel: number;
  events: Array<{
    signature: SemanticSignature;
    role: string;
    count: number;
    critical?: boolean;
  }>;
  resources: Array<{
    type: string;
    key: string;
    operation: string;
    count: number;
  }>;
  responseShape: JsonShape;
};

// ─── Finding ─────────────────────────────────────────────────────────────────
export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export type FindingCategory =
  | "behavior_change"
  | "race_condition" | "rate_limit" | "idempotency" | "retry_storm"
  | "security_authentication" | "security_authorization"
  | "security_sensitive_data" | "security_injection" | "security_mass_assignment"
  | "performance" | "data_integrity" | "tracegraph_policy_change";

export type Finding = {
  id: string;
  fingerprint: string;
  ruleId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  description: string;
  evidence: Array<{ traceId: string; eventIds: string[]; file?: string; line?: number }>;
  recommendation?: string;
};

// ─── Suppression ─────────────────────────────────────────────────────────────
export type Suppression = {
  id: string;
  ruleId: string;
  semanticTarget: Partial<SemanticSignature>;
  requiresEvidence?: Array<{ type: string; name: string }>;
  reason: string;
  expiresAt: string;
  approvedBy: string;
  createdAt: string;
};

export type SuppressionsFile = {
  schemaVersion: "tracegraph.suppressions.v1";
  suppressions: Suppression[];
};

// ─── FindingApproval ─────────────────────────────────────────────────────────
export type FindingApproval = {
  findingFingerprint: string;
  ruleId: string;
  semanticTarget: Partial<SemanticSignature>;
  approvedBy: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
};

export type FindingApprovalsFile = {
  schemaVersion: "tracegraph.finding-approvals.v1";
  approvals: FindingApproval[];
};
```

---

## 2. File Layout (`packages/trace-core`)

```
packages/trace-core/src/
├── writer.ts          — TraceEventWriter: write event to .jsonl.tmp
├── finaliser.ts       — finaliseTrace(): post-process + atomic rename
├── reader.ts          — readTrace(), readBundle(), readBaseline()
├── storage.ts         — StorageManager: prune, compress, status
├── ids.ts             — createRunId(), createTraceId(), createEventId()
└── index.ts           — public exports
```

### `writer.ts`

```typescript
import fs from "node:fs";
import path from "node:path";
import type { TraceEvent } from "@tracegraph/schema";

export class TraceEventWriter {
  private stream: fs.WriteStream;

  constructor(private readonly tmpPath: string) {
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    this.stream = fs.createWriteStream(tmpPath, { flags: "a" });
  }

  write(event: TraceEvent): void {
    this.stream.write(JSON.stringify(event) + "\n");
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.stream.end((err: Error | null) => (err ? reject(err) : resolve()))
    );
  }
}
```

### `finaliser.ts`

```typescript
import fs from "node:fs";
import path from "node:path";
import type { TraceSession } from "@tracegraph/schema";
import { SCHEMA_VERSIONS } from "@tracegraph/schema";

export async function finaliseTrace(opts: {
  runDir: string;
  traceId: string;
  tracesDir: string;
  sessionMeta: Omit<TraceSession, "events" | "schemaVersion">;
}): Promise<string> {
  const jsonlTmp  = path.join(opts.runDir, `${opts.traceId}.events.jsonl.tmp`);
  const traceTmp  = path.join(opts.tracesDir, `${opts.traceId}.trace.json.tmp`);
  const traceFinal = path.join(opts.tracesDir, `${opts.traceId}.trace.json`);

  // Read all events from JSONL
  const raw = fs.readFileSync(jsonlTmp, "utf8");
  const events = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const session: TraceSession = {
    schemaVersion: SCHEMA_VERSIONS.trace,
    ...opts.sessionMeta,
    events,
  };

  // Write complete trace to .tmp
  fs.mkdirSync(opts.tracesDir, { recursive: true });
  fs.writeFileSync(traceTmp, JSON.stringify(session, null, 2));

  // Atomic rename — marks the file as complete and safe to read
  fs.renameSync(traceTmp, traceFinal);

  return traceFinal;
}
```

### `storage.ts`

```typescript
export type StorageConfig = {
  compressCompletedRuns: boolean;
  maxRuns: number;
  maxAgeDays: number;
  maxSizeMB: number;
  keepFailedRuns: number;
  pruneOnRun: boolean;
};

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  compressCompletedRuns: true,
  maxRuns: 20,
  maxAgeDays: 7,
  maxSizeMB: 500,
  keepFailedRuns: 50,
  pruneOnRun: true,
};

export class StorageManager {
  constructor(
    private readonly tracegraphDir: string,
    private readonly config: StorageConfig = DEFAULT_STORAGE_CONFIG
  ) {}

  prune(): void { /* remove runs > maxRuns and > maxAgeDays, never baselines */ }
  status(): StorageStatus { /* return counts and sizes */ }
  clean(opts?: { olderThan?: string; keepLast?: number; allRuns?: boolean }): void {}
}

export type StorageStatus = {
  runs: number;
  traces: number;
  baselines: number;
  totalSizeMB: number;
};
```

### `ids.ts`

```typescript
import { randomBytes } from "node:crypto";

const prefix = (tag: string) => `${tag}_${randomBytes(8).toString("hex")}`;

export const createRunId   = () => prefix("run");
export const createTraceId = () => prefix("trace");
export const createEventId = () => prefix("evt");
export const createSessionId = () => prefix("sess");
```

---

## 3. CLI Skeleton (`packages/cli`)

### Commands required for M0

```
tracegraph run -- <command>       Run a command and produce a trace
tracegraph clean [--options]      Prune local trace storage
tracegraph storage status         Show storage usage
```

### stdout protocol (M0 only emits these)

```typescript
// Emit via: process.stdout.write(JSON.stringify(envelope) + "\n")

emit("run.started",     { runId });
emit("trace.started",   { runId, traceId, entrypoint });
emit("trace.progress",  { runId, traceId, eventCount });
emit("trace.completed", { runId, traceId, file: finalPath });
emit("run.completed",   { runId, status, captureLevel: { overall: 0, label: "..." } });
emit("error",           { runId, message, code });
```

### Exit codes

```typescript
export const EXIT = {
  SUCCESS:           0,
  COMMAND_FAILURE:   1,
  CLI_ERROR:         2,
  APPROVAL_REQUIRED: 3,
  POLICY_REVIEW:     4,
  SCHEMA_MIGRATION:  5,
} as const;
```

### CLI entry structure

```
packages/cli/src/
├── index.ts              — entry point, command router
├── commands/
│   ├── run.ts            — tracegraph run -- <cmd>
│   ├── clean.ts          — tracegraph clean
│   └── storage.ts        — tracegraph storage status
├── protocol.ts           — emit() helper for stdout JSONL
└── config.ts             — load tracegraph.config.json
```

---

## 4. Integration Test — Milestone 0 Exit Criterion

File: `packages/cli/tests/milestone0-cli-file-protocol.integration.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Milestone 0 — CLI file protocol", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracegraph-m0-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces a valid trace.json with correct schemaVersion", () => {
    const result = spawnSync(
      "node",
      ["dist/index.js", "run", "--", "node", "-e", "console.log('hello')"],
      { cwd: tmpDir, encoding: "utf8" }
    );

    expect(result.status).toBe(0);

    const tracesDir = path.join(tmpDir, ".tracegraph", "traces");
    const traceFiles = fs.readdirSync(tracesDir).filter((f) => f.endsWith(".trace.json"));
    expect(traceFiles.length).toBeGreaterThanOrEqual(1);

    const trace = JSON.parse(fs.readFileSync(path.join(tracesDir, traceFiles[0]), "utf8"));
    expect(trace.schemaVersion).toBe("tracegraph.trace.v1");
    expect(trace.traceId).toMatch(/^trace_/);
    expect(trace.runId).toMatch(/^run_/);
    expect(Array.isArray(trace.events)).toBe(true);
  });

  it("leaves no .tmp files after completion", () => {
    spawnSync("node", ["dist/index.js", "run", "--", "node", "-e", "process.exit(0)"], {
      cwd: tmpDir,
    });

    const allFiles: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach((f) => {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) walk(full);
        else allFiles.push(full);
      });
    };
    walk(path.join(tmpDir, ".tracegraph"));
    const tmpFiles = allFiles.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("emits only control events on stdout — no raw trace.event lines", () => {
    const result = spawnSync(
      "node",
      ["dist/index.js", "run", "--", "node", "-e", "console.log('hi')"],
      { cwd: tmpDir, encoding: "utf8" }
    );

    const lines = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const rawEventLines = lines.filter((l) => l.type === "trace.event");
    expect(rawEventLines).toHaveLength(0);

    const types = lines.map((l) => l.type);
    expect(types).toContain("run.started");
    expect(types).toContain("run.completed");
  });

  it("stdout envelopes carry the correct protocol field", () => {
    const result = spawnSync(
      "node",
      ["dist/index.js", "run", "--", "node", "-e", "process.exit(0)"],
      { cwd: tmpDir, encoding: "utf8" }
    );

    const lines = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    lines.forEach((line) => {
      expect(line.protocol).toBe("tracegraph.cli.v1");
      expect(typeof line.runId).toBe("string");
      expect(typeof line.timestamp).toBe("number");
    });
  });

  it("tracegraph clean removes runs and leaves no orphan files", () => {
    spawnSync("node", ["dist/index.js", "run", "--", "node", "-e", "process.exit(0)"], {
      cwd: tmpDir,
    });

    spawnSync("node", ["dist/index.js", "clean", "--all-runs"], { cwd: tmpDir });

    const runsDir = path.join(tmpDir, ".tracegraph", "runs");
    if (fs.existsSync(runsDir)) {
      const remaining = fs.readdirSync(runsDir);
      expect(remaining).toHaveLength(0);
    }
  });

  it("exits with code 1 when the wrapped command fails", () => {
    const result = spawnSync(
      "node",
      ["dist/index.js", "run", "--", "node", "-e", "process.exit(1)"],
      { cwd: tmpDir }
    );
    expect(result.status).toBe(1);
  });

  it("trace.completed stdout event references the finalised file path", () => {
    const result = spawnSync(
      "node",
      ["dist/index.js", "run", "--", "node", "-e", "console.log('done')"],
      { cwd: tmpDir, encoding: "utf8" }
    );

    const lines = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const completed = lines.find((l) => l.type === "trace.completed");
    expect(completed).toBeDefined();
    expect(completed.file).toMatch(/\.trace\.json$/);
    expect(fs.existsSync(path.join(tmpDir, completed.file))).toBe(true);
  });

  it("tracegraph storage status reports the run", () => {
    spawnSync("node", ["dist/index.js", "run", "--", "node", "-e", "process.exit(0)"], {
      cwd: tmpDir,
    });

    const result = spawnSync("node", ["dist/index.js", "storage", "status"], {
      cwd: tmpDir,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    // Status output must mention at least one run
    expect(result.stdout).toMatch(/run/i);
  });
});
```

---

## 5. M0 Checklist

- [ ] `packages/shared-types` — all types defined and exported, including `SCHEMA_VERSIONS`
- [ ] `schemas/trace-event.schema.json` — JSON schema matching `TraceEvent` type
- [ ] `schemas/trace-session.schema.json` — JSON schema matching `TraceSession` type
- [ ] `packages/trace-core/src/ids.ts` — `createRunId`, `createTraceId`, `createEventId`
- [ ] `packages/trace-core/src/writer.ts` — `TraceEventWriter` with `write()` and `close()`
- [ ] `packages/trace-core/src/finaliser.ts` — `finaliseTrace()` with atomic rename
- [ ] `packages/trace-core/src/storage.ts` — `StorageManager` with `prune()`, `status()`, `clean()`
- [ ] `packages/trace-core/src/reader.ts` — `readTrace()`, `readBundle()`, `readBaseline()` with schema version validation
- [ ] `packages/cli/src/protocol.ts` — `emit()` for stdout JSONL envelopes
- [ ] `packages/cli/src/commands/run.ts` — wraps child process, wires writer and finaliser
- [ ] `packages/cli/src/commands/clean.ts` — delegates to `StorageManager.clean()`
- [ ] `packages/cli/src/commands/storage.ts` — delegates to `StorageManager.status()`
- [ ] Exit codes defined and returned consistently
- [ ] `.gitignore` updated — `runs/`, `traces/`, `reports/` excluded
- [ ] `pnpm-workspace.yaml` — all M0 packages registered
- [ ] `vitest.config.ts` — root test config
- [ ] `milestone0-cli-file-protocol.integration.test.ts` — all 7 assertions pass
- [ ] CI runs the integration test (push or PR)

---

## 6. What M0 does NOT include

- No language adapters (no Express, no Laravel)
- No graph engine
- No behaviour diff
- No VS Code extension
- No HTML viewer
- No sanitiser (in scope for M1)
- No baseline commands
- No scenario runner

M0 is finished when the file protocol integration test passes and a real engineer can run
`tracegraph run -- node -e "console.log('hello')"` and inspect a valid `.trace.json`.
