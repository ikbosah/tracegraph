<?php

declare(strict_types=1);

use Tracegraph\Laravel\Tracegraph;

if (!function_exists('tracegraph_trace')) {
    /**
     * Wraps a callable and emits a `function_call` TraceGraph event.
     *
     * Procedural alias for Tracegraph::trace() — useful in scripts and
     * non-OOP contexts.
     *
     * @template T
     * @param  callable(): T  $fn
     * @return T
     */
    function tracegraph_trace(string $name, callable $fn): mixed
    {
        return Tracegraph::trace($name, $fn);
    }
}

if (!function_exists('tracegraph_auth_check')) {
    /**
     * Emits an `auth_check` TraceGraph event.
     *
     * Procedural alias for Tracegraph::authCheck() — use at every
     * authorisation gate in your application.
     */
    function tracegraph_auth_check(string $name): void
    {
        Tracegraph::authCheck($name);
    }
}

if (!function_exists('tracegraph_xdebug_marker')) {
    /**
     * Xdebug correlation anchor.
     *
     * This function is intentionally a no-op. When Xdebug profiling is active,
     * this call creates a recognizable stack frame that TraceGraph uses as a
     * correlation anchor when post-processing Xdebug traces.
     *
     * The function is stripped from the user-visible call graph.
     * Do not add logic here. The function signature must remain stable.
     */
    function tracegraph_xdebug_marker(string $label): void
    {
        // Intentional no-op. See docblock above.
    }
}
