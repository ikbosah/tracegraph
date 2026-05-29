<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Feature;

use Illuminate\Auth\Events\Attempting;
use Illuminate\Auth\Events\Authenticated;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\Listeners\AuthEventListener;

final class AuthEventListenerTest extends TestCase
{
    private AuthEventListener $listener;

    protected function setUp(): void
    {
        parent::setUp();
        $this->listener = new AuthEventListener();
    }

    // ── Attempting event ──────────────────────────────────────────────────────

    public function test_attempting_event_produces_auth_check(): void
    {
        $event = new Attempting('web', ['email' => 'user@example.com'], false);
        $this->listener->onAttempting($event);

        $checks = $this->eventsOfType('auth_check');
        $this->assertCount(1, $checks);
    }

    public function test_attempting_event_name_includes_guard(): void
    {
        $event = new Attempting('api', ['email' => 'user@example.com'], false);
        $this->listener->onAttempting($event);

        $checks = $this->eventsOfType('auth_check');
        $this->assertStringContainsString('api', $checks[0]['name']);
        $this->assertStringContainsString('attempting', $checks[0]['name']);
    }

    // ── Authenticated event ───────────────────────────────────────────────────

    public function test_authenticated_event_produces_auth_check(): void
    {
        $user  = new \stdClass();
        $event = new Authenticated('web', $user);
        $this->listener->onAuthenticated($event);

        $checks = $this->eventsOfType('auth_check');
        $this->assertCount(1, $checks);
    }

    public function test_authenticated_event_name_includes_guard(): void
    {
        $user  = new \stdClass();
        $event = new Authenticated('sanctum', $user);
        $this->listener->onAuthenticated($event);

        $checks = $this->eventsOfType('auth_check');
        $this->assertStringContainsString('sanctum', $checks[0]['name']);
        $this->assertStringContainsString('authenticated', $checks[0]['name']);
    }

    // ── Event structure ───────────────────────────────────────────────────────

    public function test_auth_check_event_has_correct_schema(): void
    {
        $event = new Attempting('web', [], false);
        $this->listener->onAttempting($event);

        $checks = $this->eventsOfType('auth_check');
        $check  = $checks[0];

        $this->assertSame('tracegraph.event.v1', $check['schemaVersion']);
        $this->assertSame('auth_check', $check['type']);
        $this->assertSame('php', $check['language']);
        $this->assertSame('laravel', $check['framework']);
        $this->assertSame($this->traceId, $check['traceId']);
        $this->assertArrayHasKey('eventId', $check);
        $this->assertArrayHasKey('startTime', $check);
        $this->assertArrayHasKey('eventName', $check);
    }

    // ── Context parent ────────────────────────────────────────────────────────

    public function test_uses_context_stack_as_parent(): void
    {
        Context::push('evt_request_frame');

        $event = new Attempting('web', [], false);
        $this->listener->onAttempting($event);

        $checks = $this->eventsOfType('auth_check');
        $this->assertSame('evt_request_frame', $checks[0]['parentEventId']);
    }

    public function test_uses_root_event_when_no_context(): void
    {
        $event = new Attempting('web', [], false);
        $this->listener->onAttempting($event);

        $checks = $this->eventsOfType('auth_check');
        $this->assertSame('evt_root_feature', $checks[0]['parentEventId']);
    }

    // ── Disabled mode ─────────────────────────────────────────────────────────

    public function test_no_event_when_disabled(): void
    {
        EventWriter::_resetForTest();
        putenv('TRACEGRAPH_ENABLED');

        $event = new Attempting('web', [], false);
        $this->listener->onAttempting($event);

        $events = $this->readWrittenEvents();
        $this->assertCount(0, $events);
    }

    // ── Both listeners together ───────────────────────────────────────────────

    public function test_attempting_then_authenticated_produces_two_auth_checks(): void
    {
        $attempting    = new Attempting('web', ['email' => 'user@example.com'], false);
        $authenticated = new Authenticated('web', new \stdClass());

        $this->listener->onAttempting($attempting);
        $this->listener->onAuthenticated($authenticated);

        $checks = $this->eventsOfType('auth_check');
        $this->assertCount(2, $checks);
    }
}
