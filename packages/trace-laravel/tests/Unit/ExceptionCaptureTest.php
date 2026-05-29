<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Unit;

use PHPUnit\Framework\TestCase;
use RuntimeException;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\Tracegraph;

/**
 * ExceptionCaptureTest — unit tests for Tracegraph::captureException()
 *
 * Tests:
 *   EC1: captureException() emits exactly one `error` event
 *   EC2: The error event contains type, message, and stack fields
 *   EC3: Vendor frames are stripped from the stack trace
 *   EC4: The error event respects the current Context call stack (parentEventId)
 *   EC5: captureException() is a no-op when TRACEGRAPH_ENABLED is not set
 */
final class ExceptionCaptureTest extends TestCase
{
    private string $runDir = '';

    protected function setUp(): void
    {
        EventWriter::_resetForTest();
        Context::clear();

        $this->runDir = sys_get_temp_dir() . '/tracegraph-exc-' . bin2hex(random_bytes(4));
        mkdir($this->runDir, 0755, true);

        putenv('TRACEGRAPH_ENABLED=1');
        putenv('TRACEGRAPH_RUN_DIR=' . $this->runDir);
        putenv('TRACEGRAPH_TRACE_ID=trc_exc_test');
        putenv('TRACEGRAPH_RUN_ID=run_exc_test');
        putenv('TRACEGRAPH_ROOT_EVENT_ID=evt_root_exc');
    }

    protected function tearDown(): void
    {
        EventWriter::_resetForTest();
        Context::clear();

        if (is_dir($this->runDir)) {
            foreach (glob($this->runDir . '/*') ?: [] as $file) {
                @unlink($file);
            }
            @rmdir($this->runDir);
        }

        putenv('TRACEGRAPH_ENABLED');
        putenv('TRACEGRAPH_RUN_DIR');
        putenv('TRACEGRAPH_TRACE_ID');
        putenv('TRACEGRAPH_RUN_ID');
        putenv('TRACEGRAPH_ROOT_EVENT_ID');
    }

    // ── EC1: emits exactly one error event ────────────────────────────────────

    public function test_EC1_captures_exactly_one_error_event(): void
    {
        $e = new RuntimeException('something went wrong');
        Tracegraph::captureException($e);

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $events = $writer->_readEventsForTest();

        $this->assertCount(1, $events);
        $this->assertSame('error', $events[0]['type']);
    }

    // ── EC2: event fields ──────────────────────────────────────────────────────

    public function test_EC2_error_event_has_correct_schema_fields(): void
    {
        $e = new RuntimeException('database connection failed');
        Tracegraph::captureException($e);

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $event  = $writer->_readEventsForTest()[0];

        $this->assertSame('tracegraph.event.v1', $event['schemaVersion']);
        $this->assertSame('error', $event['type']);
        $this->assertSame('php', $event['language']);
        $this->assertSame('laravel', $event['framework']);
        $this->assertSame('trc_exc_test', $event['traceId']);
        $this->assertArrayHasKey('eventId', $event);
        $this->assertArrayHasKey('startTime', $event);

        // Error payload
        $this->assertArrayHasKey('error', $event);
        $this->assertSame('RuntimeException', $event['error']['type']);
        $this->assertSame('database connection failed', $event['error']['message']);
        $this->assertArrayHasKey('stack', $event['error']);
        $this->assertIsString($event['error']['stack']);
    }

    // ── EC3: vendor frames are stripped ───────────────────────────────────────

    public function test_EC3_vendor_frames_are_stripped_from_stack_trace(): void
    {
        // Throw inside a call that naturally propagates through PHPUnit (vendor/).
        // The stack trace will contain vendor/ frames which should be removed.
        $e = null;
        try {
            throw new RuntimeException('test error for stack stripping');
        } catch (RuntimeException $caught) {
            $e = $caught;
        }

        $this->assertNotNull($e);

        // Normalise to forward slashes for cross-platform comparison.
        // On Windows, getTraceAsString() uses backslashes (e.g. \vendor\).
        $rawStack       = $e->getTraceAsString();
        $rawStackNormal = str_replace('\\', '/', $rawStack);

        $this->assertTrue(
            str_contains($rawStackNormal, '/vendor/'),
            'Expected raw stack to contain /vendor/ frames (PHPUnit is in vendor/)',
        );

        Tracegraph::captureException($e);

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $event = $writer->_readEventsForTest()[0];

        // The captured stack is already stripped; normalise for the assertion too
        $strippedStack = str_replace('\\', '/', $event['error']['stack']);

        $this->assertStringNotContainsString(
            '/vendor/',
            $strippedStack,
            'Captured stack trace should not contain /vendor/ frames',
        );
    }

    // ── EC4: parentEventId respects Context call stack ─────────────────────────

    public function test_EC4_error_event_is_parented_to_context_stack(): void
    {
        Context::push('evt_request_abc');

        $e = new RuntimeException('auth failed');
        Tracegraph::captureException($e);

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $event = $writer->_readEventsForTest()[0];

        $this->assertSame('evt_request_abc', $event['parentEventId']);
    }

    public function test_EC4b_error_event_falls_back_to_root_when_context_is_empty(): void
    {
        // No Context::push() — stack is empty
        $e = new RuntimeException('bare error');
        Tracegraph::captureException($e);

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $event = $writer->_readEventsForTest()[0];

        $this->assertSame('evt_root_exc', $event['parentEventId']);
    }

    // ── EC5: no-op when disabled ───────────────────────────────────────────────

    public function test_EC5_is_noop_when_tracegraph_is_disabled(): void
    {
        EventWriter::_resetForTest();
        putenv('TRACEGRAPH_ENABLED');   // unset

        $e = new RuntimeException('this should not be captured');
        Tracegraph::captureException($e);

        // No EventWriter was created, no exception thrown
        $this->assertNull(EventWriter::getInstance());
    }
}
