<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Feature;

use Illuminate\Queue\Events\JobFailed;
use Illuminate\Queue\Events\JobProcessed;
use Illuminate\Queue\Events\JobProcessing;
use RuntimeException;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\Listeners\QueueEventListener;

/**
 * QueueEventListenerTest
 *
 * Verifies that queue job lifecycle events produce the correct
 * queue_event TraceGraph events.
 *
 * Uses a minimal stub job object instead of a real queued job
 * to avoid the full Laravel queue infrastructure.
 */
final class QueueEventListenerTest extends TestCase
{
    private QueueEventListener $listener;

    protected function setUp(): void
    {
        parent::setUp();
        $this->listener = new QueueEventListener();
    }

    // ── JobProcessing (start) ─────────────────────────────────────────────────

    public function test_job_processing_produces_queue_event(): void
    {
        $this->listener->onJobProcessing($this->makeJobProcessingEvent());

        $events = $this->eventsOfType('queue_event');
        $this->assertCount(1, $events);
    }

    public function test_job_processing_event_has_correct_schema(): void
    {
        $this->listener->onJobProcessing($this->makeJobProcessingEvent());

        $event = $this->eventsOfType('queue_event')[0];

        $this->assertSame('tracegraph.event.v1', $event['schemaVersion']);
        $this->assertSame('queue_event', $event['type']);
        $this->assertSame('php', $event['language']);
        $this->assertSame('laravel', $event['framework']);
        $this->assertSame($this->traceId, $event['traceId']);
    }

    public function test_job_processing_metadata_has_start_type(): void
    {
        $this->listener->onJobProcessing($this->makeJobProcessingEvent());

        $metadata = $this->eventsOfType('queue_event')[0]['metadata'];
        $this->assertSame('start', $metadata['queueEventType']);
    }

    public function test_job_processing_metadata_includes_queue_and_connection(): void
    {
        $this->listener->onJobProcessing($this->makeJobProcessingEvent('high', 'redis'));

        $metadata = $this->eventsOfType('queue_event')[0]['metadata'];
        $this->assertSame('high', $metadata['queue']);
        $this->assertSame('redis', $metadata['connection']);
    }

    // ── JobProcessed (succeeded) ──────────────────────────────────────────────

    public function test_job_processed_produces_succeeded_event(): void
    {
        $this->listener->onJobProcessed($this->makeJobProcessedEvent());

        $events = $this->eventsOfType('queue_event');
        $this->assertCount(1, $events);

        $this->assertSame('succeeded', $events[0]['metadata']['queueEventType']);
    }

    public function test_job_processed_event_has_correct_schema(): void
    {
        $this->listener->onJobProcessed($this->makeJobProcessedEvent());

        $event = $this->eventsOfType('queue_event')[0];
        $this->assertSame('tracegraph.event.v1', $event['schemaVersion']);
        $this->assertSame('queue_event', $event['type']);
        $this->assertSame('php', $event['language']);
    }

    // ── JobFailed ─────────────────────────────────────────────────────────────

    public function test_job_failed_produces_failed_event(): void
    {
        $this->listener->onJobFailed($this->makeJobFailedEvent());

        $events = $this->eventsOfType('queue_event');
        $this->assertCount(1, $events);
        $this->assertSame('failed', $events[0]['metadata']['queueEventType']);
    }

    public function test_failed_job_event_has_error_field(): void
    {
        $this->listener->onJobFailed($this->makeJobFailedEvent());

        $event = $this->eventsOfType('queue_event')[0];
        $this->assertArrayHasKey('error', $event);
        $this->assertSame('RuntimeException', $event['error']['type']);
        $this->assertSame('Job processing failed', $event['error']['message']);
    }

    // ── Context parent ────────────────────────────────────────────────────────

    public function test_uses_context_stack_as_parent(): void
    {
        Context::push('evt_controller_frame');

        $this->listener->onJobProcessing($this->makeJobProcessingEvent());

        $events = $this->eventsOfType('queue_event');
        $this->assertSame('evt_controller_frame', $events[0]['parentEventId']);
    }

    public function test_uses_root_event_when_no_context(): void
    {
        $this->listener->onJobProcessing($this->makeJobProcessingEvent());

        $events = $this->eventsOfType('queue_event');
        $this->assertSame('evt_root_feature', $events[0]['parentEventId']);
    }

    // ── Full lifecycle: processing → processed ────────────────────────────────

    public function test_full_lifecycle_produces_two_events(): void
    {
        $job = $this->makeStubJob();

        $this->listener->onJobProcessing(
            new JobProcessing('database', $job),
        );
        $this->listener->onJobProcessed(
            new JobProcessed('database', $job),
        );

        $events = $this->eventsOfType('queue_event');
        $this->assertCount(2, $events);

        $types = array_column(
            array_column($events, 'metadata'),
            'queueEventType',
        );
        $this->assertContains('start', $types);
        $this->assertContains('succeeded', $types);
    }

    // ── Disabled mode ─────────────────────────────────────────────────────────

    public function test_no_event_when_disabled(): void
    {
        EventWriter::_resetForTest();
        putenv('TRACEGRAPH_ENABLED');

        $this->listener->onJobProcessing($this->makeJobProcessingEvent());

        $this->assertCount(0, $this->readWrittenEvents());
    }

    // ── Stub factories ────────────────────────────────────────────────────────

    private function makeStubJob(string $queue = 'default'): object
    {
        return new class ($queue) {
            public function __construct(private string $q) {}
            public function getQueue(): string   { return $this->q; }
            public function attempts(): int      { return 1; }
            public function payload(): array     { return ['displayName' => 'StubJob']; }
        };
    }

    private function makeJobProcessingEvent(string $queue = 'default', string $connection = 'database'): JobProcessing
    {
        return new JobProcessing($connection, $this->makeStubJob($queue));
    }

    private function makeJobProcessedEvent(string $queue = 'default', string $connection = 'database'): JobProcessed
    {
        return new JobProcessed($connection, $this->makeStubJob($queue));
    }

    private function makeJobFailedEvent(): JobFailed
    {
        return new JobFailed(
            'database',
            $this->makeStubJob(),
            new RuntimeException('Job processing failed'),
        );
    }
}
