<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Testing\Internal;

use PHPUnit\Event\Test\Failed;
use PHPUnit\Event\Test\FailedSubscriber;

/**
 * Records failure details when PHPUnit fires Test\Failed.
 *
 * @internal
 */
final class TestFailedSubscriber implements FailedSubscriber
{
    public function __construct(private readonly PhpUnitTestState $state) {}

    public function notify(Failed $event): void
    {
        $this->state->status       = 'fail';
        $this->state->errorType    = $event->throwable()->className();
        $this->state->errorMessage = $event->throwable()->message();
        $this->state->errorStack   = $event->throwable()->stackTrace();
    }
}
