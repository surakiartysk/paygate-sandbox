/**
 * The Direct API section of docs/api.md, run as written.
 *
 * "Paying by QR, without the hosted page" is the only description of three
 * routes — `optionDetails`, `payment` and `qr` — that used to be a table row
 * each. A page that explains a flow step by step is a page a reader follows
 * step by step, so this follows it: the curl commands in the section's first
 * block, in order, with `<paymentToken from step 1>` filled in from step 1's
 * answer, against a throwaway sandbox. It then checks the claims the prose
 * makes that the commands do not show.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSandbox, postJson } from './helpers.js';

const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'api.md'), 'utf8');
const section = doc.slice(doc.indexOf('### Paying by QR, without the hosted page'), doc.indexOf('### Other 2C2P routes'));
const script = /```bash\n([\s\S]*?)```/.exec(section)?.[1];
const haveCurl = spawnSync('curl', ['--version']).status === 0;

/** The commands, split at their step comments, so each can be run and its answer read. */
const steps = (script ?? '').split(/^# \d\..*$/m).slice(1).map((step) => step.trim());

describe('the QR flow in docs/api.md', { skip: !haveCurl && 'curl is not installed' }, () => {
  let sandbox;
  let token;
  let answers;

  before(async () => {
    sandbox = await startSandbox();
    assert.equal(steps.length, 3, 'found the three steps');

    const run = (command) =>
      JSON.parse(
        execFileSync('bash', ['-c', command.replaceAll('http://localhost:3000', sandbox.baseUrl)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        })
      );

    const created = run(steps[0].replace(/curl /, 'curl -s '));
    token = created.paymentToken;
    const withToken = (command) => command.replace('<paymentToken from step 1>', token).replace(/curl /, 'curl -s ');
    answers = { created, options: run(withToken(steps[1])), qr: run(withToken(steps[2])) };
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('offers PromptPay and TrueMoney QR for a QR token, as the prose says', () => {
    assert.deepEqual(
      answers.options.paymentOptions.map((option) => option.channelCode),
      ['PROMPTPAY', 'TRUEMONEYQR']
    );
  });

  test('answers the payment request with the shape the example shows', () => {
    assert.deepEqual(Object.keys(answers.qr).sort(), ['channelCode', 'data', 'expiryDescription', 'respCode', 'respDesc', 'type']);
    assert.equal(answers.qr.respCode, '1005');
    assert.equal(answers.qr.channelCode, 'PPQR');
    assert.match(answers.qr.data, /\/api\/2c2p\/qr\/INV-QR-1/);
  });

  test('serves the address it returns as an SVG, as the prose says', async () => {
    const response = await fetch(answers.qr.data.replace(/^https?:\/\/[^/]+/, sandbox.baseUrl));
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.match(await response.text(), /INV-QR-1/);
  });

  test('leaves the payment pending', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments/INV-QR-1`, { headers: { 'X-Admin-Password': 'test-password' } });
    assert.equal((await response.json()).payment.status, 'pending');
  });

  test('stores the name it was given on the payment record', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments/INV-QR-1`, { headers: { 'X-Admin-Password': 'test-password' } });
    assert.equal((await response.json()).payment.customerName, 'Somchai');
  });

  test('refuses a channel it does not emulate with 9058 and HTTP 200', async () => {
    const response = await postJson(`${sandbox.baseUrl}/api/2c2p/payment`, { paymentToken: token, payment: { code: { channelCode: 'VISA' } } });
    assert.equal(response.status, 200);
    assert.equal(response.body.respCode, '9058');
  });

  test('defaults the channel to PPQR when none is named', async () => {
    const { body } = await postJson(`${sandbox.baseUrl}/api/2c2p/payment`, { paymentToken: token });
    assert.equal(body.channelCode, 'PPQR');
  });

  test('says 9005 without a token and 9040 for one that matches nothing', async () => {
    const missing = await postJson(`${sandbox.baseUrl}/api/2c2p/payment`, {});
    const unknown = await postJson(`${sandbox.baseUrl}/api/2c2p/payment`, { paymentToken: 'mock_token_nothing' });
    assert.equal(missing.body.respCode, '9005');
    assert.equal(unknown.body.respCode, '9040');
  });
});
