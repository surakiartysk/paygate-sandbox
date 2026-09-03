/**
 * End-to-end payment flows against a live sandbox instance.
 *
 * Each test drives the sandbox the way a merchant backend would: create a
 * payment through the provider API, move it through its lifecycle via the
 * admin API, and assert on the callback that lands on a local receiver.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, startReceiver, adminHeaders, postJson, uniqueInvoice } from './helpers.js';

describe('payment flows', () => {
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

  test('2C2P: token request returns a payment token and redirect URL', async () => {
    const invoiceNo = uniqueInvoice();
    const { status, body } = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 1500,
      currencyCode: 'THB',
      description: 'Smoke test',
      backendReturnUrl: receiver.url
    });

    assert.equal(status, 200);
    assert.equal(body.respCode, '0000');
    assert.ok(body.paymentToken, 'expected a paymentToken');
    assert.ok(body.webPaymentUrl, 'expected a webPaymentUrl');
  });

  test('2C2P: inquiry reports a new payment as in progress', async () => {
    const invoiceNo = uniqueInvoice();
    await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 500,
      backendReturnUrl: receiver.url
    });

    const { status, body } = await postJson(`${sandbox.baseUrl}/api/2c2p/inquiry`, { invoiceNo });

    assert.equal(status, 200);
    assert.equal(body.invoiceNo, invoiceNo);
    assert.equal(body.respCode, '2001', 'a pending payment reports 2001 (in progress)');
  });

  test('2C2P: a successful payment produces a 0000 callback', async () => {
    const invoiceNo = uniqueInvoice();
    await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 2500,
      backendReturnUrl: receiver.url
    });

    const before = receiver.requests.length;

    const { status } = await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      { sequence: [{ status: 'success', respCode: '0000', delayAfter: 0 }] },
      adminHeaders()
    );
    assert.equal(status, 200);

    const [received] = (await receiver.waitFor(before + 1)).slice(before);
    const payload = received.body.payload;
    assert.equal(payload.invoiceNo, invoiceNo);
    assert.equal(payload.respCode, '0000');
    assert.equal(payload.amount, '2500.00', 'amount is formatted to 2 decimal places');
    assert.ok(payload.approvalCode, 'a successful payment carries an approval code');
  });

  test('2C2P: a failed payment carries the requested decline code', async () => {
    const invoiceNo = uniqueInvoice();
    await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 100,
      backendReturnUrl: receiver.url
    });

    const before = receiver.requests.length;

    await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      { sequence: [{ status: 'failed', respCode: '4010', delayAfter: 0 }] },
      adminHeaders()
    );

    const [received] = (await receiver.waitFor(before + 1)).slice(before);
    assert.equal(received.body.payload.respCode, '4010');
    assert.match(received.body.payload.respDesc, /insufficient/i);
  });

  test('custom fields are merged into the callback payload', async () => {
    const invoiceNo = uniqueInvoice();
    await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 750,
      backendReturnUrl: receiver.url
    });

    const before = receiver.requests.length;

    await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      {
        sequence: [{ status: 'success', respCode: '0000', delayAfter: 0 }],
        customFields: { orderRef: 'ORD-42', tenant: 'acme' }
      },
      adminHeaders()
    );

    const [received] = (await receiver.waitFor(before + 1)).slice(before);
    const payload = received.body.payload;
    assert.equal(payload.orderRef, 'ORD-42');
    assert.equal(payload.tenant, 'acme');
    // Provider fields survive alongside the custom ones.
    assert.equal(payload.invoiceNo, invoiceNo);
    assert.equal(payload.respCode, '0000');
  });

  test('a callback sequence delivers every step in order', async () => {
    const invoiceNo = uniqueInvoice();
    await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 300,
      backendReturnUrl: receiver.url
    });

    const before = receiver.requests.length;

    await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      {
        sequence: [
          { status: 'pending', respCode: '2001', delayAfter: 0 },
          { status: 'success', respCode: '0000', delayAfter: 0 }
        ]
      },
      adminHeaders()
    );

    const delivered = (await receiver.waitFor(before + 2)).slice(before);
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0].body.payload.respCode, '2001');
    assert.equal(delivered[1].body.payload.respCode, '0000');
  });

  test('Omise: creating a charge returns a charge object', async () => {
    const { status, body } = await postJson(`${sandbox.baseUrl}/api/omise/charges`, {
      amount: 10000,
      currency: 'thb',
      description: 'Smoke test charge',
      return_uri: receiver.url
    });

    assert.equal(status, 200);
    const charge = body.data;
    assert.equal(charge.object, 'charge');
    assert.ok(charge.id?.startsWith('chrg_'), `expected a chrg_ id, got ${charge.id}`);
    assert.equal(charge.amount, 10000);
    assert.equal(charge.currency, 'thb');
  });

  test('Omise: a charge can be fetched back by id', async () => {
    const created = await postJson(`${sandbox.baseUrl}/api/omise/charges`, {
      amount: 5000,
      currency: 'thb',
      return_uri: receiver.url
    });

    const chargeId = created.body.data.id;
    const response = await fetch(`${sandbox.baseUrl}/api/omise/charges/${chargeId}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.id ?? body.data?.id, chargeId);
    assert.equal(body.amount ?? body.data?.amount, 5000);
  });

  test('inquiry on an unknown invoice reports not found', async () => {
    const { body } = await postJson(`${sandbox.baseUrl}/api/2c2p/inquiry`, {
      invoiceNo: 'DOES-NOT-EXIST-12345'
    });

    assert.equal(body.respCode, '2002', 'unknown transactions report 2002');
  });
});
