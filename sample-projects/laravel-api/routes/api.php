<?php

declare(strict_types=1);

use App\Http\Controllers\ProductController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
|
| These routes are loaded by the AppServiceProvider.
|
*/

Route::prefix('products')->group(function () {
    Route::get('/',            [ProductController::class, 'index']);
    Route::post('/',           [ProductController::class, 'store']);
    Route::get('/{id}',        [ProductController::class, 'show'])    ->where('id', '[0-9]+');
    Route::post('/{id}/reserve', [ProductController::class, 'reserve'])->where('id', '[0-9]+');
});
