<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\Tracegraph;

final class TracegraphTest extends TestCase
{
    private string $runDir = '';

    protected function setUp(): void
    {
        EventWriter::_resetForTest();
        Context::clear();

        $this->runDir = sys_get_temp_dir() . '/tracegraph-test-' . bin2hex(random_bytes(4));
        mkdir($this->runDir, 0755, true);

        putenv('TRACEGRAPH_ENABLED=1');
        putenv('TRACEGRAPH_RUN_DIR=' . $this->runDir);
        putenv('TRACEGRAPH_TRACE_ID=trc_tracegraph_test');
        putenv('TRACEGRAPH_RUN_ID=run_test');
        putenv('TRACEGRAPH_ROOT_EVENT_ID=evt_root');
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

    // ── Tracegraph::trace() ───────────────────────────────────────────────────

    public function test_trace_returns_callable_result(): void
    {
        $result = Tracegraph::trace('TestService.compute', fn() => 42);
        $this->assertSame(42, $result);
    }

    public function test_trace_emits_function_call_and_return_events(): void
    {
        Tracegraph::trace('TestService.doWork', fn() => 'done');

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $events = $writer->_readEventsForTest();

        // Expect: function_call + return
        $this->assertCount(2, $events);

        $callEvent = $events[0];
        $this->assertSame('function_call', $callEvent['type']);
        $this->assertSame('php', $callEvent['language']);
        $this->assertSame('TestService.doWork', $callEvent['name']);
        $this->assertSame('tracegraph.event.v1', $callEvent['schemaVersion']);
        $this->assertSame('trc_tracegraph_test', $callEvent['traceId']);
        $this->assertSame('evt_root', $callEvent['parentEventId']);

        $returnEvent = $events[1];
        $this->assertSame('return', $returnEvent['type']);
        $this->assertSame($callEvent['eventId'], $returnEvent['parentEventId']);
    }

    public function test_trace_uses_context_stack_as_parent(): void
    {
        Context::push('evt_http_request_parent');

        Tracegraph::trace('ChildService.run', fn() => null);

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $events = $writer->_readEventsForTest();

        $callEvent = $events[0];
        $this->assertSame('evt_http_request_parent', $callEvent['parentEventId']);
    }

    public function test_trace_nested_calls_produce_correct_parent_chain(): void
    {
        Tracegraph::trace('Outer.run', function () {
            Tracegraph::trace('Inner.run', fn() => 'inner');
        });

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $events = $writer->_readEventsForTest();

        // outer function_call, inner function_call, inner return, outer return = 4 events
        $this->assertCount(4, $events);

        $outerCall = $events[0];
        $innerCall = $events[1];

        $this->assertSame('Outer.run', $outerCall['name']);
        $this->assertSame('Inner.run', $innerCall['name']);
        // Inner's parent should be Outer's eventId
        $this->assertSame($outerCall['eventId'], $innerCall['parentEventId']);
    }

    public function test_trace_emits_error_event_on_exception(): void
    {
        $caughtMessage = null;
        try {
            Tracegraph::trace('FailingService.run', function () {
                throw new \RuntimeException('something went wrong');
            });
        } catch (\RuntimeException $e) {
            $caughtMessage = $e->getMessage();
        }

        $this->assertSame('something went wrong', $caughtMessage);

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $events = $writer->_readEventsForTest();

        // function_call + error (no return event on exception)
        $this->assertCount(2, $events);
        $errorEvent = $events[1];
        $this->assertSame('error', $errorEvent['type']);
        $this->assertSame('RuntimeException', $errorEvent['error']['type']);
        $this->assertSame('something went wrong', $errorEvent['error']['message']);
    }

    public function test_trace_context_is_restored_after_exception(): void
    {
        Context::push('evt_outer_parent');

        try {
            Tracegraph::trace('FailingService.run', function () {
                throw new \RuntimeException('fail');
            });
        } catch (\RuntimeException) {
            // swallow
        }

        // After exception, context stack should be back to outer_parent (not include the failed call)
        $this->assertSame('evt_outer_parent', Context::currentParentEventId());
    }

    public function test_trace_is_noop_when_disabled(): void
    {
        EventWriter::_resetForTest();
        putenv('TRACEGRAPH_ENABLED');

        $callCount = 0;
        $result = Tracegraph::trace('SomeService.run', function () use (&$callCount) {
            $callCount++;
            return 'result';
        });

        $this->assertSame('result', $result);
        $this->assertSame(1, $callCount);
        $this->assertNull(EventWriter::getInstance());
    }

    // ── Tracegraph::authCheck() ───────────────────────────────────────────────

    public function test_auth_check_emits_auth_check_event(): void
    {
        Tracegraph::authCheck('OrderPolicy.canPlace');

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $events = $writer->_readEventsForTest();

        $this->assertCount(1, $events);
        $event = $events[0];

        $this->assertSame('auth_check', $event['type']);
        $this->assertSame('php', $event['language']);
        $this->assertSame('OrderPolicy.canPlace', $event['name']);
        $this->assertSame('OrderPolicy.canPlace', $event['eventName']);
        $this->assertSame('tracegraph.event.v1', $event['schemaVersion']);
        $this->assertSame('trc_tracegraph_test', $event['traceId']);
        $this->assertSame('evt_root', $event['parentEventId']);
    }

    public function test_auth_check_uses_context_stack_as_parent(): void
    {
        Context::push('evt_request_frame');

        Tracegraph::authCheck('can:create-orders');

        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $events = $writer->_readEventsForTest();

        $this->assertSame('evt_request_frame', $events[0]['parentEventId']);
    }

    public function test_auth_check_is_noop_when_disabled(): void
    {
        EventWriter::_resetForTest();
        putenv('TRACEGRAPH_ENABLED');

        Tracegraph::authCheck('SomePolicy.check');

        $this->assertNull(EventWriter::getInstance());
    }
}
