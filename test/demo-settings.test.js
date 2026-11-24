/**
 * A demo visitor's own settings and request log — decision 31.
 *
 * Most of these try to go around the scope: one visitor's settings reaching
 * the owner or another visitor, a request without the visitor's token picking
 * up their settings, a visitor reading log entries that are not theirs, a
 * stored delay outlasting the ceiling. Each was proven by breaking the code
 * under test; the mutations are in the commit that added this file.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox, postJson, adminHeaders, uniqueInvoice } from './helpers.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const demoHeaders = (token) => ({ ...JSON_HEADERS, 'X-Demo-Token': token });

async function signInDemo(baseUrl) {
  const { status, body } = await postJson(`${baseUrl}/api/admin/login`, { password: 'demo' });
  assert.equal(status, 200, JSON.stringify(body));
  return body;
}

async function call(url, headers, method = 'GET') {
  const response = await fetch(url, { method, headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

const invoicesOf = async (baseUrl, token) =>
  (await call(`${baseUrl}/api/admin/payments?limit=100`, demoHeaders(token))).body.payments.map((p) => p.invoiceNo);

const settingsOf = async (baseUrl, headers) => (await call(`${baseUrl}/api/admin/config`, headers)).body.config;

/** A 2C2P token request, with or without a visitor's token on it. */
const token2c2p = async (baseUrl, headers = JSON_HEADERS) =>
  (await postJson(`${baseUrl}/api/2c2p/token`, { invoiceNo: uniqueInvoice(), amount: 100 }, headers)).body;

describe('a visitor\'s own settings', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('are kept for that visitor, and reach neither the owner nor another visitor', async () => {
    const alice = await signInDemo(sandbox.baseUrl);
    const bob = await signInDemo(sandbox.baseUrl);

    const saved = await postJson(`${sandbox.baseUrl}/api/admin/config`,
      { globalDelay: 250, duplicateCallback: true }, demoHeaders(alice.token));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const aliceNow = await settingsOf(sandbox.baseUrl, demoHeaders(alice.token));
    assert.equal(aliceNow.globalDelay, 250);
    assert.equal(aliceNow.duplicateCallback, true);

    const bobNow = await settingsOf(sandbox.baseUrl, demoHeaders(bob.token));
    assert.equal(bobNow.globalDelay, 0);
    assert.equal(bobNow.duplicateCallback, false);

    const owner = await settingsOf(sandbox.baseUrl, adminHeaders());
    assert.equal(owner.globalDelay, 0);
    assert.equal(owner.duplicateCallback, false);
  });

  test('may not set retention, or a delay past the ceiling', async () => {
    const visitor = await signInDemo(sandbox.baseUrl);
    const headers = demoHeaders(visitor.token);

    const retention = await postJson(`${sandbox.baseUrl}/api/admin/config`, { logTTLDays: 30 }, headers);
    assert.equal(retention.status, 400);

    const longWait = await postJson(`${sandbox.baseUrl}/api/admin/config`, { globalDelay: 600000 }, headers);
    assert.equal(longWait.status, 400);
    assert.equal((await settingsOf(sandbox.baseUrl, headers)).globalDelay, 0);
  });

  test('apply to a provider request that carries the visitor\'s token, and to no other', async () => {
    const visitor = await signInDemo(sandbox.baseUrl);
    await postJson(`${sandbox.baseUrl}/api/admin/config`, { forceError2c2p: '4005' }, demoHeaders(visitor.token));

    assert.equal((await token2c2p(sandbox.baseUrl, demoHeaders(visitor.token))).respCode, '4005');
    assert.equal((await token2c2p(sandbox.baseUrl)).respCode, '0000', 'a stranger got the visitor\'s error');
  });

  test('a visitor\'s token on a provider request brings their settings, not the owner\'s', async () => {
    const visitor = await signInDemo(sandbox.baseUrl);
    await postJson(`${sandbox.baseUrl}/api/admin/config`, { forceError2c2p: '9999' }, adminHeaders());
    try {
      assert.equal((await token2c2p(sandbox.baseUrl, demoHeaders(visitor.token))).respCode, '0000');
    } finally {
      await postJson(`${sandbox.baseUrl}/api/admin/config`, { forceError2c2p: '' }, adminHeaders());
    }
  });

  test('send a visitor\'s callback twice when they ask, and only theirs', { timeout: 15000 }, async () => {
    const twice = await signInDemo(sandbox.baseUrl);
    const once = await signInDemo(sandbox.baseUrl);
    await postJson(`${sandbox.baseUrl}/api/admin/config`, { duplicateCallback: true }, demoHeaders(twice.token));

    for (const visitor of [twice, once]) {
      const [invoice] = await invoicesOf(sandbox.baseUrl, visitor.token);
      const sent = await postJson(`${sandbox.baseUrl}/api/admin/payments/${invoice}/callback`, {}, demoHeaders(visitor.token));
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
    }

    const captures = async (visitor) =>
      (await call(`${sandbox.baseUrl}/api/inspect/${visitor.inspectorSessionId}`, JSON_HEADERS)).body.captures.length;
    assert.equal(await captures(twice), 2);
    assert.equal(await captures(once), 1);
  });
});

describe('a visitor\'s request log', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  const inquire = (invoiceNo) => postJson(`${sandbox.baseUrl}/api/2c2p/inquiry`, { invoiceNo });

  test('holds the entries for their own invoices and nobody else\'s', async () => {
    const alice = await signInDemo(sandbox.baseUrl);
    const bob = await signInDemo(sandbox.baseUrl);
    const [aliceInvoice] = await invoicesOf(sandbox.baseUrl, alice.token);
    const [bobInvoice] = await invoicesOf(sandbox.baseUrl, bob.token);
    const stranger = uniqueInvoice();

    await inquire(aliceInvoice);
    await inquire(bobInvoice);
    await inquire(stranger);

    const seen = (await call(`${sandbox.baseUrl}/api/admin/logs?limit=100`, demoHeaders(alice.token))).body;
    const invoices = seen.logs.map((log) => log.invoiceNo);
    assert.ok(invoices.includes(aliceInvoice), invoices.join(', '));
    assert.ok(!invoices.includes(bobInvoice), 'Alice read Bob\'s log');
    assert.ok(!invoices.includes(stranger), 'Alice read a stranger\'s log');
    assert.equal(seen.pagination.total, invoices.length, 'the count is of Alice\'s entries, not everyone\'s');

    const all = (await call(`${sandbox.baseUrl}/api/admin/logs?limit=100`, adminHeaders())).body.logs.map((l) => l.invoiceNo);
    assert.ok(all.includes(stranger) && all.includes(bobInvoice), 'the owner still reads everything');
  });
});

describe('a stored visitor delay is held to the ceiling where it is applied', () => {
  let sandbox;
  const CEILING_MS = 500;

  before(async () => {
    sandbox = await startSandbox({ MOCK_MAX_DELAY_MS: String(CEILING_MS) });
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('a ten-minute delay written straight into the store waits only the ceiling', { timeout: 15000 }, async () => {
    const visitor = await signInDemo(sandbox.baseUrl);
    const [invoice] = await invoicesOf(sandbox.baseUrl, visitor.token);
    const ownerId = invoice.split('-')[1];

    // Past the API's own check, as a bad write from any future path would be.
    const file = join(sandbox.dataDir, 'demo-settings.json');
    await postJson(`${sandbox.baseUrl}/api/admin/config`, { globalDelay: 1 }, demoHeaders(visitor.token));
    const records = JSON.parse(readFileSync(file, 'utf8'));
    records[ownerId].settings.globalDelay = 600000;
    writeFileSync(file, JSON.stringify(records));

    const started = Date.now();
    const response = await fetch(`${sandbox.baseUrl}/api/2c2p/token`, {
      method: 'POST',
      headers: demoHeaders(visitor.token),
      body: JSON.stringify({ invoiceNo: uniqueInvoice(), amount: 100 }),
      signal: AbortSignal.timeout(8000)
    });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(elapsed < CEILING_MS + 2000, `a ten-minute stored delay held the request for ${elapsed}ms`);
  });
});
