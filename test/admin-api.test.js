/**
 * Admin API: authentication and configuration.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, adminHeaders, postJson, uniqueInvoice } from './helpers.js';

describe('admin API', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('rejects requests without the admin password', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments`);
    assert.equal(response.status, 401);
  });

  test('rejects requests with the wrong admin password', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments`, {
      headers: { 'X-Admin-Password': 'wrong-password' }
    });
    assert.equal(response.status, 401);
  });

  test('accepts requests with the correct admin password', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments`, {
      headers: adminHeaders()
    });
    assert.equal(response.status, 200);
  });

  test('rejects unknown configuration keys', async () => {
    const { status, body } = await postJson(
      `${sandbox.baseUrl}/api/admin/config`,
      { notARealSetting: true },
      adminHeaders()
    );

    assert.equal(status, 400);
    assert.match(body.error, /invalid config keys/i);
  });

  test('stores and returns custom field presets', async () => {
    const presets = [
      { name: 'Order context', fields: { orderRef: 'ORD-1', tenant: 'acme' } }
    ];

    const saved = await postJson(
      `${sandbox.baseUrl}/api/admin/config`,
      { customFieldPresets: presets },
      adminHeaders()
    );
    assert.equal(saved.status, 200);

    const response = await fetch(`${sandbox.baseUrl}/api/admin/config`, { headers: adminHeaders() });
    const body = await response.json();
    assert.deepEqual(body.config.customFieldPresets, presets);
  });

  test('rejects malformed custom field presets', async () => {
    const { status } = await postJson(
      `${sandbox.baseUrl}/api/admin/config`,
      { customFieldPresets: [{ name: '', fields: 'not-an-object' }] },
      adminHeaders()
    );

    assert.equal(status, 400);
  });

  /*
   * Save on the dashboard's Settings sent `autoRefresh`, which the API did not
   * list, so every Save answered 400 "Invalid config keys: autoRefresh" and the
   * global delay, forced errors, failure rate and duplicate callback could not
   * be set from the page at all. It had been that way since the first commit and
   * nothing exercised Save. Found by the state review, in Chromium.
   *
   * The keys are read from the dashboard's own source rather than copied here:
   * a copy would keep agreeing with the API after the page changed.
   */
  test('accepts every setting the dashboard sends when Save is pressed', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../public/js/dashboard.js', import.meta.url), 'utf8');
    const block = /async function saveConfig\(\) \{[\s\S]*?const newConfig = \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? '';
    const keys = [...block.matchAll(/^\s{6}(\w+):/gm)].map(m => m[1]);

    assert.ok(keys.length >= 5, `found the keys saveConfig sends: ${keys.join(', ')}`);

    const sent = Object.fromEntries(keys.map(k => [k, k.startsWith('force') ? null : k === 'duplicateCallback' || k === 'autoRefresh' ? true : 0]));
    const { status, body } = await postJson(`${sandbox.baseUrl}/api/admin/config`, sent, adminHeaders());

    assert.equal(status, 200, body.error);
    assert.equal(body.config.autoRefresh, true, 'autoRefresh is stored, so the page can read it back');
  });

  test('refuses an autoRefresh that is not a boolean', async () => {
    const { status } = await postJson(`${sandbox.baseUrl}/api/admin/config`, { autoRefresh: 'yes' }, adminHeaders());

    assert.equal(status, 400);
  });

  test('validates numeric configuration bounds', async () => {
    const { status } = await postJson(
      `${sandbox.baseUrl}/api/admin/config`,
      { failureRate: 150 },
      adminHeaders()
    );

    assert.equal(status, 400, 'failureRate above 100 is rejected');
  });
});

/**
 * An invoice number is whatever the caller sent.
 *
 * Nothing validates its character set — `POST /api/2c2p/token` stores what it
 * is given — so `AB/CD` is a perfectly ordinary invoice number to end up with,
 * and the admin API addresses payments by putting that string in a URL path.
 *
 * Both halves have to agree about encoding. The dashboard built the URL by
 * interpolating the raw value, so a slash split the path and the request
 * reached a different route entirely (405, not 404). Encoding it on the way
 * out is only half: the handler matched the path segment with a regex and
 * used it raw, so `AB%2FCD` was looked up literally and found nothing.
 *
 * The effect was that a payment with a slash in its number could be created by
 * anyone through the public API and then not be managed at all — status,
 * callback and delete all missed it.
 */
describe('invoice numbers that need encoding', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('a payment whose number contains a slash can still be read and changed', async () => {
    const invoiceNo = 'AB/CD-' + Date.now();

    const created = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      merchantID: 'M', invoiceNo, description: 'slash test', amount: 100, currencyCode: 'THB'
    });
    assert.equal(created.body.respCode, '0000');

    const encoded = encodeURIComponent(invoiceNo);

    // Read it back.
    const read = await fetch(`${sandbox.baseUrl}/api/admin/payments/${encoded}`, {
      headers: adminHeaders()
    });
    assert.equal(read.status, 200, 'the payment should be reachable by its encoded number');

    // And act on it.
    const changed = await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${encoded}/status`,
      { status: 'success' },
      adminHeaders()
    );
    assert.equal(changed.status, 200, 'its status should be changeable');
  });
});


/**
 * The summary tiles' numbers, from the server.
 *
 * The dashboard counted statuses on the page it had loaded and put them beside
 * a total for every page — so past one page the tiles could not add up — and
 * its third tile left expired payments out altogether. The list now carries
 * counts over every page, filters applied, and the tiles read those.
 */
describe('payment list counts', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('counts every status across all pages, not just the one returned', async () => {
    const statuses = ['pending', 'success', 'failed', 'cancelled', 'expired', 'expired'];
    for (const status of statuses) {
      const invoiceNo = uniqueInvoice();
      await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo, amount: 100 });
      if (status !== 'pending') {
        await postJson(`${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/status`, { status }, adminHeaders());
      }
    }

    // One payment per page, so a count taken from the page could only ever be 1.
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments?limit=1`, { headers: adminHeaders() });
    const body = await response.json();

    assert.equal(body.payments.length, 1);
    assert.deepEqual(body.counts, { pending: 1, success: 1, failed: 1, cancelled: 1, expired: 2 });
    const summed = Object.values(body.counts).reduce((a, b) => a + b, 0);
    assert.equal(summed, body.pagination.total);
  });
});
