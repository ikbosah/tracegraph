/**
 * M6 T6.5 — `tracegraph scenario` commands
 *
 * tracegraph scenario run <file>       — Execute a scenario end-to-end
 * tracegraph scenario validate <file>  — Validate a scenario file without running
 * tracegraph scenario list             — List scenario files in .tracegraph/scenarios/
 */
import fs   from 'fs';
import path from 'path';
import { EXIT_CODES } from '@tracegraph/shared-types';
import { runScenario, loadScenarioDefinition } from '@tracegraph/scenario-runner';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ScenarioRunCliOptions = {
  /** Override the workspace root. Defaults to process.cwd(). */
  workspaceRoot?: string;
};

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * Run a scenario definition file and print step-by-step results to stderr.
 * Emits a `bundle.created` JSON event to stdout when a bundle is produced
 * (consumed by the VS Code extension).
 *
 * Returns EXIT_CODES.SUCCESS (0) if all steps passed, CLI_ERROR (2) on errors,
 * or COMMAND_FAILURE (1) if any step failed.
 */
export async function scenarioRunCommand(
  scenarioFile: string,
  options: ScenarioRunCliOptions = {},
): Promise<number> {
  const cwd         = options.workspaceRoot ?? process.cwd();
  const absScenario = path.resolve(cwd, scenarioFile);

  process.stderr.write(
    `[tracegraph] Running scenario: ${path.relative(cwd, absScenario)}\n`,
  );

  try {
    const result = await runScenario(absScenario, { workspaceRoot: cwd });

    // ── Step-by-step output ────────────────────────────────────────────────────
    for (const step of result.steps) {
      const icon  = step.status === 'passed'  ? '  ✓'
                  : step.status === 'skipped' ? '  –'
                  : '  ✗';
      const extra = step.error      ? ` — ${step.error}`
                  : step.statusCode ? ` [${step.statusCode}]`
                  : '';
      process.stderr.write(`${icon} ${step.name}${extra}\n`);
    }

    // ── Summary ────────────────────────────────────────────────────────────────
    const statusLabel = result.passed ? '✓ passed' : '✗ failed';
    process.stderr.write(
      `[tracegraph] Scenario "${result.scenarioId}" ${statusLabel} ` +
      `(${result.steps.length} step(s), ${result.durationMs}ms)\n`,
    );

    if (result.bundleFile) {
      process.stderr.write(`[tracegraph] Bundle written: ${result.bundleFile}\n`);

      // Emit bundle.created on stdout for the VS Code extension
      process.stdout.write(
        JSON.stringify({
          protocol:  'tracegraph.cli.v1',
          type:      'bundle.created',
          runId:     result.runId,
          timestamp: Date.now(),
          payload: {
            file:       result.bundleFile,
            scenarioId: result.scenarioId,
          },
        }) + '\n',
      );
    }

    return result.passed ? EXIT_CODES.SUCCESS : EXIT_CODES.COMMAND_FAILURE;
  } catch (err: unknown) {
    process.stderr.write(`[tracegraph] Error: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }
}

/**
 * Validate a scenario file's JSON structure without running it.
 * Prints a summary of the scenario on success, or a descriptive error.
 */
export function scenarioValidateCommand(scenarioFile: string): number {
  const cwd = process.cwd();
  const abs = path.resolve(cwd, scenarioFile);

  try {
    const def = loadScenarioDefinition(abs);

    const servers = def.servers ?? [];
    const lines: string[] = [
      `✓  ${def.name} (${def.scenarioId})`,
      `   Steps:   ${def.steps.length}`,
      `   Servers: ${servers.length}`,
    ];
    if (servers.length > 0) {
      for (const s of servers) {
        lines.push(`     • ${s.name}  port ${s.port}  "${s.command}"`);
      }
    }
    if (def.tags?.length) {
      lines.push(`   Tags: ${def.tags.join(', ')}`);
    }

    process.stdout.write(lines.join('\n') + '\n');
    return EXIT_CODES.SUCCESS;
  } catch (err: unknown) {
    process.stderr.write(`[tracegraph] Invalid scenario: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }
}

/**
 * List all `.scenario.json` files found in `.tracegraph/scenarios/`.
 */
export function scenarioListCommand(): number {
  const cwd          = process.cwd();
  const scenariosDir = path.join(cwd, '.tracegraph', 'scenarios');

  if (!fs.existsSync(scenariosDir)) {
    process.stdout.write(
      'No scenarios directory found.\n' +
      'Create .tracegraph/scenarios/ and add *.scenario.json files.\n',
    );
    return EXIT_CODES.SUCCESS;
  }

  const files = fs.readdirSync(scenariosDir)
    .filter((f) => f.endsWith('.scenario.json'))
    .sort();

  if (files.length === 0) {
    process.stdout.write(
      'No scenario files found in .tracegraph/scenarios/\n',
    );
    return EXIT_CODES.SUCCESS;
  }

  process.stdout.write(`Scenarios in .tracegraph/scenarios/ (${files.length}):\n\n`);

  for (const file of files) {
    const abs = path.join(scenariosDir, file);
    try {
      const def = JSON.parse(fs.readFileSync(abs, 'utf8')) as {
        name?: string; scenarioId?: string;
        steps?: unknown[]; servers?: unknown[];
      };
      const name    = def.name    ?? def.scenarioId ?? file;
      const nSteps  = (def.steps   ?? []).length;
      const nSrvs   = (def.servers ?? []).length;
      process.stdout.write(
        `  ${file}\n` +
        `    ${name} — ${nSteps} step(s), ${nSrvs} server(s)\n`,
      );
    } catch {
      process.stdout.write(`  ${file} (unreadable)\n`);
    }
  }

  return EXIT_CODES.SUCCESS;
}
