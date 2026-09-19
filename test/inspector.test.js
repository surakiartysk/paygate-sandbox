/**
 * Built-in callback inspector and the guided demo scenario.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, postJson, adminHeaders, uniqueInvoice } from './helpers.js';
import { inspectorTTLRemaining } from '../lib/storage.js';

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

  /*
   * The per-session cap counts captures, not bytes.
   *
   * Before the byte cap, one POST of a 5 MB body was stored whole — the count
   * cap does not look at size, and the comment above it claimed it stopped a
   * noisy client exhausting storage. Measured against a running server, not
   * argued from the code.
   */
  test('truncates an oversized body instead of storing it whole', async () => {
    const { body: created } = await postJson(`${sandbox.baseUrl}/api/inspect`, {});
    const sessionId = created.sessionId;

    const posted = await postJson(`${sandbox.baseUrl}/api/inspect/${sessionId}`, {
      pad: 'A'.repeat(200 * 1024)
    });
    assert.equal(posted.status, 200, 'an oversized callback is still a delivered callback');

    const response = await fetch(`${sandbox.baseUrl}/api/inspect/${sessionId}`);
    const session = await response.json();
    const [capture] = session.captures;

    assert.equal(capture.body.truncated, true);
    assert.ok(capture.body.originalBytes > 200 * 1024);
    assert.ok(
      JSON.stringify(capture.body.preview).length < 70 * 1024,
      'the stored excerpt must be bounded, not merely flagged'
    );
    assert.ok(capture.body.preview.includes('AAAA'), 'the excerpt has to be readable');
  });

  test('stores a normal callback body untouched', async () => {
    const { body: created } = await postJson(`${sandbox.baseUrl}/api/inspect`, {});

    await postJson(`${sandbox.baseUrl}/api/inspect/${created.sessionId}`, {
      payload: { invoiceNo: 'INV-SMALL', respCode: '0000' }
    });

    const response = await fetch(`${sandbox.baseUrl}/api/inspect/${created.sessionId}`);
    const session = await response.json();

    // The pair matters: truncating everything would pass the test above.
    assert.equal(session.captures[0].body.truncated, undefined);
    assert.equal(session.captures[0].body.payload.invoiceNo, 'INV-SMALL');
  });

  test('keeps only the most recent captures once the count cap is reached', async () => {
    const { body: created } = await postJson(`${sandbox.baseUrl}/api/inspect`, {});
    const sessionId = created.sessionId;

    for (let i = 0; i < 55; i += 1) {
      await postJson(`${sandbox.baseUrl}/api/inspect/${sessionId}`, { i });
    }

    const response = await fetch(`${sandbox.baseUrl}/api/inspect/${sessionId}`);
    const session = await response.json();

    assert.equal(session.captures.length, 50);
    assert.equal(session.captures[0].body.i, 5, 'the oldest five must have rolled off');
    assert.equal(session.captures[49].body.i, 54);
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

/*
 * The two storage backends have to expire a session at the same moment.
 *
 * They did not. The local store dropped sessions 24 hours after `createdAt`,
 * while every KV write set a fresh 24-hour `ex` — so a session receiving one
 * callback a day lived forever on the deployed path and expired on the dev
 * one. Both module comments promise a shared demo never accumulates; only the
 * absolute reading keeps that.
 *
 * Tested here rather than through the API because the divergence lives in the
 * branch a test run never takes: `useKV` is false without KV credentials, so
 * an end-to-end test exercises the half that was already right.
 */
describe('inspector session expiry', () => {
  const DAY = 24 * 60 * 60;
  const agedHours = (hours) => ({
    createdAt: new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  });

  test('counts down from creation rather than resetting on each write', () => {
    const remaining = inspectorTTLRemaining(agedHours(23));

    assert.ok(remaining > 0, 'a 23-hour-old session is still live');
    assert.ok(
      remaining <= DAY - 23 * 60 * 60 + 2,
      'a write must not hand the session another full day'
    );
  });

  test('gives a fresh session close to the whole window', () => {
    const remaining = inspectorTTLRemaining({ createdAt: new Date().toISOString() });

    assert.ok(remaining > DAY - 5 && remaining <= DAY);
  });

  test('reports nothing left once the window has passed', () => {
    assert.equal(inspectorTTLRemaining(agedHours(25)), 0);
  });

  test('gives an unreadable timestamp a full window rather than dropping it', () => {
    // Failing open here is deliberate: losing a live session over a parsing
    // problem is the worse failure of the two.
    assert.equal(inspectorTTLRemaining({ createdAt: 'not a date' }), DAY);
    assert.equal(inspectorTTLRemaining({}), DAY);
    assert.equal(inspectorTTLRemaining(null), DAY);
  });
});
