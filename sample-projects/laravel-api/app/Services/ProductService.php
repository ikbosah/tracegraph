<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\Product;
use Tracegraph\Laravel\Tracegraph;

/**
 * ProductService — manages product catalogue.
 *
 * All public methods are wrapped in Tracegraph::trace() to produce
 * function_call events, giving TraceGraph level-2 capture.
 *
 * The checkStock() method calls Tracegraph::authCheck() to mark the
 * authorisation gate — TraceGraph raises a Critical finding if this
 * call disappears from the trace.
 */
final class ProductService
{
    /**
     * Returns all products with stock > 0.
     *
     * @return array<int, array<string, mixed>>
     */
    public function listAvailable(): array
    {
        return Tracegraph::trace('ProductService.listAvailable', function (): array {
            $products = Product::where('stock', '>', 0)->get();
            return $products->map(fn(Product $p) => $this->toArray($p))->all();
        });
    }

    /**
     * Finds a product by ID. Returns null if not found.
     *
     * @return array<string, mixed>|null
     */
    public function find(int $id): ?array
    {
        return Tracegraph::trace('ProductService.find', function () use ($id): ?array {
            $product = Product::find($id);
            return $product ? $this->toArray($product) : null;
        });
    }

    /**
     * Reserves stock for a purchase.
     *
     * The caller must be authenticated — we emit an auth_check event
     * so TraceGraph can detect if this gate is accidentally removed.
     *
     * @throws \InvalidArgumentException when stock is insufficient
     */
    public function reserveStock(int $productId, int $quantity, string $customerId): bool
    {
        return Tracegraph::trace('ProductService.reserveStock', function () use ($productId, $quantity, $customerId): bool {
            // ── Authorisation gate ────────────────────────────────────────────
            // Every protected operation must call authCheck — this is the
            // semantic anchor TraceGraph uses to detect removed auth.
            Tracegraph::authCheck('ProductPolicy.reserveStock');

            if (empty($customerId)) {
                throw new \InvalidArgumentException('Customer ID is required');
            }

            $product = Product::findOrFail($productId);

            if ($product->stock < $quantity) {
                throw new \InvalidArgumentException(
                    "Insufficient stock: requested {$quantity}, available {$product->stock}",
                );
            }

            $product->decrement('stock', $quantity);
            return true;
        });
    }

    /**
     * Creates a new product (admin only).
     *
     * @param  array{name: string, sku: string, stock: int, price: float}  $data
     * @return array<string, mixed>
     */
    public function create(array $data): array
    {
        return Tracegraph::trace('ProductService.create', function () use ($data): array {
            Tracegraph::authCheck('ProductPolicy.create');

            $product = Product::create($data);
            return $this->toArray($product);
        });
    }

    /** @return array<string, mixed> */
    private function toArray(Product $product): array
    {
        return [
            'id'    => $product->id,
            'name'  => $product->name,
            'sku'   => $product->sku,
            'stock' => $product->stock,
            'price' => $product->price,
        ];
    }
}
