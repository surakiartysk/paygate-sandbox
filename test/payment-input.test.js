/**
 * What the public provider APIs accept, and how long they keep it.
 *
 * Three faults, all reachable without signing in:
 *
 * - `"invoiceNo": 12345` was stored as a number. The dashboard's Payments and
 *   Logs tabs called `.slice` on it and stopped rendering, and the admin
 *   search called `.toLowerCase` on it and answered 500 — the admin's own
 *   screens, broken by one anonymous request until the row was deleted by hand.
 * - Every field was stored at whatever size it arrived.
 * - Nothing was ever dropped: a payment created once was kept for ever.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { startSandbox, adminHeaders, postJson, uniqueInvoice } from './helpers.js';

const listPayments = async (baseUrl, query = '') =>
  fetch(`${baseUrl}/api/admin/payments${query}`, { headers: adminHeaders() });

describe('what a payment may be created from', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('2C2P refuses an invoice number that is not a string, and stores nothing', async () => {
    const { body } = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo: 12345, amount: 100 });
    assert.equal(body.respCode, '9004');
    assert.match(body.respDesc, /invoiceNo/);

    const inquiry = await postJson(`${sandbox.baseUrl}/api/2c2p/inquiry`, { invoiceNo: '12345' });
    assert.notEqual(inquiry.body.respCode, '2001', 'the refused payment was stored anyway');
    assert.equal((await listPayments(sandbox.baseUrl, '?search=123')).status, 200);
  });

  test('a log entry records the invoice number as a string, whatever the request held', async () => {
    // Inquiry stores nothing, so it has no reason to refuse — but it logs.
    await postJson(`${sandbox.baseUrl}/api/2c2p/inquiry`, { invoiceNo: 777001 });
    const { logs } = await (await fetch(`${sandbox.baseUrl}/api/admin/logs`, { headers: adminHeaders() })).json();
    const entry = logs.find(log => String(log.invoiceNo) === '777001');
    assert.ok(entry, 'the inquiry was not logged');
    assert.equal(entry.invoiceNo, '777001');
  });

  test('2C2P takes an invoice number of 50 characters and refuses 51, as 2C2P does', async () => {
    const at = len => postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo: 'I'.repeat(len - 6) + uniqueInvoice().slice(-6), amount: 100 });
    assert.equal((await at(50)).body.respCode, '0000');
    assert.equal((await at(51)).body.respCode, '9004');
  });

  test('2C2P refuses a request larger than 16 KB', async () => {
    const { status, body } = await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo: uniqueInvoice(), amount: 100, description: 'x'.repeat(17 * 1024)
    });
    assert.equal(status, 413);
    assert.equal(body.respCode, '9004');
  });

  test('Omise refuses a metadata invoice number that is not a string, and a request over 16 KB', async () => {
    const charge = body => postJson(`${sandbox.baseUrl}/api/omise/charges`, { amount: 10000, currency: 'thb', ...body });

    const numeric = await charge({ metadata: { invoiceNo: 12345 } });
    assert.equal(numeric.status, 400);
    assert.match(numeric.body.message, /invoiceNo/);

    const large = await charge({ description: 'x'.repeat(17 * 1024) });
    assert.equal(large.status, 413);

    assert.equal((await charge({ metadata: { invoiceNo: uniqueInvoice() } })).status, 200);
  });
});

describe('a payment stored before the API checked the type', () => {
  let sandbox;
  let dataDir;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'paygate-legacy-'));
    const legacy = { invoiceNo: 12345, provider: '2c2p', status: 'pending', amount: 100, createdAt: new Date().toISOString() };
    writeFileSync(join(dataDir, 'payments.json'), JSON.stringify({ payments: { 12345: legacy }, paymentsList: [12345] }));
    sandbox = await startSandbox({ DATA_DIR: dataDir });
  });

  after(async () => {
    await sandbox?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('is listed with its invoice number as a string, and the search still answers', async () => {
    const listed = await (await listPayments(sandbox.baseUrl)).json();
    assert.equal(listed.payments[0].invoiceNo, '12345');

    const searched = await listPayments(sandbox.baseUrl, '?search=234');
    assert.equal(searched.status, 200);
    assert.equal((await searched.json()).payments.length, 1);
  });
});

test('the dashboard shortens an invoice number that arrives as a number instead of throwing', () => {
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'dashboard.js'), 'utf8');
  const context = vm.createContext({
    window: {},
    localStorage: { getItem: () => null, removeItem() {} },
    document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => ({}) },
    console
  });
  vm.runInContext(script, context);

  assert.equal(vm.runInContext('truncateInvoiceNo(12345)', context), '12345');
  assert.equal(vm.runInContext("truncateInvoiceNo('X'.repeat(30))", context), 'X'.repeat(20) + '...');
});

describe('payments are dropped when their time is up', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox({ PAYMENT_TTL_SECONDS: '1' });
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('a payment created through the API is gone once its retention has passed', async () => {
    const invoiceNo = uniqueInvoice();
    await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo, amount: 100 });
    assert.equal((await fetch(`${sandbox.baseUrl}/api/admin/payments/${invoiceNo}`, { headers: adminHeaders() })).status, 200);

    await new Promise(r => setTimeout(r, 1300));
    assert.equal((await fetch(`${sandbox.baseUrl}/api/admin/payments/${invoiceNo}`, { headers: adminHeaders() })).status, 404);
  });
});
