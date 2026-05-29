<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Testing\Internal;

use PHPUnit\Event\Test\Skipped;
use PHPUnit\Event\Test\SkippedSubscriber;

/**
 * Records a 'skip' outcome when PHPUnit fires Test\Skipped.
 *
 * @internal
 */
final class TestSkippedSubscriber implements SkippedSubscriber
{
    public function __construct(private readonly PhpUnitTestState $state) {}

    public function notify(Skipped $event): void
    {
        $this->state->status       = 'skip';
        $this->state->errorMessage = $event->message();
    }
}
