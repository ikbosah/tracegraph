<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Listeners;

use Illuminate\Queue\Events\JobFailed;
use Illuminate\Queue\Events\JobProcessed;
use Illuminate\Queue\Events\JobProcessing;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\IdGenerator;

/**
 * QueueEventListener — captures Laravel queue lifecycle as `queue_event` TraceGraph events.
 *
 * Registered automatically by TraceServiceProvider.
 *
 * Events captured:
 *  - JobProcessing (before execution): queue_event(type=start)
 *  - JobProcessed  (after completion): queue_event(type=succeeded)
 *  - JobFailed     (on failure):       queue_event(type=failed)
 *  - Bus::dispatching (dispatch):      queue_event(type=dispatch)
 *
 * Cross-trace linkage:
 *  - dispatch events carry causedTraceId from the current trace context
 *  - start events carry causalParentRef pointing back to the dispatch event
 *
 * All queue events carry:
 *  - job.class — the fully-qualified job class name
 *  - queue     — the queue name (default, high, low, etc.)
 *  - connection — the connection name (redis, database, sync, etc.)
 */
final class QueueEventListener
{
    /**
     * Register all queue hooks.
     * Called from TraceServiceProvider::boot() when TRACEGRAPH_ENABLED=1.
     */
    public function register(): void
    {
        Event::listen(JobProcessing::class, [$this, 'onJobProcessing']);
        Event::listen(JobProcessed::class,  [$this, 'onJobProcessed']);
        Event::listen(JobFailed::class,     [$this, 'onJobFailed']);

        // Bus dispatching hook (available in Laravel 8+)
        $this->registerBusDispatchingHook();
    }

    // ── Job processing lifecycle ──────────────────────────────────────────────

    /** Before a job executes — emit queue_event(type=start). */
    public function onJobProcessing(JobProcessing $event): void
    {
        $writer = EventWriter::getInstance();
        if ($writer === null) {
            return;
        }

        $job       = $event->job;
        $jobClass  = $this->resolveJobClass($job);
        $eventId   = IdGenerator::nextId();

        // Store the event ID on the payload so onJobProcessed can find it
        $this->storeJobEventId($job, $eventId);

        $writer->write([
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => $eventId,
            'traceId'       => $writer->getTraceId(),
            'parentEventId' => Context::currentParentEventId() ?? $writer->getRootEventId(),
            'type'          => 'queue_event',
            'language'      => 'php',
            'framework'     => 'laravel',
            'name'          => "Queue::{$jobClass} start",
            'startTime'     => (int) round(microtime(true) * 1000),
            'metadata'      => [
                'queueEventType' => 'start',
                'jobClass'       => $jobClass,
                'queue'          => $job->getQueue() ?? 'default',
                'connection'     => $event->connectionName,
                'attempts'       => $job->attempts(),
            ],
        ]);
    }

    /** After a job completes successfully — emit queue_event(type=succeeded). */
    public function onJobProcessed(JobProcessed $event): void
    {
        $writer = EventWriter::getInstance();
        if ($writer === null) {
            return;
        }

        $job      = $event->job;
        $jobClass = $this->resolveJobClass($job);
        $endTime  = (int) round(microtime(true) * 1000);

        $writer->write([
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => IdGenerator::nextId(),
            'traceId'       => $writer->getTraceId(),
            'parentEventId' => $this->recallJobEventId($job)
                ?? Context::currentParentEventId()
                ?? $writer->getRootEventId(),
            'type'          => 'queue_event',
            'language'      => 'php',
            'framework'     => 'laravel',
            'name'          => "Queue::{$jobClass} succeeded",
            'startTime'     => $endTime,
            'endTime'       => $endTime,
            'metadata'      => [
                'queueEventType' => 'succeeded',
                'jobClass'       => $jobClass,
                'queue'          => $job->getQueue() ?? 'default',
                'connection'     => $event->connectionName,
            ],
        ]);
    }

    /** When a job fails — emit queue_event(type=failed) with error info. */
    public function onJobFailed(JobFailed $event): void
    {
        $writer = EventWriter::getInstance();
        if ($writer === null) {
            return;
        }

        $job      = $event->job;
        $jobClass = $this->resolveJobClass($job);
        $endTime  = (int) round(microtime(true) * 1000);
        $exception = $event->exception;

        $writer->write([
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => IdGenerator::nextId(),
            'traceId'       => $writer->getTraceId(),
            'parentEventId' => $this->recallJobEventId($job)
                ?? Context::currentParentEventId()
                ?? $writer->getRootEventId(),
            'type'          => 'queue_event',
            'language'      => 'php',
            'framework'     => 'laravel',
            'name'          => "Queue::{$jobClass} failed",
            'startTime'     => $endTime,
            'endTime'       => $endTime,
            'metadata'      => [
                'queueEventType' => 'failed',
                'jobClass'       => $jobClass,
                'queue'          => $job->getQueue() ?? 'default',
                'connection'     => $event->connectionName,
            ],
            'error'         => [
                'type'    => get_class($exception),
                'message' => $exception->getMessage(),
                'stack'   => $exception->getTraceAsString(),
            ],
        ]);
    }

    // ── Dispatch hook ─────────────────────────────────────────────────────────

    /**
     * Register the Bus dispatching hook to capture job dispatch events.
     * The causedTraceId is stored on the job payload for cross-trace linkage.
     */
    private function registerBusDispatchingHook(): void
    {
        try {
            Bus::dispatchingCallback(function (mixed $command): void {
                $writer = EventWriter::getInstance();
                if ($writer === null) {
                    return;
                }

                $jobClass = is_object($command) ? get_class($command) : (string) $command;

                $writer->write([
                    'schemaVersion' => 'tracegraph.event.v1',
                    'eventId'       => IdGenerator::nextId(),
                    'traceId'       => $writer->getTraceId(),
                    'parentEventId' => Context::currentParentEventId() ?? $writer->getRootEventId(),
                    'type'          => 'queue_event',
                    'language'      => 'php',
                    'framework'     => 'laravel',
                    'name'          => "Queue::{$this->shortClass($jobClass)} dispatch",
                    'startTime'     => (int) round(microtime(true) * 1000),
                    'metadata'      => [
                        'queueEventType' => 'dispatch',
                        'jobClass'       => $jobClass,
                        // causedTraceId enables cross-trace linkage:
                        // the job execution trace can reference this dispatch trace
                        'causedTraceId'  => $writer->getTraceId(),
                    ],
                ]);
            });
        } catch (\Throwable) {
            // dispatchingCallback not available on older Laravel versions — ignore
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Extract the job class name from the job container object. */
    private function resolveJobClass(mixed $job): string
    {
        if (!is_object($job)) {
            return (string) $job;
        }

        // Queueable jobs expose getName() or the payload json has class key
        if (method_exists($job, 'payload')) {
            try {
                $payload = $job->payload();
                if (isset($payload['displayName'])) {
                    return $payload['displayName'];
                }
                if (isset($payload['job'])) {
                    return $payload['job'];
                }
            } catch (\Throwable) {
                // Ignore
            }
        }

        return $this->shortClass(get_class($job));
    }

    private function shortClass(string $fqcn): string
    {
        $parts = explode('\\', $fqcn);
        return end($parts) ?: $fqcn;
    }

    /**
     * Stash the start-event ID onto the job object so that
     * onJobProcessed / onJobFailed can set it as parentEventId.
     */
    private function storeJobEventId(mixed $job, string $eventId): void
    {
        if (is_object($job)) {
            try {
                // @phpstan-ignore-next-line
                $job->_tracegraphStartEventId = $eventId;
            } catch (\Throwable) {
                // Read-only object — skip
            }
        }
    }

    private function recallJobEventId(mixed $job): ?string
    {
        if (is_object($job)) {
            // @phpstan-ignore-next-line
            return $job->_tracegraphStartEventId ?? null;
        }
        return null;
    }
}
