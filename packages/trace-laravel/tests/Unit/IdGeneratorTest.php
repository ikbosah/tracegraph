<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Tracegraph\Laravel\IdGenerator;

final class IdGeneratorTest extends TestCase
{
    public function test_id_starts_with_evt_prefix(): void
    {
        $id = IdGenerator::nextId();
        $this->assertStringStartsWith('evt_', $id);
    }

    public function test_id_has_correct_length(): void
    {
        // "evt_" (4) + 16 hex chars (8 bytes) = 20 chars total
        $id = IdGenerator::nextId();
        $this->assertSame(20, strlen($id));
    }

    public function test_hex_suffix_is_valid_lowercase_hex(): void
    {
        $id  = IdGenerator::nextId();
        $hex = substr($id, 4);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{16}$/', $hex);
    }

    public function test_ids_are_unique(): void
    {
        $ids = [];
        for ($i = 0; $i < 100; $i++) {
            $ids[] = IdGenerator::nextId();
        }
        $this->assertSame(100, count(array_unique($ids)));
    }
}
