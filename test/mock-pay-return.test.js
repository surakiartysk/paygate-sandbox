/**
 * Where the hosted payment page's "Return to Merchant" button may send a reader.
 *
 * The address is whatever the caller of the public token API supplied as
 * `frontendReturnUrl`, and the page assigned it to `window.location.href` after
 * adding two query parameters. A `javascript:` address survives that —
 * `javascript:alert(document.domain)//` becomes
 * `javascript:alert(document.domain)//?invoiceNo=...`, the comment swallowing
 * the parameters — so anyone able to create a payment could run a script on this
 * origin in the browser of whoever opened the link and pressed the button.
 * Measured in Chromium before the change: the dialog opened and said
 * "localhost". The payment page in the dashboard already refused such an address
 * when it drew a link; this was the one place that navigated without asking.
 *
 * The page's own inline script runs here in a VM.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mock-pay.html'), 'utf8');
const PAGE_SCRIPT = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];

async function pageFor(frontendReturnUrl) {
  const elements = {};
  const element = (id) =>
    (elements[id] ??= { textContent: '', innerHTML: '', className: '', style: {} });
  const location = { pathname: '/mock-pay/tok_1', href: 'http://sandbox.test/mock-pay/tok_1' };
  const alerts = [];

  const payment = {
    invoiceNo: 'INV-1',
    status: 'pending',
    amount: 100,
    currencyCode: 'THB',
    merchantID: 'M1',
    frontendReturnUrl
  };
  const context = vm.createContext({
    window: { location },
    document: { getElementById: element },
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ success: true, payment })
    }),
    URL,
    Intl,
    alert: (message) => alerts.push(message),
    console: { ...console, error() {} }
  });
  vm.runInContext(PAGE_SCRIPT, context);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));

  return {
    location,
    alerts,
    press: () => vm.runInContext('returnToMerchant()', context)
  };
}

describe('Return to Merchant', () => {
  test('sends the reader to an https address, with the invoice and status added', async () => {
    const page = await pageFor('https://shop.example/thanks');
    page.press();

    const target = new URL(page.location.href);
    assert.equal(target.origin + target.pathname, 'https://shop.example/thanks');
    assert.equal(target.searchParams.get('invoiceNo'), 'INV-1');
    assert.equal(target.searchParams.get('status'), 'pending');
  });

  test('sends the reader to an http address too, which a local merchant uses', async () => {
    const page = await pageFor('http://localhost:5173/done');
    page.press();

    assert.equal(new URL(page.location.href).origin, 'http://localhost:5173');
  });

  for (const hostile of [
    'javascript:alert(document.domain)//',
    'JaVaScRiPt:alert(1)//',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)'
  ]) {
    test(`does not navigate to ${hostile.slice(0, 24)}`, async () => {
      const page = await pageFor(hostile);
      const before = page.location.href;
      page.press();

      assert.equal(page.location.href, before);
      assert.equal(page.alerts.length, 1, 'the reader is told why nothing happened');
    });
  }

  test('says so, rather than throwing, for an address that is not a URL at all', async () => {
    const page = await pageFor('{{returnUrl}}');
    const before = page.location.href;
    page.press();

    assert.equal(page.location.href, before);
    assert.equal(page.alerts.length, 1);
  });
});
