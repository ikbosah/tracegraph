<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Product model.
 *
 * @property int    $id
 * @property string $name
 * @property string $sku
 * @property int    $stock
 * @property float  $price
 */
class Product extends Model
{
    protected $fillable = ['name', 'sku', 'stock', 'price'];

    protected $casts = [
        'stock' => 'integer',
        'price' => 'float',
    ];
}
