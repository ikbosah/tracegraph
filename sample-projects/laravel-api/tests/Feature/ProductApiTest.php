<?php

declare(strict_types=1);

namespace Tests\Feature;

/**
 * ProductApiTest — integration tests for the product catalogue API.
 *
 * These tests verify both the HTTP behaviour and the TraceGraph events
 * emitted during each request.
 *
 * Run with: composer test
 * Run with tracing: tracegraph run -- composer test && tracegraph baseline create
 */
final class ProductApiTest extends TestCase
{
    // ── GET /products ─────────────────────────────────────────────────────────

    public function test_list_products_returns_200(): void
    {
        $this->makeProduct(['name' => 'Laptop', 'sku' => 'LAP-001', 'stock' => 10]);
        $this->makeProduct(['name' => 'Phone',  'sku' => 'PHN-001', 'stock' => 25]);

        $response = $this->getJson('/products');

        $response->assertStatus(200);
        $response->assertJsonCount(2);
    }

    public function test_list_products_excludes_out_of_stock(): void
    {
        $this->makeProduct(['stock' => 5]);
        $this->makeProduct(['stock' => 0, 'sku' => 'OOS-001']);

        $response = $this->getJson('/products');

        $response->assertStatus(200);
        $response->assertJsonCount(1);
    }

    public function test_list_products_emits_http_and_db_events(): void
    {
        $this->makeProduct();

        $this->getJson('/products');

        $httpReqs  = $this->eventsOfType('http_request');
        $dbQueries = $this->eventsOfType('db_query');
        $fnCalls   = $this->eventsOfType('function_call');

        $this->assertCount(1, $httpReqs);
        $this->assertGreaterThanOrEqual(1, count($dbQueries));
        $this->assertGreaterThanOrEqual(1, count($fnCalls));

        // DB query should be a SELECT (read)
        $select = array_values(array_filter($dbQueries, fn($e) => $e['resource']['operation'] === 'read'));
        $this->assertNotEmpty($select);
    }

    // ── GET /products/{id} ────────────────────────────────────────────────────

    public function test_show_product_returns_200(): void
    {
        $product = $this->makeProduct(['name' => 'Headphones', 'sku' => 'HP-001']);

        $response = $this->getJson("/products/{$product->id}");

        $response->assertStatus(200);
        $response->assertJsonFragment(['name' => 'Headphones', 'sku' => 'HP-001']);
    }

    public function test_show_nonexistent_product_returns_404(): void
    {
        $response = $this->getJson('/products/99999');
        $response->assertStatus(404);
    }

    // ── POST /products ────────────────────────────────────────────────────────

    public function test_create_product_returns_201(): void
    {
        $response = $this->postJson('/products', [
            'name'  => 'Tablet',
            'sku'   => 'TAB-001',
            'stock' => 100,
            'price' => 499.99,
        ]);

        $response->assertStatus(201);
        $response->assertJsonFragment(['name' => 'Tablet', 'sku' => 'TAB-001']);
    }

    public function test_create_product_emits_auth_check_event(): void
    {
        $this->postJson('/products', [
            'name'  => 'Monitor',
            'sku'   => 'MON-001',
            'stock' => 20,
            'price' => 299.00,
        ]);

        $authChecks = $this->eventsOfType('auth_check');

        // ProductService.create calls Tracegraph::authCheck('ProductPolicy.create')
        $policyCheck = array_values(
            array_filter($authChecks, fn($e) => $e['name'] === 'ProductPolicy.create'),
        );
        $this->assertCount(1, $policyCheck);
    }

    public function test_create_product_validation_returns_422(): void
    {
        $response = $this->postJson('/products', ['name' => 'Missing Fields']);
        $response->assertStatus(422);
    }

    // ── POST /products/{id}/reserve ───────────────────────────────────────────

    public function test_reserve_stock_returns_200(): void
    {
        $product = $this->makeProduct(['stock' => 50]);

        $response = $this->postJson("/products/{$product->id}/reserve", [
            'quantity'    => 5,
            'customer_id' => 'CUST-abc123',
        ]);

        $response->assertStatus(200);
        $response->assertJsonFragment(['reserved' => true]);

        $product->refresh();
        $this->assertSame(45, $product->stock);
    }

    public function test_reserve_stock_emits_auth_check_event(): void
    {
        $product = $this->makeProduct(['stock' => 50]);

        $this->postJson("/products/{$product->id}/reserve", [
            'quantity'    => 1,
            'customer_id' => 'CUST-abc',
        ]);

        // ProductService.reserveStock calls Tracegraph::authCheck('ProductPolicy.reserveStock')
        $authChecks = $this->eventsOfType('auth_check');
        $policyCheck = array_values(
            array_filter($authChecks, fn($e) => $e['name'] === 'ProductPolicy.reserveStock'),
        );
        $this->assertCount(1, $policyCheck);
    }

    public function test_reserve_insufficient_stock_returns_409(): void
    {
        $product = $this->makeProduct(['stock' => 3]);

        $response = $this->postJson("/products/{$product->id}/reserve", [
            'quantity'    => 10,
            'customer_id' => 'CUST-abc',
        ]);

        $response->assertStatus(409);
        $response->assertJsonFragment(['error' => 'Insufficient stock: requested 10, available 3']);
    }

    public function test_reserve_nonexistent_product_returns_404(): void
    {
        $response = $this->postJson('/products/99999/reserve', [
            'quantity'    => 1,
            'customer_id' => 'CUST-abc',
        ]);

        $response->assertStatus(404);
    }

    // ── Cross-cutting trace assertions ────────────────────────────────────────

    public function test_all_events_have_correct_schema_version(): void
    {
        $this->makeProduct();
        $this->getJson('/products');

        foreach ($this->readEvents() as $event) {
            $this->assertSame('tracegraph.event.v1', $event['schemaVersion'], "Event {$event['type']} has wrong schemaVersion");
        }
    }

    public function test_all_events_have_php_language(): void
    {
        $this->makeProduct();
        $this->getJson('/products');

        foreach ($this->readEvents() as $event) {
            $this->assertSame('php', $event['language'], "Event {$event['type']} has wrong language");
        }
    }

    public function test_function_call_events_are_children_of_http_request(): void
    {
        $this->makeProduct();
        $this->getJson('/products');

        $httpReqs = $this->eventsOfType('http_request');
        $this->assertCount(1, $httpReqs);
        $requestEventId = $httpReqs[0]['eventId'];

        // function_call events (ProductService.listAvailable) should descend from http_request
        $fnCalls = $this->eventsOfType('function_call');
        $this->assertNotEmpty($fnCalls);

        // At least one fn_call is a direct child of http_request
        $directChildren = array_filter($fnCalls, fn($e) => $e['parentEventId'] === $requestEventId);
        $this->assertNotEmpty($directChildren);
    }
}
