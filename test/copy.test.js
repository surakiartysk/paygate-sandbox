/**
 * The words on the payments page and the payment page (decision 24).
 *
 * A review of every visible string found three kinds of trouble. One was untrue: the callback dialog
 * told the owner to configure presets in "Settings → Custom field presets", and no such screen exists.
 * One thing had three names: the table said "Machine", the filter "Self Service", the page "Self Service
 * Machine". And the rest was a register: Title Case on some labels and not others, "Yes, Clear All
 * Payments", "Failed to …" beside "Callback failed: …", "payment(s)". Each is held here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const dashboard = read('public/dashboard.html');
const payment = read('public/payment.html');
const dashboardJs = read('public/js/dashboard.js');
const paymentJs = read('public/js/payment-detail.js');

const toasts = (source) => [...source.matchAll(/showToast\(([^;]+?), '(error|success)'\)/g)].map((m) => m[1]);

describe('what the pages claim', () => {
  test('point the owner at the presets as they are: a key of the config API, with no form', () => {
    for (const page of [dashboard, payment]) {
      assert.doesNotMatch(page, /Settings → Custom field presets/);
      assert.match(page, /<code>customFieldPresets<\/code> through <code>POST \/api\/admin\/config<\/code>; there is no form for them yet/);
    }
    const config = read('api/admin/config.js');
    assert.match(config, /GET\/POST \/api\/admin\/config/);
    assert.match(config, /validKeys = \[[^\]]*'customFieldPresets'/);
  });

  test('say a deleted payment takes its callback history with it, which it does: the history is on the record', () => {
    for (const source of [dashboardJs, paymentJs]) {
      assert.match(source, /confirm\(`Delete payment \$\{invoiceNo\} and its callback history\? This cannot be undone\.`/);
    }
    assert.match(read('lib/storage.js'), /payment\.callbackHistory/);
  });
});

describe('one name for one thing', () => {
  test('the method filter offers each method by the name the table shows it under', () => {
    const select = /<select id="method-filter"[\s\S]*?<\/select>/.exec(dashboard)?.[0] ?? '';
    const offered = Object.fromEntries([...select.matchAll(/<option value="(\w+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]).filter(([v]) => v !== 'all'));
    const table = /const methodLabels = (\{[\s\S]*?\});/.exec(dashboardJs)?.[1] ?? '{}';
    const shown = Function(`return ${table}`)();
    assert.ok(Object.keys(offered).length >= 7, Object.keys(offered).join());
    for (const [code, name] of Object.entries(offered)) assert.equal(name, shown[code], code);
  });

  test('a status change is "Change status" on the dialog and its button, on both pages', () => {
    for (const page of [dashboard, payment]) {
      assert.match(page, /<h3 id="status-modal-title" class="modal-title">Change status<\/h3>/);
      assert.match(page, />Change status<\/button>/);
    }
    assert.match(payment, /id="btn-update-status" onclick="openStatusModal\(\)">Change status<\/button>/);
    for (const page of [dashboard, payment]) {
      assert.doesNotMatch(page, /Update Payment Status|>Update Status</);
    }
  });
});

describe('the register', () => {
  test('a toast that reports a failure says what could not be done, and none says "Failed to", "Please" or "successfully"', () => {
    for (const source of [dashboardJs, paymentJs]) {
      const all = toasts(source);
      assert.ok(all.length >= 15, `${all.length} toasts`);
      for (const toast of all) assert.doesNotMatch(toast, /Failed to|Please|successfully|\(s\)/, toast);
    }
    assert.match(dashboardJs, /"Couldn't change the status: "/);
  });

  test('a destructive dialog names its action on the button, not "Yes, …"', () => {
    assert.match(dashboard, /onclick="confirmClearPayments\(\)">Clear all payments<\/button>/);
    assert.match(dashboard, /onclick="confirmClearLogs\(\)">Clear all logs<\/button>/);
    assert.doesNotMatch(dashboard, /Yes, Clear/);
  });

  test('the counts are lower case words after their numbers, as the mockup reads: "10 payments"', () => {
    const labels = [...dashboard.matchAll(/<div class="stat-label">([^<]+)<\/div>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['payments', 'pending', 'success', 'not paid']);
  });

  test('no emoji in the pages', () => {
    for (const [name, page] of [['dashboard.html', dashboard], ['payment.html', payment]]) {
      assert.deepEqual(page.match(/\p{Extended_Pictographic}/gu) || [], [], name);
    }
  });
});

describe('the count under the list, run against the page’s own script', () => {
  function render(state) {
    const container = { innerHTML: '' };
    const context = vm.createContext({
      window: {},
      document: { hidden: false, title: '', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: (id) => (id === 'payments-pagination' ? container : null) },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: () => new Promise(() => {}),
      URLSearchParams,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      console: { ...console, debug() {}, log() {} },
    });
    vm.runInContext(dashboardJs, context);
    vm.runInContext(`paymentsPagination = ${JSON.stringify(state)}; renderPaymentsPagination();`, context);
    return container.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  test('says "1 payment" and "10 payments", not "payment(s)"', () => {
    assert.equal(render({ page: 1, totalPages: 1, total: 1, limit: 20 }), '1 payment');
    assert.equal(render({ page: 1, totalPages: 1, total: 10, limit: 20 }), '10 payments');
  });

  test('says which of them a page shows when there is more than one page', () => {
    assert.match(render({ page: 2, totalPages: 3, total: 45, limit: 20, hasNext: true, hasPrev: true }), /^21–40 of 45 payments/);
  });
});

/**
 * Found with the copy: the callback dialog's list of callbacks, which the scripts write, had two selects
 * with no name and a remove button named "✕". axe found it once the dialog was open; the accessibility
 * pass (decision 22) ran axe on the page with its dialogs closed.
 */
describe('the callbacks in the callback dialog', () => {
  for (const [name, source] of [['dashboard.js', dashboardJs], ['payment-detail.js', paymentJs]]) {
    test(`name every field and the remove button by the number of the callback, in ${name}`, () => {
      const item = /<div class="sequence-item">([\s\S]*?)<\/div>\n  `\)\.join/.exec(source)?.[1] ?? '';
      assert.match(item, /<select aria-label="Status of callback \$\{index \+ 1\}"/);
      assert.match(item, /<select aria-label="Response code of callback \$\{index \+ 1\}"/);
      assert.match(item, /<input type="number" aria-label="Wait after callback \$\{index \+ 1\}, in ms"/);
      assert.match(item, /aria-label="Remove callback \$\{index \+ 1\}">\s*<span aria-hidden="true">✕<\/span>/);
    });
  }
});

describe('what the inquiry setting reaches', () => {
  test('is offered on a 2C2P payment only, because nothing an Omise integration calls reads it', () => {
    assert.match(payment, /<div class="card" id="inquiry-card"/);
    assert.match(paymentJs, /getElementById\('inquiry-card'\)\.hidden = payment\.provider === 'omise';/);
    assert.match(read('public/css/style.css'), /\.card\[hidden\] \{\s*display: none;/);
    assert.doesNotMatch(payment, /inquiry-omise-note/);
    assert.match(read('lib/inquiryHandler.js'), /payment\.inquiryBehavior/);
    const omise = readdirSync(new URL('../api/omise/', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.js'));
    assert.ok(omise.length >= 2, omise.join());
    for (const file of omise) assert.doesNotMatch(read(`api/omise/${file}`), /inquiryBehavior|inquiryDelay|inquiryErrorCode/, file);
  });
});

describe('the wait after a callback', () => {
  for (const [name, source] of [['dashboard.js', dashboardJs], ['payment-detail.js', paymentJs]]) {
    test(`shows its unit beside the number, in ${name}`, () => {
      assert.match(source, /<span class="sequence-item-wait">\s*<input type="number" aria-label="Wait after callback[^>]*>\s*<span aria-hidden="true">ms<\/span>\s*<\/span>/);
    });
  }
});

/**
 * Found with the owner's view, which had no payments locally: the empty row kept the width of eight
 * columns on a phone (491px in a 341px box, so the box scrolled and axe asked for it to be focusable),
 * its column span was 7 of 8 and the error row's 6, the error message went into the page unescaped,
 * and both had an emoji for an icon.
 */
describe('the rows that are not payments', () => {
  const rows = [...dashboardJs.matchAll(/<td colspan="(\d+)">\s*<div class="empty-state">([\s\S]*?)<\/td>/g)];

  test('span the eight columns of either table', () => {
    assert.ok(rows.length >= 4, `${rows.length} rows`);
    for (const [, span] of rows) assert.equal(span, '8');
  });

  test('escape the error they show, and draw no emoji', () => {
    for (const [, , body] of rows) {
      assert.doesNotMatch(body, /\$\{error\.message\}/);
      assert.deepEqual(body.match(/\p{Extended_Pictographic}/gu) || [], []);
    }
    assert.equal((dashboardJs.match(/<p>\$\{escapeHtml\(error\.message\)\}<\/p>/g) || []).length, 2);
  });

  test('are as wide as a phone, not as the columns the phone does not show', () => {
    const css = read('public/css/style.css');
    assert.match(css, /\.payments-table,\s*\.payments-table tbody,\s*\.payments-table tbody tr:not\(\.payment-row\),\s*\.payments-table tbody tr:not\(\.payment-row\) td \{\s*display: block;\s*width: auto;[^}]*white-space: normal;/);
  });
});

/**
 * The settings warned of "Vercel rate limits (100 requests/hour on Hobby plan)", and the script's comment
 * said the same. Vercel's limits page (https://vercel.com/docs/limits, read 10 Oct 2026) names no hourly cap
 * on requests for a Hobby plan; its hundreds are limits on Vercel's own REST API. The warning now says what
 * the page itself does, which the script's constant holds.
 */
describe('the warning about refreshing by itself', () => {
  test('says what the page does, once a minute, and names no hourly cap it cannot show', () => {
    assert.equal(Number(/const POLL_INTERVAL_MS = (\d+);/.exec(dashboardJs)?.[1]), 60000);
    assert.match(dashboard, /Each open dashboard asks once a minute, 60 requests an hour\./);
    for (const source of [dashboard, dashboardJs]) assert.doesNotMatch(source, /100 requests\/hour|Hobby plan's 100/);
  });
});

/**
 * The landing page's footer links were text with no underline, told from the dots between them by a
 * colour that decision 21 made neutral: on the page they read as plain text. Underlined now, as the
 * invoice links are.
 */
describe("the landing page's footer links", () => {
  test('are underlined, at rest and not only under the pointer', () => {
    const css = read('public/css/style.css');
    const rule = /\n\.landing-footer-links a \{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(rule, /text-decoration: underline;/);
    assert.doesNotMatch(rule, /text-decoration: none/);
  });
});

