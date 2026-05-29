<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Tracegraph\Laravel\EventWriter;

final class EventWriterTest extends TestCase
{
    private string $runDir = '';

    protected function setUp(): void
    {
        EventWriter::_resetForTest();
        $this->runDir = sys_get_temp_dir() . '/tracegraph-test-' . bin2hex(random_bytes(4));
        mkdir($this->runDir, 0755, true);

        // Clear env vars
        putenv('TRACEGRAPH_ENABLED');
        putenv('TRACEGRAPH_RUN_DIR');
        putenv('TRACEGRAPH_TRACE_ID');
        putenv('TRACEGRAPH_RUN_ID');
        putenv('TRACEGRAPH_SESSION_ID');
        putenv('TRACEGRAPH_ROOT_EVENT_ID');
    }

    protected function tearDown(): void
    {
        EventWriter::_resetForTest();

        // Clean up temp files
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
        putenv('TRACEGRAPH_SESSION_ID');
        putenv('TRACEGRAPH_ROOT_EVENT_ID');
    }

    public function test_returns_null_when_disabled(): void
    {
        $this->assertNull(EventWriter::getInstance());
    }

    public function test_returns_null_when_enabled_but_missing_run_dir(): void
    {
        putenv('TRACEGRAPH_ENABLED=1');
        putenv('TRACEGRAPH_TRACE_ID=trc_test');
        putenv('TRACEGRAPH_RUN_ID=run_test');

        $this->assertNull(EventWriter::getInstance());
    }

    public function test_returns_null_when_enabled_but_missing_trace_id(): void
    {
        putenv('TRACEGRAPH_ENABLED=1');
        putenv('TRACEGRAPH_RUN_DIR=' . $this->runDir);
        putenv('TRACEGRAPH_RUN_ID=run_test');

        $this->assertNull(EventWriter::getInstance());
    }

    public function test_returns_instance_when_all_required_vars_set(): void
    {
        $this->setRequiredEnvVars();
        $writer = EventWriter::getInstance();
        $this->assertInstanceOf(EventWriter::class, $writer);
    }

    public function test_returns_same_singleton_instance(): void
    {
        $this->setRequiredEnvVars();
        $a = EventWriter::getInstance();
        $b = EventWriter::getInstance();
        $this->assertSame($a, $b);
    }

    public function test_write_appends_json_line(): void
    {
        $this->setRequiredEnvVars('trc_write_test');
        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);

        $event = [
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => 'evt_test001',
            'traceId'       => 'trc_write_test',
            'type'          => 'function_call',
            'language'      => 'php',
            'name'          => 'TestService.doSomething',
            'startTime'     => 1234567890,
        ];

        $writer->write($event);

        $events = $writer->_readEventsForTest();
        $this->assertCount(1, $events);
        $this->assertSame('evt_test001', $events[0]['eventId']);
        $this->assertSame('tracegraph.event.v1', $events[0]['schemaVersion']);
        $this->assertSame('function_call', $events[0]['type']);
    }

    public function test_multiple_writes_produce_multiple_lines(): void
    {
        $this->setRequiredEnvVars('trc_multi_write');
        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);

        for ($i = 1; $i <= 3; $i++) {
            $writer->write([
                'schemaVersion' => 'tracegraph.event.v1',
                'eventId'       => "evt_00{$i}",
                'traceId'       => 'trc_multi_write',
                'type'          => 'function_call',
                'language'      => 'php',
                'name'          => "step{$i}",
                'startTime'     => 1000 + $i,
            ]);
        }

        $events = $writer->_readEventsForTest();
        $this->assertCount(3, $events);
        $this->assertSame('evt_001', $events[0]['eventId']);
        $this->assertSame('evt_002', $events[1]['eventId']);
        $this->assertSame('evt_003', $events[2]['eventId']);
    }

    public function test_get_trace_id_returns_env_value(): void
    {
        $this->setRequiredEnvVars('trc_expected_id');
        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $this->assertSame('trc_expected_id', $writer->getTraceId());
    }

    public function test_get_root_event_id_when_set(): void
    {
        $this->setRequiredEnvVars();
        putenv('TRACEGRAPH_ROOT_EVENT_ID=evt_root_123');
        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $this->assertSame('evt_root_123', $writer->getRootEventId());
    }

    public function test_get_root_event_id_is_null_when_not_set(): void
    {
        $this->setRequiredEnvVars();
        // ROOT_EVENT_ID not set
        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);
        $this->assertNull($writer->getRootEventId());
    }

    public function test_reset_clears_singleton(): void
    {
        $this->setRequiredEnvVars();
        $first = EventWriter::getInstance();
        $this->assertNotNull($first);

        EventWriter::_resetForTest();

        // After reset, a new instance is created
        $second = EventWriter::getInstance();
        $this->assertNotNull($second);
        $this->assertNotSame($first, $second);
    }

    // ─────────────────────────────────────────────────────────────────────────

    private function setRequiredEnvVars(string $traceId = 'trc_default_test'): void
    {
        putenv('TRACEGRAPH_ENABLED=1');
        putenv('TRACEGRAPH_RUN_DIR=' . $this->runDir);
        putenv("TRACEGRAPH_TRACE_ID={$traceId}");
        putenv('TRACEGRAPH_RUN_ID=run_test');
    }
}
