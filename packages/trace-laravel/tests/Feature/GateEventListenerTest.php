<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Feature;

use Illuminate\Support\Facades\Gate;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\Listeners\GateEventListener;

/**
 * GateEventListenerTest
 *
 * Verifies that Gate::after hook produces correct authorization_check events
 * including policy class inference from model arguments.
 *
 * Tests use GateEventListener::handle() directly and also via Gate::allows()
 * to verify integration through the service provider.
 */
final class GateEventListenerTest extends TestCase
{
    private GateEventListener $listener;

    protected function setUp(): void
    {
        parent::setUp();
        $this->listener = new GateEventListener();
    }

    // ── Basic authorization_check event ───────────────────────────────────────

    public function test_gate_check_produces_authorization_check_event(): void
    {
        $this->listener->handle(null, 'update', true, []);

        $events = $this->eventsOfType('authorization_check');
        $this->assertCount(1, $events);
    }

    public function test_authorization_check_event_has_correct_schema(): void
    {
        $this->listener->handle(null, 'delete', false, []);

        $events = $this->eventsOfType('authorization_check');
        $event  = $events[0];

        $this->assertSame('tracegraph.event.v1', $event['schemaVersion']);
        $this->assertSame('authorization_check', $event['type']);
        $this->assertSame('php', $event['language']);
        $this->assertSame('laravel', $event['framework']);
        $this->assertSame($this->traceId, $event['traceId']);
        $this->assertArrayHasKey('eventId', $event);
        $this->assertArrayHasKey('startTime', $event);
    }

    // ── Ability and result in metadata ────────────────────────────────────────

    public function test_metadata_contains_ability_and_result(): void
    {
        $this->listener->handle(null, 'update', true, []);

        $events   = $this->eventsOfType('authorization_check');
        $metadata = $events[0]['metadata'];

        $this->assertSame('update', $metadata['ability']);
        $this->assertTrue($metadata['result']);
    }

    public function test_denied_gate_result_stored_in_metadata(): void
    {
        $this->listener->handle(null, 'view', false, []);

        $metadata = $this->eventsOfType('authorization_check')[0]['metadata'];
        $this->assertFalse($metadata['result']);
    }

    public function test_security_critical_flag_is_set(): void
    {
        $this->listener->handle(null, 'update', true, []);

        $metadata = $this->eventsOfType('authorization_check')[0]['metadata'];
        $this->assertTrue($metadata['security.critical']);
    }

    // ── User ID extraction ────────────────────────────────────────────────────

    public function test_user_id_extracted_from_authenticatable(): void
    {
        $user = new class {
            public function getAuthIdentifier(): int { return 42; }
        };

        $this->listener->handle($user, 'update', true, []);

        $metadata = $this->eventsOfType('authorization_check')[0]['metadata'];
        $this->assertSame(42, $metadata['userId']);
    }

    public function test_null_user_stored_as_null_user_id(): void
    {
        $this->listener->handle(null, 'create', true, []);

        $metadata = $this->eventsOfType('authorization_check')[0]['metadata'];
        $this->assertNull($metadata['userId']);
    }

    // ── Policy class inference ────────────────────────────────────────────────

    public function test_no_model_argument_produces_fallback_name(): void
    {
        $this->listener->handle(null, 'admin', true, []);

        $events = $this->eventsOfType('authorization_check');
        // Without a model argument there is no policy to infer — name should
        // fall back to the ability name prefixed with "Gate::"
        $this->assertStringContainsString('admin', $events[0]['name']);
    }

    public function test_model_argument_produces_policy_display_name(): void
    {
        // Define a model class and its policy at runtime so no real app needed
        if (!class_exists('App\\Models\\Invoice')) {
            eval('namespace App\\Models; class Invoice {}');
        }
        if (!class_exists('App\\Policies\\InvoicePolicy')) {
            eval('namespace App\\Policies; class InvoicePolicy {}');
        }

        $model = new \App\Models\Invoice();
        $this->listener->handle(null, 'update', true, [$model]);

        $events      = $this->eventsOfType('authorization_check');
        $displayName = $events[0]['displayName'] ?? null;

        // Should infer InvoicePolicy::update
        $this->assertSame('InvoicePolicy::update', $displayName);
        $this->assertStringContainsString('InvoicePolicy::update', $events[0]['name']);
    }

    public function test_display_name_is_null_without_model_argument(): void
    {
        $this->listener->handle(null, 'view-reports', true, []);

        $events = $this->eventsOfType('authorization_check');
        $this->assertNull($events[0]['displayName']);
    }

    // ── Context parent ────────────────────────────────────────────────────────

    public function test_uses_context_stack_as_parent(): void
    {
        Context::push('evt_request_for_gate');

        $this->listener->handle(null, 'update', true, []);

        $events = $this->eventsOfType('authorization_check');
        $this->assertSame('evt_request_for_gate', $events[0]['parentEventId']);
    }

    public function test_uses_root_event_when_no_context(): void
    {
        $this->listener->handle(null, 'update', true, []);

        $events = $this->eventsOfType('authorization_check');
        $this->assertSame('evt_root_feature', $events[0]['parentEventId']);
    }

    // ── Disabled mode ─────────────────────────────────────────────────────────

    public function test_no_event_when_disabled(): void
    {
        EventWriter::_resetForTest();
        putenv('TRACEGRAPH_ENABLED');

        $this->listener->handle(null, 'update', true, []);

        $this->assertCount(0, $this->readWrittenEvents());
    }

    // ── ServiceProvider integration ───────────────────────────────────────────

    public function test_gate_after_hook_fires_through_service_provider(): void
    {
        // Register a simple ability
        Gate::define('test-ability', fn () => true);

        // Evaluate it — should trigger the after hook registered by TraceServiceProvider
        Gate::allows('test-ability');

        // The Gate::after hook should have fired and written an authorization_check
        $events = $this->eventsOfType('authorization_check');
        $this->assertGreaterThanOrEqual(1, count($events));

        $found = false;
        foreach ($events as $event) {
            if (($event['metadata']['ability'] ?? '') === 'test-ability') {
                $found = true;
                break;
            }
        }
        $this->assertTrue($found, 'authorization_check event for test-ability not found');
    }
}
