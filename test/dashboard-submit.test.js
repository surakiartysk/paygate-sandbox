/**
 * What happens when a dashboard action is triggered twice before its first
 * request has answered.
 *
 * "Update Status" kept its modal open for the whole request and nothing marked
 * the action as under way, so a second click sent a second request — and, with
 * "send a callback afterwards" ticked, opened the callback modal twice. The
 * callback senders closed their modal first and then disabled a button inside
 * it: the button was out of sight while it was disabled, and still disabled
 * when the modal was opened again, so the reader met a "Send" that did nothing
 * and said nothing.
 *
 * Run in a VM against the page's own script, as dashboard-refresh.test.js does,
 * with `fetch` held so a test chooses when an answer arrives.
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

function loadPage() {
  const posts = [];
  const held = [];
  const elements = {};
  const element = (id) =>
    (elements[id] ??= {
      value: '',
      checked: false,
      textContent: '',
      innerHTML: '',
      style: {},
      disabled: false,
      classList: { contains: () => false, add() {}, remove() {}, toggle() {} }
    });

  const context = vm.createContext({
    window: {},
    // dialog.js is a second script on the page, like custom-fields.js; its focus handling is not what is
    // under test here, so opening and closing a dialog stand in as what they did before it.
    Dialog: { open: (el) => el.classList.add('active'), close: (el) => el.classList.remove('active') },
    localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    document: { hidden: false, addEventListener() {}, querySelectorAll: () => [], getElementById: element },
    fetch: (url, options = {}) => {
      if (options.method === 'POST') posts.push(String(url));
      return new Promise((resolve, reject) => held.push({ resolve, reject }));
    },
    URLSearchParams,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (fn) => { fn(); return 1; },
    console: { ...console, debug() {}, log() {} }
  });
  vm.runInContext(PAGE_SCRIPT, context);
  // custom-fields.js is a second script on the page; its three functions are
  // not what is under test, so they are stood in for after dashboard.js loads.
  vm.runInContext(
    `var __toasts = []; showToast = (message, kind) => { __toasts.push(kind + ': ' + message); };
     loadPayments = () => {}; openCallbackModal = () => { __openedCallback++; }; var __openedCallback = 0;
     getCustomFields = () => null; resetCustomFields = () => {};`,
    context
  );

  const run = (code) => vm.runInContext(code, context);
  const ok = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
  return {
    posts,
    run,
    toasts: () => run('__toasts'),
    openedCallback: () => run('__openedCallback'),
    /**
     * Answers every request still waiting. All of them, so a page that sent
     * one too many fails an assertion instead of leaving a promise pending.
     */
    answer: (body) => held.splice(0).forEach((request) => request.resolve(ok(body))),
    fail: (error) => held.splice(0).forEach((request) => request.reject(error))
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function openStatusModalFor(page, invoiceNo, { sendCallback = false } = {}) {
  page.run(`currentInvoiceNo = ${JSON.stringify(invoiceNo)};
    document.getElementById('new-status').value = 'success';
    document.getElementById('resp-code-group').style.display = 'none';
    document.getElementById('send-callback-after').checked = ${sendCallback};`);
}

describe('Update Status pressed twice', () => {
  test('sends one request, and opens the callback modal once', async () => {
    const page = loadPage();
    openStatusModalFor(page, 'INV-1', { sendCallback: true });

    const first = page.run('confirmUpdateStatus()');
    const second = page.run('confirmUpdateStatus()');
    page.answer({ success: true });
    await Promise.all([first, second]);
    await settle();

    assert.equal(page.posts.length, 1, `sent ${page.posts.join(', ')}`);
    assert.equal(page.openedCallback(), 1);
  });

  test('can be used again once the first has answered', async () => {
    const page = loadPage();
    openStatusModalFor(page, 'INV-1');
    const first = page.run('confirmUpdateStatus()');
    page.answer({ success: true });
    await first;

    openStatusModalFor(page, 'INV-1');
    const again = page.run('confirmUpdateStatus()');
    page.answer({ success: true });
    await again;

    assert.equal(page.posts.length, 2);
  });

  test('can be tried again after the request failed', async () => {
    const page = loadPage();
    openStatusModalFor(page, 'INV-1');
    const first = page.run('confirmUpdateStatus()');
    page.fail(new Error('network down'));
    await first;
    assert.match(page.toasts().join('\n'), /Failed to update status: network down/);

    openStatusModalFor(page, 'INV-1');
    const again = page.run('confirmUpdateStatus()');
    page.answer({ success: true });
    await again;

    assert.equal(page.posts.length, 2);
  });
});

describe('an action that throws outright', () => {
  /*
   * The senders catch their own request errors, so what reaches `once` as a
   * rejection is a fault in the page itself — here a toast that cannot be
   * shown. It must still let go of the action, or the reader is locked out of
   * it until they reload.
   */
  test('does not leave the action locked', async () => {
    const page = loadPage();
    openStatusModalFor(page, 'INV-1');
    page.run(`var __realToast = showToast; showToast = () => { throw new Error('toast broke'); };`);
    const first = page.run('confirmUpdateStatus()');
    page.answer({ success: true });
    await assert.rejects(first, /toast broke/);

    page.run('showToast = __realToast');
    openStatusModalFor(page, 'INV-1');
    const again = page.run('confirmUpdateStatus()');
    page.answer({ success: true });
    await again;

    assert.equal(page.posts.length, 2);
  });
});

describe('sending a callback while one is still on its way', () => {
  const openSequence = (page, invoiceNo) =>
    page.run(`currentInvoiceNo = ${JSON.stringify(invoiceNo)}; callbackMode = 'sequence';
      callbackSequence = [{ status: 'success', respCode: '0000', delayAfter: 0 }];`);

  test('a second send for the same invoice is refused, and says why', async () => {
    const page = loadPage();
    openSequence(page, 'INV-1');
    const first = page.run('handleCallbackSend()');
    openSequence(page, 'INV-1');
    page.run('handleCallbackSend()');

    assert.equal(page.posts.length, 1);
    assert.match(page.toasts().join('\n'), /already being sent/);
    assert.equal(page.run('currentInvoiceNo'), 'INV-1', 'the modal keeps what the reader built');

    page.answer({ success: true, results: [{ responseTime: 5 }] });
    await first;
  });

  test('another invoice is not held up by it', async () => {
    const page = loadPage();
    openSequence(page, 'INV-1');
    page.run('handleCallbackSend()');
    openSequence(page, 'INV-2');
    page.run('handleCallbackSend()');

    assert.equal(page.posts.length, 2);
  });

  test('the same invoice can be sent again once the first has answered', async () => {
    const page = loadPage();
    openSequence(page, 'INV-1');
    const first = page.run('handleCallbackSend()');
    page.answer({ success: true, results: [{ responseTime: 5 }] });
    await first;

    openSequence(page, 'INV-1');
    page.run('handleCallbackSend()');

    assert.equal(page.posts.length, 2);
  });

  test('a custom payload is held to the same rule', async () => {
    const page = loadPage();
    page.run(`validateCallbackPayload = () => ({ a: 1 });`);
    const custom = (invoiceNo) => page.run(`currentInvoiceNo = ${JSON.stringify(invoiceNo)}; callbackMode = 'custom';`);
    custom('INV-1');
    const first = page.run('handleCallbackSend()');
    custom('INV-1');
    page.run('handleCallbackSend()');

    assert.equal(page.posts.length, 1);
    assert.match(page.toasts().join('\n'), /already being sent/);
    assert.equal(page.run('currentInvoiceNo'), 'INV-1', 'the modal keeps what the reader built');
    page.answer({ success: true, result: { responseTime: 1 } });
    await first;
  });
});
