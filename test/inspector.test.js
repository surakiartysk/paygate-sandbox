/**
 * Built-in callback inspector and the guided demo scenario.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, postJson, adminHeaders, uniqueInvoice } from './helpers.js';

describe('callback inspector', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('mints a session and its callback URL', async () => {
    const { status, body } = await postJson(`${sandbox.baseUrl}/api/inspect`, {});

    assert.equal(status, 200);
    assert.ok(body.sessionId, 'expected a session id');
    assert.ok(body.callbackUrl.endsWith(`/api/inspect/${body.sessionId}`));
  });

  test('captures a posted callback and reads it back', async () => {
    const { body: created } = await postJson(`${sandbox.baseUrl}/api/inspect`, {});
    const sessionId = created.sessionId;

    const posted = await postJson(`${sandbox.baseUrl}/api/inspect/${sessionId}`, {
      payload: { invoiceNo: 'INV-1', respCode: '0000' }
    });
    assert.equal(posted.status, 200);
    assert.equal(posted.body.received, true);

    const response = await fetch(`${sandbox.baseUrl}/api/inspect/${sessionId}`);
    const session = await response.json();

    assert.equal(session.captures.length, 1);
    assert.equal(session.captures[0].body.payload.invoiceNo, 'INV-1');
    assert.equal(session.captures[0].method, 'POST');
  });

  test('keeps sessions separate', async () => {
    const { body: a } = await postJson(`${sandbox.baseUrl}/api/inspect`, {});
    const { body: b } = await postJson(`${sandbox.baseUrl}/api/inspect`, {});

    await postJson(`${sandbox.baseUrl}/api/inspect/${a.sessionId}`, { marker: 'a' });

    const responseB = await fetch(`${sandbox.baseUrl}/api/inspect/${b.sessionId}`);
    const sessionB = await responseB.json();
    assert.equal(sessionB.captures.length, 0, 'session B must not see session A traffic');
  });

  test('clears a session on request', async () => {
    const { body: created } = await postJson(`${sandbox.baseUrl}/api/inspect`, {});
    await postJson(`${sandbox.baseUrl}/api/inspect/${created.sessionId}`, { marker: 1 });

    await fetch(`${sandbox.baseUrl}/api/inspect/${created.sessionId}`, { method: 'DELETE' });

    const response = await fetch(`${sandbox.baseUrl}/api/inspect/${created.sessionId}`);
    const session = await response.json();
    assert.equal(session.captures.length, 0);
  });

  test('rejects a session id outside the permitted character set', async () => {
    const { status } = await postJson(`${sandbox.baseUrl}/api/inspect/..%2Fetc%2Fpasswd`, {});
    assert.equal(status, 400);
  });

  test('an end-to-end callback lands in the inspector', async () => {
    const { body: created } = await postJson(`${sandbox.baseUrl}/api/inspect`, {});
    const callbackUrl = `${sandbox.baseUrl}/api/inspect/${created.sessionId}`;
    const invoiceNo = uniqueInvoice();

    await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
      invoiceNo,
      amount: 1200,
      backendReturnUrl: callbackUrl
    });

    await postJson(
      `${sandbox.baseUrl}/api/admin/payments/${invoiceNo}/callback`,
      { sequence: [{ status: 'success', respCode: '0000', delayAfter: 0 }] },
      adminHeaders()
    );

    const response = await fetch(callbackUrl);
    const session = await response.json();

    assert.equal(session.captures.length, 1);
    assert.equal(session.captures[0].body.payload.invoiceNo, invoiceNo);
    assert.equal(session.captures[0].body.payload.respCode, '0000');
  });
});

describe('guided demo', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('seeds an empty instance and refuses to re-seed', async () => {
    const first = await postJson(`${sandbox.baseUrl}/api/demo/seed`, {});
    assert.equal(first.status, 200);
    assert.equal(first.body.seeded, true);
    assert.ok(first.body.count > 0);

    const second = await postJson(`${sandbox.baseUrl}/api/demo/seed`, {});
    assert.equal(second.body.seeded, false, 'seeding must not duplicate existing data');
  });

  test('runs a payment end to end and captures its callback', async () => {
    const { status, body } = await postJson(`${sandbox.baseUrl}/api/demo/scenario`, {});

    assert.equal(status, 200);
    assert.equal(body.steps.length, 5, 'the scenario narrates five steps');
    assert.ok(body.invoiceNo.startsWith('DEMO-RUN-'));

    // The callback must actually have been delivered to the built-in inspector.
    assert.equal(body.received.length, 1, 'the scenario captures its own callback');
    assert.equal(body.received[0].body.payload.invoiceNo, body.invoiceNo);
    assert.equal(body.received[0].body.payload.respCode, '0000');
    assert.match(body.steps[3].result, /Delivered/);
  });
});
