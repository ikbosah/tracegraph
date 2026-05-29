<?php

declare(strict_types=1);

namespace Tracegraph\Laravel;

/**
 * IdGenerator — generates unique TraceGraph event IDs.
 *
 * Format: "evt_" + 16 lowercase hex characters (64 bits of randomness).
 * Matches the JS createEventId() output format from @tracegraph/trace-core.
 */
final class IdGenerator
{
    private function __construct() {}

    /**
     * Returns a new unique event ID.
     *
     * @return string  e.g. "evt_3f2a9b1c4e8d07f1"
     */
    public static function nextId(): string
    {
        return 'evt_' . bin2hex(random_bytes(8));
    }
}
