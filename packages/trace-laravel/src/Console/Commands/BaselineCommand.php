<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Console\Commands;

use Illuminate\Console\Command;

/**
 * tracegraph:baseline — create a baseline from the latest captured trace files.
 *
 * Delegates to `tracegraph baseline create` (the Node.js CLI) via `exec()`.
 * When the Node.js CLI is not available (no `tracegraph` binary on PATH),
 * falls back to a pure-PHP summary that lists trace files and their event counts.
 *
 * Usage:
 *   php artisan tracegraph:baseline
 *   php artisan tracegraph:baseline --reason "Sprint 42 baseline"
 *   php artisan tracegraph:baseline --approved-by "alice"
 */
final class BaselineCommand extends Command
{
    /** @var string */
    protected $signature = 'tracegraph:baseline
        {--reason=    : Approval reason for the baseline}
        {--approved-by= : Name of the approver}
        {--all        : Overwrite existing baselines}';

    /** @var string */
    protected $description = 'Create TraceGraph baselines from the latest captured trace files';

    public function handle(): int
    {
        $runDir = getenv('TRACEGRAPH_RUN_DIR');

        if (!$runDir || !is_dir($runDir)) {
            $this->error(
                '[TraceGraph] No trace run directory found. ' .
                'Run your tests with TRACEGRAPH_ENABLED=1 first.',
            );
            return Command::FAILURE;
        }

        // ── Try Node.js CLI ────────────────────────────────────────────────
        if ($this->nodeCliAvailable()) {
            return $this->runNodeCli($runDir);
        }

        // ── PHP fallback: list and summarise trace files ───────────────────
        return $this->phpFallback($runDir);
    }

    private function nodeCliAvailable(): bool
    {
        $output = shell_exec('tracegraph --version 2>/dev/null');
        return $output !== null && str_contains($output, '0.');
    }

    private function runNodeCli(string $runDir): int
    {
        $parts = ['tracegraph baseline create'];

        $reason     = $this->option('reason');
        $approvedBy = $this->option('approved-by');
        $all        = $this->option('all');

        if ($reason) {
            $parts[] = '--reason ' . escapeshellarg((string) $reason);
        }
        if ($approvedBy) {
            $parts[] = '--approved-by ' . escapeshellarg((string) $approvedBy);
        }
        if ($all) {
            $parts[] = '--all';
        }

        $cmd    = implode(' ', $parts);
        $output = [];
        $exit   = 0;

        exec($cmd, $output, $exit);

        foreach ($output as $line) {
            $this->line($line);
        }

        return $exit === 0 ? Command::SUCCESS : Command::FAILURE;
    }

    private function phpFallback(string $runDir): int
    {
        $traceFiles = glob($runDir . '/*.events.jsonl') ?: [];

        if (empty($traceFiles)) {
            $this->warn('[TraceGraph] No trace files found in: ' . $runDir);
            return Command::FAILURE;
        }

        $this->info('[TraceGraph] Trace files found (PHP fallback — install Node.js CLI for full baseline support):');
        $this->line('');

        foreach ($traceFiles as $file) {
            $lines      = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
            $eventCount = count($lines);
            $traceId    = pathinfo($file, PATHINFO_FILENAME);
            $traceId    = str_replace('.events', '', $traceId);

            $this->line(sprintf(
                '  <info>%s</info>  (%d events)',
                $traceId,
                $eventCount,
            ));
        }

        $this->line('');
        $this->comment('Run `tracegraph baseline create` (Node.js CLI) to create proper baselines.');

        return Command::SUCCESS;
    }
}
