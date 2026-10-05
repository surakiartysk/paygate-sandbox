/**
 * How the dashboard's payment list keeps itself current.
 *
 * Three faults, all found by the state review, all in the page's own script, so
 * this runs it in a VM (as dashboard-stats.test.js does) with `fetch` stubbed:
 *
 * - With a filter on, auto-refresh asked for a total the filter did not apply to,
 *   decided the list had changed, reloaded it, and restarted its own timer — which
 *   polls at once. 511 requests in 185 seconds.
 * - A slow answer to an older request overwrote the newer one: the dropdown said
 *   "pending" and the rows said SUCCESS.
 * - On page 2, deleting the only row left an empty page and a footer reading
 *   "Showing 50 payment(s)" with no way back.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PAGE_SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'dashboard.js'),
  'utf8'
);

const row = (invoiceNo, status = 'pending') => ({ invoiceNo, status, amount: 100, callbackCount: 0 });

/** A reply the way the list API shapes it. */
const reply = (payments, { page = 1, total = payments.length, limit = 50 } = {}) => ({
  success: true,
  payments,
  counts: {},
  pagination: {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasNext: false,
    hasPrev: page > 1
  }
});

/**
 * The page's script, loaded with a `fetch` that answers from `serve(url)`.
 * `serve` may return a promise, so a test can hold an answer back.
 */
function loadPage({ filters = {}, serve }) {
  const calls = [];
  const elements = {};
  const element = (id) =>
    (elements[id] ??= {
      value: filters[id] ?? '',
      textContent: '',
      innerHTML: '',
      title: '',
      style: {},
      classList: { contains: () => false, add() {}, remove() {} }
    });

  const context = vm.createContext({
    window: {},
    localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    document: {
      hidden: false,
      addEventListener() {},
      querySelectorAll: () => [],
      getElementById: element
    },
    fetch: async (url) => {
      calls.push(String(url));
      const body = await serve(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body)
      };
    },
    URLSearchParams,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (fn) => fn,
    console: { ...console, debug() {} }
  });
  vm.runInContext(PAGE_SCRIPT, context);

  // What reaches the screen, counted rather than drawn.
  vm.runInContext(
    `var __renders = 0; renderPayments = () => { __renders++; };
     renderPaymentsPagination = () => {}; updateStats = () => {};
     currentTab = 'payments'; autoRefreshEnabled = true;`,
    context
  );
  const run = (code) => vm.runInContext(code, context);
  return { calls, run, shown: () => run('payments.map(p => p.invoiceNo + ":" + p.status).join(",")'), renders: () => run('__renders') };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const settleAll = async () => {
  for (let i = 0; i < 40; i++) await settle();
};

describe('auto-refresh with a filter on', () => {
  /*
   * The server's list is the filtered one. The old poll asked for the unfiltered
   * total (3), which can never equal the filtered count it had stored (2), so it
   * reloaded, restarted its timer, polled at once, and went round again.
   *
   * `serve` stops answering after 40 requests so the old code ends here as it
   * did on a real server — in a burst — rather than hanging the test.
   */
  test('asks once, and does not restart itself into a burst', async () => {
    let served = 0;
    const page = loadPage({
      filters: { 'status-filter': 'pending' },
      serve: (url) => {
        if (++served > 40) return new Promise(() => {});
        return reply(url.includes('status=pending') ? [row('A'), row('B')] : [row('A'), row('B'), row('C', 'success')]);
      }
    });
    await page.run('loadPayments()');
    const before = page.calls.length;

    page.run('startAutoRefresh()');
    await settleAll();

    assert.ok(page.calls.length - before <= 2, `starting auto-refresh made ${page.calls.length - before} requests`);
  });

  test('asks for the list the reader is looking at, and leaves it alone if it has not changed', async () => {
    const page = loadPage({
      filters: { 'status-filter': 'pending' },
      serve: () => reply([row('A'), row('B')])
    });
    await page.run('loadPayments()');
    const renders = page.renders();
    const before = page.calls.length;

    const changed = await page.run('refreshPaymentsIfChanged()');

    assert.equal(page.calls.length - before, 1, 'one request');
    assert.match(page.calls.at(-1), /status=pending/, 'the same filter as the list on screen');
    assert.equal(changed, false);
    assert.equal(page.renders(), renders, 'nothing is redrawn');
  });

  /*
   * The old poll watched only the total, so a payment changed elsewhere — by a
   * callback, or an admin in another tab — never appeared: the server said
   * success, the row said PENDING four minutes later.
   */
  test('shows a status that changed somewhere else', async () => {
    let status = 'pending';
    const page = loadPage({ serve: () => reply([row('A', status)]) });
    await page.run('loadPayments()');
    assert.equal(page.shown(), 'A:pending');

    status = 'success';
    const changed = await page.run('refreshPaymentsIfChanged()');

    assert.equal(changed, true);
    assert.equal(page.shown(), 'A:success');
  });
});

describe('answers that arrive out of order', () => {
  /*
   * A slow answer to the first filter overwrote the answer to the second: the
   * dropdown said "success" and the rows were the pending ones.
   */
  test('the newest request wins, whichever answers last', async () => {
    let releaseFirst;
    const first = new Promise((resolve) => (releaseFirst = resolve));
    let n = 0;
    const page = loadPage({
      filters: { 'status-filter': 'pending' },
      serve: (url) => (++n === 1 ? first : reply([row('S', 'success')]))
    });

    const older = page.run('loadPayments()');
    page.run(`document.getElementById('status-filter').value = 'success'`);
    await page.run('loadPayments()');
    releaseFirst(reply([row('P', 'pending')]));
    await older;
    await settleAll();

    assert.equal(page.shown(), 'S:success');
  });
});

describe('a page that is no longer there', () => {
  /*
   * 51 payments, the reader on page 2, the only row on it deleted: the server
   * answers page 2 of one page — empty — and the table said "No payments yet"
   * under a footer reading "Showing 50 payment(s)" with no way back.
   */
  test('goes to the last page that exists', async () => {
    const page = loadPage({
      serve: (url) => (/page=1\b/.test(url) ? reply([row('A')], { page: 1, total: 50 }) : reply([], { page: 2, total: 50 }))
    });
    page.run('paymentsPagination.page = 2');

    await page.run('loadPayments()');
    await settleAll();

    assert.match(page.calls.at(-1), /page=1\b/);
    assert.equal(page.shown(), 'A:pending');
  });

  // With nothing left the server reports zero pages, and "the last page" is the first.
  test('goes to page 1, not page 0, when no payments are left', async () => {
    const page = loadPage({
      serve: (url) => (/page=1\b/.test(url) ? reply([], { page: 1, total: 0 }) : reply([], { page: 2, total: 0 }))
    });
    page.run('paymentsPagination.page = 2');

    await page.run('loadPayments()');
    await settleAll();

    assert.match(page.calls.at(-1), /page=1\b/);
    assert.equal(page.run('paymentsPagination.page'), 1);
  });
});
