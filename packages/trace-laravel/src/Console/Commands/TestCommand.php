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
 * When the Node.js CLI is NOT available (PHP-only fallback), sets
 * `TRACEGRAPH_ENABLED=1` and `TRACEGRAPH_RUN_DIR` directly, then delegates
 * to `php artisan test`.
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

        // Set tracing environment variables for child process
        putenv('TRACEGRAPH_ENABLED=1');
        putenv('TRACEGRAPH_RUN_DIR=' . $runDir);

        $cmd = 'php artisan test';
        if ($phpunitArgs !== '') {
            $cmd .= ' ' . $phpunitArgs;
        }

        $output = [];
        $exit   = 0;

        $this->line('[TraceGraph] Tracing enabled (PHP fallback). Running: ' . $cmd);
        $this->comment('[TraceGraph] Trace output dir: ' . $runDir);

        exec($cmd, $output, $exit);

        foreach ($output as $line) {
            $this->line($line);
        }

        if ($exit === 0) {
            $this->info('[TraceGraph] Tests passed. Trace files written to: ' . $runDir);
            $this->comment('Run `tracegraph baseline create` (Node.js CLI) to create baselines.');
        } else {
            $this->warn('[TraceGraph] Tests failed (exit ' . $exit . '). Trace files may still be useful.');
        }

        return $exit === 0 ? Command::SUCCESS : Command::FAILURE;
    }
}
