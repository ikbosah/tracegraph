<?php

return [
    /*
     |--------------------------------------------------------------------------
     | TraceGraph Adapter Configuration
     |--------------------------------------------------------------------------
     |
     | All settings can also be controlled via environment variables.
     | See https://tracegraph.dev/docs/laravel for full documentation.
     |
     */

    'enabled'      => env('TRACEGRAPH_ENABLED', false),
    'run_dir'      => env('TRACEGRAPH_RUN_DIR',  storage_path('tracegraph')),
    'trace_id'     => env('TRACEGRAPH_TRACE_ID'),
    'run_id'       => env('TRACEGRAPH_RUN_ID'),

    /*
     | Capture options
     */
    'capture' => [
        'http'   => true,
        'db'     => true,
        'auth'   => true,
        'gate'   => true,
        'queue'  => true,
    ],
];
