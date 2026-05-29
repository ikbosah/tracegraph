<?php

declare(strict_types=1);

namespace Tracegraph\Laravel;

/**
 * Tracegraph — public API for manual PHP instrumentation.
 *
 * Usage:
 *   use Tracegraph\Laravel\Tracegraph;
 *
 *   $result = Tracegraph::trace('OrderService.create', fn() => $this->create($dto));
 *
 *   Tracegraph::authCheck('OrderPolicy.canPlace');
 *
 * When TRACEGRAPH_ENABLED is not set, all methods are no-ops with zero overhead.
 */
final class Tracegraph
{
    private function __construct() {}

    /**
     * Wraps a callable and emits a `function_call` event capturing its
     * execution time and any thrown exception.
     *
     * @template T
     * @param  callable(): T  $fn
     * @return T
     *
     * @throws \Throwable  Re-throws any exception from $fn after recording the error event.
     */
    public static function trace(string $name, callable $fn): mixed
    {
        $writer = EventWriter::getInstance();
        if ($writer === null) {
            return $fn();
        }

        $writer->markManualTrace();

        $eventId    = IdGenerator::nextId();
        $startTime  = (int) round(microtime(true) * 1000);
        $parentId   = Context::currentParentEventId();

        $writer->write([
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => $eventId,
            'traceId'       => $writer->getTraceId(),
            'parentEventId' => $parentId ?? $writer->getRootEventId(),
            'type'          => 'function_call',
            'language'      => 'php',
            'name'          => $name,
            'startTime'     => $startTime,
        ]);

        Context::push($eventId);

        try {
            $result  = $fn();
            $endTime = (int) round(microtime(true) * 1000);

            $writer->write([
                'schemaVersion' => 'tracegraph.event.v1',
                'eventId'       => IdGenerator::nextId(),
                'traceId'       => $writer->getTraceId(),
                'parentEventId' => $eventId,
                'type'          => 'return',
                'language'      => 'php',
                'name'          => $name . ' → return',
                'startTime'     => $startTime,
                'endTime'       => $endTime,
                'durationMs'    => $endTime - $startTime,
            ]);

            return $result;
        } catch (\Throwable $e) {
            $endTime = (int) round(microtime(true) * 1000);

            $writer->write([
                'schemaVersion' => 'tracegraph.event.v1',
                'eventId'       => IdGenerator::nextId(),
                'traceId'       => $writer->getTraceId(),
                'parentEventId' => $eventId,
                'type'          => 'error',
                'language'      => 'php',
                'name'          => $name . ' → error',
                'startTime'     => $startTime,
                'endTime'       => $endTime,
                'durationMs'    => $endTime - $startTime,
                'error'         => [
                    'type'    => get_class($e),
                    'message' => $e->getMessage(),
                    'stack'   => $e->getTraceAsString(),
                ],
            ]);

            throw $e;
        } finally {
            Context::pop();
        }
    }

    /**
     * Captures a `\Throwable` as a TraceGraph `error` event.
     *
     * Use this in your Laravel exception handler to record unhandled or
     * partially-handled exceptions in the trace without interrupting the
     * normal exception-handling pipeline.
     *
     * @example
     *   // app/Exceptions/Handler.php
     *   public function register(): void
     *   {
     *       $this->reportable(function (\Throwable $e): void {
     *           Tracegraph::captureException($e);
     *       });
     *   }
     *
     * Vendor framework frames (lines containing `/vendor/`) are stripped from
     * the stack trace to reduce noise and expose application-level frames.
     *
     * No-op when TRACEGRAPH_ENABLED is not set.
     */
    public static function captureException(\Throwable $e): void
    {
        $writer = EventWriter::getInstance();
        if ($writer === null) {
            return;
        }

        $writer->write([
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => IdGenerator::nextId(),
            'traceId'       => $writer->getTraceId(),
            'parentEventId' => Context::currentParentEventId() ?? $writer->getRootEventId(),
            'type'          => 'error',
            'language'      => 'php',
            'framework'     => 'laravel',
            'name'          => get_class($e) . ': ' . $e->getMessage(),
            'startTime'     => (int) round(microtime(true) * 1000),
            'error'         => [
                'type'    => get_class($e),
                'message' => $e->getMessage(),
                'stack'   => self::stripVendorFrames($e->getTraceAsString()),
            ],
        ]);
    }

    /**
     * Emits an `auth_check` event.
     *
     * Call this at every authorisation gate in your application — it's the
     * semantic anchor that TraceGraph uses to detect removed authorisation
     * checks (Critical finding).
     *
     * @example
     *   Tracegraph::authCheck('OrderPolicy.canPlace');
     *   // or
     *   Tracegraph::authCheck('can:manage-orders');
     */
    public static function authCheck(string $name): void
    {
        $writer = EventWriter::getInstance();
        if ($writer === null) {
            return;
        }

        $writer->write([
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => IdGenerator::nextId(),
            'traceId'       => $writer->getTraceId(),
            'parentEventId' => Context::currentParentEventId() ?? $writer->getRootEventId(),
            'type'          => 'auth_check',
            'language'      => 'php',
            'name'          => $name,
            'eventName'     => $name,
            'startTime'     => (int) round(microtime(true) * 1000),
        ]);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Strips vendor framework frames from a PHP stack trace string.
     *
     * Each line in `getTraceAsString()` output looks like:
     *   #N /path/to/file.php(line): ClassName->method()
     *
     * Lines whose file path contains `/vendor/` are dropped. The trailing
     * `{main}` sentinel (no file path) is always kept.
     */
    private static function stripVendorFrames(string $stack): string
    {
        $lines    = explode("\n", $stack);
        $filtered = array_filter(
            $lines,
            static function (string $line): bool {
                // Normalise to forward slashes so the check works on Windows too
                $normalised   = str_replace('\\', '/', $line);
                $isVendorFrame = str_contains($normalised, '/vendor/');
                return !$isVendorFrame || trim($line) === '{main}';
            },
        );
        return implode("\n", array_values($filtered));
    }
}
