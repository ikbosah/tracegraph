<?php

declare(strict_types=1);

namespace Tracegraph\Laravel\Listeners;

use Illuminate\Database\Events\QueryExecuted;
use Tracegraph\Laravel\Context;
use Tracegraph\Laravel\EventWriter;
use Tracegraph\Laravel\IdGenerator;

/**
 * DatabaseQueryListener — captures SQL queries as `db_query` TraceGraph events.
 *
 * Registered automatically by TraceServiceProvider via DB::listen().
 * Each query emitted by Laravel's query builder / ORM produces one db_query event.
 *
 * Resource parsing:
 *  SELECT … FROM table  → { type: "database", key: table, operation: "read"   }
 *  INSERT INTO table …  → { type: "database", key: table, operation: "write"  }
 *  UPDATE table …       → { type: "database", key: table, operation: "update" }
 *  DELETE FROM table …  → { type: "database", key: table, operation: "delete" }
 */
final class DatabaseQueryListener
{
    public function __invoke(QueryExecuted $event): void
    {
        $writer = EventWriter::getInstance();
        if ($writer === null) {
            return;
        }

        $resource   = self::parseSql($event->sql);
        $durationMs = (int) round($event->time);
        $endTime    = (int) round(microtime(true) * 1000);
        $startTime  = $endTime - $durationMs;

        $writer->write([
            'schemaVersion' => 'tracegraph.event.v1',
            'eventId'       => IdGenerator::nextId(),
            'traceId'       => $writer->getTraceId(),
            'parentEventId' => Context::currentParentEventId() ?? $writer->getRootEventId(),
            'type'          => 'db_query',
            'language'      => 'php',
            'framework'     => 'laravel',
            'name'          => 'DB::' . $resource['operation'] . ' ' . $resource['table'],
            'startTime'     => $startTime,
            'endTime'       => $endTime,
            'durationMs'    => $durationMs,
            'resource'      => [
                'type'      => 'database',
                'key'       => $resource['table'],
                'operation' => $resource['operation'],
            ],
            'metadata'      => [
                'sql'          => $event->sql,
                'bindingCount' => count($event->bindings),
                'connection'   => $event->connectionName,
            ],
        ]);
    }

    /**
     * Parses a SQL string to extract the primary table and operation type.
     * Best-effort — handles the most common DML patterns.
     *
     * @return array{table: string, operation: string}
     */
    private static function parseSql(string $sql): array
    {
        // Normalise whitespace for easier matching
        $normalised = preg_replace('/\s+/', ' ', trim($sql));
        $lower      = strtolower($normalised ?? $sql);

        if (str_starts_with($lower, 'select')) {
            $operation = 'read';
            if (preg_match('/\bfrom\s+[`"]?(\w+)[`"]?/i', $normalised, $m)) {
                return ['table' => $m[1], 'operation' => $operation];
            }
        } elseif (str_starts_with($lower, 'insert')) {
            $operation = 'write';
            if (preg_match('/\binto\s+[`"]?(\w+)[`"]?/i', $normalised, $m)) {
                return ['table' => $m[1], 'operation' => $operation];
            }
        } elseif (str_starts_with($lower, 'update')) {
            $operation = 'update';
            if (preg_match('/^update\s+[`"]?(\w+)[`"]?/i', $normalised, $m)) {
                return ['table' => $m[1], 'operation' => $operation];
            }
        } elseif (str_starts_with($lower, 'delete')) {
            $operation = 'delete';
            if (preg_match('/\bfrom\s+[`"]?(\w+)[`"]?/i', $normalised, $m)) {
                return ['table' => $m[1], 'operation' => $operation];
            }
        }

        // Fallback: unknown DML or DDL
        return ['table' => 'unknown', 'operation' => 'read'];
    }
}
