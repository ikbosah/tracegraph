<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Console\Commands;

use Illuminate\Console\Command;

/**
 * tracegraph:compare — compare candidate traces against baselines.
 *
 * Delegates to `tracegraph compare` (the Node.js CLI).
 * Falls back to a PHP diff summary when the Node.js CLI is not available.
 *
 * Usage:
 *   php artisan tracegraph:compare
 *   php artisan tracegraph:compare --fail-on-critical
 *   php artisan tracegraph:compare --baseline .tracegraph/baselines --candidate .tracegraph/traces
 */
final class CompareCommand extends Command
{
    /** @var string */
    protected $signature = 'tracegraph:compare
        {--baseline=   : Directory containing baseline files}
        {--candidate=  : Candidate trace file or directory}
        {--out=        : Output path for the report JSON}
        {--fail-on-critical : Exit with failure if any critical findings are open}';

    /** @var string */
    protected $description = 'Compare candidate traces against baselines and produce a findings report';

    public function handle(): int
    {
        $cwd = getcwd() ?: '.';

        // ── Try Node.js CLI ────────────────────────────────────────────────
        if ($this->nodeCliAvailable()) {
            return $this->runNodeCli($cwd);
        }

        // ── PHP fallback ───────────────────────────────────────────────────
        return $this->phpFallback($cwd);
    }

    private function nodeCliAvailable(): bool
    {
        $output = shell_exec('tracegraph --version 2>/dev/null');
        return $output !== null && str_contains($output, '0.');
    }

    private function runNodeCli(string $cwd): int
    {
        $parts = ['tracegraph compare'];

        $baseline       = $this->option('baseline');
        $candidate      = $this->option('candidate');
        $out            = $this->option('out');
        $failOnCritical = $this->option('fail-on-critical');

        if ($baseline) {
            $parts[] = '--baseline ' . escapeshellarg((string) $baseline);
        }
        if ($candidate) {
            $parts[] = '--candidate ' . escapeshellarg((string) $candidate);
        }
        if ($out) {
            $parts[] = '--out ' . escapeshellarg((string) $out);
        }
        if ($failOnCritical) {
            $parts[] = '--fail-on-critical';
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

    private function phpFallback(string $cwd): int
    {
        $tracesDir    = (string) ($this->option('candidate') ?? $cwd . '/.tracegraph/traces');
        $baselinesDir = (string) ($this->option('baseline')  ?? $cwd . '/.tracegraph/baselines');

        $traceFiles    = glob($tracesDir    . '/*.events.jsonl') ?: [];
        $baselineFiles = glob($baselinesDir . '/*.baseline.json') ?: [];

        $this->line('');
        $this->info('[TraceGraph] Compare summary (PHP fallback):');
        $this->line('');
        $this->line(sprintf('  Baselines:  %d file(s) in %s', count($baselineFiles), $baselinesDir));
        $this->line(sprintf('  Candidates: %d file(s) in %s', count($traceFiles),    $tracesDir));

        if (empty($traceFiles)) {
            $this->error('  No candidate trace files found.');
            return Command::FAILURE;
        }

        if (empty($baselineFiles)) {
            $this->warn('  No baselines found — run `php artisan tracegraph:baseline` first.');
            return Command::FAILURE;
        }

        $this->line('');
        $this->comment('Install the Node.js CLI (`npm i -g tracegraph`) for full comparison with findings.');

        return Command::SUCCESS;
    }
}
