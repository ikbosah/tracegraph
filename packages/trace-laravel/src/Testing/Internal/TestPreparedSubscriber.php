<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Testing\Internal;

use PHPUnit\Event\Test\Prepared;
use PHPUnit\Event\Test\PreparedSubscriber;

/**
 * Records the test start time when PHPUnit fires Test\Prepared.
 *
 * Phase 2 invasive: when TRACEGRAPH_INVASIVE >= 2, also ensures the
 * TraceServiceProvider is registered in the currently-running Laravel
 * application so that application events (http_request, db_query, auth_check)
 * are captured during test execution.  This fires BEFORE the test method runs,
 * so the middleware and listeners are in place for any $this->get() / post()
 * calls the test makes.
 *
 * @internal
 */
final class TestPreparedSubscriber implements PreparedSubscriber
{
    public function __construct(private readonly PhpUnitTestState $state) {}

    public function notify(Prepared $event): void
    {
        $this->state->reset();
        $this->state->startTimeMs = (int) round(microtime(true) * 1000);

        // Phase 2: register the service provider so application hooks fire during tests.
        // The provider is idempotent — calling register() on an already-loaded provider
        // returns the existing instance without double-booting.
        if (((int) (getenv('TRACEGRAPH_INVASIVE') ?: '0')) >= 2) {
            $this->tryRegisterServiceProvider();
        }
    }

    /**
     * Register TraceServiceProvider into the active Laravel application (if any).
     *
     * Called before every test method so that each test's fresh Application
     * instance (created by setUp() / createApplication()) has the provider
     * registered and booted.
     *
     * Safe when Laravel is not being used: all access is guarded by function_exists
     * and instanceof checks, and everything is wrapped in a catch-all try/catch.
     */
    private function tryRegisterServiceProvider(): void
    {
        // app() helper is only present in Laravel projects.
        if (!function_exists('app')) {
            return;
        }

        try {
            /** @var mixed $app */
            $app = app();

            // Only proceed if this is a full Illuminate Application instance.
            if (!($app instanceof \Illuminate\Foundation\Application)) {
                return;
            }

            // register() is idempotent — if the provider is already loaded it
            // returns the existing instance without calling boot() again.
            $app->register(\Tracegraph\Laravel\TraceServiceProvider::class);
        } catch (\Throwable) {
            // Best-effort: never let instrumentation errors affect the test run.
        }
    }
}
