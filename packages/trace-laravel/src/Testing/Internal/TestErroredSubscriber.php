<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Testing\Internal;

use PHPUnit\Event\Test\Errored;
use PHPUnit\Event\Test\ErroredSubscriber;

/**
 * Records error details when PHPUnit fires Test\Errored.
 *
 * In PHPUnit 10/11 there are two distinct failure events:
 *  - Test\Failed  — assertion failures (ExpectationFailedException)
 *  - Test\Errored — unexpected exceptions thrown during setUp(), tearDown(),
 *                   or the test body itself (e.g. QueryException, TypeError)
 *
 * Without this subscriber, errored tests inherit the 'pass' status set by
 * TestPreparedSubscriber and are recorded with the wrong outcome in the trace.
 *
 * @internal
 */
final class TestErroredSubscriber implements ErroredSubscriber
{
    public function __construct(private readonly PhpUnitTestState $state) {}

    public function notify(Errored $event): void
    {
        $this->state->status       = 'fail';
        $this->state->errorType    = $event->throwable()->className();
        $this->state->errorMessage = $event->throwable()->message();
        $this->state->errorStack   = $event->throwable()->stackTrace();
    }
}
