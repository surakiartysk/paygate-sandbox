/**
 * The low findings of the 14 October security review.
 *
 * - **Ids drawn from Math.random.** An Omise payment token is what the
 *   mock-pay page acts on, so whoever holds it can pay or cancel the payment.
 *   An inspector session id is all that stands between a stranger and the
 *   callbacks it captured. Both were the time plus a few characters of
 *   Math.random.
 * - **Error text in answers.** `'System error: ' + error.message` told any
 *   caller what had broken inside, and where.
 * - **The dev server.** It served any path it was given, `..` included, so
 *   `/../.env` answered with the repository's own .env. It also listened on
 *   every interface.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSessionId } from '../lib/inspector.js';
import { startSandbox, adminHeaders, postJson, uniqueInvoice } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('ids a stranger must not guess', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('an Omise payment token carries 192 random bits, and no timestamp', async () => {
    const invoiceNo = uniqueInvoice();
    const created = await postJson(`${sandbox.baseUrl}/api/omise/charges`, {
      amount: 10000, currency: 'thb', metadata: { invoiceNo }
    });
    assert.equal(created.status, 200);

    const { payment } = await (await fetch(`${sandbox.baseUrl}/api/admin/payments/${invoiceNo}`, { headers: adminHeaders() })).json();
    assert.match(payment.paymentToken, /^omise_token_[A-Za-z0-9_-]{32}$/);
  });

  test('an inspector session id carries 128 random bits, and no timestamp', () => {
    const ids = Array.from({ length: 50 }, generateSessionId);
    for (const id of ids) assert.match(id, /^s_[0-9a-f]{32}$/);
    assert.equal(new Set(ids).size, ids.length);
  });
});

test('no route puts an error\'s own message in its answer', () => {
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.js')) files.push(path);
    }
  };
  walk(join(root, 'api'));

  // A message may go to the server's own log; it may not go to the caller.
  // So every console call is cut out first, however many lines it spans.
  const withoutConsole = source => {
    let out = '';
    let i = 0;
    for (let at; (at = source.indexOf('console.', i)) !== -1; ) {
      out += source.slice(i, at);
      let depth = 0;
      let j = source.indexOf('(', at);
      for (; j < source.length; j++) {
        if (source[j] === '(') depth++;
        else if (source[j] === ')' && --depth === 0) break;
      }
      out += source.slice(at, j + 1).replace(/[^\n]/g, ' ');
      i = j + 1;
    }
    return out + source.slice(i);
  };
  const leaks = files.flatMap(file => withoutConsole(readFileSync(file, 'utf8')).split('\n')
    .map((line, i) => ({ file: file.slice(root.length + 1), line: i + 1, text: line.trim() }))
    .filter(({ text }) => /\b(error|err)\.message\b/.test(text)));

  assert.deepEqual(leaks, []);
});

describe('the dev server', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  /** A GET with the path exactly as written; `fetch` would resolve the `..`. */
  const rawGet = path => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(sandbox.baseUrl);
    const req = httpRequest({ hostname, port, path, method: 'GET' }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

  test('serves nothing from outside public/', async () => {
    for (const path of ['/../package.json', '/js/../../package.json', '/..%2fpackage.json']) {
      const { status, body } = await rawGet(path);
      assert.equal(status, 404, path);
      assert.doesNotMatch(body, /"name": "paygate-sandbox"/, path);
    }
    assert.equal((await rawGet('/js/dashboard.js')).status, 200);
  });

  test('is not reachable on the machine\'s other addresses', async (t) => {
    const address = Object.values(networkInterfaces()).flat()
      .find(a => a && a.family === 'IPv4' && !a.internal)?.address;
    if (!address) return t.skip('this machine has no address but loopback');

    const { port } = new URL(sandbox.baseUrl);
    const outcome = await new Promise(resolve => {
      const socket = connect({ host: address, port: Number(port) });
      socket.once('connect', () => { socket.destroy(); resolve('connected'); });
      socket.once('error', error => resolve(error.code));
    });
    assert.notEqual(outcome, 'connected');
  });
});
