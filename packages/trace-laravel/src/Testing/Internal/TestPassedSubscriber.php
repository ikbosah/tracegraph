<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Testing\Internal;

use PHPUnit\Event\Test\Passed;
use PHPUnit\Event\Test\PassedSubscriber;

/**
 * Records a 'pass' outcome when PHPUnit fires Test\Passed.
 *
 * @internal
 */
final class TestPassedSubscriber implements PassedSubscriber
{
    public function __construct(private readonly PhpUnitTestState $state) {}

    public function notify(Passed $event): void
    {
        $this->state->status = 'pass';
    }
}
