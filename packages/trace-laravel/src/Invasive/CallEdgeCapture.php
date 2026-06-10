<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Invasive;

/**
 * CallEdgeCapture — Phase 2 invasive instrumentation.
 *
 * Captures PHP runtime call edges via debug_backtrace() at each EventWriter::write()
 * invocation and at each ServiceProvider listener call.  Accumulates unique
 * caller → callee pairs across the entire test run and writes them to
 * {TRACEGRAPH_RUN_DIR}/call_edges.json on shutdown.
 *
 * This file is written to the run directory (alongside the JSONL traces) and is
 * later read by the TypeScript audit pipeline to augment the static graph's
 * zero-edge baseline with runtime-observed call relationships.
 *
 * Only active when TRACEGRAPH_ENABLED=1 AND TRACEGRAPH_INVASIVE >= 2.
 */
final class CallEdgeCapture
{
    private static ?self $instance = null;

    /**
     * Accumulated unique edges: "caller::fqn->callee::fqn" → ['caller' => ..., 'callee' => ...]
     *
     * @var array<string, array{caller: string, callee: string}>
     */
    private array $edges = [];

    private readonly string $runDir;

    private function __construct(string $runDir)
    {
        $this->runDir = $runDir;

        register_shutdown_function(function (): void {
            $this->writeEdges();
        });
    }

    /**
     * Returns the singleton instance when Phase 2 invasive capture is active.
     * Returns null when disabled — callers should use ?-> to skip silently.
     */
    public static function getInstance(): ?self
    {
        if (getenv('TRACEGRAPH_ENABLED') !== '1') {
            return null;
        }

        $invasive = (int) (getenv('TRACEGRAPH_INVASIVE') ?: '0');
        if ($invasive < 2) {
            return null;
        }

        $runDir = getenv('TRACEGRAPH_RUN_DIR');
        if ($runDir === false || $runDir === '') {
            return null;
        }

        if (self::$instance === null) {
            self::$instance = new self($runDir);
        }

        return self::$instance;
    }

    /**
     * Record a debug_backtrace() result and extract caller→callee pairs from
     * the application frames (non-vendor, non-framework, non-Tracegraph).
     *
     * @param array<int, array{class?: string, function?: string, file?: string, type?: string}> $frames
     */
    public function record(array $frames): void
    {
        // Extract application frames (ordered from innermost to outermost call)
        $appFqns = [];
        foreach ($frames as $frame) {
            if (!$this->isAppFrame($frame)) {
                continue;
            }
            $class    = $frame['class']    ?? '';
            $function = $frame['function'] ?? '';
            if ($class === '' || $function === '') {
                continue;
            }
            $appFqns[] = $class . '::' . $function;
        }

        // Build caller→callee pairs from adjacent app frames.
        // In debug_backtrace(), appFqns[i] was CALLED BY appFqns[i+1].
        // So: source (caller) = appFqns[i+1], target (callee) = appFqns[i].
        $count = count($appFqns);
        for ($i = 0; $i < $count - 1; $i++) {
            $callee = $appFqns[$i];
            $caller = $appFqns[$i + 1];
            $key    = $caller . '->' . $callee;
            if (!array_key_exists($key, $this->edges)) {
                $this->edges[$key] = ['caller' => $caller, 'callee' => $callee];
            }
        }
    }

    /**
     * Determine whether a backtrace frame belongs to application code
     * (as opposed to vendor/framework/tracegraph/PHPUnit internals).
     *
     * @param array{class?: string, function?: string, file?: string, type?: string} $frame
     */
    private function isAppFrame(array $frame): bool
    {
        $class = $frame['class']    ?? '';
        $file  = $frame['file']     ?? '';

        // Must have both a class and a function to build a FQN.
        if ($class === '' || ($frame['function'] ?? '') === '') {
            return false;
        }

        // Skip Tracegraph instrumentation namespace.
        if (str_starts_with($class, 'Tracegraph\\')) {
            return false;
        }

        // Skip PHPUnit framework.
        if (str_starts_with($class, 'PHPUnit\\')) {
            return false;
        }

        // Skip the full Illuminate / Laravel framework stack.
        if (str_starts_with($class, 'Illuminate\\')) {
            return false;
        }

        // Skip Symfony (used internally by Laravel).
        if (str_starts_with($class, 'Symfony\\')) {
            return false;
        }

        // Skip anonymous closures (class name contains '{closure}').
        if (str_contains($class, '{closure}')) {
            return false;
        }

        // Skip any file inside a vendor/ directory.
        // Normalise to forward slashes so the check works on both Windows and Unix.
        $normalised = str_replace('\\', '/', $file);
        if (str_contains($normalised, '/vendor/')) {
            return false;
        }

        return true;
    }

    // ── Shutdown artifact ─────────────────────────────────────────────────────

    private function writeEdges(): void
    {
        if ($this->edges === []) {
            return;
        }

        $path = $this->runDir . DIRECTORY_SEPARATOR . 'call_edges.json';
        $data = array_values($this->edges);

        try {
            file_put_contents(
                $path,
                json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n",
            );
        } catch (\Throwable) {
            // Best-effort — never let instrumentation errors affect the test run
        }
    }

    // ── Test helpers ──────────────────────────────────────────────────────────

    /** Resets the singleton. For use in tests only. */
    public static function _resetForTest(): void
    {
        self::$instance = null;
    }

    /** Returns accumulated edges. For tests only. */
    public function _getEdgesForTest(): array
    {
        return array_values($this->edges);
    }
}
