<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Console\Commands;

use Illuminate\Console\Command;

/**
 * tracegraph:report — render the latest findings report.
 *
 * Delegates to `tracegraph report` (the Node.js CLI).
 * Falls back to a plain-text listing of the latest .report.json when
 * the Node.js CLI is not available.
 *
 * Usage:
 *   php artisan tracegraph:report
 *   php artisan tracegraph:report --format markdown
 *   php artisan tracegraph:report --out docs/security-report.md
 */
final class ReportCommand extends Command
{
    /** @var string */
    protected $signature = 'tracegraph:report
        {--format=markdown : Output format: markdown | json | github-step-summary}
        {--input=          : Path to a specific .report.json file}
        {--out=            : Write rendered output to this file instead of stdout}';

    /** @var string */
    protected $description = 'Render the latest TraceGraph findings report';

    public function handle(): int
    {
        // ── Try Node.js CLI ────────────────────────────────────────────────
        if ($this->nodeCliAvailable()) {
            return $this->runNodeCli();
        }

        // ── PHP fallback ───────────────────────────────────────────────────
        return $this->phpFallback();
    }

    private function nodeCliAvailable(): bool
    {
        $output = shell_exec('tracegraph --version 2>/dev/null');
        return $output !== null && str_contains($output, '0.');
    }

    private function runNodeCli(): int
    {
        $parts  = ['tracegraph report'];
        $format = $this->option('format');
        $input  = $this->option('input');
        $out    = $this->option('out');

        if ($format) {
            $parts[] = '--format ' . escapeshellarg((string) $format);
        }
        if ($input) {
            $parts[] = '--input ' . escapeshellarg((string) $input);
        }
        if ($out) {
            $parts[] = '--out ' . escapeshellarg((string) $out);
        }

        $cmd    = implode(' ', $parts);
        $output = [];
        $exit   = 0;

        exec($cmd, $output, $exit);

        $outPath = $this->option('out');
        if (!$outPath) {
            foreach ($output as $line) {
                $this->line($line);
            }
        } else {
            $this->info('[TraceGraph] Report written to: ' . $outPath);
        }

        return $exit === 0 ? Command::SUCCESS : Command::FAILURE;
    }

    private function phpFallback(): int
    {
        $cwd        = getcwd() ?: '.';
        $reportsDir = $cwd . '/.tracegraph';

        $reportFiles = glob($reportsDir . '/**/*.report.json') ?: [];
        if (empty($reportFiles)) {
            $reportFiles = glob($reportsDir . '/*.report.json') ?: [];
        }

        if (empty($reportFiles)) {
            $this->warn('[TraceGraph] No report files found. Run `php artisan tracegraph:compare` first.');
            return Command::FAILURE;
        }

        // Use the most recent report file
        usort($reportFiles, static fn ($a, $b) => filemtime($b) - filemtime($a));
        $latestReport = $reportFiles[0];

        $raw  = file_get_contents($latestReport) ?: '{}';
        $data = json_decode($raw, true);

        if (!is_array($data)) {
            $this->error('[TraceGraph] Could not parse report file: ' . $latestReport);
            return Command::FAILURE;
        }

        $this->line('');
        $this->info('[TraceGraph] Report: ' . basename($latestReport));
        $this->line('');

        $findings = $data['findings'] ?? [];
        $open     = array_filter($findings, static fn ($f) => ($f['status'] ?? '') === 'open');

        $this->line(sprintf('  Total findings:  %d', count($findings)));
        $this->line(sprintf('  Open findings:   %d', count($open)));

        if (!empty($open)) {
            $this->line('');
            $this->warn('  Open findings:');
            foreach ($open as $finding) {
                $sev   = strtoupper($finding['severity'] ?? 'INFO');
                $title = $finding['title'] ?? 'Untitled';
                $this->line(sprintf('    [%s] %s', $sev, $title));
            }
        }

        $this->line('');
        $this->comment('Install the Node.js CLI (`npm i -g tracegraph`) for markdown/HTML report rendering.');

        return Command::SUCCESS;
    }
}
