<?php

declare(strict_types=1);

namespace Tracegraph\Laravel;

/**
 * Context — static call-stack tracking for PHP traces.
 *
 * PHP is synchronous per request, so a simple static array acts as the
 * call stack. There is no need for AsyncLocalStorage equivalents.
 *
 * TraceMiddleware pushes the http_request eventId onto the stack before
 * dispatching the request and pops it after. Tracegraph::trace() does the
 * same for nested function calls.
 *
 * currentParentEventId() returns the topmost eventId — the "current" call
 * frame that new events should be children of.
 */
final class Context
{
    /** @var array<int, string> */
    private static array $callStack = [];

    private function __construct() {}

    /** Push an event ID onto the call stack. */
    public static function push(string $eventId): void
    {
        self::$callStack[] = $eventId;
    }

    /** Pop the topmost event ID off the call stack. */
    public static function pop(): void
    {
        array_pop(self::$callStack);
    }

    /**
     * Returns the current parent event ID (top of the call stack),
     * or null if the stack is empty (top-level event).
     */
    public static function currentParentEventId(): ?string
    {
        if (empty(self::$callStack)) {
            return null;
        }
        return end(self::$callStack) ?: null;
    }

    /** Clears the entire call stack. For use in tests only. */
    public static function clear(): void
    {
        self::$callStack = [];
    }
}
