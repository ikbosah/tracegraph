<?php

declare(strict_types=1);

namespace Tracegraph\Laravel;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * TraceMiddleware — Laravel HTTP instrumentation.
 *
 * Captures every HTTP request/response pair as a pair of TraceGraph events:
 *  - `http_request`  — emitted before dispatching to the next middleware/handler
 *  - `http_response` — emitted after the response is assembled
 *
 * Register via TraceServiceProvider (automatic) or manually in app/Http/Kernel.php:
 *   protected $middleware = [
 *       \Tracegraph\Laravel\TraceMiddleware::class,
 *       // ...
 *   ];
 *
 * Must be placed BEFORE authentication/authorisation middleware so that
 * auth_check events emitted by those layers are children of the http_request event.
 */
final class TraceMiddleware
{
    public function handle(Request $request, Closure $next): Response
    {
        $writer = EventWriter::getInstance();

        if ($writer === null) {
            /** @var Response */
            return $next($request);
        }

        $requestEventId = IdGenerator::nextId();
        $startTime      = (int) round(microtime(true) * 1000);
        $rootParent     = Context::currentParentEventId() ?? $writer->getRootEventId();

        // ── http_request event ─────────────────────────────────────────────────
        $writer->write([
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => $requestEventId,
            'traceId'       => $writer->getTraceId(),
            'parentEventId' => $rootParent,
            'type'          => 'http_request',
            'language'      => 'php',
            'framework'     => 'laravel',
            'name'          => $request->method() . ' ' . $request->path(),
            'displayName'   => $request->method() . ' ' . $request->fullUrl(),
            'startTime'     => $startTime,
            'input'         => [
                'method'  => $request->method(),
                'path'    => '/' . $request->path(),
                'query'   => $request->query(),
            ],
            'metadata'      => [
                'correlationId' => $request->header('x-tracegraph-correlation-id'),
                'scenarioId'    => $request->header('x-tracegraph-scenario-id'),
                'traceparent'   => $request->header('traceparent'),
            ],
        ]);

        // ── Push request event onto the call stack ─────────────────────────────
        Context::push($requestEventId);

        $thrownError = null;

        try {
            /** @var Response $response */
            $response = $next($request);
        } catch (\Throwable $e) {
            $thrownError = $e;
            throw $e;
        } finally {
            Context::pop();

            $endTime    = (int) round(microtime(true) * 1000);
            $statusCode = isset($response) ? $response->getStatusCode() : 500;

            // ── Error event (5xx or uncaught exception) ────────────────────────
            if ($thrownError !== null || $statusCode >= 500) {
                $writer->write([
                    'schemaVersion' => 'tracegraph.event.v1',
                    'eventId'       => IdGenerator::nextId(),
                    'traceId'       => $writer->getTraceId(),
                    'parentEventId' => $requestEventId,
                    'type'          => 'error',
                    'language'      => 'php',
                    'framework'     => 'laravel',
                    'name'          => $request->method() . ' ' . $request->path() . ' → error',
                    'startTime'     => $startTime,
                    'endTime'       => $endTime,
                    'durationMs'    => $endTime - $startTime,
                    'error'         => $thrownError !== null
                        ? [
                            'type'    => get_class($thrownError),
                            'message' => $thrownError->getMessage(),
                            'stack'   => $thrownError->getTraceAsString(),
                        ]
                        : ['type' => 'HttpError', 'message' => "HTTP {$statusCode}"],
                ]);
            }

            // ── http_response event ────────────────────────────────────────────
            $writer->write([
                'schemaVersion' => 'tracegraph.event.v1',
                'eventId'       => IdGenerator::nextId(),
                'traceId'       => $writer->getTraceId(),
                'parentEventId' => $requestEventId,
                'type'          => 'http_response',
                'language'      => 'php',
                'framework'     => 'laravel',
                'name'          => $request->method() . ' ' . $request->path() . ' → ' . $statusCode,
                'displayName'   => "HTTP {$statusCode}",
                'startTime'     => $startTime,
                'endTime'       => $endTime,
                'durationMs'    => $endTime - $startTime,
                'output'        => [
                    'statusCode' => $statusCode,
                ],
            ]);
        }

        return $response;
    }
}
