/**
 * Demo visitors.
 *
 * The published demo password is safe to publish only if everything it grants
 * is scoped. So these tests are mostly attempts to go around the scope: read
 * another visitor's payment, change the shared config, read the request log,
 * clear the instance, send a callback somewhere of the visitor's choosing,
 * hold a request open for as long as they like.
 *
 * Each one was proven by breaking the implementation, not the assertion; the
 * mutations are listed in the commit that added this file.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, startReceiver, postJson, adminHeaders } from './helpers.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** @param {string} token */
const demoHeaders = (token) => ({ ...JSON_HEADERS, 'X-Demo-Token': token });

/**
 * Sign in as a new demo visitor.
 * @param {string} baseUrl - Sandbox origin
 * @returns {Promise<{ token: string, inspectorSessionId: string }>}
 */
async function signInDemo(baseUrl) {
  const { status, body } = await postJson(`${baseUrl}/api/admin/login`, { password: 'demo' });
  assert.equal(status, 200, `demo sign-in failed: ${JSON.stringify(body)}`);
  assert.equal(body.role, 'demo');
  return body;
}

/**
 * @param {string} url - Target
 * @param {Record<string, string>} headers - Request headers
 * @param {string} [method] - HTTP method
 */
async function call(url, headers, method = 'GET') {
  const response = await fetch(url, { method, headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

const listFor = async (baseUrl, headers) => {
  const { status, body } = await call(`${baseUrl}/api/admin/payments?limit=100`, headers);
  assert.equal(status, 200, JSON.stringify(body));
  return body.payments.map(p => p.invoiceNo);
};

describe('demo visitors', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('the published password signs in a visitor with ten payments of their own', async () => {
    const visitor = await signInDemo(sandbox.baseUrl);

    assert.match(visitor.token, /^demo_[A-Za-z0-9_-]{43}$/);
    const invoices = await listFor(sandbox.baseUrl, demoHeaders(visitor.token));
    assert.equal(invoices.length, 10);
    const owner = invoices[0].split('-')[1];
    assert.ok(invoices.every(i => i.startsWith(`DEMO-${owner}-`)), invoices.join(', '));
  });

  test('a visitor cannot see or touch another visitor\'s payments', async () => {
    const alice = await signInDemo(sandbox.baseUrl);
    const bob = await signInDemo(sandbox.baseUrl);

    const aliceInvoices = await listFor(sandbox.baseUrl, demoHeaders(alice.token));
    const bobInvoices = await listFor(sandbox.baseUrl, demoHeaders(bob.token));
    assert.equal(aliceInvoices.filter(i => bobInvoices.includes(i)).length, 0);

    const target = aliceInvoices[0];
    const base = `${sandbox.baseUrl}/api/admin/payments/${encodeURIComponent(target)}`;
    const before = (await call(base, demoHeaders(alice.token))).body.payment;

    // Every route that takes an invoice number, as Bob.
    const attempts = [
      await call(base, demoHeaders(bob.token)),
      await call(`${base}?preview=callback`, demoHeaders(bob.token)),
      await postJson(`${base}/status`, { status: 'failed' }, demoHeaders(bob.token)),
      await postJson(`${base}/callback`, {}, demoHeaders(bob.token)),
      await postJson(`${base}/inquiry-config`, { behavior: 'timeout' }, demoHeaders(bob.token)),
      await call(base, demoHeaders(bob.token), 'DELETE')
    ];
    assert.deepEqual(attempts.map(a => a.status), [404, 404, 404, 404, 404, 404]);

    const after = (await call(base, demoHeaders(alice.token))).body.payment;
    assert.equal(after.status, before.status);
    assert.equal(after.callbackCount, before.callbackCount);
    assert.equal(after.inquiryBehavior, before.inquiryBehavior);
  });

  test('the admin\'s list leaves visitors\' payments out, and the admin can still open one', async () => {
    const visitor = await signInDemo(sandbox.baseUrl);
    const [invoice] = await listFor(sandbox.baseUrl, demoHeaders(visitor.token));

    const adminInvoices = await listFor(sandbox.baseUrl, adminHeaders());
    assert.ok(!adminInvoices.some(i => i.startsWith('DEMO-')), adminInvoices.join(', '));

    const opened = await call(`${sandbox.baseUrl}/api/admin/payments/${invoice}`, adminHeaders());
    assert.equal(opened.status, 200);
  });

  test('a visitor may read the config but not change it, and may not read logs or clear payments', async () => {
    const visitor = await signInDemo(sandbox.baseUrl);
    const headers = demoHeaders(visitor.token);

    assert.equal((await call(`${sandbox.baseUrl}/api/admin/config`, headers)).status, 200);
    assert.equal((await call(`${sandbox.baseUrl}/api/admin/response-codes`, headers)).status, 200);

    const write = await postJson(`${sandbox.baseUrl}/api/admin/config`, { globalDelay: 5000 }, headers);
    assert.equal(write.status, 403);
    const config = (await call(`${sandbox.baseUrl}/api/admin/config`, adminHeaders())).body.config;
    assert.equal(config.globalDelay, 0);

    assert.equal((await call(`${sandbox.baseUrl}/api/admin/logs`, headers)).status, 403);

    const clear = await postJson(`${sandbox.baseUrl}/api/admin/payments/clear`, {}, headers);
    assert.equal(clear.status, 403);
    assert.equal((await listFor(sandbox.baseUrl, headers)).length, 10);
  });

  test('a token that was never issued is not a visitor', async () => {
    const forged = `demo_${'A'.repeat(43)}`;
    assert.equal((await call(`${sandbox.baseUrl}/api/admin/payments`, demoHeaders(forged))).status, 401);
    assert.equal((await call(`${sandbox.baseUrl}/api/admin/payments`, demoHeaders('demo'))).status, 401);
  });

  test('a visitor\'s callback goes to their own inspector, never to an address they name', async () => {
    const receiver = await startReceiver();
    try {
      const visitor = await signInDemo(sandbox.baseUrl);
      const headers = demoHeaders(visitor.token);
      const [invoice] = await listFor(sandbox.baseUrl, headers);
      const url = `${sandbox.baseUrl}/api/admin/payments/${invoice}/callback`;

      const redirected = await postJson(url, { callbackUrl: receiver.url }, headers);
      assert.equal(redirected.status, 403);

      const delivered = await postJson(url, {}, headers);
      assert.equal(delivered.status, 200, JSON.stringify(delivered.body));

      const inspected = await call(`${sandbox.baseUrl}/api/inspect/${visitor.inspectorSessionId}`, JSON_HEADERS);
      assert.equal(inspected.body.captures.length, 1);
      assert.equal(receiver.requests.length, 0, 'the named address was called');
    } finally {
      await receiver.stop();
    }
  });
});

describe('the published demo password can never be the admin password', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox({ ADMIN_PASSWORD: 'demo' });
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('an admin password of "demo" opens nothing, and "demo" still signs in a visitor', async () => {
    const asAdmin = await call(`${sandbox.baseUrl}/api/admin/logs`, { 'X-Admin-Password': 'demo' });
    assert.equal(asAdmin.status, 401);

    const visitor = await signInDemo(sandbox.baseUrl);
    assert.equal((await call(`${sandbox.baseUrl}/api/admin/logs`, demoHeaders(visitor.token))).status, 403);
  });
});

describe('demo visitors expire, and there is a ceiling on how many', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox({ DEMO_TTL_SECONDS: '1', DEMO_MAX_LIVE_PAYMENTS: '10' });
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('a full instance refuses the next visitor; an expired one is swept to make room', async () => {
    const first = await signInDemo(sandbox.baseUrl);
    const [invoice] = await listFor(sandbox.baseUrl, demoHeaders(first.token));

    const refused = await postJson(`${sandbox.baseUrl}/api/admin/login`, { password: 'demo' });
    assert.equal(refused.status, 503);

    await new Promise(r => setTimeout(r, 1300));
    assert.equal((await call(`${sandbox.baseUrl}/api/admin/payments`, demoHeaders(first.token))).status, 401);

    await signInDemo(sandbox.baseUrl);
    const swept = await call(`${sandbox.baseUrl}/api/admin/payments/${invoice}`, adminHeaders());
    assert.equal(swept.status, 404, 'the expired visitor\'s payment was not deleted');
  });
});

describe('demo rate limits', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox({ RATE_LIMIT_MAX: '12' });
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('sign-in has its own bucket of ten, which browsing does not spend', async () => {
    // Spend most of the shared bucket on the provider API first.
    for (let i = 0; i < 11; i++) {
      await fetch(`${sandbox.baseUrl}/api/2c2p/info`);
    }

    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await postJson(`${sandbox.baseUrl}/api/admin/login`, { password: 'wrong' })).status);
    }
    assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
  });

  test('a visitor on the admin routes is held to the shared limit; the admin is not', async () => {
    const visitor = await signInDemoAfterReset(sandbox.baseUrl);
    const statuses = [];
    for (let i = 0; i < 13; i++) {
      statuses.push((await call(`${sandbox.baseUrl}/api/admin/payments`, demoHeaders(visitor.token))).status);
    }
    assert.ok(statuses.includes(429), `no request was limited: ${statuses.join(', ')}`);

    for (let i = 0; i < 13; i++) {
      assert.equal((await call(`${sandbox.baseUrl}/api/admin/payments`, adminHeaders())).status, 200);
    }
  });
});

/**
 * Sign in once the previous test's minute has passed, if it needs to.
 * @param {string} baseUrl - Sandbox origin
 */
async function signInDemoAfterReset(baseUrl) {
  for (;;) {
    const { status, body } = await postJson(`${baseUrl}/api/admin/login`, { password: 'demo' });
    if (status === 200) return body;
    assert.equal(status, 429, JSON.stringify(body));
    await new Promise(r => setTimeout(r, 1000));
  }
}

describe('a visitor\'s payment cannot hold a request past the ceiling', () => {
  let sandbox;
  const CEILING_MS = 500;

  before(async () => {
    sandbox = await startSandbox({ MOCK_MAX_DELAY_MS: String(CEILING_MS) });
  });

  after(async () => {
    await sandbox?.stop();
  });

  const timedInquiry = async (invoiceNo) => {
    const started = Date.now();
    const response = await fetch(`${sandbox.baseUrl}/api/2c2p/inquiry`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ invoiceNo }),
      signal: AbortSignal.timeout(8000)
    });
    return { status: response.status, elapsed: Date.now() - started };
  };

  test('a delay a visitor sets is cut to the ceiling', { timeout: 15000 }, async () => {
    const visitor = await signInDemo(sandbox.baseUrl);
    const [invoice] = await listFor(sandbox.baseUrl, demoHeaders(visitor.token));
    await postJson(`${sandbox.baseUrl}/api/admin/payments/${invoice}/inquiry-config`,
      { behavior: 'delay', delay: 600000 }, demoHeaders(visitor.token));

    const { status, elapsed } = await timedInquiry(invoice);
    assert.equal(status, 200);
    assert.ok(elapsed < CEILING_MS + 2000, `a ten-minute delay held the request for ${elapsed}ms`);
  });

  test('a timeout a visitor sets ends at the ceiling with a 504', { timeout: 15000 }, async () => {
    const visitor = await signInDemo(sandbox.baseUrl);
    const [invoice] = await listFor(sandbox.baseUrl, demoHeaders(visitor.token));
    await postJson(`${sandbox.baseUrl}/api/admin/payments/${invoice}/inquiry-config`,
      { behavior: 'timeout' }, demoHeaders(visitor.token));

    const { status, elapsed } = await timedInquiry(invoice);
    assert.equal(status, 504);
    assert.ok(elapsed >= CEILING_MS - 50, `answered after ${elapsed}ms, before the ceiling`);
  });

  // The pair: the ceiling is the visitor's, not everyone's.
  test('an admin payment\'s delay is still honoured past the ceiling', { timeout: 15000 }, async () => {
    const invoiceNo = `ADMIN-${Date.now()}`;
    await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo, amount: 100 });
    await postJson(`${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/inquiry-config`,
      { behavior: 'delay', delay: CEILING_MS * 3 }, adminHeaders());

    const { elapsed } = await timedInquiry(invoiceNo);
    assert.ok(elapsed >= CEILING_MS * 3 - 50, `took ${elapsed}ms`);
  });
});
