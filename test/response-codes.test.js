/**
 * The 2C2P response codes the sandbox answers with, checked against what the
 * codes mean.
 *
 * A sandbox is only useful if a code it sends means what the provider means by
 * it: an integration that maps 4051 to "card expired" here will mislabel every
 * real insufficient-funds decline. Card declines are 40 followed by the ISO 8583
 * response code — 14 invalid card number, 51 insufficient funds, 54 expired
 * card — and the sandbox had all three on the wrong numbers. It also answered a
 * duplicate invoice number with 0003, which is "transaction is cancelled", and
 * described forced 0001 and 0003 as merchant and currency errors when they are
 * the pending and cancelled statuses.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, postJson, uniqueInvoice } from './helpers.js';

describe('2C2P response codes', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  async function tokenWithForcedError(code) {
    const { body } = await postJson(
      `${sandbox.baseUrl}/api/2c2p/token`,
      { invoiceNo: uniqueInvoice(), amount: 100 },
      { 'Content-Type': 'application/json', 'x-mock-error': code }
    );
    return body;
  }

  test('a duplicate invoice number is 9015, not the cancelled status', async () => {
    const invoiceNo = uniqueInvoice();
    const first = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo, amount: 100 });
    assert.equal(first.body.respCode, '0000');

    const { body } = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo, amount: 100 });
    assert.equal(body.respCode, '9015');
  });

  test('card declines carry the ISO 8583 code after 40', async () => {
    const cases = [
      ['insufficient_funds', '4051'],
      ['invalid_card_number', '4014'],
      ['expired_card', '4054'],
    ];
    for (const [reason, expected] of cases) {
      const body = await tokenWithForcedError(reason);
      assert.equal(body.respCode, expected, `${reason} must decline with ${expected}`);
    }
  });

  test('each card code describes the decline it is', async () => {
    assert.equal((await tokenWithForcedError('4051')).respDesc, 'Insufficient funds');
    assert.equal((await tokenWithForcedError('4014')).respDesc, 'Invalid card number');
    assert.equal((await tokenWithForcedError('4054')).respDesc, 'Expired card');
  });

  test('0001 and 0003 are the pending and cancelled statuses', async () => {
    assert.equal((await tokenWithForcedError('0001')).respDesc, 'Transaction is pending');
    assert.equal((await tokenWithForcedError('0003')).respDesc, 'Transaction is cancelled');
  });
});
