<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Listeners;

use Illuminate\Auth\Events\Attempting;
use Illuminate\Auth\Events\Authenticated;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\IdGenerator;

/**
 * AuthEventListener — captures Laravel Auth events as `auth_check` TraceGraph events.
 *
 * Registered automatically by TraceServiceProvider.
 *
 * Listens to:
 *  - Attempting    — credentials are being checked (pre-auth gate)
 *  - Authenticated — a user was successfully authenticated (post-auth gate)
 *
 * auth_check events are Critical in baselines — if they disappear from a trace,
 * TraceGraph raises a Critical finding ("AuthorisationRemoved").
 *
 * For application-level authorisation (beyond login), call
 * Tracegraph::authCheck('PolicyName.method') explicitly in your code.
 */
final class AuthEventListener
{
    /** Called when authentication is being attempted. */
    public function onAttempting(Attempting $event): void
    {
        $this->emit("Auth.attempting:{$event->guard}");
    }

    /** Called when a user has been successfully authenticated. */
    public function onAuthenticated(Authenticated $event): void
    {
        $guard = $event->guard;
        $this->emit("Auth.authenticated:{$guard}");
    }

    // ─────────────────────────────────────────────────────────────────────────

    private function emit(string $name): void
    {
        $writer = EventWriter::getInstance();
        if ($writer === null) {
            return;
        }

        $writer->write([
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => IdGenerator::nextId(),
            'traceId'       => $writer->getTraceId(),
            'parentEventId' => Context::currentParentEventId() ?? $writer->getRootEventId(),
            'type'          => 'auth_check',
            'language'      => 'php',
            'framework'     => 'laravel',
            'name'          => $name,
            'eventName'     => $name,
            'startTime'     => (int) round(microtime(true) * 1000),
        ]);
    }
}
