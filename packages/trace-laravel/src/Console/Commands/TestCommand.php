<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Console\Commands;

use Illuminate\Console\Command;

/**
 * tracegraph:test — run the project's test suite with TraceGraph tracing enabled.
 *
 * When the Node.js CLI is available, delegates to:
 *   tracegraph run -- php artisan test [--...passthrough flags]
 *
 * This wraps the test run in the full CLI pipeline: trace capture, stdout
 * JSONL protocol, automatic Xdebug import (if XDEBUG_MODE=trace), and
 * `latest.json` pointer update.
 *
 * When the Node.js CLI is NOT available (PHP-only fallback), generates all
 * required trace IDs, sets all TRACEGRAPH_* env vars, delegates to
 * `php artisan test`, then assembles the captured events into a
 * `.tracegraph/traces/{traceId}.trace.json` file and writes `latest.json`
 * — the same artifacts that `tracegraph run` produces on the Node.js path.
 *
 * Usage:
 *   php artisan tracegraph:test
 *   php artisan tracegraph:test --run-id my-run
 *   php artisan tracegraph:test --phpunit-args "--testsuite=Feature"
 */
final class TestCommand extends Command
{
    /** @var string */
    protected $signature = 'tracegraph:test
        {--run-id=       : Override the generated run ID}
        {--scenario-id=  : Tag this run with a scenario/PR correlation ID}
        {--run-dir=      : Override the run directory (default: .tracegraph/runs/<runId>/)}
        {--phpunit-args= : Extra arguments forwarded verbatim to the underlying test runner}';

    /** @var string */
    protected $description = 'Run the Laravel test suite with TraceGraph tracing enabled';

    public function handle(): int
    {
        $runDir = $this->option('run-dir')
            ?? (getcwd() . '/.tracegraph/runs/run_' . bin2hex(random_bytes(6)));

        if (!is_dir($runDir)) {
            mkdir($runDir, 0755, true);
        }

        // ── Try Node.js CLI ────────────────────────────────────────────────
        if ($this->nodeCliAvailable()) {
            return $this->runWithNodeCli($runDir);
        }

        // ── PHP fallback ───────────────────────────────────────────────────
        return $this->phpFallback($runDir);
    }

    private function nodeCliAvailable(): bool
    {
        $output = shell_exec('tracegraph --version 2>/dev/null');
        return $output !== null && str_contains($output, '0.');
    }

    private function runWithNodeCli(string $runDir): int
    {
        $parts = ['tracegraph run'];

        $runId      = $this->option('run-id');
        $scenarioId = $this->option('scenario-id');

        if ($runId) {
            $parts[] = '--run-id ' . escapeshellarg((string) $runId);
        }
        if ($scenarioId) {
            $parts[] = '--scenario-id ' . escapeshellarg((string) $scenarioId);
        }

        $phpunitArgs = (string) ($this->option('phpunit-args') ?? '');

        $parts[] = '-- php artisan test';
        if ($phpunitArgs !== '') {
            $parts[] = $phpunitArgs;
        }

        $cmd    = implode(' ', $parts);
        $output = [];
        $exit   = 0;

        $this->line('[TraceGraph] Running: ' . $cmd);
        exec($cmd, $output, $exit);

        foreach ($output as $line) {
            $this->line($line);
        }

        return $exit === 0 ? Command::SUCCESS : Command::FAILURE;
    }

    private function phpFallback(string $runDir): int
    {
        $phpunitArgs = (string) ($this->option('phpunit-args') ?? '');

        // ── Generate IDs (format must match @tracegraph/trace-core) ───────────
        $traceId     = 'trace_' . bin2hex(random_bytes(8));
        $runId       = 'run_'   . bin2hex(random_bytes(8));
        $sessionId   = 'sess_'  . bin2hex(random_bytes(8));
        $rootEventId = 'evt_'   . bin2hex(random_bytes(8));
        $startedAt   = (int) round(microtime(true) * 1000);

        // ── Set ALL env vars required by EventWriter::getInstance() ───────────
        putenv('TRACEGRAPH_ENABLED=1');
        putenv('TRACEGRAPH_RUN_DIR='        . $runDir);
        putenv('TRACEGRAPH_TRACE_ID='       . $traceId);
        putenv('TRACEGRAPH_RUN_ID='         . $runId);
        putenv('TRACEGRAPH_SESSION_ID='     . $sessionId);
        putenv('TRACEGRAPH_ROOT_EVENT_ID='  . $rootEventId);

        // ── Write trace_start event ────────────────────────────────────────────
        $jsonlPath = $runDir . DIRECTORY_SEPARATOR . $traceId . '.events.jsonl.tmp';
        $cmd       = 'php artisan test' . ($phpunitArgs !== '' ? ' ' . $phpunitArgs : '');

        $this->writeJsonlEvent($jsonlPath, [
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => $rootEventId,
            'traceId'       => $traceId,
            'parentEventId' => null,
            'type'          => 'trace_start',
            'language'      => 'php',
            'name'          => 'trace_start',
            'startTime'     => $startedAt,
            'metadata'      => ['command' => $cmd],
        ]);

        $output = [];
        $exit   = 0;

        $this->line('[TraceGraph] Tracing enabled (PHP fallback). Running: ' . $cmd);
        $this->comment('[TraceGraph] Trace output dir: ' . $runDir);

        exec($cmd, $output, $exit);

        $endedAt = (int) round(microtime(true) * 1000);

        foreach ($output as $line) {
            $this->line($line);
        }

        // ── Write trace_end event ─────────────────────────────────────────────
        $endEventId = 'evt_' . bin2hex(random_bytes(8));
        $this->writeJsonlEvent($jsonlPath, [
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => $endEventId,
            'traceId'       => $traceId,
            'parentEventId' => $rootEventId,
            'type'          => 'trace_end',
            'language'      => 'php',
            'name'          => 'trace_end',
            'startTime'     => $endedAt,
            'endTime'       => $endedAt,
            'durationMs'    => $endedAt - $startedAt,
            'metadata'      => ['exitCode' => $exit],
        ]);

        // ── Assemble TraceSession and write to .tracegraph/traces/ ───────────
        $status = $exit === 0 ? 'passed' : 'failed';
        $this->assembleTraceSession(
            runDir:     $runDir,
            traceId:    $traceId,
            sessionId:  $sessionId,
            runId:      $runId,
            startedAt:  $startedAt,
            endedAt:    $endedAt,
            status:     $status,
            command:    $cmd,
        );

        if ($exit === 0) {
            $this->info('[TraceGraph] Tests passed. Trace files written to: ' . $runDir);
            $this->comment('Run `tracegraph baseline create` to create baselines.');
        } else {
            $this->warn('[TraceGraph] Tests failed (exit ' . $exit . '). Trace files may still be useful.');
        }

        return $exit === 0 ? Command::SUCCESS : Command::FAILURE;
    }

    /**
     * Assembles raw JSONL events into a TraceSession JSON file and writes
     * latest.json — mirrors the Node.js finaliseTrace() + latest.json step
     * from packages/cli/src/commands/run.ts.
     */
    private function assembleTraceSession(
        string $runDir,
        string $traceId,
        string $sessionId,
        string $runId,
        int    $startedAt,
        int    $endedAt,
        string $status,
        string $command,
    ): void {
        $cwd          = getcwd() ?: $runDir;
        $tracegraphDir = dirname($runDir, 2); // {cwd}/.tracegraph/runs/<id> → {cwd}/.tracegraph
        $tracesDir     = $tracegraphDir . DIRECTORY_SEPARATOR . 'traces';

        if (!is_dir($tracesDir)) {
            mkdir($tracesDir, 0755, true);
        }

        // ── Read JSONL events ──────────────────────────────────────────────────
        $jsonlPath = $runDir . DIRECTORY_SEPARATOR . $traceId . '.events.jsonl.tmp';
        $events    = [];

        if (file_exists($jsonlPath)) {
            foreach (explode("\n", trim(file_get_contents($jsonlPath) ?: '')) as $line) {
                $line = trim($line);
                if ($line === '') {
                    continue;
                }
                $decoded = json_decode($line, true);
                if (is_array($decoded)) {
                    $events[] = $decoded;
                }
            }
        }

        // ── Read capture-level.json (written by EventWriter shutdown) ─────────
        $captureLevel = [
            'overall'  => 1,
            'label'    => 'Framework adapters (Laravel)',
            'adapters' => [],
        ];
        $captureLevelPath = $runDir . DIRECTORY_SEPARATOR . 'capture-level.json';
        if (file_exists($captureLevelPath)) {
            $parsed = json_decode(file_get_contents($captureLevelPath) ?: '{}', true);
            if (is_array($parsed)) {
                $captureLevel = $parsed;
            }
        }

        // ── Build TraceSession ─────────────────────────────────────────────────
        $session = [
            'schemaVersion' => 'tracegraph.trace.v1',
            'traceId'       => $traceId,
            'sessionId'     => $sessionId,
            'runId'         => $runId,
            'workspaceRoot' => $cwd,
            'language'      => 'php',
            'framework'     => 'laravel',
            'entrypoint'    => ['type' => 'cli_command', 'command' => $command],
            'startedAt'     => $startedAt,
            'endedAt'       => $endedAt,
            'status'        => $status,
            'captureLevel'  => $captureLevel,
            'events'        => $events,
        ];

        // ── Atomic write: .tmp → final ─────────────────────────────────────────
        $traceTmpPath   = $tracesDir . DIRECTORY_SEPARATOR . $traceId . '.trace.json.tmp';
        $traceFinalPath = $tracesDir . DIRECTORY_SEPARATOR . $traceId . '.trace.json';

        file_put_contents(
            $traceTmpPath,
            json_encode($session, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n",
        );
        rename($traceTmpPath, $traceFinalPath);

        // ── Write latest.json ─────────────────────────────────────────────────
        $latestPath = $tracegraphDir . DIRECTORY_SEPARATOR . 'latest.json';
        $latest     = [
            'latestRunId'    => $runId,
            'latestTraceIds' => [$traceId],
            'latestReportId' => null,
            'updatedAt'      => $endedAt,
        ];
        file_put_contents(
            $latestPath,
            json_encode($latest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
        );

        // ── Clean up the tmp JSONL file ───────────────────────────────────────
        @unlink($jsonlPath);
    }

    /** Appends a single event as a JSON line to a .events.jsonl.tmp file. */
    private function writeJsonlEvent(string $path, array $event): void
    {
        try {
            file_put_contents(
                $path,
                json_encode($event, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n",
                FILE_APPEND | LOCK_EX,
            );
        } catch (\Throwable) {
            // Best-effort: never let tracing errors affect the application
        }
    }
}
