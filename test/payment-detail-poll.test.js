/**
 * What the payment page's ten-second refresh may and may not do to the reader.
 *
 * It re-rendered the whole page from the server's copy each time, including the
 * "Inquiry simulation" form — so a behaviour chosen but not yet saved was put
 * back every ten seconds. It polled in a hidden tab. A failed poll replaced the
 * invoice heading with "Error: …" on a page that had loaded fine a moment
 * before. And an answer to an older request could arrive after a newer one and
 * put the older state back on screen.
 *
 * Run in a VM against the page's own script, with fetch held so a test chooses
 * when an answer arrives.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PAGE_SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'payment-detail.js'),
  'utf8'
);

const payment = (overrides = {}) => ({
  invoiceNo: 'INV-1',
  status: 'pending',
  amount: 100,
  currencyCode: 'THB',
  merchantID: 'M1',
  paymentToken: 'tok',
  inquiryBehavior: 'normal',
  inquiryDelay: 5000,
  statusHistory: [],
  callbackHistory: [],
  ...overrides
});

function loadPage() {
  const held = [];
  const intervals = [];
  const elements = {};
  const element = (id) =>
    (elements[id] ??= {
      value: '',
      checked: false,
      textContent: '',
      innerHTML: '',
      className: '',
      title: '',
      disabled: false,
      style: {},
      classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
      appendChild() {}
    });

  const document = {
    hidden: false,
    title: '',
    body: { classList: { add() {} }, prepend() {} },
    addEventListener() {},
    querySelectorAll: () => [],
    getElementById: element
  };
  const context = vm.createContext({
    window: { location: { pathname: '/payment/INV-1', href: '' } },
    document,
    localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    fetch: () => new Promise((resolve, reject) => held.push({ resolve, reject })),
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    setTimeout: () => 1,
    console: { ...console, error() {}, log() {}, debug() {} }
  });
  vm.runInContext(PAGE_SCRIPT, context);

  const ok = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body)
  });
  return {
    element,
    document,
    intervals,
    asked: () => held.length,
    run: (code) => vm.runInContext(code, context),
    /** Answers the request at `index` among those still waiting. */
    answer: (index, body) => held.splice(index, 1)[0].resolve(ok({ success: true, payment: body })),
    fail: (index, error) => held.splice(index, 1)[0].reject(error)
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('the Inquiry simulation form during a refresh', () => {
  async function loadedWith(overrides) {
    const page = loadPage();
    const first = page.run('loadPayment()');
    page.answer(0, payment(overrides));
    await first;
    return page;
  }

  test('keeps a behaviour the reader has chosen and not yet saved', async () => {
    const page = await loadedWith();
    assert.equal(page.element('inquiry-behavior').value, 'normal');

    page.element('inquiry-behavior').value = 'delay';
    page.element('inquiry-delay').value = '9000';
    const poll = page.run('loadPayment()');
    page.answer(0, payment());
    await poll;

    assert.equal(page.element('inquiry-behavior').value, 'delay');
    assert.equal(page.element('inquiry-delay').value, '9000');
  });

  test('still follows the server when the stored setting itself changed', async () => {
    const page = await loadedWith();

    const poll = page.run('loadPayment()');
    page.answer(0, payment({ inquiryBehavior: 'timeout' }));
    await poll;

    assert.equal(page.element('inquiry-behavior').value, 'timeout');
  });

  test('shows what was saved, once the server returns it', async () => {
    const page = await loadedWith({ inquiryBehavior: 'delay', inquiryDelay: 5000 });
    page.element('inquiry-delay').value = '9000';

    // Only the delay differs from what was shown: saving it must still be seen.
    const afterSave = page.run('loadPayment()');
    page.answer(0, payment({ inquiryBehavior: 'delay', inquiryDelay: 7000 }));
    await afterSave;

    assert.equal(String(page.element('inquiry-delay').value), '7000');
  });
});

describe('the ten-second refresh', () => {
  test('does not ask while the tab is hidden', async () => {
    const page = loadPage();
    page.document.hidden = true;
    page.run('refreshPayment()');
    assert.equal(page.asked(), 0);

    page.document.hidden = false;
    page.run('refreshPayment()');
    assert.equal(page.asked(), 1);
  });

  test('is the timer the page actually starts', async () => {
    const page = loadPage();
    assert.equal(page.intervals.length, 1);
    assert.equal(page.intervals[0].ms, 10000);

    page.document.hidden = true;
    page.intervals[0].fn();
    assert.equal(page.asked(), 0, 'a hidden tab was polled');

    page.document.hidden = false;
    page.intervals[0].fn();
    assert.equal(page.asked(), 1);
  });

  test('a failed refresh leaves the page as it was', async () => {
    const page = loadPage();
    const first = page.run('loadPayment()');
    page.answer(0, payment());
    await first;
    assert.equal(page.element('invoice-display').textContent, 'INV-1');

    const poll = page.run('refreshPayment()');
    page.fail(0, new Error('network down'));
    await poll;

    assert.equal(page.element('invoice-display').textContent, 'INV-1');
  });

  test('a failed first load still says so', async () => {
    const page = loadPage();
    const first = page.run('loadPayment()');
    page.fail(0, new Error('network down'));
    await first;

    assert.match(page.element('invoice-display').textContent, /Error: network down/);
  });

  test('an older request failing does not report an error the newer one may clear', async () => {
    const page = loadPage();
    const older = page.run('loadPayment()');
    const newer = page.run('loadPayment()');

    page.fail(0, new Error('network down'));
    await older;
    assert.equal(page.element('invoice-display').textContent, '', 'a superseded failure was shown');

    page.answer(0, payment());
    await newer;
    assert.equal(page.element('invoice-display').textContent, 'INV-1');
  });

  test('an older answer arriving late does not replace a newer one', async () => {
    const page = loadPage();
    const older = page.run('loadPayment()');
    const newer = page.run('loadPayment()');

    page.answer(1, payment({ status: 'success' }));
    await newer;
    page.answer(0, payment({ status: 'pending' }));
    await older;

    assert.equal(page.element('status-badge').textContent, 'SUCCESS');
  });
});
