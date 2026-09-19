/**
 * What the record says was delivered, against what was delivered.
 *
 * The sandbox's job is to show an integrator which callbacks went out. A
 * callback that arrives and is not written down is that job failing quietly:
 * the API answers success, the receiver has it, and the dashboard does not.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, postJson, adminHeaders, uniqueInvoice } from './helpers.js';

describe('callback history under concurrency', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  /**
   * Fires `count` callbacks at one invoice at once and reports both numbers.
   *
   * The inspector is the independent witness here. Asserting history against
   * itself would pass no matter what was lost — the point is that the record
   * and the receiver disagree, so the receiver has to be asked.
   */
  async function raceCallbacks(count, body) {
    const { body: session } = await postJson(`${sandbox.baseUrl}/api/inspect`, {});
    const sink = `${sandbox.baseUrl}/api/inspect/${session.sessionId}`;
    const invoiceNo = uniqueInvoice();

    await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 100,
      backendReturnUrl: sink
    });

    await Promise.all(
      Array.from({ length: count }, () =>
        postJson(`${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`, body, adminHeaders())
      )
    );

    const captured = await (await fetch(sink)).json();
    const record = await (
      await fetch(`${sandbox.baseUrl}/api/admin/payments/${invoiceNo}`, {
        headers: adminHeaders()
      })
    ).json();
    const payment = record.payment ?? record;

    return {
      delivered: captured.captures.length,
      recorded: (payment.callbackHistory || []).length,
      count: payment.callbackCount
    };
  }

  test('records every single callback that was actually delivered', async () => {
    const { delivered, recorded, count } = await raceCallbacks(6, {});

    assert.equal(delivered, 6, 'all six must reach the receiver');
    assert.equal(recorded, delivered, 'every delivered callback must be in the history');
    assert.equal(count, delivered, 'callbackCount must agree with the history it counts');
  });

  test('records every callback in a sequence too', async () => {
    const { delivered, recorded, count } = await raceCallbacks(6, {
      sequence: [{ status: 'success', respCode: '0000', delayAfter: 0 }]
    });

    // This path re-read the payment before appending and was already correct.
    // It is here so a change to the shared append cannot regress it unnoticed.
    assert.equal(recorded, delivered);
    assert.equal(count, delivered);
  });

  test('keeps the record intact under heavier concurrency', async () => {
    // Six was enough to lose three before the fix. Thirty is here because a
    // narrower window is still a window: if this ever regresses on the local
    // store, a larger burst is what shows it.
    const { delivered, recorded } = await raceCallbacks(30, {});

    assert.equal(delivered, 30);
    assert.equal(recorded, 30);
  });
});
