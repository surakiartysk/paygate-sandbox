/**
 * What the request log keeps, and what it must not.
 *
 * The log stores request headers and is readable through the dashboard, on
 * disk, for seven days. `sanitizeHeaders` exists to keep credentials out of
 * it, and it worked — for the four header names somebody thought of in
 * advance. `x-admin-password`, the one credential this application actually
 * defines, was not among them, so a request carrying both logged
 * `"authorization": "[REDACTED]"` beside `"x-admin-password": "mockpay"`.
 *
 * Every test here asserts on the stored log rather than on the function, so a
 * change anywhere in the path from handler to disk is caught.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, postJson, adminHeaders, uniqueInvoice } from './helpers.js';
import { sanitizeHeaders } from '../lib/logger.js';

describe('credential redaction in the request log', () => {
  let sandbox;
  let headers;

  before(async () => {
    sandbox = await startSandbox();

    // One logged request carrying a spread of headers: two on the explicit
    // list, one that only the pattern catches, and one that must survive.
    await postJson(
      `${sandbox.baseUrl}/api/2c2p/token`,
      { invoiceNo: uniqueInvoice(), amount: 100 },
      {
        'Content-Type': 'application/json',
        Authorization: 'Bearer super-secret-value',
        'X-Admin-Password': 'test-password',
        'X-Webhook-Signature': 'sig-abc-123',
        'X-Custom-Trace': 'keep-me'
      }
    );

    headers = await storedTokenHeaders();
  });

  after(async () => {
    await sandbox?.stop();
  });

  async function storedTokenHeaders() {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/logs`, { headers: adminHeaders() });
    const { logs } = await response.json();
    const entry = logs.find((l) => l.type === 'token');

    assert.ok(entry, 'the token request must have been logged at all');
    return entry.request.headers;
  }

  test('redacts the admin password', async () => {
    assert.equal(headers['x-admin-password'], '[REDACTED]');
  });

  test('still redacts the headers it always knew about', async () => {
    assert.equal(headers.authorization, '[REDACTED]');
  });

  test('redacts a credential-shaped name nobody listed', async () => {
    // Nothing names `x-webhook-signature`; only the pattern catches it.
    assert.equal(headers['x-webhook-signature'], '[REDACTED]');
  });

  test('leaves an ordinary header readable', async () => {
    // The pair that matters: redacting everything would pass all three tests
    // above and make the log useless.
    assert.equal(headers['x-custom-trace'], 'keep-me');
    assert.equal(headers['content-type'], 'application/json');
  });

  test('no secret survives anywhere in the stored entry', async () => {
    // Asserting per-key can miss a copy somewhere else in the record, so this
    // searches the whole serialised entry.
    const response = await fetch(`${sandbox.baseUrl}/api/admin/logs`, { headers: adminHeaders() });
    const { logs } = await response.json();
    const serialised = JSON.stringify(logs);

    for (const secret of ['super-secret-value', 'sig-abc-123']) {
      assert.ok(!serialised.includes(secret), `'${secret}' is still in the log`);
    }
    // `test-password` is the admin password this sandbox runs with.
    assert.ok(!serialised.includes('test-password'), 'the admin password is still in the log');
  });
});

/*
 * Casing, which no request through the server can reach.
 *
 * Node lowercases the header names it parses, and `logCallback` passes no
 * headers at all, so every name `sanitizeHeaders` sees today is already
 * lowercase. Removing the `toLowerCase` leaves every test above green.
 *
 * It is kept because the moment outbound callback headers are logged the names
 * arrive in their conventional casing — `Content-Type`, `User-Agent`, and
 * whatever signature header comes with them. Pinned here, where the two can
 * actually differ.
 */
describe('sanitizeHeaders, called directly', () => {
  test('redacts regardless of how the name is cased', () => {
    const result = sanitizeHeaders({
      Authorization: 'Bearer x',
      'X-Admin-Password': 'pw',
      'X-Webhook-Signature': 'sig'
    });

    assert.equal(result.Authorization, '[REDACTED]');
    assert.equal(result['X-Admin-Password'], '[REDACTED]');
    assert.equal(result['X-Webhook-Signature'], '[REDACTED]');
  });

  test('lowercases the name before consulting the explicit list', () => {
    /*
     * `Cookie` is the case that actually tests this, and finding that out took
     * a mutation that should have failed and did not.
     *
     * The pattern carries the `i` flag, so `Authorization` matches it whatever
     * the casing — which means removing the `toLowerCase` leaves the test
     * above green and proves nothing about the list. `cookie` is the only
     * entry the pattern does not also catch, so it is the only name whose
     * redaction depends on the lowercasing alone.
     */
    const result = sanitizeHeaders({ Cookie: 'session=abc' });

    assert.equal(result.Cookie, '[REDACTED]');
  });

  test('keeps the original casing of the names it returns', () => {
    // Lowercasing the keys would quietly change what a reader of the log sees.
    const result = sanitizeHeaders({ 'Content-Type': 'application/json' });

    assert.deepEqual(result, { 'Content-Type': 'application/json' });
  });

  test('handles no headers at all', () => {
    assert.deepEqual(sanitizeHeaders(null), {});
    assert.deepEqual(sanitizeHeaders(undefined), {});
    assert.deepEqual(sanitizeHeaders({}), {});
  });
});

