/**
 * The payment page finds the payment the dashboard linked it to.
 *
 * The admin API was made to round-trip an invoice number that needs encoding —
 * see 'invoice numbers that need encoding' in admin-api.test.js — but that test
 * builds the API URL itself. The page does not: it reads the number back out
 * of its own path, and `location.pathname` keeps the percent-encoding the
 * dashboard's link put there. Read raw, `AB%2FCD` was encoded a second time on
 * the way to the API, which then looked up `AB%2FCD` literally and found
 * nothing. Every number that needs encoding — a slash, a space, Thai — opened
 * to an empty page.
 *
 * So this runs the page's own script, not a copy of its logic: it is loaded
 * into a VM context with only what it touches before the first fetch, given
 * the path the dashboard links to, and the URL it asks for is sent to a real
 * sandbox.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { startSandbox, postJson, adminHeaders } from './helpers.js';

const PAGE_SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'payment-detail.js'),
  'utf8'
);

/**
 * Load the page at `pathname` and return the URL it fetches the payment from.
 * @param {string} pathname - The path as the browser reports it
 * @returns {Promise<string>} The first URL the page fetched
 */
async function urlThePageFetches(pathname) {
  const fetched = [];
  const context = vm.createContext({
    window: { location: { pathname } },
    localStorage: { getItem: () => '1', removeItem: () => {} },
    document: { addEventListener: () => {}, querySelectorAll: () => [], getElementById: () => null },
    // Record the request and never answer it: everything after the fetch is
    // rendering, which needs a DOM this test does not have.
    fetch: (url) => {
      fetched.push(url);
      return new Promise(() => {});
    },
    // A top-level refresh timer; it must not keep the test process alive.
    setInterval: () => 0,
    console
  });
  vm.runInContext(PAGE_SCRIPT, context);
  context.loadPayment();
  return fetched[0];
}

describe('payment page addressed by an encoded invoice number', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  for (const [label, invoiceNo] of [
    ['a slash', `AB/CD-${Date.now()}`],
    ['a space', `INV 7-${Date.now()}`],
    ['Thai', `ใบแจ้งหนี้-${Date.now()}`],
    ['nothing to encode', `PLAIN${Date.now()}`]
  ]) {
    test(`opens a payment whose number has ${label}`, async () => {
      const created = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo, amount: 100 });
      assert.equal(created.body.respCode, '0000');

      // The link as dashboard.js builds it, and as location.pathname reports it.
      const pathname = `/payment/${encodeURIComponent(invoiceNo)}`;
      const apiUrl = await urlThePageFetches(pathname);

      const response = await fetch(`${sandbox.baseUrl}${apiUrl}`, { headers: adminHeaders() });
      assert.equal(response.status, 200, `the page asked for ${apiUrl}`);
      assert.equal((await response.json()).payment.invoiceNo, invoiceNo);
    });
  }

  test('a path that is not valid percent-encoding still loads the page', async () => {
    // A hand-typed or truncated URL. decodeURIComponent throws on it, and a
    // throw at the top of the script would leave the page without any of its
    // handlers — a 404 from the API is the right answer, a dead page is not.
    const apiUrl = await urlThePageFetches('/payment/AB%E0%B8');
    assert.match(apiUrl, /^\/api\/admin\/payments\//);
  });
});
