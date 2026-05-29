<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Testing\Internal;

use PHPUnit\Event\Code\TestMethod;
use PHPUnit\Event\Test\Finished;
use PHPUnit\Event\Test\FinishedSubscriber;

/**
 * Writes one JSONL trace file per test when PHPUnit fires Test\Finished.
 *
 * File layout (all events share the same testTraceId):
 *   test_file  (parentEventId: null  — root of this trace)
 *   test_run   (parentEventId: test_file.eventId)
 *
 * @internal
 */
final class TestFinishedSubscriber implements FinishedSubscriber
{
    public function __construct(private readonly PhpUnitTestState $state) {}

    public function notify(Finished $event): void
    {
        $test        = $event->test();
        $startTimeMs = $this->state->startTimeMs ?? (int) round(microtime(true) * 1000);
        $endTimeMs   = (int) round(microtime(true) * 1000);
        $durationMs  = max(0, $endTimeMs - $startTimeMs);

        $testTraceId = 'trace_' . bin2hex(random_bytes(8));
        $fileEventId = 'evt_' . bin2hex(random_bytes(8));
        $testEventId = 'evt_' . bin2hex(random_bytes(8));

        // Extract class / method / file details when available
        $className  = null;
        $methodName = null;
        $filePath   = $test->file();

        if ($test->isTestMethod() && $test instanceof TestMethod) {
            $className  = $test->className();
            $methodName = $test->methodName();
        }

        $testName = $test->name();   // always available

        // ── test_file event ───────────────────────────────────────────────────
        $fileEvent = [
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => $fileEventId,
            'traceId'       => $testTraceId,
            'parentEventId' => null,
            'type'          => 'test_file',
            'language'      => 'php',
            'framework'     => 'phpunit',
            'name'          => $this->relativePath($filePath),
            'file'          => $this->relativePath($filePath),
            'startTime'     => $startTimeMs,
            'endTime'       => $endTimeMs,
            'durationMs'    => $durationMs,
            'metadata'      => [
                'filepath' => $filePath,
            ],
        ];

        // ── test_run event ────────────────────────────────────────────────────
        $testRunEvent = [
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => $testEventId,
            'traceId'       => $testTraceId,
            'parentEventId' => $fileEventId,
            'type'          => 'test_run',
            'language'      => 'php',
            'framework'     => 'phpunit',
            'name'          => $testName,
            'startTime'     => $startTimeMs,
            'endTime'       => $endTimeMs,
            'durationMs'    => $durationMs,
            'metadata'      => [
                'testStatus' => $this->state->status,
                'className'  => $className,
                'methodName' => $methodName,
            ],
        ];

        // Attach error payload for failed / errored tests
        if ($this->state->status === 'fail' && $this->state->errorType !== null) {
            $testRunEvent['error'] = [
                'type'    => $this->state->errorType,
                'message' => $this->state->errorMessage ?? '',
                'stack'   => $this->state->errorStack   ?? '',
            ];
        }

        $this->writeJsonl($testTraceId, [$fileEvent, $testRunEvent]);
    }

    private function writeJsonl(string $testTraceId, array $events): void
    {
        $path = $this->state->testsDir . DIRECTORY_SEPARATOR . $testTraceId . '.events.jsonl.tmp';

        try {
            $lines = array_map(
                static fn (array $e): string => json_encode($e, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                $events,
            );
            file_put_contents($path, implode("\n", $lines) . "\n");
        } catch (\Throwable) {
            // Best-effort: never let tracing errors affect the test run
        }
    }

    private function relativePath(string $absolutePath): string
    {
        $cwd = getcwd();
        if ($cwd !== false && str_starts_with($absolutePath, $cwd)) {
            $rel = substr($absolutePath, strlen($cwd));
            return ltrim(str_replace('\\', '/', $rel), '/');
        }

        return str_replace('\\', '/', $absolutePath);
    }
}
