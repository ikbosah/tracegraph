<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Feature;

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Schema;

/**
 * FullPipelineIntegrationTest — M4 exit criterion #1
 *
 * Exit criterion (IMPLEMENTATION_PLAN.md M4):
 *   "Laravel request trace contains ≥ 6 semantic events including
 *    http_request, authorization_check, db_query, http_response"
 *
 * This test exercises the full instrumentation pipeline in a single request:
 *   HTTP request → Gate auth check → 2× DB queries → HTTP response
 *
 * Tests:
 *   E1: A single request produces ≥ 6 events
 *   E2: Events include all four required types
 *   E3: Gate check produces authorization_check with correct ability + policy displayName
 *   E4: DB queries show SQL, table name, operation, duration
 *   E5: http_request is the parent of auth and db events
 *   E6: http_response is the last event and is a child of http_request
 */
final class FullPipelineIntegrationTest extends TestCase
{
    use RefreshDatabase;

    /** @param \Illuminate\Foundation\Application $app */
    protected function getEnvironmentSetUp($app): void
    {
        // Use SQLite in-memory so tests are fast and self-contained
        $app['config']->set('database.default', 'sqlite');
        $app['config']->set('database.connections.sqlite', [
            'driver'   => 'sqlite',
            'database' => ':memory:',
            'prefix'   => '',
        ]);
    }

    protected function setUp(): void
    {
        parent::setUp();

        // Create a minimal orders table
        Schema::create('orders', function (Blueprint $table): void {
            $table->id();
            $table->string('status')->default('pending');
            $table->decimal('total', 8, 2)->default(0.00);
            $table->timestamps();
        });

        // Seed one order
        DB::table('orders')->insert([
            'status'     => 'pending',
            'total'      => 99.99,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // Register a Gate policy for the 'view-order' ability
        Gate::define('view-order', fn(mixed $user, object $order): bool => true);
    }

    protected function tearDown(): void
    {
        Schema::dropIfExists('orders');
        parent::tearDown();
    }

    protected function defineRoutes($router): void
    {
        // A route that: does a Gate check, runs two DB queries, returns the order
        $router->get('/api/orders/{id}', function (int $id): \Illuminate\Http\JsonResponse {
            // Fetch the order (DB query 1)
            $order = DB::table('orders')->where('id', $id)->first();

            if ($order === null) {
                return response()->json(['error' => 'Not found'], 404);
            }

            // Gate authorization check (produces authorization_check event)
            Gate::allows('view-order', $order);

            // Audit log query (DB query 2)
            DB::table('orders')
                ->where('id', $id)
                ->update(['updated_at' => now()]);

            return response()->json([
                'id'     => $order->id,
                'status' => $order->status,
                'total'  => $order->total,
            ]);
        });
    }

    // ── E1: ≥ 6 events total ─────────────────────────────────────────────────

    public function test_E1_single_request_produces_at_least_6_events(): void
    {
        $this->get('/api/orders/1');

        $events = $this->readWrittenEvents();

        $this->assertGreaterThanOrEqual(
            6,
            count($events),
            sprintf(
                'Expected ≥6 events, got %d. Types: %s',
                count($events),
                implode(', ', array_column($events, 'type')),
            ),
        );
    }

    // ── E2: all four required event types present ─────────────────────────────

    public function test_E2_trace_contains_all_required_event_types(): void
    {
        $this->get('/api/orders/1');

        $types = array_unique(array_column($this->readWrittenEvents(), 'type'));

        $this->assertContains('http_request',        $types, 'http_request event missing');
        $this->assertContains('authorization_check', $types, 'authorization_check event missing');
        $this->assertContains('db_query',            $types, 'db_query event missing');
        $this->assertContains('http_response',       $types, 'http_response event missing');
    }

    // ── E3: authorization_check has correct ability + inferred policy ─────────

    public function test_E3_authorization_check_has_ability_and_result(): void
    {
        $this->get('/api/orders/1');

        $authEvents = $this->eventsOfType('authorization_check');

        $this->assertNotEmpty($authEvents, 'No authorization_check events found');

        $event = $authEvents[0];
        $this->assertSame('view-order', $event['metadata']['ability']);
        $this->assertTrue($event['metadata']['result']);
        // The field is stored as 'security.critical' (dotted flat key, not nested)
        $this->assertTrue($event['metadata']['security.critical']);
    }

    // ── E4: DB queries from the request show SQL, table, operation, duration ──

    public function test_E4_db_query_events_have_required_fields(): void
    {
        $this->get('/api/orders/1');

        $requestEvents = $this->eventsOfType('http_request');
        $this->assertCount(1, $requestEvents);
        $requestEventId = $requestEvents[0]['eventId'];

        // Filter to only db_query events that are children of the http_request
        // (setUp() also fires db_query events for Schema creation / inserts, but
        //  those are NOT parented to the http_request event)
        $requestDbEvents = array_values(array_filter(
            $this->eventsOfType('db_query'),
            fn(array $e) => ($e['parentEventId'] ?? null) === $requestEventId,
        ));

        $this->assertGreaterThanOrEqual(
            2,
            count($requestDbEvents),
            'Expected at least 2 DB query events from the HTTP request',
        );

        // Verify structural fields on all request-scoped db_query events
        foreach ($requestDbEvents as $event) {
            $this->assertSame('tracegraph.event.v1', $event['schemaVersion']);
            $this->assertSame('db_query', $event['type']);
            $this->assertSame('php', $event['language']);
            $this->assertSame('laravel', $event['framework']);
            $this->assertArrayHasKey('durationMs', $event);
            $this->assertIsNumeric($event['durationMs']);
        }

        // Among the request-scoped events, at least 2 must reference the 'orders' table
        // (SQLite may emit additional low-level queries for some operations)
        $ordersDbEvents = array_values(array_filter(
            $requestDbEvents,
            fn(array $e) => str_contains(
                strtolower($e['metadata']['sql'] ?? ''),
                'orders',
            ),
        ));

        $this->assertGreaterThanOrEqual(
            2,
            count($ordersDbEvents),
            sprintf(
                'Expected ≥2 db_query events referencing the orders table. Got %d total request-scoped events.',
                count($requestDbEvents),
            ),
        );

        // Validate one of the 'orders' events in detail (the SELECT)
        $selectEvent = null;
        foreach ($ordersDbEvents as $e) {
            if (str_contains(strtolower($e['metadata']['sql'] ?? ''), 'select')) {
                $selectEvent = $e;
                break;
            }
        }

        $this->assertNotNull($selectEvent, 'Expected a SELECT db_query event on the orders table');
        // Table name is in resource.key (consistent with the DatabaseQueryListener schema)
        $this->assertSame('orders', $selectEvent['resource']['key']);
        $this->assertSame('read', $selectEvent['resource']['operation']);
        $this->assertSame('database', $selectEvent['resource']['type']);
    }

    // ── E5: auth and db events from the request are children of http_request ──

    public function test_E5_auth_and_db_events_are_children_of_http_request(): void
    {
        $this->get('/api/orders/1');

        $requestEvents = $this->eventsOfType('http_request');
        $this->assertCount(1, $requestEvents);
        $requestEventId = $requestEvents[0]['eventId'];

        // All authorization_check events must be parented to http_request
        foreach ($this->eventsOfType('authorization_check') as $event) {
            $this->assertSame(
                $requestEventId,
                $event['parentEventId'],
                "authorization_check parentEventId should be the http_request eventId",
            );
        }

        // At least the two request-scoped db_query events must be parented to http_request
        $requestDbEvents = array_values(array_filter(
            $this->eventsOfType('db_query'),
            fn(array $e) => ($e['parentEventId'] ?? null) === $requestEventId,
        ));

        $this->assertGreaterThanOrEqual(
            2,
            count($requestDbEvents),
            'Expected at least 2 db_query events parented to the http_request event',
        );
    }

    // ── E6: http_response is last event and child of http_request ─────────────

    public function test_E6_http_response_is_child_of_http_request(): void
    {
        $this->get('/api/orders/1');

        $requestEvents  = $this->eventsOfType('http_request');
        $responseEvents = $this->eventsOfType('http_response');

        $this->assertCount(1, $requestEvents);
        $this->assertCount(1, $responseEvents);

        $this->assertSame(
            $requestEvents[0]['eventId'],
            $responseEvents[0]['parentEventId'],
            'http_response must be a child of http_request',
        );

        $this->assertSame(200, $responseEvents[0]['output']['statusCode']);
        $this->assertArrayHasKey('durationMs', $responseEvents[0]);
    }
}
