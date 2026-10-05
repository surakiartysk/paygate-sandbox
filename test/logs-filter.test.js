/**
 * The request log's filters look at every log, not at the page being shown.
 *
 * The handler fetched one page of the newest logs and then filtered that page,
 * so a filter could only find what was already among the newest fifty: an
 * older request for the same invoice answered "No logs yet" with a total of
 * zero, and "page 2 of the token logs" could never exist. Retention is capped
 * (MAX_TOTAL_LOGS), so scanning for a filtered query is bounded.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, postJson, adminHeaders, uniqueInvoice } from './helpers.js';

describe('filtering the request log', () => {
  let sandbox;
  let oldInvoice;
  const NEWER = 60;

  before(async () => {
    sandbox = await startSandbox();
    oldInvoice = uniqueInvoice();

    // The one request we will look for, made first so sixty newer ones bury it
    // beyond the default page of fifty.
    await postJson(`${sandbox.baseUrl}/api/2c2p/inquiry`, { invoiceNo: oldInvoice });
    for (let i = 0; i < NEWER; i++) {
      await postJson(`${sandbox.baseUrl}/api/2c2p/token`, { invoiceNo: uniqueInvoice(), amount: 100 });
    }
  });

  after(async () => {
    await sandbox?.stop();
  });

  const logs = async (query) => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/logs?${query}`, { headers: adminHeaders() });
    assert.equal(response.status, 200);
    return response.json();
  };

  test('finds an invoice whose logs are older than the first page', async () => {
    const body = await logs(`invoiceNo=${oldInvoice}`);
    assert.equal(body.logs.length, 1);
    assert.equal(body.logs[0].invoiceNo, oldInvoice);
    assert.equal(body.pagination.total, 1);
  });

  test('finds a type whose logs are all older than the first page', async () => {
    const body = await logs('type=inquiry');
    assert.equal(body.logs.length, 1);
    assert.equal(body.pagination.total, 1);
  });

  test('pages through a filtered list, and the total counts the whole of it', async () => {
    const first = await logs('type=token&limit=25&page=1');
    const third = await logs('type=token&limit=25&page=3');

    assert.equal(first.pagination.total, NEWER);
    assert.equal(first.pagination.totalPages, 3);
    assert.equal(first.logs.length, 25);
    assert.equal(third.logs.length, NEWER - 50);
    assert.equal(third.pagination.hasNext, false);
    assert.ok(third.logs.every((log) => log.type === 'token'));
    const ids = new Set([...first.logs, ...third.logs].map((log) => log.id));
    assert.equal(ids.size, first.logs.length + third.logs.length, 'no log appears on two pages');
  });

  test('an unfiltered request still pages the newest first', async () => {
    const body = await logs('limit=10');
    assert.equal(body.logs.length, 10);
    assert.equal(body.pagination.total, NEWER + 1);
    assert.ok(body.logs.every((log) => log.type === 'token'), 'the newest are token logs');
  });
});
