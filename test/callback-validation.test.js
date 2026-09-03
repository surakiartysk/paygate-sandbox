/**
 * Input validation on the callback endpoint.
 *
 * These cover the ways a caller can send something the sandbox should refuse:
 * custom fields that try to rewrite the transaction's outcome, malformed
 * sequences, and delays long enough to outlive a serverless function.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, startReceiver, adminHeaders, postJson, uniqueInvoice } from './helpers.js';

describe('callback validation', () => {
  let sandbox;
  let receiver;

  before(async () => {
    sandbox = await startSandbox({ RATE_LIMIT_MAX: '0' });
    receiver = await startReceiver();
  });

  after(async () => {
    await receiver?.stop();
    await sandbox?.stop();
  });

  /**
   * Create a payment pointed at the receiver.
   * @returns {Promise<string>} The new invoice number
   */
  async function createPayment() {
    const invoiceNo = uniqueInvoice();
    await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 100,
      backendReturnUrl: receiver.url
    });
    return invoiceNo;
  }

  test('custom fields cannot overwrite the transaction outcome', async () => {
    const invoiceNo = await createPayment();
    const before = receiver.requests.length;

    await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      {
        sequence: [{ status: 'success', respCode: '0000', delayAfter: 0 }],
        customFields: { respCode: 'HACKED', invoiceNo: 'SOMEONE-ELSE', orderRef: 'ORD-9' }
      },
      adminHeaders()
    );

    const [received] = (await receiver.waitFor(before + 1)).slice(before);
    const payload = received.body.payload;

    assert.equal(payload.respCode, '0000', 'respCode is not overridable');
    assert.equal(payload.invoiceNo, invoiceNo, 'invoiceNo is not overridable');
    assert.equal(payload.orderRef, 'ORD-9', 'non-reserved fields are still merged');
  });

  test('customFields must be an object', async () => {
    const invoiceNo = await createPayment();

    for (const value of ['a string', 42, ['an', 'array']]) {
      const { status } = await postJson(
        `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
        { sequence: [{ status: 'success', delayAfter: 0 }], customFields: value },
        adminHeaders()
      );
      assert.equal(status, 400, `${JSON.stringify(value)} must be rejected`);
    }
  });

  test('an unknown status is rejected', async () => {
    const invoiceNo = await createPayment();

    const { status, body } = await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      { sequence: [{ status: 'not-a-status', delayAfter: 0 }] },
      adminHeaders()
    );

    assert.equal(status, 400);
    assert.match(body.error, /status must be one of/);
  });

  test('a delay long enough to outlive the function is rejected', async () => {
    const invoiceNo = await createPayment();

    const { status, body } = await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      {
        sequence: [
          { status: 'pending', delayAfter: 60000 },
          { status: 'success', delayAfter: 0 }
        ]
      },
      adminHeaders()
    );

    assert.equal(status, 400);
    assert.match(body.error, /delayAfter may not exceed/);
  });

  test('an over-long sequence is rejected', async () => {
    const invoiceNo = await createPayment();

    const { status, body } = await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      { sequence: Array.from({ length: 20 }, () => ({ status: 'success', delayAfter: 0 })) },
      adminHeaders()
    );

    assert.equal(status, 400);
    assert.match(body.error, /at most/);
  });

  test('a delay budget spread across several steps is rejected', async () => {
    const invoiceNo = await createPayment();

    const { status } = await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      {
        sequence: [
          { status: 'pending', delayAfter: 5000 },
          { status: 'pending', delayAfter: 5000 },
          { status: 'success', delayAfter: 0 }
        ]
      },
      adminHeaders()
    );

    assert.equal(status, 400, 'the total delay budget is enforced, not just per step');
  });

  test('a legitimate sequence is still accepted', async () => {
    const invoiceNo = await createPayment();
    const before = receiver.requests.length;

    const { status } = await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      {
        sequence: [
          { status: 'pending', respCode: '2001', delayAfter: 200 },
          { status: 'success', respCode: '0000', delayAfter: 0 }
        ],
        customFields: { orderRef: 'ORD-1' }
      },
      adminHeaders()
    );

    assert.equal(status, 200);
    const delivered = (await receiver.waitFor(before + 2)).slice(before);
    assert.equal(delivered[0].body.payload.respCode, '2001');
    assert.equal(delivered[1].body.payload.respCode, '0000');
    assert.equal(delivered[1].body.payload.orderRef, 'ORD-1');
  });
});
