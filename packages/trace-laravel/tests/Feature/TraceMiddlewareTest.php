<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Feature;

use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\TraceMiddleware;

final class TraceMiddlewareTest extends TestCase
{
    protected function defineRoutes($router): void
    {
        $router->get('/ping', fn() => response()->json(['ok' => true]));
        $router->post('/orders', fn() => response()->json(['id' => 1], 201));
        $router->get('/error-route', fn() => response()->json(['error' => 'oops'], 500));
    }

    // ── Basic event emission ──────────────────────────────────────────────────

    public function test_get_request_produces_http_request_event(): void
    {
        $this->get('/ping');

        $requests = $this->eventsOfType('http_request');
        $this->assertCount(1, $requests);

        $event = $requests[0];
        $this->assertSame('tracegraph.event.v1', $event['schemaVersion']);
        $this->assertSame('php', $event['language']);
        $this->assertSame('laravel', $event['framework']);
        $this->assertSame('GET ping', $event['name']);
        $this->assertSame($this->traceId, $event['traceId']);
        $this->assertArrayHasKey('eventId', $event);
        $this->assertArrayHasKey('startTime', $event);
    }

    public function test_get_request_produces_http_response_event(): void
    {
        $this->get('/ping');

        $responses = $this->eventsOfType('http_response');
        $this->assertCount(1, $responses);

        $event = $responses[0];
        $this->assertSame('http_response', $event['type']);
        $this->assertSame('php', $event['language']);
        $this->assertSame(200, $event['output']['statusCode']);
        $this->assertArrayHasKey('durationMs', $event);
    }

    public function test_response_event_is_child_of_request_event(): void
    {
        $this->get('/ping');

        $requests  = $this->eventsOfType('http_request');
        $responses = $this->eventsOfType('http_response');

        $this->assertCount(1, $requests);
        $this->assertCount(1, $responses);

        $this->assertSame($requests[0]['eventId'], $responses[0]['parentEventId']);
    }

    public function test_post_request_captures_method_and_path(): void
    {
        $this->postJson('/orders', ['productId' => 'P1', 'quantity' => 2]);

        $requests = $this->eventsOfType('http_request');
        $this->assertCount(1, $requests);
        $this->assertSame('POST orders', $requests[0]['name']);
    }

    public function test_captures_correct_status_code_in_response(): void
    {
        $this->postJson('/orders', []);

        $responses = $this->eventsOfType('http_response');
        $this->assertCount(1, $responses);
        $this->assertSame(201, $responses[0]['output']['statusCode']);
    }

    // ── Input capture ─────────────────────────────────────────────────────────

    public function test_request_event_captures_input_fields(): void
    {
        $this->get('/ping?foo=bar');

        $requests = $this->eventsOfType('http_request');
        $this->assertCount(1, $requests);

        $input = $requests[0]['input'];
        $this->assertSame('GET', $input['method']);
        $this->assertSame('/ping', $input['path']);
        $this->assertSame('bar', $input['query']['foo']);
    }

    // ── Error handling ────────────────────────────────────────────────────────

    public function test_5xx_response_produces_error_event(): void
    {
        $this->get('/error-route');

        $errors = $this->eventsOfType('error');
        $this->assertCount(1, $errors);

        $event = $errors[0];
        $this->assertSame('HttpError', $event['error']['type']);
        $this->assertSame('HTTP 500', $event['error']['message']);
    }

    public function test_5xx_error_event_is_child_of_request_event(): void
    {
        $this->get('/error-route');

        $requests = $this->eventsOfType('http_request');
        $errors   = $this->eventsOfType('error');

        $this->assertCount(1, $requests);
        $this->assertCount(1, $errors);
        $this->assertSame($requests[0]['eventId'], $errors[0]['parentEventId']);
    }

    // ── Disabled mode ─────────────────────────────────────────────────────────

    public function test_no_events_emitted_when_disabled(): void
    {
        EventWriter::_resetForTest();
        putenv('TRACEGRAPH_ENABLED');

        $this->get('/ping');

        $events = $this->readWrittenEvents();
        $this->assertCount(0, $events);
    }

    // ── Context stack ─────────────────────────────────────────────────────────

    public function test_context_is_clean_after_request(): void
    {
        $this->get('/ping');

        // After the middleware completes, the call stack should be empty
        $this->assertNull(Context::currentParentEventId());
    }

    // ── Direct middleware invocation ──────────────────────────────────────────

    public function test_direct_invocation_emits_events_to_writer(): void
    {
        $writer = EventWriter::getInstance();
        $this->assertNotNull($writer);

        $middleware = new TraceMiddleware();
        $request    = Request::create('/api/test', 'GET');

        $middleware->handle($request, fn($req) => new Response('ok', 200));

        $events = $writer->_readEventsForTest();
        $types  = array_column($events, 'type');

        $this->assertContains('http_request', $types);
        $this->assertContains('http_response', $types);
    }
}
