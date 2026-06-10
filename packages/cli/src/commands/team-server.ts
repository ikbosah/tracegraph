/**
 * M9A T9A.2/3/4 — Team Server CLI integration
 *
 * Provides upload and pull helpers used by other commands:
 *
 *   uploadToTeamServer(serverUrl, runId, traceFiles, reportFile) — POST to team server
 *   pullBaselinesFromTeamServer(serverUrl, projectId, baselinesDir) — GET and save
 *   createTeamServerRun(serverUrl, projectId) — POST /api/v1/runs → returns runId
 */
import fs    from 'fs';
import path  from 'path';
import https from 'https';
import http  from 'http';
// Note: FormData/File are not reliably exported from node:buffer in all Node 18 versions.
// We use a manual multipart implementation instead (see uploadFile below).

// ─── Types ────────────────────────────────────────────────────────────────────

export type TeamServerOptions = {
  serverUrl:  string;
  token?:     string;
  projectId?: string;
};

// ─── createTeamServerRun ─────────────────────────────────────────────────────

export async function createTeamServerRun(
  opts:   TeamServerOptions,
  runId:  string,
): Promise<string | null> {
  const projectId = opts.projectId ?? deriveProjectId();

  try {
    const res = await jsonPost(
      `${opts.serverUrl}/api/v1/runs`,
      { project_id: projectId, run_id: runId, environment: 'ci' },
      opts.token,
    );
    return (res as { id?: string }).id ?? null;
  } catch (err) {
    process.stderr.write(`[tracegraph] Team Server: failed to create run — ${String(err)}\n`);
    return null;
  }
}

// ─── uploadToTeamServer ──────────────────────────────────────────────────────

export async function uploadToTeamServer(
  opts:        TeamServerOptions,
  serverRunId: string,
  traceFiles:  string[],
  reportFile?: string,
): Promise<void> {
  const base = `${opts.serverUrl}/api/v1/runs/${serverRunId}`;

  // Upload traces
  let uploaded = 0;
  for (const traceFile of traceFiles) {
    if (!fs.existsSync(traceFile)) continue;
    try {
      await uploadFile(`${base}/traces`, traceFile, 'trace', opts.token);
      uploaded++;
    } catch (err) {
      process.stderr.write(
        `[tracegraph] Team Server: trace upload failed (${path.basename(traceFile)}) — ${String(err)}\n`,
      );
    }
  }

  // Upload report
  if (reportFile && fs.existsSync(reportFile)) {
    try {
      await uploadFile(`${base}/report`, reportFile, 'report', opts.token);
      process.stdout.write(
        `[tracegraph] Team Server: ${uploaded} trace(s) + report uploaded to ${opts.serverUrl}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[tracegraph] Team Server: report upload failed — ${String(err)}\n`,
      );
    }
  } else {
    process.stdout.write(
      `[tracegraph] Team Server: ${uploaded} trace(s) uploaded to ${opts.serverUrl}\n`,
    );
  }
}

// ─── uploadArchitectureSnapshot ─────────────────────────────────────────────

/**
 * G9 — Upload the local architecture baseline as a snapshot to the Team Server.
 * Called by `compare --upload` when .tracegraph/static-graph/architecture-baseline.json exists.
 * Returns the created snapshot ID on success, null on failure (non-fatal).
 */
export async function uploadArchitectureSnapshot(
  opts:       TeamServerOptions,
  serverRunId: string,
  baselineJson: unknown,
): Promise<string | null> {
  const projectId = opts.projectId ?? deriveProjectId();

  try {
    const res = await jsonPost(
      `${opts.serverUrl}/api/v1/projects/${projectId}/architecture?run_id=${encodeURIComponent(serverRunId)}`,
      baselineJson,
      opts.token,
    );
    return (res as { id?: string }).id ?? null;
  } catch (err) {
    process.stderr.write(
      `[tracegraph] Team Server: architecture snapshot upload failed — ${String(err)}\n`,
    );
    return null;
  }
}

// ─── pullBaselinesFromTeamServer ─────────────────────────────────────────────

export async function pullBaselinesFromTeamServer(
  opts:         TeamServerOptions,
  baselinesDir: string,
): Promise<number> {
  const projectId = opts.projectId ?? deriveProjectId();

  let baselines: Array<{ test_id: string }>;
  try {
    const res = await jsonGet(
      `${opts.serverUrl}/api/v1/projects/${projectId}/baselines`,
      opts.token,
    ) as { baselines: Array<{ test_id: string }> };
    baselines = res.baselines ?? [];
  } catch (err) {
    process.stderr.write(
      `[tracegraph] Team Server: failed to list baselines — ${String(err)}\n`,
    );
    return 0;
  }

  fs.mkdirSync(baselinesDir, { recursive: true });
  let saved = 0;

  for (const { test_id } of baselines) {
    try {
      const content = await jsonGet(
        `${opts.serverUrl}/api/v1/projects/${projectId}/baselines/${test_id}`,
        opts.token,
      );
      const destFile = path.join(baselinesDir, `${test_id}.baseline.json`);
      fs.writeFileSync(destFile, JSON.stringify(content, null, 2) + '\n', 'utf8');
      saved++;
    } catch (err) {
      process.stderr.write(
        `[tracegraph] Team Server: failed to pull baseline ${test_id} — ${String(err)}\n`,
      );
    }
  }

  process.stdout.write(
    `[tracegraph] Team Server: pulled ${saved} baseline(s) from ${opts.serverUrl}\n`,
  );
  return saved;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveProjectId(): string {
  // Use cwd basename as default project ID — stable per project
  return path.basename(process.cwd()).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

function makeHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = token ?? process.env['TRACEGRAPH_TOKEN'];
  if (t) h['Authorization'] = `Bearer ${t}`;
  return h;
}

function jsonPost(url: string, body: unknown, token?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const headers = {
      ...makeHeaders(token),
      'Content-Length': String(Buffer.byteLength(bodyStr)),
    };

    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
        method: 'POST', headers, timeout: 15_000 },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            try { resolve(JSON.parse(data)); }
            catch { resolve(data); }
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(bodyStr);
    req.end();
  });
}

function jsonGet(url: string, token?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const headers = makeHeaders(token);
    delete headers['Content-Type'];

    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
        method: 'GET', headers, timeout: 15_000 },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            try { resolve(JSON.parse(data)); }
            catch { resolve(data); }
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

/**
 * Upload a file using a multipart/form-data POST (no external deps).
 * Uses Node.js built-in `FormData` (available from Node 18+).
 */
async function uploadFile(url: string, filePath: string, field: string, token?: string): Promise<void> {
  const fileContent = fs.readFileSync(filePath);
  const fileName    = path.basename(filePath);

  // Build multipart body manually (FormData from node:buffer not available in all Node 18 versions)
  const boundary = `----TracegraphBoundary${Date.now()}`;
  const preamble =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${field}"; filename="${fileName}"\r\n` +
    `Content-Type: application/json\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(preamble, 'utf8'),
    fileContent,
    Buffer.from(epilogue, 'utf8'),
  ]);

  const parsed = new URL(url);
  const lib    = parsed.protocol === 'https:' ? https : http;
  const token_ = token ?? process.env['TRACEGRAPH_TOKEN'];

  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'Content-Type':   `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    };
    if (token_) headers['Authorization'] = `Bearer ${token_}`;

    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
        method: 'POST', headers, timeout: 30_000 },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve();
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Upload timed out')); });
    req.write(body);
    req.end();
  });
}

// (FormData/File not used — manual multipart implementation above)
