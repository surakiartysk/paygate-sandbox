/**
 * A payment that has been settled stays settled when someone asks for a QR code.
 *
 * `POST /api/2c2p/payment` is public: it takes a payment token and nothing
 * else. It wrote `status: 'pending'` unconditionally, so anyone holding the
 * token could reopen a payment an admin had marked successful (or cancelled, or
 * expired) — and with no history entry, so the record read `…>success` beside a
 * status of `pending`. Found by the state review.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, adminHeaders, postJson, uniqueInvoice } from './helpers.js';

describe('asking for a QR code on a settled payment', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  /** A payment, moved to `status` by the admin, and the QR request for its token. */
  async function qrAfter(status) {
    const invoiceNo = uniqueInvoice();
    const { body: token } = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 100
    });

    if (status !== 'pending') {
      await postJson(
        `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/status`,
        { status },
        adminHeaders()
      );
    }

    const { body: qr } = await postJson(`${sandbox.baseUrl}/api/2c2p/payment`, {
      paymentToken: token.paymentToken,
      payment: { code: { channelCode: 'PPQR' }, data: {} }
    });
    const record = await (
      await fetch(`${sandbox.baseUrl}/api/admin/payments/${invoiceNo}`, { headers: adminHeaders() })
    ).json();

    return { qr, payment: record.payment ?? record };
  }

  for (const status of ['success', 'failed', 'cancelled', 'expired']) {
    test(`does not reopen a ${status} payment`, async () => {
      const { qr, payment } = await qrAfter(status);

      assert.equal(payment.status, status, 'the status the admin set must stand');
      assert.equal(qr.respCode, '9040', 'the caller is told the token cannot be used');
    });
  }

  test('still gives a pending payment its QR code', async () => {
    const { qr, payment } = await qrAfter('pending');

    assert.equal(payment.status, 'pending');
    assert.equal(qr.respCode, '1005');
    assert.ok(qr.data, 'a QR url is returned');
  });
});
