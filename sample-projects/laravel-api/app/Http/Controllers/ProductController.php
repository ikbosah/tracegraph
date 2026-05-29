<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Services\ProductService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * ProductController — REST API for the product catalogue.
 *
 * Routes:
 *   GET    /api/products              → list available
 *   GET    /api/products/{id}         → show one
 *   POST   /api/products              → create (admin)
 *   POST   /api/products/{id}/reserve → reserve stock (authenticated)
 */
final class ProductController
{
    public function __construct(private readonly ProductService $service) {}

    public function index(): JsonResponse
    {
        $products = $this->service->listAvailable();
        return response()->json($products);
    }

    public function show(int $id): JsonResponse
    {
        $product = $this->service->find($id);

        if ($product === null) {
            return response()->json(['error' => 'Product not found'], 404);
        }

        return response()->json($product);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name'  => 'required|string|max:255',
            'sku'   => 'required|string|max:64',
            'stock' => 'required|integer|min:0',
            'price' => 'required|numeric|min:0',
        ]);

        try {
            $product = $this->service->create($data);
            return response()->json($product, 201);
        } catch (\InvalidArgumentException $e) {
            return response()->json(['error' => $e->getMessage()], 403);
        }
    }

    public function reserve(Request $request, int $id): JsonResponse
    {
        $data = $request->validate([
            'quantity'    => 'required|integer|min:1',
            'customer_id' => 'required|string',
        ]);

        try {
            $this->service->reserveStock($id, $data['quantity'], $data['customer_id']);
            return response()->json(['reserved' => true, 'productId' => $id]);
        } catch (\Illuminate\Database\Eloquent\ModelNotFoundException) {
            return response()->json(['error' => 'Product not found'], 404);
        } catch (\InvalidArgumentException $e) {
            return response()->json(['error' => $e->getMessage()], 409);
        }
    }
}
