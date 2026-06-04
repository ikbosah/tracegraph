/**
 * M9A T9A.8 — `tracegraph server` command group
 *
 * Manages the TraceGraph Team Server Docker deployment.
 *
 *   tracegraph server install  — validate Docker available, write docker-compose.yml, start
 *   tracegraph server status   — check health endpoint, show version
 *   tracegraph server stop     — docker compose down
 *   tracegraph server logs     — docker compose logs
 */
import fs   from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { EXIT_CODES } from '@tracegraph/shared-types';
import http  from 'http';
import https from 'https';

export type ServerInstallOptions = {
  port?:     string;
  dataDir?:  string;
};

export type ServerStatusOptions = {
  url?: string;
};

// ─── server install ───────────────────────────────────────────────────────────

export function serverInstallCommand(options: ServerInstallOptions): number {
  // Check Docker is available
  const dockerCheck = spawnSync('docker', ['--version'], {
    encoding: 'utf8', stdio: 'pipe',
  });
  if (dockerCheck.error || dockerCheck.status !== 0) {
    process.stderr.write(
      '[tracegraph] Docker is not available. Install Docker Desktop or Docker Engine first.\n' +
      '  https://docs.docker.com/get-docker/\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const cwd     = process.cwd();
  const port    = options.port ?? '3000';
  const dataDir = options.dataDir ?? path.join(cwd, '.tracegraph-server', 'data');

  // Write .env for docker compose
  const envContent = [
    `PORT=${port}`,
    `TRACEGRAPH_DATA_DIR=/data`,
    `TRACEGRAPH_ADMIN_EMAIL=admin@localhost`,
    `TRACEGRAPH_ADMIN_PASSWORD=changeme`,
  ].join('\n') + '\n';

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(cwd, '.env'), envContent, 'utf8');

  // Write a local docker-compose.yml pointing to the registry image
  const composeContent = `version: "3.9"
services:
  team-server:
    image: tracegraph/team-server:latest
    container_name: tracegraph-team-server
    restart: unless-stopped
    ports:
      - "\${PORT:-${port}}:3000"
    environment:
      PORT: 3000
      TRACEGRAPH_ADMIN_EMAIL: "\${TRACEGRAPH_ADMIN_EMAIL:-admin@localhost}"
      TRACEGRAPH_ADMIN_PASSWORD: "\${TRACEGRAPH_ADMIN_PASSWORD:-changeme}"
    volumes:
      - ${dataDir}:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
volumes: {}
`;

  const composePath = path.join(cwd, 'docker-compose.team-server.yml');
  fs.writeFileSync(composePath, composeContent, 'utf8');

  process.stdout.write(
    `[tracegraph] Team Server setup:\n` +
    `  Compose file: ${composePath}\n` +
    `  Data volume:  ${dataDir}\n` +
    `  Admin email:  admin@localhost  (change TRACEGRAPH_ADMIN_EMAIL in .env)\n` +
    `  Admin pass:   changeme          (change TRACEGRAPH_ADMIN_PASSWORD in .env)\n\n`,
  );

  // Start the server
  process.stdout.write(`[tracegraph] Starting Team Server on port ${port}...\n`);
  const result = spawnSync(
    'docker',
    ['compose', '-f', composePath, 'up', '-d'],
    { stdio: 'inherit', encoding: 'utf8' },
  );

  if (result.status !== 0) {
    process.stderr.write(
      '[tracegraph] docker compose up failed. Check Docker logs for details.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  process.stdout.write(
    `\n[tracegraph] ✅ Team Server started at http://localhost:${port}\n` +
    `  Dashboard:  http://localhost:${port}\n` +
    `  Health:     http://localhost:${port}/health\n` +
    `\n  To upload traces: tracegraph compare --upload http://localhost:${port}\n`,
  );
  return EXIT_CODES.SUCCESS;
}

// ─── server status ────────────────────────────────────────────────────────────

export async function serverStatusCommand(options: ServerStatusOptions): Promise<number> {
  const serverUrl = options.url ?? 'http://localhost:3000';

  process.stdout.write(`[tracegraph] Checking ${serverUrl}/health...\n`);

  try {
    const result = await fetchJson(`${serverUrl}/health`);
    const r = result as Record<string, unknown>;
    process.stdout.write(
      `[tracegraph] ✅ Team Server is healthy\n` +
      `  Status:  ${r['status']}\n` +
      `  Version: ${r['version']}\n` +
      `  Time:    ${r['time']}\n`,
    );
    return EXIT_CODES.SUCCESS;
  } catch (err) {
    process.stderr.write(
      `[tracegraph] ✗ Team Server is not reachable at ${serverUrl}\n` +
      `  Error: ${String(err)}\n` +
      `  Run: tracegraph server install  or  docker compose up\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }
}

// ─── server stop ──────────────────────────────────────────────────────────────

export function serverStopCommand(): number {
  const composePath = path.join(process.cwd(), 'docker-compose.team-server.yml');

  if (!fs.existsSync(composePath)) {
    process.stderr.write(
      '[tracegraph] No docker-compose.team-server.yml found. Is the server installed?\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const result = spawnSync(
    'docker',
    ['compose', '-f', composePath, 'down'],
    { stdio: 'inherit', encoding: 'utf8' },
  );

  return result.status === 0 ? EXIT_CODES.SUCCESS : EXIT_CODES.CLI_ERROR;
}

// ─── server logs ─────────────────────────────────────────────────────────────

export function serverLogsCommand(options: { follow?: boolean }): number {
  const composePath = path.join(process.cwd(), 'docker-compose.team-server.yml');

  const args = ['compose', '-f', composePath, 'logs'];
  if (options.follow) args.push('-f');

  const result = spawnSync('docker', args, { stdio: 'inherit', encoding: 'utf8' });
  return result.status === 0 ? EXIT_CODES.SUCCESS : EXIT_CODES.CLI_ERROR;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const lib     = url.startsWith('https') ? https : http;
    const timeout = 5000;
    const req     = lib.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON response from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}
