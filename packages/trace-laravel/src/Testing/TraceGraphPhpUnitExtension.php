<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Testing;

use PHPUnit\Runner\Extension\Extension;
use PHPUnit\Runner\Extension\Facade;
use PHPUnit\Runner\Extension\ParameterCollection;
use PHPUnit\TextUI\Configuration\Configuration;

/**
 * TraceGraphPhpUnitExtension — PHPUnit 10/11 extension that captures one
 * trace per test case and writes JSONL files to:
 *   {TRACEGRAPH_RUN_DIR}/tests/{traceId}.events.jsonl.tmp
 *
 * Register in phpunit.xml:
 *   <extensions>
 *     <bootstrap class="Tracegraph\Laravel\Testing\TraceGraphPhpUnitExtension"/>
 *   </extensions>
 *
 * The extension is a no-op unless TRACEGRAPH_ENABLED=1 and
 * TRACEGRAPH_RUN_DIR is set in the environment.
 */
final class TraceGraphPhpUnitExtension implements Extension
{
    public function bootstrap(
        Configuration $configuration,
        Facade $facade,
        ParameterCollection $parameters,
    ): void {
        if (getenv('TRACEGRAPH_ENABLED') !== '1') {
            return;
        }

        $runDir = getenv('TRACEGRAPH_RUN_DIR');
        if (empty($runDir)) {
            return;
        }

        $testsDir = $runDir . DIRECTORY_SEPARATOR . 'tests';
        if (!is_dir($testsDir)) {
            mkdir($testsDir, 0755, true);
        }

        // Shared mutable state passed to all subscribers.
        // PHPUnit runs tests sequentially in a single process, so no locking needed.
        $state = new Internal\PhpUnitTestState($testsDir);

        $facade->registerSubscribers(
            new Internal\TestPreparedSubscriber($state),
            new Internal\TestPassedSubscriber($state),
            new Internal\TestFailedSubscriber($state),
            new Internal\TestSkippedSubscriber($state),
            new Internal\TestFinishedSubscriber($state),
        );
    }
}
