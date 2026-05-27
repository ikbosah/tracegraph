import fs from 'fs';
import path from 'path';
import type { StorageConfig } from '@tracegraph/trace-core';

export type TraceGraphConfig = {
  projectName?: string;
  languages?: string[];
  trace?: {
    include?: string[];
    exclude?: string[];
    maxEvents?: number;
    captureInputs?: boolean;
    captureOutputs?: boolean;
    captureLogs?: boolean;
  };
  sanitize?: {
    maxDepth?: number;
    maxArrayLength?: number;
    maxStringLength?: number;
    redactKeys?: string[];
  };
  diff?: {
    mode?: 'structure' | 'input-shape' | 'value-sensitive';
    valueSensitiveFields?: string[];
  };
  security?: {
    protectedRoutes?: string[];
    sensitiveFields?: string[];
  };
  behavior?: {
    failOnCritical?: boolean;
    failOnHigh?: boolean;
    allowBehaviorChangesWithApproval?: boolean;
  };
  storage?: StorageConfig;
};

const CONFIG_FILENAME = 'tracegraph.config.json';

/**
 * Load `tracegraph.config.json` from the given root directory.
 * Returns an empty config object (all defaults) if the file does not exist.
 * Invalid JSON is reported to stderr; the empty config is used as a fallback.
 */
export function loadConfig(workspaceRoot: string): TraceGraphConfig {
  const configPath = path.join(workspaceRoot, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as TraceGraphConfig;
  } catch (err) {
    process.stderr.write(
      `[tracegraph] Warning: could not parse ${configPath}: ${String(err)}\n` +
      `[tracegraph] Using default configuration.\n`,
    );
    return {};
  }
}
