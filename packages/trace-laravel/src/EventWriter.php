<?php

declare(strict_types=1);

namespace Tracegraph\Laravel;

/**
 * EventWriter — singleton that streams TraceEvent arrays as JSON Lines.
 *
 * Mirrors the JS ChildEventWriter pattern:
 *  - Reads the same TRACEGRAPH_* env vars set by `tracegraph run`
 *  - Appends events to `{runDir}/{traceId}.events.jsonl.tmp` via fopen/fwrite
 *  - On PHP shutdown: writes capture-level.json and meta.json to runDir
 *  - If TRACEGRAPH_ENABLED is absent or not '1', isEnabled() returns false
 *    and write() is a no-op — zero overhead in production
 */
final class EventWriter
{
    private static ?self $instance = null;

    private readonly string $runDir;
    private readonly string $traceId;
    private readonly string $runId;
    private readonly string $sessionId;
    private readonly ?string $rootEventId;
    private readonly string $jsonlPath;

    /** Whether Tracegraph::trace() was called at least once (upgrades capture level to 2). */
    private bool $hasManualTrace = false;

    private function __construct(
        string $runDir,
        string $traceId,
        string $runId,
        string $sessionId,
        ?string $rootEventId,
    ) {
        $this->runDir      = $runDir;
        $this->traceId     = $traceId;
        $this->runId       = $runId;
        $this->sessionId   = $sessionId;
        $this->rootEventId = $rootEventId;
        $this->jsonlPath   = $runDir . DIRECTORY_SEPARATOR . $traceId . '.events.jsonl.tmp';

        // Ensure the run directory exists
        if (!is_dir($runDir)) {
            mkdir($runDir, 0755, true);
        }

        // On shutdown: write capture-level.json and meta.json so the CLI can finalise correctly
        register_shutdown_function(function (): void {
            $this->writeShutdownArtifacts();
        });
    }

    /**
     * Returns the singleton writer when TRACEGRAPH_ENABLED=1 and all required
     * env vars are present. Returns null when instrumentation is disabled.
     */
    public static function getInstance(): ?self
    {
        if (getenv('TRACEGRAPH_ENABLED') !== '1') {
            return null;
        }

        $runDir  = getenv('TRACEGRAPH_RUN_DIR');
        $traceId = getenv('TRACEGRAPH_TRACE_ID');
        $runId   = getenv('TRACEGRAPH_RUN_ID');

        if ($runDir === false || $traceId === false || $runId === false) {
            return null;
        }

        if (self::$instance === null) {
            $sessionId    = getenv('TRACEGRAPH_SESSION_ID') ?: '';
            $rootEventId  = getenv('TRACEGRAPH_ROOT_EVENT_ID') ?: null;

            self::$instance = new self($runDir, $traceId, $runId, $sessionId, $rootEventId);
        }

        return self::$instance;
    }

    /** Returns true when an active trace is running. */
    public function isEnabled(): bool
    {
        return true; // getInstance() already checked; only reachable when enabled
    }

    public function getTraceId(): string
    {
        return $this->traceId;
    }

    public function getRunId(): string
    {
        return $this->runId;
    }

    public function getSessionId(): string
    {
        return $this->sessionId;
    }

    public function getRootEventId(): ?string
    {
        return $this->rootEventId;
    }

    /**
     * Appends a TraceEvent as a JSON line to the .events.jsonl.tmp file.
     * Never throws — tracing must never crash the application.
     *
     * Phase 2 invasive: when TRACEGRAPH_INVASIVE >= 2, also records the current
     * PHP call stack into CallEdgeCapture so that runtime caller→callee edges can
     * be derived from application frames and merged into the static graph.
     */
    public function write(array $event): void
    {
        try {
            // Phase 2: capture backtrace at the point of every application event
            // (http_request, db_query, auth_check, etc.).  Only active when
            // TRACEGRAPH_INVASIVE >= 2; guarded here so debug_backtrace() is never
            // called in normal (non-Phase-2) mode — it has non-trivial overhead.
            // We cache the env-var check in a static variable so getenv() is only
            // called once per PHP process.
            static $invasiveLevel = null;
            if ($invasiveLevel === null) {
                $invasiveLevel = (int) (getenv('TRACEGRAPH_INVASIVE') ?: '0');
            }
            if ($invasiveLevel >= 2) {
                \Tracegraph\Laravel\Invasive\CallEdgeCapture::getInstance()?->record(
                    // @phpstan-ignore-next-line
                    debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 25),
                );
            }

            $line = json_encode($event, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
            // file_put_contents with LOCK_EX is safe for single-threaded PHP-FPM per request.
            // For high concurrency, fopen/flock would be safer, but JSONL ordering
            // is not semantically significant so the occasional interleave is harmless.
            file_put_contents($this->jsonlPath, $line, FILE_APPEND | LOCK_EX);
        } catch (\Throwable) {
            // Best-effort: never let tracing errors affect the application
        }
    }

    /** Mark that at least one manual trace() call has been made (upgrades capture level). */
    public function markManualTrace(): void
    {
        $this->hasManualTrace = true;
    }

    // ── Shutdown artifacts ────────────────────────────────────────────────────

    private function writeShutdownArtifacts(): void
    {
        $level    = $this->hasManualTrace ? 2 : 1;
        $label    = $this->hasManualTrace
            ? 'Framework adapters + manual trace wrappers (Laravel)'
            : 'Framework adapters (Laravel)';

        $captured = ['http_request', 'http_response', 'db_query', 'auth_check'];
        if ($this->hasManualTrace) {
            $captured[] = 'function_call';
        }

        $captureLevel = [
            'overall'  => $level,
            'label'    => $label,
            'adapters' => [
                'laravel' => [
                    'level'          => $level,
                    'mode'           => 'framework-hooks',
                    'captured'       => $captured,
                    'notCaptured'    => ['vendor functions', 'raw PHP calls'],
                    'recommendation' => $this->hasManualTrace
                        ? null
                        : 'Wrap business-logic functions with Tracegraph::trace() for level 2 capture',
                ],
            ],
        ];

        $captureLevelPath = $this->runDir . DIRECTORY_SEPARATOR . 'capture-level.json';

        // Non-downgrade guard: the PHPUnit extension writes Level 5 during test
        // execution.  This shutdown handler fires AFTER all tests — don't overwrite
        // a higher level with Level 1/2.
        $existingLevel = 0;
        try {
            $raw = file_get_contents($captureLevelPath);
            if ($raw !== false) {
                $decoded = json_decode($raw, true);
                if (isset($decoded['overall']) && is_int($decoded['overall'])) {
                    $existingLevel = $decoded['overall'];
                }
            }
        } catch (\Throwable) { /* file absent or unreadable — proceed */ }

        if ($existingLevel <= $level) {
            $this->writeSafeJson($captureLevelPath, $captureLevel);
        }

        // meta.json tells the CLI this trace came from PHP/Laravel
        $this->writeSafeJson(
            $this->runDir . DIRECTORY_SEPARATOR . 'meta.json',
            ['language' => 'php', 'framework' => 'laravel'],
        );
    }

    private function writeSafeJson(string $path, array $data): void
    {
        try {
            file_put_contents(
                $path,
                json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
            );
        } catch (\Throwable) {
            // Best-effort
        }
    }

    // ── Testing helpers ───────────────────────────────────────────────────────

    /** Resets the singleton. For use in tests only. */
    public static function _resetForTest(): void
    {
        self::$instance = null;
    }

    /**
     * Returns all events written to the JSONL file (parsed). For tests only.
     *
     * @return array<int, array<string, mixed>>
     */
    public function _readEventsForTest(): array
    {
        if (!file_exists($this->jsonlPath)) {
            return [];
        }

        $events = [];
        foreach (explode("\n", trim(file_get_contents($this->jsonlPath) ?: '')) as $line) {
            $trimmed = trim($line);
            if ($trimmed === '') {
                continue;
            }
            $decoded = json_decode($trimmed, true);
            if (is_array($decoded)) {
                $events[] = $decoded;
            }
        }

        return $events;
    }

    /** Returns the jsonl file path. For tests only. */
    public function _getJsonlPath(): string
    {
        return $this->jsonlPath;
    }
}
