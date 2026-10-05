/**
 * What another origin may do here, and what a page tells the browser.
 *
 * The admin API used to answer every origin, and with it any site a
 * developer visited could read a local instance's payments, request log and
 * config, using the published default password — measured in Chromium from a
 * page on another port. Decision 19.
 *
 * Three layers held that open, so three are held here: vercel.json (what a
 * deployment sends), each admin handler (which set its own headers too), and
 * the dev server's preflight (which had a copy of its own).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { headersFor } from '../lib/vercelHeaders.js';
import { startSandbox } from './helpers.js';

const ADMIN_PATHS = [
  '/api/admin/login',
  '/api/admin/logout',
  '/api/admin/payments',
  '/api/admin/payments/clear',
  '/api/admin/payments/INV-1',
  '/api/admin/payments/INV-1/status',
  '/api/admin/config',
  '/api/admin/response-codes',
  '/api/admin/logs',
];

const PUBLIC_API_PATHS = [
  '/api/2c2p/token',
  '/api/2c2p/inquiry',
  '/api/omise/charges',
  '/api/inspect',
  '/api/inspect/s_abc',
  '/api/demo/scenario',
];

const PAGE_PATHS = ['/', '/dashboard', '/login', '/payment/INV-1', '/mock-pay/tok', '/js/dashboard.js'];

describe('vercel.json', () => {
  test('grants no other origin anything on the admin API', () => {
    for (const path of ADMIN_PATHS) {
      assert.equal(headersFor(path)['Access-Control-Allow-Origin'], undefined, path);
    }
  });

  test('still lets any origin call the provider APIs, as a merchant integration would', () => {
    for (const path of PUBLIC_API_PATHS) {
      assert.equal(headersFor(path)['Access-Control-Allow-Origin'], '*', path);
    }
  });

  test('offers the admin password header to no path', () => {
    for (const path of [...ADMIN_PATHS, ...PUBLIC_API_PATHS]) {
      assert.doesNotMatch(headersFor(path)['Access-Control-Allow-Headers'] ?? '', /x-admin-password/i, path);
    }
  });

  test('tells the browser a page may not be framed or sniffed', () => {
    for (const path of PAGE_PATHS) {
      const headers = headersFor(path);
      assert.match(headers['Content-Security-Policy'] ?? '', /frame-ancestors 'none'/, path);
      assert.equal(headers['X-Content-Type-Options'], 'nosniff', path);
    }
  });

  /*
   * A rule must match the whole path. Read as a search rather than a match,
   * the page rule's lookahead finds a later `/` inside an API path and stamps
   * the page headers on it — the first version of this file never noticed.
   */
  test('keeps the page rule off the API', () => {
    for (const path of [...ADMIN_PATHS, ...PUBLIC_API_PATHS]) {
      assert.equal(headersFor(path)['Content-Security-Policy'], undefined, path);
    }
  });
});

/** A Vercel-shaped response that records what a handler set. */
function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json() { return this; },
    send() { return this; },
    end() { return this; },
  };
}

describe('the admin handlers', () => {
  const handlers = [
    ['login', '../api/admin/login.js', '/api/admin/login'],
    ['logs', '../api/admin/logs.js', '/api/admin/logs'],
    ['config', '../api/admin/config.js', '/api/admin/config'],
    ['payments', '../api/admin/payments/index.js', '/api/admin/payments'],
    ['a payment', '../api/admin/payments/[invoiceNo]/index.js', '/api/admin/payments/INV-1'],
    ['a payment action', '../api/admin/payments/[invoiceNo]/[...slug].js', '/api/admin/payments/INV-1/status'],
  ];

  for (const [name, module, url] of handlers) {
    test(`${name} sets no CORS header of its own, preflight or not`, async () => {
      const { default: handler } = await import(module);
      for (const method of ['OPTIONS', 'GET']) {
        const res = mockResponse();
        await handler({ method, url, headers: {}, query: { invoiceNo: 'INV-1' }, body: {} }, res);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined, `${method} ${url}`);
      }
    });
  }
});

describe('the dev server', () => {
  let sandbox;
  before(async () => { sandbox = await startSandbox(); });
  after(async () => { await sandbox.stop(); });

  const preflight = (path, headers) =>
    fetch(sandbox.baseUrl + path, {
      method: 'OPTIONS',
      headers: { Origin: 'http://elsewhere.example', 'Access-Control-Request-Method': 'GET', ...headers },
    });

  test('fails a preflight for the admin API, so the request itself is never sent', async () => {
    const res = await preflight('/api/admin/payments', { 'Access-Control-Request-Headers': 'x-admin-password' });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  test('passes a preflight for a provider API', async () => {
    const res = await preflight('/api/2c2p/token', { 'Access-Control-Request-Headers': 'content-type' });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  test('answers the admin API without a CORS header, and still answers it', async () => {
    const res = await fetch(`${sandbox.baseUrl}/api/admin/payments`, {
      headers: { 'X-Admin-Password': 'test-password' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  test('sends a page with the headers vercel.json gives it', async () => {
    const res = await fetch(`${sandbox.baseUrl}/dashboard`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});
