<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Testing\Internal;

/**
 * Shared mutable state for the PHPUnit extension subscribers.
 *
 * One instance is created by TraceGraphPhpUnitExtension::bootstrap() and
 * passed to all subscribers. Because PHPUnit runs tests sequentially, no
 * locking is necessary.
 *
 * @internal
 */
final class PhpUnitTestState
{
    /** Directory where per-test JSONL files are written. */
    public readonly string $testsDir;

    /** Unix timestamp in milliseconds — set when Test\Prepared fires. */
    public ?int $startTimeMs = null;

    /** Test outcome captured before Finished fires. */
    public string $status = 'pass';   // 'pass' | 'fail' | 'skip'

    /** Exception class name for failed/errored tests. */
    public ?string $errorType = null;

    /** Human-readable failure message. */
    public ?string $errorMessage = null;

    /** Stack trace as a string. */
    public ?string $errorStack = null;

    public function __construct(string $testsDir)
    {
        $this->testsDir = $testsDir;
    }

    /** Resets outcome fields for the next test. */
    public function reset(): void
    {
        $this->startTimeMs  = null;
        $this->status       = 'pass';
        $this->errorType    = null;
        $this->errorMessage = null;
        $this->errorStack   = null;
    }
}
