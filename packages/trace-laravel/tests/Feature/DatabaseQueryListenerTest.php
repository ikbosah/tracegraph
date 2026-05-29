<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Feature;

use Illuminate\Database\Events\QueryExecuted;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\Listeners\DatabaseQueryListener;

final class DatabaseQueryListenerTest extends TestCase
{
    private DatabaseQueryListener $listener;

    protected function setUp(): void
    {
        parent::setUp();
        $this->listener = new DatabaseQueryListener();
    }

    private function dispatchQuery(string $sql, float $timeMs = 5.0): void
    {
        $event = new QueryExecuted(
            $sql,
            [],
            $timeMs,
            $this->app['db']->connection('sqlite'),
        );
        ($this->listener)($event);
    }

    // ── SQL parsing: operation detection ─────────────────────────────────────

    public function test_select_produces_read_operation(): void
    {
        $this->dispatchQuery('SELECT * FROM orders WHERE id = ?');

        $events = $this->eventsOfType('db_query');
        $this->assertCount(1, $events);
        $this->assertSame('read', $events[0]['resource']['operation']);
    }

    public function test_insert_produces_write_operation(): void
    {
        $this->dispatchQuery('INSERT INTO orders (customer_id, total) VALUES (?, ?)');

        $events = $this->eventsOfType('db_query');
        $this->assertCount(1, $events);
        $this->assertSame('write', $events[0]['resource']['operation']);
    }

    public function test_update_produces_update_operation(): void
    {
        $this->dispatchQuery('UPDATE orders SET status = ? WHERE id = ?');

        $events = $this->eventsOfType('db_query');
        $this->assertCount(1, $events);
        $this->assertSame('update', $events[0]['resource']['operation']);
    }

    public function test_delete_produces_delete_operation(): void
    {
        $this->dispatchQuery('DELETE FROM orders WHERE id = ?');

        $events = $this->eventsOfType('db_query');
        $this->assertCount(1, $events);
        $this->assertSame('delete', $events[0]['resource']['operation']);
    }

    // ── SQL parsing: table extraction ─────────────────────────────────────────

    public function test_extracts_table_name_from_select(): void
    {
        $this->dispatchQuery('SELECT id, name FROM products WHERE stock > ?');

        $events = $this->eventsOfType('db_query');
        $this->assertSame('products', $events[0]['resource']['key']);
    }

    public function test_extracts_table_name_from_insert(): void
    {
        $this->dispatchQuery('INSERT INTO users (email, name) VALUES (?, ?)');

        $events = $this->eventsOfType('db_query');
        $this->assertSame('users', $events[0]['resource']['key']);
    }

    public function test_extracts_table_name_from_update(): void
    {
        $this->dispatchQuery('UPDATE inventory SET reserved = reserved + ? WHERE product_id = ?');

        $events = $this->eventsOfType('db_query');
        $this->assertSame('inventory', $events[0]['resource']['key']);
    }

    public function test_extracts_table_name_from_delete(): void
    {
        $this->dispatchQuery('DELETE FROM sessions WHERE expires_at < ?');

        $events = $this->eventsOfType('db_query');
        $this->assertSame('sessions', $events[0]['resource']['key']);
    }

    // ── Event structure ───────────────────────────────────────────────────────

    public function test_db_query_event_has_correct_schema(): void
    {
        $this->dispatchQuery('SELECT * FROM orders', 12.0);

        $events = $this->eventsOfType('db_query');
        $this->assertCount(1, $events);

        $event = $events[0];
        $this->assertSame('tracegraph.event.v1', $event['schemaVersion']);
        $this->assertSame('php', $event['language']);
        $this->assertSame('laravel', $event['framework']);
        $this->assertSame($this->traceId, $event['traceId']);
        $this->assertSame('database', $event['resource']['type']);
        $this->assertSame(12, $event['durationMs']);
        $this->assertArrayHasKey('eventId', $event);
        $this->assertArrayHasKey('startTime', $event);
        $this->assertArrayHasKey('endTime', $event);
    }

    public function test_event_name_format(): void
    {
        $this->dispatchQuery('SELECT * FROM products');

        $events = $this->eventsOfType('db_query');
        $this->assertSame('DB::read products', $events[0]['name']);
    }

    public function test_metadata_includes_sql_and_connection(): void
    {
        $this->dispatchQuery('SELECT id FROM orders WHERE status = ?');

        $events = $this->eventsOfType('db_query');
        $meta   = $events[0]['metadata'];

        $this->assertStringContainsString('SELECT', $meta['sql']);
        $this->assertSame('sqlite', $meta['connection']);
    }

    // ── Context parent ────────────────────────────────────────────────────────

    public function test_uses_context_stack_as_parent(): void
    {
        Context::push('evt_http_frame');

        $this->dispatchQuery('SELECT * FROM orders');

        $events = $this->eventsOfType('db_query');
        $this->assertSame('evt_http_frame', $events[0]['parentEventId']);
    }

    public function test_uses_root_event_when_no_context(): void
    {
        // Context is cleared in setUp
        $this->dispatchQuery('SELECT * FROM orders');

        $events = $this->eventsOfType('db_query');
        $this->assertSame('evt_root_feature', $events[0]['parentEventId']);
    }

    // ── Disabled mode ─────────────────────────────────────────────────────────

    public function test_no_event_when_disabled(): void
    {
        EventWriter::_resetForTest();
        putenv('TRACEGRAPH_ENABLED');

        $this->dispatchQuery('SELECT * FROM orders');

        $events = $this->eventsOfType('db_query');
        $this->assertCount(0, $events);
    }
}
