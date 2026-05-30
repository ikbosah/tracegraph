# @tracegraph/jest

TraceGraph reporter for Jest. Produces per-test `.trace.json` files (capture level 5), giving each test case its own isolated trace with full test-lifecycle events. Drop-in addition to any existing Jest setup.

## What's in this package

| Export | Description |
|--------|-------------|
| `TraceGraphJestReporter` | Jest reporter class — implements `onTestFileStart`, `onTestStart`, `onTestResult`, and `onRunComplete` to write one trace per test |

The package also provides a default export so Jest can load it via the short-form string `'@tracegraph/jest'` without needing the class name.

## Installation

```bash
npm install -D @tracegraph/jest jest
```

## Usage

### Add to `jest.config.js`

```javascript
module.exports = {
  reporters: [
    'default',
    '@tracegraph/jest',
  ],
};
```

With options (currently none required, reserved for future use):

```javascript
module.exports = {
  reporters: [
    'default',
    ['@tracegraph/jest', {}],
  ],
};
```

### Via `tracegraph run` (auto-injection)

```bash
tracegraph run -- npx jest
# → "@tracegraph/jest reporter auto-injected"
```

`tracegraph run` detects Jest in the command and appends `--reporters=default --reporters=@tracegraph/jest` automatically unless the reporter is already present.

### Direct CLI usage

```bash
npx jest --reporters=default --reporters=@tracegraph/jest
```

## What the reporter captures

Each test trace includes:

- `test_file` event — the test file path and suite structure
- `test_run` event per test — test name, pass/fail/skip/todo status, and duration in milliseconds
- `error` event on test failure — error type and message extracted from Jest's test result
- All events emitted by `traceFunction` / `traceMethod` / `traceExpress` instrumentation running inside the test body

## Trace isolation

Each test in a test file gets its own `traceId`. Events are written to separate `.tmp` files per test and atomically finalised to `.trace.json` files when the test completes.

## Requirements

- Jest ≥ 27.0.0
- `TRACEGRAPH_ENABLED=1` and `TRACEGRAPH_RUN_DIR` set in the environment (set automatically by `tracegraph run`)
