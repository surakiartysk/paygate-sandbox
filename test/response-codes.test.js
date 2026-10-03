/**
 * The 2C2P response codes the sandbox answers with, checked against what the
 * provider says they mean.
 *
 * A sandbox is only useful if a code it sends means what the provider means by
 * it: an integration that learns 4051 is "card expired" here will mislabel every
 * real insufficient-funds decline. The sandbox had card declines on the wrong
 * numbers, answered a missing invoice number with 0001 — which is "transaction
 * is pending" — and used 0002, which 2C2P does not define at all, for invalid
 * amounts and tokens.
 *
 * OFFICIAL is copied by hand from the provider's reference
 * (https://developer.2c2p.com/docs/response-code-payment), and only for the
 * codes this sandbox uses. Copying is the point: a list derived from the
 * sandbox's own table would agree with it by construction and prove nothing.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSandbox, postJson, uniqueInvoice, adminHeaders } from './helpers.js';

const OFFICIAL = {
  '0000': 'Successful',
  '0001': 'Transaction is pending',
  '0003': 'Transaction is cancelled',
  '0999': 'System error',
  '2001': 'Transaction in progress',
  '2002': 'Transaction not found',
  '2003': 'Payment / Inquiry Failed',
  '4001': 'Refer to card issuer',
  '4005': 'Do not honor',
  '4014': 'Invalid Card Number',
  '4041': 'Lost Card - Pick Up',
  '4043': 'Stolen Card - Pick Up',
  '4051': 'Insufficient Funds',
  '4054': 'Expired Card',
  '4057': 'Transaction Not Permitted to Cardholder',
  '4061': 'Exceeds Withdrawal Amount Limits',
  '4065': 'Exceeds Withdrawal Frequency Limit',
  '4078': 'Invalid Three Digits Format',
  '4080': 'User Cancellation by Closing Internet Browser',
  '4094': 'Duplicate Transmission',
  '5002': 'Timeout',
  '5005': 'Duplicated Invoice',
  '5006': 'Invalid Amount',
  '5009': 'Payment Expired',
  '5014': 'Authentication Failed',
  '5998': 'Internal Error',
  '9004': 'The [ParameterName] value is not valid',
  '9005': 'Some mandatory fields are missing',
  '9009': 'Amount is invalid',
  '9010': 'Invalid Currency Code',
  '9015': 'Existing Invoice Number',
  '9020': 'Payment Expired ( From V4 Payment API )',
  '9035': 'Payment failed',
  '9040': 'The token is invalid',
  '9058': 'Payment channel invalid',
  '9999': 'Request to merchant backend has failed',
};

// 1005 is a payment-flow code ("display the QR and wait"), from a separate table.
const FLOW_CODES = new Set(['1005']);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.js') ? [path] : [];
  });
}

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

  test('every code in the source is one 2C2P defines', () => {
    const unknown = [];
    for (const file of [...sourceFiles(join(ROOT, 'api')), ...sourceFiles(join(ROOT, 'lib'))]) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/respCode:\s*'(\d{4})'/g)) {
        if (!OFFICIAL[match[1]] && !FLOW_CODES.has(match[1])) {
          unknown.push(`${file.slice(ROOT.length + 1)}: ${match[1]}`);
        }
      }
    }
    assert.deepEqual(unknown, [], 'codes 2C2P does not define, or this table has not checked');
  });

  test('every code the dashboard offers is described as 2C2P describes it', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/response-codes?provider=2c2p`, {
      headers: adminHeaders()
    });
    const body = await response.json();
    const entries = Object.values(body.responseCodes ?? {}).flat();
    assert.ok(entries.length > 10, `expected the 2C2P catalogue, got ${JSON.stringify(body).slice(0, 200)}`);

    const wrong = entries
      .filter(({ code, desc }) => OFFICIAL[code] !== desc)
      .map(({ code, desc }) => `${code}: '${desc}', 2C2P says '${OFFICIAL[code] ?? 'nothing'}'`);
    assert.deepEqual(wrong, []);
  });

  test('a forced code is described as 2C2P describes it', async () => {
    for (const code of ['0001', '0003', '4014', '4051', '4054', '9035', '9999']) {
      assert.equal((await tokenWithForcedError(code)).respDesc, OFFICIAL[code], code);
    }
  });

  test('card declines carry the ISO 8583 code after 40', async () => {
    const cases = [
      ['insufficient_funds', '4051'],
      ['invalid_card_number', '4014'],
      ['invalid_cvc', '4078'],
      ['expired_card', '4054'],
    ];
    for (const [reason, expected] of cases) {
      const body = await tokenWithForcedError(reason);
      assert.equal(body.respCode, expected, `${reason} must decline with ${expected}`);
    }
  });

  test('a duplicate invoice number is 9015, not the cancelled status', async () => {
    const invoiceNo = uniqueInvoice();
    const first = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo, amount: 100 });
    assert.equal(first.body.respCode, '0000');

    const { body } = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo, amount: 100 });
    assert.equal(body.respCode, '9015');
  });

  test('a rejected request answers with a validation code, not a payment status', async () => {
    const missingInvoice = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { amount: 100 });
    assert.equal(missingInvoice.body.respCode, '9005', 'a missing invoiceNo is not a pending payment');

    const badAmount = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo: uniqueInvoice(), amount: -1 });
    assert.equal(badAmount.body.respCode, '9009');

    const badToken = await postJson(`${sandbox.baseUrl}/api/2c2p/payment`, {
      paymentToken: 'no-such-token',
      payment: { code: { channelCode: 'PPQR' }, data: {} }
    });
    assert.equal(badToken.body.respCode, '9040');
  });
});
