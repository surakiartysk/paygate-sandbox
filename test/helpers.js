/**
 * Test helpers
 *
 * Boots the dev server in a child process against a throwaway data directory
 * so a test run never touches the working data/ files, and provides a small
 * callback receiver so tests can assert on what the sandbox actually sent.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Start the sandbox on a free port with isolated storage.
 * @param {Record<string, string>} [env] - Extra environment variables
 * @returns {Promise<{ baseUrl: string, stop: () => Promise<void> }>}
 */
export async function startSandbox(env = {}) {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'paygate-test-'));

  const child = spawn(process.execPath, ['dev-server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: 'test-password',
      // Pin every origin-derived URL to this instance. Without it a developer's
      // .env could point the sandbox's own callbacks at a different port.
      MOCK_SERVER_URL: `http://127.0.0.1:${port}`,
      // Tests drive loopback callbacks, and must not be throttled.
      ALLOW_PRIVATE_CALLBACKS: 'true',
      RATE_LIMIT_MAX: '0',
      URL_REWRITE_RULES: '',
      // Never inherit a real KV store into a test run.
      KV_REST_API_URL: '',
      KV_REST_API_TOKEN: '',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl);

  return {
    baseUrl,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

/**
 * A port nothing is listening on, chosen by the OS.
 *
 * This used to be a random pick from 3100–3899. With sixteen sandboxes in a
 * run, that is about a one-in-seven chance per run that two land on the same
 * port — and the loser fails quietly: its dev server cannot bind, while
 * `waitForServer` gets an answer from the *other* test's sandbox and carries
 * on against it, with that sandbox's environment. It showed up as timing tests
 * failing under the wrong ceiling, and as "did not start within 15000ms".
 *
 * Closing the probe before the child binds leaves a moment in which something
 * else could be given the same port. Linux hands out these ports from the
 * whole ephemeral range at random, so that is a far smaller chance than the
 * one it replaces — smaller, not zero.
 *
 * @returns {Promise<number>} Port number
 */
async function freePort() {
  const probe = createNetServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/**
 * Start a throwaway HTTP server that records every request it receives.
 * @returns {Promise<{ url: string, requests: Array<object>, waitFor: (n: number) => Promise<Array<object>>, stop: () => Promise<void> }>}
 */
export async function startReceiver() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"received":true}');
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/callback`,
    requests,
    /**
     * Resolve once at least `n` requests have arrived.
     * @param {number} n - Expected request count
     * @param {number} [timeoutMs] - How long to wait
     * @returns {Promise<Array<object>>} The received requests
     */
    async waitFor(n, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < n) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${n} request(s); got ${requests.length}`);
        }
        await new Promise(r => setTimeout(r, 50));
      }
      return requests;
    },
    async stop() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

/**
 * Poll the sandbox until it answers.
 * @param {string} baseUrl - Server origin
 */
async function waitForServer(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/api/admin/config`, { headers: adminHeaders() });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`Sandbox did not start within ${timeoutMs}ms`);
}

/**
 * Headers carrying the test admin credential.
 * @returns {Record<string, string>} Request headers
 */
export function adminHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Admin-Password': 'test-password'
  };
}

/**
 * POST JSON and return the parsed response.
 * @param {string} url - Target URL
 * @param {object} body - JSON body
 * @param {Record<string, string>} [headers] - Extra headers
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function postJson(url, body, headers = { 'Content-Type': 'application/json' }) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

/**
 * Build a unique invoice number for a test.
 * @returns {string} Invoice number
 */
export function uniqueInvoice() {
  return `TEST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}
