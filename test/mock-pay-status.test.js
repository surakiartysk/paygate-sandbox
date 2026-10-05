/**
 * What the hosted payment page says about a payment, and how it learns.
 *
 * It said "Waiting for payment confirmation... The Admin Dashboard will update
 * the status" and then never looked again, so the status the admin set was
 * invisible until the reader reloaded. And a payment that had expired fell
 * through every branch of the status display, leaving the markup's own default:
 * a green "Payment completed!" on a payment that had not been paid.
 *
 * The page's inline script runs here in a VM, with fetch held so a test chooses
 * what the server says and when.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mock-pay.html'), 'utf8');
const PAGE_SCRIPT = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];

/** What the markup itself says before any script touches the message: the default a missed branch leaves behind. */
const MARKUP_DEFAULT = /id="completed-message"[^>]*>([\s\S]*?)<\/div>/.exec(html)[1].trim();

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function openPage(firstStatus) {
  let status = firstStatus;
  let fail = null;
  let asks = 0;
  let gate = null;
  const intervals = [];
  const cleared = [];
  const elements = {};
  // textContent and innerHTML are one thing, as in a browser: setting either
  // replaces what the other reads, so a branch that sets one cannot leave the
  // markup's default showing through the other.
  const element = (id) => {
    if (elements[id]) return elements[id];
    let markup = id === 'completed-message' ? MARKUP_DEFAULT : '';
    return (elements[id] = {
      className: '',
      style: {},
      get innerHTML() { return markup; },
      set innerHTML(value) { markup = String(value); },
      get textContent() { return markup.replace(/<[^>]*>/g, ''); },
      set textContent(value) { markup = String(value); }
    });
  };

  const document = { hidden: false, getElementById: element };
  const context = vm.createContext({
    window: { location: { pathname: '/mock-pay/tok_1', href: '' } },
    document,
    fetch: async () => {
      asks++;
      if (gate) await gate;
      if (fail) throw fail;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            success: true,
            payment: { invoiceNo: 'INV-1', status, amount: 100, currencyCode: 'THB', merchantID: 'M1' }
          })
      };
    },
    URL,
    Intl,
    alert() {},
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval: (id) => cleared.push(id),
    console: { ...console, error() {} }
  });
  vm.runInContext(PAGE_SCRIPT, context);
  await settle();

  return {
    element,
    document,
    intervals,
    cleared,
    asks: () => asks,
    serverNowSays: (next) => { status = next; },
    serverDrops: (error) => { fail = error; },
    /** Holds every answer from now until the returned function is called. */
    hold: () => {
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      return () => { gate = null; release(); };
    },
    run: (code) => vm.runInContext(code, context),
    poll: async () => { intervals.at(-1).fn(); await settle(); }
  };
}

describe('the completed message', () => {
  test('does not call an expired payment completed', async () => {
    const page = await openPage('expired');

    const message = page.element('completed-message');
    assert.doesNotMatch(message.innerHTML, /completed/i);
    assert.match(message.innerHTML, /Payment expired/);
    assert.equal(page.element('pay-status').textContent, 'EXPIRED');
  });

  test('says nothing hopeful about a status it does not know', async () => {
    const page = await openPage('refunded');

    const message = page.element('completed-message');
    assert.doesNotMatch(message.innerHTML, /completed/i);
  });

  test('still says completed for a success', async () => {
    const page = await openPage('success');

    assert.match(page.element('completed-message').innerHTML, /completed successfully/i);
  });
});

describe('a payment that is still pending', () => {
  test('is asked about again, and shows the status the admin sets', async () => {
    const page = await openPage('pending');
    assert.equal(page.intervals.length, 1, 'a pending page polls');
    assert.equal(page.element('waiting-state').style.display, 'block');

    page.serverNowSays('success');
    await page.poll();

    assert.equal(page.element('pay-status').textContent, 'SUCCESS');
    assert.equal(page.element('waiting-state').style.display, 'none');
    assert.match(page.element('completed-message').innerHTML, /completed successfully/i);
  });

  test('stops asking once it is no longer pending', async () => {
    const page = await openPage('pending');
    page.serverNowSays('failed');
    await page.poll();

    assert.deepEqual(page.cleared, [1]);
  });

  test('keeps asking while it is still pending', async () => {
    const page = await openPage('pending');
    await page.poll();

    assert.deepEqual(page.cleared, []);
    assert.equal(page.element('pay-status').textContent, 'PENDING');
  });

  test('does not send a second request while the first has not answered', async () => {
    const page = await openPage('pending');
    const before = page.asks();

    const release = page.hold();
    await page.poll();
    await page.poll();
    assert.equal(page.asks(), before + 1);

    release();
    await settle();
  });

  test('loading the payment again does not start a second timer', async () => {
    const page = await openPage('pending');
    await page.run('loadPayment()');
    await settle();

    assert.equal(page.intervals.length, 1);
  });

  test('does not ask while the tab is hidden', async () => {
    const page = await openPage('pending');
    const before = page.asks();

    page.document.hidden = true;
    await page.poll();
    assert.equal(page.asks(), before);

    page.document.hidden = false;
    await page.poll();
    assert.equal(page.asks(), before + 1);
  });

  test('keeps the payment on screen through a poll that dropped', async () => {
    const page = await openPage('pending');
    assert.equal(page.element('error-state').style.display, undefined);

    page.serverDrops(new Error('network down'));
    await page.poll();

    assert.notEqual(page.element('error-state').style.display, 'block');
    assert.equal(page.element('payment-details').style.display, 'block');
  });

  test('a payment that is already settled is not polled at all', async () => {
    const page = await openPage('success');

    assert.equal(page.intervals.length, 0);
  });
});
