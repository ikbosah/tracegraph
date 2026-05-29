<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Console\Commands;

use Illuminate\Console\Command;

/**
 * tracegraph:open — open a trace file or report in the browser-based HTML viewer.
 *
 * When the Node.js CLI is available, delegates to:
 *   tracegraph open --html <file> [--out <output.html>] [--no-open]
 *
 * When the Node.js CLI is NOT available, prints the file path and instructs
 * the developer to install the CLI (PHP cannot generate the HTML bundle).
 *
 * Usage:
 *   php artisan tracegraph:open
 *   php artisan tracegraph:open --file .tracegraph/traces/trace_abc.trace.json
 *   php artisan tracegraph:open --out report.html --no-open
 */
final class OpenCommand extends Command
{
    /** @var string */
    protected $signature = 'tracegraph:open
        {--file=     : Path to the .trace.json or .report.json file to open}
        {--out=      : Write the HTML file to this path instead of the default}
        {--no-open   : Generate the HTML file but do not launch a browser}';

    /** @var string */
    protected $description = 'Open a trace file or report in the HTML graph viewer';

    public function handle(): int
    {
        $file = $this->resolveFile();

        if ($file === null) {
            $this->error(
                '[TraceGraph] No trace file found. ' .
                'Run `php artisan tracegraph:test` first, or pass --file <path>.',
            );
            return Command::FAILURE;
        }

        if (!file_exists($file)) {
            $this->error('[TraceGraph] File not found: ' . $file);
            return Command::FAILURE;
        }

        // ── Try Node.js CLI ────────────────────────────────────────────────
        if ($this->nodeCliAvailable()) {
            return $this->runWithNodeCli($file);
        }

        // ── PHP fallback: we cannot generate the HTML bundle ──────────────
        $this->warn('[TraceGraph] Node.js CLI (tracegraph) not found on PATH.');
        $this->line('  Install it globally:  npm install -g tracegraph');
        $this->line('  Then run:             tracegraph open --html ' . escapeshellarg($file));
        $this->line('');
        $this->line('  Trace file location: ' . realpath($file));

        return Command::FAILURE;
    }

    /**
     * Resolves which file to open.
     *
     * Priority:
     *  1. --file option provided explicitly
     *  2. Most recent .report.json in .tracegraph/reports/
     *  3. Most recent .trace.json in .tracegraph/traces/
     */
    private function resolveFile(): ?string
    {
        $explicit = $this->option('file');
        if ($explicit) {
            return (string) $explicit;
        }

        $cwd = getcwd() ?: '.';

        // Prefer the latest report
        $reports = glob($cwd . '/.tracegraph/reports/*.report.json') ?: [];
        if (!empty($reports)) {
            usort($reports, static fn (string $a, string $b): int => filemtime($b) - filemtime($a));
            return $reports[0];
        }

        // Fall back to the latest trace
        $traces = glob($cwd . '/.tracegraph/traces/*.trace.json') ?: [];
        if (!empty($traces)) {
            usort($traces, static fn (string $a, string $b): int => filemtime($b) - filemtime($a));
            return $traces[0];
        }

        return null;
    }

    private function nodeCliAvailable(): bool
    {
        $output = shell_exec('tracegraph --version 2>/dev/null');
        return $output !== null && str_contains($output, '0.');
    }

    private function runWithNodeCli(string $file): int
    {
        $parts = ['tracegraph open --html', escapeshellarg($file)];

        $out    = $this->option('out');
        $noOpen = $this->option('no-open');

        if ($out) {
            $parts[] = '--out ' . escapeshellarg((string) $out);
        }
        if ($noOpen) {
            $parts[] = '--no-open';
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
}
