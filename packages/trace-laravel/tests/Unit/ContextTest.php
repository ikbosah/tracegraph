<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Tracegraph\Laravel\Context;

final class ContextTest extends TestCase
{
    protected function setUp(): void
    {
        Context::clear();
    }

    protected function tearDown(): void
    {
        Context::clear();
    }

    public function test_initial_state_returns_null(): void
    {
        $this->assertNull(Context::currentParentEventId());
    }

    public function test_push_makes_id_current(): void
    {
        Context::push('evt_aabbccdd11223344');
        $this->assertSame('evt_aabbccdd11223344', Context::currentParentEventId());
    }

    public function test_pop_removes_current_id(): void
    {
        Context::push('evt_aabbccdd11223344');
        Context::pop();
        $this->assertNull(Context::currentParentEventId());
    }

    public function test_nested_push_maintains_stack_order(): void
    {
        Context::push('evt_level1');
        Context::push('evt_level2');
        Context::push('evt_level3');

        $this->assertSame('evt_level3', Context::currentParentEventId());

        Context::pop();
        $this->assertSame('evt_level2', Context::currentParentEventId());

        Context::pop();
        $this->assertSame('evt_level1', Context::currentParentEventId());

        Context::pop();
        $this->assertNull(Context::currentParentEventId());
    }

    public function test_clear_empties_entire_stack(): void
    {
        Context::push('evt_a');
        Context::push('evt_b');
        Context::push('evt_c');

        Context::clear();

        $this->assertNull(Context::currentParentEventId());
    }

    public function test_pop_on_empty_stack_is_safe(): void
    {
        // Should not throw
        Context::pop();
        $this->assertNull(Context::currentParentEventId());
    }
}
