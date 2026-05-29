<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Listeners;

use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\IdGenerator;

/**
 * GateEventListener — captures Laravel Gate checks as `authorization_check` events.
 *
 * Registered via Gate::after() in TraceServiceProvider.
 * Called after every Gate::allows() / Gate::authorize() / @can directive check.
 *
 * What it captures:
 *  - The ability being checked (e.g. 'update', 'delete')
 *  - The result (allowed/denied)
 *  - The user ID (if the user is an Authenticatable)
 *  - The inferred Policy class and method (e.g. "OrderPolicy::update")
 *
 * Policy class inference algorithm:
 *  1. Inspect $arguments — find the first object with a model class
 *  2. Derive the model name from the class (e.g. App\Models\Order → Order)
 *  3. Look for a matching Policy class in App\Policies\{ModelName}Policy
 *     (also tries the policy map registered with the Gate)
 *  4. If found, displayName = "{PolicyClass}::{ability}"
 *
 * authorization_check events are marked security.critical: true — if they
 * disappear from a trace, TraceGraph raises a Critical finding.
 */
final class GateEventListener
{
    /**
     * Called after every Gate check.
     *
     * @param  \Illuminate\Contracts\Auth\Authenticatable|null  $user
     * @param  string                                           $ability
     * @param  bool|null                                        $result
     * @param  array<mixed>                                     $arguments
     */
    public function handle(
        mixed $user,
        string $ability,
        bool|null $result,
        array $arguments = [],
    ): void {
        $writer = EventWriter::getInstance();
        if ($writer === null) {
            return;
        }

        $userId      = $this->extractUserId($user);
        $displayName = $this->inferDisplayName($ability, $arguments);

        $writer->write([
            'schemaVersion'    => 'tracegraph.event.v1',
            'eventId'          => IdGenerator::nextId(),
            'traceId'          => $writer->getTraceId(),
            'parentEventId'    => Context::currentParentEventId() ?? $writer->getRootEventId(),
            'type'             => 'authorization_check',
            'language'         => 'php',
            'framework'        => 'laravel',
            'name'             => $displayName ?? "Gate::{$ability}",
            'displayName'      => $displayName,
            'startTime'        => (int) round(microtime(true) * 1000),
            'metadata'         => [
                'ability'          => $ability,
                'result'           => $result,
                'userId'           => $userId,
                'security.critical' => true,
            ],
        ]);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Extract a scalar user identifier from the Authenticatable object.
     * Returns null when the user is not logged in or when the key is complex.
     */
    private function extractUserId(mixed $user): int|string|null
    {
        if ($user === null) {
            return null;
        }

        // Illuminate\Contracts\Auth\Authenticatable defines getAuthIdentifier()
        if (method_exists($user, 'getAuthIdentifier')) {
            $id = $user->getAuthIdentifier();
            return (is_int($id) || is_string($id)) ? $id : null;
        }

        return null;
    }

    /**
     * Infer a human-readable displayName for the Gate check.
     *
     * Tries to produce "OrderPolicy::update" from Gate::allows('update', $order).
     * Falls back to null when no policy can be inferred.
     *
     * @param  array<mixed>  $arguments
     */
    private function inferDisplayName(string $ability, array $arguments): ?string
    {
        $modelObject = $this->findFirstModelArgument($arguments);
        if ($modelObject === null) {
            return null;
        }

        $modelClass  = get_class($modelObject);
        $policyClass = $this->resolvePolicyClass($modelClass);

        if ($policyClass === null) {
            return null;
        }

        // Strip fully-qualified namespace — use only the short class name
        $shortPolicy = class_basename($policyClass);

        return "{$shortPolicy}::{$ability}";
    }

    /**
     * Scan $arguments for the first object (non-user model argument).
     * Gate::allows('update', $order) → [$order] → returns $order
     *
     * @param  array<mixed>  $arguments
     */
    private function findFirstModelArgument(array $arguments): ?object
    {
        foreach ($arguments as $arg) {
            if (is_object($arg)) {
                return $arg;
            }
        }
        return null;
    }

    /**
     * Resolve the Policy class for a given model class.
     *
     * Strategy (in order):
     *  1. Check if Gate has a policy registered for the model (via getPolicyFor())
     *  2. Derive conventionally: App\Models\Order → App\Policies\OrderPolicy
     *  3. Try root namespace: Order → \OrderPolicy
     *
     * Returns null when no policy class can be found.
     */
    private function resolvePolicyClass(string $modelClass): ?string
    {
        // Strategy 1: ask the Gate (most accurate — respects policy registrations)
        try {
            $gate = app('Illuminate\Contracts\Auth\Access\Gate');
            if (method_exists($gate, 'getPolicyFor')) {
                /** @var mixed $policy */
                $policy = $gate->getPolicyFor($modelClass);
                if ($policy !== null && is_object($policy)) {
                    return get_class($policy);
                }
                if ($policy !== null && is_string($policy) && class_exists($policy)) {
                    return $policy;
                }
            }
        } catch (\Throwable) {
            // Gate not available (e.g. running outside HTTP context) — continue
        }

        // Strategy 2: conventional Laravel namespace derivation
        // App\Models\Order → App\Policies\OrderPolicy
        $shortName = class_basename($modelClass);

        // Try App\Policies namespace (most common)
        $candidate = "App\\Policies\\{$shortName}Policy";
        if (class_exists($candidate)) {
            return $candidate;
        }

        // Try same namespace with "Policy" suffix
        $parts     = explode('\\', $modelClass);
        array_pop($parts);
        $ns        = implode('\\', $parts);
        $nsCandidate = $ns . "\\Policies\\{$shortName}Policy";
        if (class_exists($nsCandidate)) {
            return $nsCandidate;
        }

        return null;
    }
}
