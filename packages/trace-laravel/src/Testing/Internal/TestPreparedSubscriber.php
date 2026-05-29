<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Testing\Internal;

use PHPUnit\Event\Test\Prepared;
use PHPUnit\Event\Test\PreparedSubscriber;

/**
 * Records the test start time when PHPUnit fires Test\Prepared.
 *
 * @internal
 */
final class TestPreparedSubscriber implements PreparedSubscriber
{
    public function __construct(private readonly PhpUnitTestState $state) {}

    public function notify(Prepared $event): void
    {
        $this->state->reset();
        $this->state->startTimeMs = (int) round(microtime(true) * 1000);
    }
}
