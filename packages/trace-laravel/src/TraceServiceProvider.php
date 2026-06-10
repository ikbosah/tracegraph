<?php

declare(strict_types=1);

namespace Tracegraph\Laravel;

use Illuminate\Auth\Events\Attempting;
use Illuminate\Auth\Events\Authenticated;
use Illuminate\Contracts\Http\Kernel as HttpKernel;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;
use Tracegraph\Laravel\Console\Commands\BaselineCommand;
use Tracegraph\Laravel\Console\Commands\CompareCommand;
use Tracegraph\Laravel\Console\Commands\InstallCommand;
use Tracegraph\Laravel\Console\Commands\OpenCommand;
use Tracegraph\Laravel\Console\Commands\ReportCommand;
use Tracegraph\Laravel\Console\Commands\TestCommand;
use Tracegraph\Laravel\Listeners\AuthEventListener;
use Tracegraph\Laravel\Listeners\DatabaseQueryListener;
use Tracegraph\Laravel\Listeners\GateEventListener;
use Tracegraph\Laravel\Listeners\QueueEventListener;

/**
 * TraceServiceProvider — auto-registers all TraceGraph instrumentation hooks.
 *
 * Auto-discovered via composer.json's extra.laravel.providers — no manual
 * registration required.
 *
 * What it hooks:
 *  1. TraceMiddleware — global HTTP middleware (http_request / http_response)
 *  2. DB::listen     — every SQL query (db_query)
 *  3. Auth events    — Attempting + Authenticated (auth_check)
 *
 * All hooks are no-ops when TRACEGRAPH_ENABLED != '1'.
 */
final class TraceServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // No bindings required — all configuration is via env vars
    }

    public function boot(): void
    {
        // Artisan commands are always registered (regardless of TRACEGRAPH_ENABLED)
        // so developers can run them without needing tracing active.
        if ($this->app->runningInConsole()) {
            $this->commands([
                InstallCommand::class,
                TestCommand::class,
                BaselineCommand::class,
                CompareCommand::class,
                ReportCommand::class,
                OpenCommand::class,
            ]);
        }

        if (getenv('TRACEGRAPH_ENABLED') !== '1') {
            return;
        }

        $this->registerMiddleware();
        $this->registerDatabaseListener();
        $this->registerAuthListeners();
        $this->registerGateListener();
        $this->registerQueueListener();
    }

    // ── Middleware ────────────────────────────────────────────────────────────

    private function registerMiddleware(): void
    {
        // Prepend so TraceMiddleware wraps all other middleware,
        // giving the widest possible http_request scope.
        if ($this->app->bound(HttpKernel::class)) {
            /** @var \Illuminate\Foundation\Http\Kernel $kernel */
            $kernel = $this->app->make(HttpKernel::class);
            if (method_exists($kernel, 'prependMiddleware')) {
                $kernel->prependMiddleware(TraceMiddleware::class);
            }
        }
    }

    // ── Database ──────────────────────────────────────────────────────────────

    private function registerDatabaseListener(): void
    {
        // Wrap in a try/catch — DB facade may not be available in all contexts
        try {
            $listener = new DatabaseQueryListener();
            DB::listen(static function (QueryExecuted $event) use ($listener): void {
                $listener($event);
            });
        } catch (\Throwable) {
            // Best-effort
        }
    }

    // ── Auth ──────────────────────────────────────────────────────────────────

    private function registerAuthListeners(): void
    {
        $listener = new AuthEventListener();

        Event::listen(Attempting::class, [$listener, 'onAttempting']);
        Event::listen(Authenticated::class, [$listener, 'onAuthenticated']);
    }

    // ── Gate / Policy ─────────────────────────────────────────────────────────

    private function registerGateListener(): void
    {
        try {
            $gateListener = new GateEventListener();
            // Laravel 10+ Gate::after() may pass an Illuminate\Auth\Access\Response
            // object as $result instead of a plain bool.  Use mixed so the closure
            // does not throw a TypeError; GateEventListener::handle() normalises it.
            Gate::after(static function (mixed $user, string $ability, mixed $result, mixed $arguments) use ($gateListener): void {
                $gateListener->handle($user, $ability, $result, is_array($arguments) ? $arguments : [$arguments]);
            });
        } catch (\Throwable) {
            // Best-effort — Gate facade may not be available in all contexts
        }
    }

    // ── Queue ─────────────────────────────────────────────────────────────────

    private function registerQueueListener(): void
    {
        try {
            $queueListener = new QueueEventListener();
            $queueListener->register();
        } catch (\Throwable) {
            // Best-effort — Queue facade may not be available in all contexts
        }
    }
}
