<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Feature;

use Orchestra\Testbench\TestCase as OrchestraTestCase;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\TraceServiceProvider;

/**
 * Base class for TraceGraph feature tests.
 *
 * Sets up a minimal Laravel app via Orchestra Testbench with:
 *  - TraceServiceProvider registered
 *  - TRACEGRAPH_* env vars pointing at a temp directory
 *  - Automatic cleanup between tests
 */
abstract class TestCase extends OrchestraTestCase
{
    protected string $runDir = '';
    protected string $traceId = 'trc_feature_test';

    protected function setUp(): void
    {
        $this->runDir  = sys_get_temp_dir() . '/tracegraph-feature-' . bin2hex(random_bytes(4));
        $this->traceId = 'trc_' . bin2hex(random_bytes(4));

        mkdir($this->runDir, 0755, true);

        // Set env vars BEFORE parent setUp() calls boot() on the service provider
        putenv('TRACEGRAPH_ENABLED=1');
        putenv('TRACEGRAPH_RUN_DIR=' . $this->runDir);
        putenv("TRACEGRAPH_TRACE_ID={$this->traceId}");
        putenv('TRACEGRAPH_RUN_ID=run_feature_test');
        putenv('TRACEGRAPH_SESSION_ID=sess_feature_test');
        putenv('TRACEGRAPH_ROOT_EVENT_ID=evt_root_feature');

        EventWriter::_resetForTest();
        Context::clear();

        parent::setUp();
    }

    protected function tearDown(): void
    {
        parent::tearDown();

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
        putenv('TRACEGRAPH_SESSION_ID');
        putenv('TRACEGRAPH_ROOT_EVENT_ID');
    }

    protected function getPackageProviders($app): array
    {
        return [TraceServiceProvider::class];
    }

    /**
     * Read all events written to the current trace's JSONL file.
     *
     * @return array<int, array<string, mixed>>
     */
    protected function readWrittenEvents(): array
    {
        $writer = EventWriter::getInstance();
        if ($writer === null) {
            return [];
        }
        return $writer->_readEventsForTest();
    }

    /**
     * Filter events by type.
     *
     * @return array<int, array<string, mixed>>
     */
    protected function eventsOfType(string $type): array
    {
        return array_values(
            array_filter(
                $this->readWrittenEvents(),
                fn(array $e) => $e['type'] === $type,
            ),
        );
    }
}
