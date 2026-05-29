<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Console\Commands;

use Illuminate\Console\Command;

/**
 * tracegraph:install — first-time project setup for the Laravel adapter.
 *
 * What it does:
 *   1. Publishes the `tracegraph` config stub to `config/tracegraph.php`
 *      (skips if it already exists, unless --force is passed).
 *   2. Verifies that `TRACEGRAPH_ENABLED` is not hardcoded to `1` in the
 *      production `.env` — warns if it is.
 *   3. Prints a short "next steps" guide.
 *
 * Usage:
 *   php artisan tracegraph:install
 *   php artisan tracegraph:install --force   # overwrite existing config
 */
final class InstallCommand extends Command
{
    /** @var string */
    protected $signature = 'tracegraph:install {--force : Overwrite existing config file}';

    /** @var string */
    protected $description = 'Install and configure the TraceGraph Laravel adapter';

    public function handle(): int
    {
        $this->line('');
        $this->info('[TraceGraph] Installing Laravel adapter...');
        $this->line('');

        // ── 1. Publish config file ─────────────────────────────────────────
        $configDest = config_path('tracegraph.php');
        $configSrc  = __DIR__ . '/../../../../config/tracegraph.php';

        if (file_exists($configSrc)) {
            if (file_exists($configDest) && !$this->option('force')) {
                $this->line('  <comment>⚠</comment>  config/tracegraph.php already exists — skipping (use --force to overwrite)');
            } else {
                if (!is_dir(dirname($configDest))) {
                    mkdir(dirname($configDest), 0755, true);
                }
                copy($configSrc, $configDest);
                $this->line('  <info>✓</info>  Published config/tracegraph.php');
            }
        } else {
            // Write a minimal inline config if the source stub is absent
            $this->writeInlineConfig($configDest);
        }

        // ── 2. Check .env for accidental hardcoding ────────────────────────
        $this->checkDotEnv();

        // ── 3. Next steps ──────────────────────────────────────────────────
        $this->line('');
        $this->info('[TraceGraph] Installation complete. Next steps:');
        $this->line('');
        $this->line('  1. Add to your <comment>.env.testing</comment>:');
        $this->line('       TRACEGRAPH_ENABLED=1');
        $this->line('       TRACEGRAPH_RUN_DIR=.tracegraph/runs/${TRACEGRAPH_RUN_ID:-local}');
        $this->line('');
        $this->line('  2. Register the extension in <comment>phpunit.xml</comment>:');
        $this->line('       <extensions>');
        $this->line('         <bootstrap class="Tracegraph\Laravel\Testing\TraceGraphPhpUnitExtension"/>');
        $this->line('       </extensions>');
        $this->line('');
        $this->line('  3. Capture exceptions in <comment>app/Exceptions/Handler.php</comment>:');
        $this->line('       $this->reportable(function (\Throwable $e) {');
        $this->line('           \Tracegraph\Laravel\Tracegraph::captureException($e);');
        $this->line('       });');
        $this->line('');

        return Command::SUCCESS;
    }

    private function checkDotEnv(): void
    {
        $envPath = base_path('.env');

        if (!file_exists($envPath)) {
            return;
        }

        $contents = file_get_contents($envPath) ?: '';

        if (preg_match('/^TRACEGRAPH_ENABLED\s*=\s*1\s*$/m', $contents)) {
            $this->line('');
            $this->warn(
                '  ⚠  TRACEGRAPH_ENABLED=1 is set in your .env file. ' .
                'Remove it to prevent tracing in production — use .env.testing instead.',
            );
        }
    }

    private function writeInlineConfig(string $path): void
    {
        $stub = <<<'PHP'
<?php

return [
    /*
     |--------------------------------------------------------------------------
     | TraceGraph Adapter Configuration
     |--------------------------------------------------------------------------
     |
     | All settings can also be controlled via environment variables.
     | See https://tracegraph.dev/docs/laravel for full documentation.
     |
     */

    'enabled'      => env('TRACEGRAPH_ENABLED', false),
    'run_dir'      => env('TRACEGRAPH_RUN_DIR',  storage_path('tracegraph')),
    'trace_id'     => env('TRACEGRAPH_TRACE_ID'),
    'run_id'       => env('TRACEGRAPH_RUN_ID'),

    /*
     | Capture options
     */
    'capture' => [
        'http'   => true,
        'db'     => true,
        'auth'   => true,
        'gate'   => true,
        'queue'  => true,
    ],
];
PHP;

        if (!file_exists($path) || $this->option('force')) {
            if (!is_dir(dirname($path))) {
                mkdir(dirname($path), 0755, true);
            }
            file_put_contents($path, $stub . "\n");
            $this->line('  <info>✓</info>  Published config/tracegraph.php (generated inline)');
        }
    }
}
