/**
 * Links the sandbox hands a merchant must lead back to the sandbox.
 *
 * A pending Omise charge carries `authorize_uri`, and a merchant redirects the
 * payer there. It pointed at Omise's own 3-D Secure host for card charges, and
 * source objects carried a link to a route this sandbox never served, so
 * following either left the sandbox or reached a 404, and a charge made from a
 * redirect source had no link at all. A 2C2P QR payment's image URL named one
 * fixed deployment whatever instance issued it, the Direct API's QR, wallet and
 * bank flows linked to pages that did not exist, and an Omise source's QR
 * image lived on the provider's domain. These tests follow each link the way a
 * merchant would.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, startReceiver, postJson, uniqueInvoice, adminHeaders } from './helpers.js';

describe('links the sandbox hands out', () => {
  let sandbox;
  let receiver;

  before(async () => {
    sandbox = await startSandbox();
    receiver = await startReceiver();
  });

  after(async () => {
    await receiver?.stop();
    await sandbox?.stop();
  });

  /** Follow a charge's authorize_uri and check it lands on this charge. */
  async function assertAuthorizesHere(charge, amount) {
    const uri = charge.authorize_uri;
    assert.ok(uri, `expected an authorize_uri on a pending charge, got ${uri}`);
    assert.ok(
      uri.startsWith(`${sandbox.baseUrl}/mock-pay/`),
      `authorize_uri must stay on this sandbox, got ${uri}`
    );

    const page = await fetch(uri);
    assert.equal(page.status, 200, `the authorize page answered ${page.status}`);

    const token = decodeURIComponent(uri.split('/mock-pay/')[1]);
    const info = await (await fetch(`${sandbox.baseUrl}/api/2c2p/info?token=${encodeURIComponent(token)}`)).json();
    assert.equal(info.payment?.amount, amount / 100, 'the authorize page resolves to a different payment');
  }

  test('a card charge authorizes on this sandbox, and says so again when fetched', async () => {
    const { body } = await postJson(`${sandbox.baseUrl}/api/omise/charges`, {
      amount: 120000,
      currency: 'thb',
      card: 'tokn_test_card',
      return_uri: receiver.url
    });
    const charge = body.data;
    assert.equal(charge.status, 'pending');
    await assertAuthorizesHere(charge, 120000);

    const fetched = await (await fetch(`${sandbox.baseUrl}/api/omise/charges/${charge.id}`)).json();
    assert.equal(fetched.authorize_uri ?? fetched.data?.authorize_uri, charge.authorize_uri);
  });

  test('a redirect source carries no authorize_uri; the charge made from it does', async () => {
    const { body: sourceBody } = await postJson(`${sandbox.baseUrl}/api/omise/sources`, {
      amount: 80000,
      currency: 'thb',
      type: 'internet_banking_scb'
    });
    const source = sourceBody.data ?? sourceBody;
    assert.ok(source.id?.startsWith('src_'), `expected a src_ id, got ${source.id}`);
    assert.equal(source.authorize_uri, undefined, 'a source object has no authorize_uri in the Omise API');

    const { body } = await postJson(`${sandbox.baseUrl}/api/omise/charges`, {
      amount: 80000,
      currency: 'thb',
      source: source.id,
      return_uri: receiver.url
    });
    await assertAuthorizesHere(body.data, 80000);
  });

  test('a 2C2P QR payment points at a QR image this instance serves', async () => {
    const invoiceNo = uniqueInvoice();
    const { body: token } = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 1500,
      currencyCode: 'THB',
      description: 'QR link test',
      backendReturnUrl: receiver.url
    });
    assert.equal(token.respCode, '0000');

    const { body } = await postJson(`${sandbox.baseUrl}/api/2c2p/payment`, {
      paymentToken: token.paymentToken,
      payment: { code: { channelCode: 'PPQR' }, data: {} }
    });
    assert.equal(body.respCode, '1005');
    assert.ok(
      body.data.startsWith(`${sandbox.baseUrl}/api/2c2p/qr/`),
      `the QR image must be served by this sandbox, got ${body.data}`
    );

    const image = await fetch(body.data);
    assert.equal(image.status, 200);
    assert.match(await image.text(), /1500\.00/, 'the QR image is for a different payment');
  });

  for (const paymentMethod of ['QR', 'DPAY', 'IB']) {
    test(`a Direct API ${paymentMethod} payment links to a page this instance serves`, async () => {
      const { body } = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
        invoiceNo: uniqueInvoice(),
        amount: 900,
        currencyCode: 'THB',
        paymentMethod,
        backendReturnUrl: receiver.url
      });
      const link = body.webPaymentUrl;
      assert.ok(
        link?.startsWith(`${sandbox.baseUrl}/mock-pay/`),
        `${paymentMethod} must link to this sandbox's payment page, got ${link}`
      );
      const page = await fetch(link);
      assert.equal(page.status, 200, `${paymentMethod}'s payment page answered ${page.status}`);
    });
  }

  test('an Omise QR source points at a QR image this instance serves', async () => {
    const { body } = await postJson(`${sandbox.baseUrl}/api/omise/sources`, {
      amount: 50000,
      currency: 'thb',
      type: 'promptpay'
    });
    const source = body.data ?? body;
    const uri = source.scannable_code?.image?.download_uri;
    assert.ok(
      uri?.startsWith(`${sandbox.baseUrl}/api/omise/sources/`),
      `the QR image must be served by this sandbox, got ${uri}`
    );
    const image = await fetch(uri);
    assert.equal(image.status, 200, `the QR image answered ${image.status}`);
    assert.match(image.headers.get('content-type') ?? '', /image\/svg\+xml/);
  });

  test('a QR image escapes the invoice number drawn into it', async () => {
    // An invoice number is whatever the caller sent, and the image is an SVG on
    // the sandbox's own origin: markup in it would run there.
    const invoiceNo = `QR<script>alert(1)</script>${Date.now()}`;
    const { body: token } = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 100,
      currencyCode: 'THB',
      backendReturnUrl: receiver.url
    });
    assert.equal(token.respCode, '0000');
    const { body } = await postJson(`${sandbox.baseUrl}/api/2c2p/payment`, {
      paymentToken: token.paymentToken,
      payment: { code: { channelCode: 'PPQR' }, data: {} }
    });
    const svg = await (await fetch(body.data)).text();
    assert.ok(!svg.includes('<script'), 'the invoice number reached the SVG unescaped');
    assert.ok(svg.includes('&lt;script'), 'the invoice number is missing from the image');
  });
});

describe('links in a webhook, with no MOCK_SERVER_URL set', () => {
  let sandbox;
  let receiver;

  before(async () => {
    sandbox = await startSandbox({ MOCK_SERVER_URL: '' });
    receiver = await startReceiver();
  });

  after(async () => {
    await receiver?.stop();
    await sandbox?.stop();
  });

  test('a pending charge\'s webhook links to the instance the charge was made on', async () => {
    // A webhook is built with no request to read an origin from. Without the
    // one recorded at creation it fell back to localhost:3000.
    const invoiceNo = uniqueInvoice();
    const { body } = await postJson(`${sandbox.baseUrl}/api/omise/charges`, {
      amount: 70000,
      currency: 'thb',
      card: 'tokn_test_card',
      metadata: { invoiceNo },
      webhook_endpoints: [receiver.url]
    });
    assert.equal(body.data.status, 'pending');

    const before = receiver.requests.length;
    await postJson(`${sandbox.baseUrl}/api/admin/payments/${encodeURIComponent(invoiceNo)}/callback`, {}, adminHeaders());
    const [delivered] = (await receiver.waitFor(before + 1)).slice(before);
    const uri = delivered.body.data?.authorize_uri;
    assert.ok(
      uri?.startsWith(`${sandbox.baseUrl}/mock-pay/`),
      `the webhook's authorize_uri must point at this instance, got ${uri}`
    );
  });
});
