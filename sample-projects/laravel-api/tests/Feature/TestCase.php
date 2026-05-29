<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Product;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Orchestra\Testbench\TestCase as OrchestraTestCase;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\TraceServiceProvider;

abstract class TestCase extends OrchestraTestCase
{
    use RefreshDatabase;

    protected string $runDir = '';

    protected function setUp(): void
    {
        $this->runDir = sys_get_temp_dir() . '/tg-laravel-api-test-' . bin2hex(random_bytes(4));
        mkdir($this->runDir, 0755, true);

        putenv('TRACEGRAPH_ENABLED=1');
        putenv('TRACEGRAPH_RUN_DIR=' . $this->runDir);
        putenv('TRACEGRAPH_TRACE_ID=trc_api_test');
        putenv('TRACEGRAPH_RUN_ID=run_api_test');
        putenv('TRACEGRAPH_ROOT_EVENT_ID=evt_root_api');

        EventWriter::_resetForTest();
        Context::clear();

        parent::setUp();
    }

    protected function tearDown(): void
    {
        parent::tearDown();

        EventWriter::_resetForTest();
        Context::clear();

        foreach (glob($this->runDir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->runDir);

        putenv('TRACEGRAPH_ENABLED');
        putenv('TRACEGRAPH_RUN_DIR');
        putenv('TRACEGRAPH_TRACE_ID');
        putenv('TRACEGRAPH_RUN_ID');
        putenv('TRACEGRAPH_ROOT_EVENT_ID');
    }

    protected function getPackageProviders($app): array
    {
        return [TraceServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        $app['config']->set('database.default', 'sqlite');
        $app['config']->set('database.connections.sqlite', [
            'driver'   => 'sqlite',
            'database' => ':memory:',
            'prefix'   => '',
        ]);
    }

    protected function defineDatabaseMigrations(): void
    {
        $this->loadMigrationsFrom(__DIR__ . '/../../database/migrations');
    }

    protected function defineRoutes($router): void
    {
        require __DIR__ . '/../../routes/api.php';
    }

    /**
     * Read all events written by this test.
     *
     * @return array<int, array<string, mixed>>
     */
    protected function readEvents(): array
    {
        $writer = EventWriter::getInstance();
        return $writer?->_readEventsForTest() ?? [];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    protected function eventsOfType(string $type): array
    {
        return array_values(
            array_filter($this->readEvents(), fn(array $e) => $e['type'] === $type),
        );
    }

    protected function makeProduct(array $attrs = []): Product
    {
        return Product::create(array_merge([
            'name'  => 'Test Widget',
            'sku'   => 'SKU-' . rand(1000, 9999),
            'stock' => 50,
            'price' => 29.99,
        ], $attrs));
    }
}
