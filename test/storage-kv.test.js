/**
 * The KV half of storage — the half the deployed instance runs.
 *
 * Every other test boots the dev server on local JSON files, so nothing in the
 * suite exercised KV until this. These run storage against an in-memory stand-in
 * that keeps what matters about Upstash: keys expire at their `ex`, `get` and
 * `smembers` hand back JSON already parsed, and every call is counted, so a test
 * can say how many reads an answer cost.
 *
 * What they pin down is the reason this file exists: payments used to be kept
 * for ever, and the public routes that look one up read every payment to do
 * it — so each anonymous request cost more for as long as the instance lived.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  countLiveDemoVisitors,
  deletePayment,
  getAllPayments,
  getOmiseCharge,
  getPayment,
  getPaymentByToken,
  saveDemoVisitor,
  saveLog,
  savePayment,
  trimLogIndex,
  updatePayment,
  useKvClientForTests
} from '../lib/storage.js';
import { applyDelay, checkForceError } from '../lib/simulation.js';

const DAY = 24 * 60 * 60 * 1000;

/** Upstash parses what it hands back; a string that is not JSON stays one. */
function deserialise(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** An in-memory stand-in for the @vercel/kv client, with a clock of its own. */
class FakeKv {
  constructor() {
    this.values = new Map();
    this.expiries = new Map();
    this.sets = new Map();
    this.zsets = new Map();
    this.calls = [];
    this.offset = 0;
  }

  now() { return Date.now() + this.offset; }
  advance(ms) { this.offset += ms; }
  count(method) { return this.calls.filter(c => c === method).length; }

  live(key) {
    const expiry = this.expiries.get(key);
    if (expiry !== undefined && expiry <= this.now()) {
      this.values.delete(key);
      this.expiries.delete(key);
    }
    return this.values.has(key);
  }

  /** Write a value as a deployment before this change would have: no expiry. */
  plant(key, value) {
    this.values.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  async get(key) {
    this.calls.push('get');
    return this.live(key) ? deserialise(this.values.get(key)) : null;
  }

  async mget(...keys) {
    this.calls.push('mget');
    return keys.map(key => (this.live(key) ? deserialise(this.values.get(key)) : null));
  }

  async set(key, value, options) {
    this.calls.push('set');
    this.values.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    if (options?.ex) this.expiries.set(key, this.now() + options.ex * 1000);
    else this.expiries.delete(key);
    return 'OK';
  }

  async del(...keys) {
    this.calls.push('del');
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key)) removed++;
      this.expiries.delete(key);
    }
    return removed;
  }

  async sadd(key, ...members) {
    this.calls.push('sadd');
    const set = this.sets.get(key) ?? new Set();
    members.forEach(m => set.add(String(m)));
    this.sets.set(key, set);
  }

  async srem(key, ...members) {
    this.calls.push('srem');
    members.forEach(m => this.sets.get(key)?.delete(String(m)));
  }

  async smembers(key) {
    this.calls.push('smembers');
    return [...(this.sets.get(key) ?? [])].map(deserialise);
  }

  async zadd(key, { score, member }) {
    this.calls.push('zadd');
    const zset = this.zsets.get(key) ?? new Map();
    zset.set(member, score);
    this.zsets.set(key, zset);
  }

  async zremrangebyscore(key, min, max) {
    this.calls.push('zremrangebyscore');
    const zset = this.zsets.get(key);
    if (!zset) return 0;
    for (const [member, score] of zset) if (score >= min && score <= max) zset.delete(member);
  }

  async zcard(key) {
    this.calls.push('zcard');
    return this.zsets.get(key)?.size ?? 0;
  }

  async zrange(key, start, stop) {
    this.calls.push('zrange');
    const members = [...(this.zsets.get(key) ?? new Map())].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    return members.slice(start, stop < 0 ? members.length + stop + 1 : stop + 1);
  }

  async zscore(key, member) {
    this.calls.push('zscore');
    return this.zsets.get(key)?.get(member) ?? null;
  }

  async zrem(key, ...members) {
    this.calls.push('zrem');
    members.forEach(m => this.zsets.get(key)?.delete(m));
  }
}

let kv;

beforeEach(() => {
  kv = new FakeKv();
  useKvClientForTests(kv);
  delete process.env.PAYMENT_TTL_SECONDS;
});

const payment = (invoiceNo, extra = {}) => ({
  invoiceNo,
  provider: '2c2p',
  status: 'pending',
  paymentToken: `mock_token_${invoiceNo}`,
  createdAt: new Date().toISOString(),
  ...extra
});

describe('payments are kept for a week, then dropped by the store', () => {
  test('a saved payment and its token index expire a week from now', async () => {
    await savePayment(payment('KEEP-1'));

    const expected = kv.now() + 7 * DAY;
    for (const key of ['payment:KEEP-1', 'payref:mock_token_KEEP-1']) {
      const expiry = kv.expiries.get(key);
      assert.ok(expiry !== undefined, `${key} was written with no expiry`);
      assert.ok(Math.abs(expiry - expected) < 5000, `${key} expires ${(expiry - kv.now()) / DAY} days out`);
    }
  });

  test('the deadline is fixed at the first save; later saves keep it', async () => {
    const first = await savePayment(payment('KEEP-2'));
    const firstExpiry = kv.expiries.get('payment:KEEP-2');
    await new Promise(r => setTimeout(r, 1100));
    await updatePayment('KEEP-2', { status: 'success' });

    assert.equal((await getPayment('KEEP-2')).purgeAt, first.purgeAt);
    const moved = kv.expiries.get('payment:KEEP-2') - firstExpiry;
    assert.ok(Math.abs(moved) < 1000, `the update moved the expiry by ${moved} ms`);
  });

  test('once the store drops a payment, the list forgets it too', async () => {
    await savePayment(payment('GONE-1'));
    kv.advance(8 * DAY);

    assert.deepEqual(await getAllPayments(), []);
    assert.deepEqual([...kv.sets.get('payments:list')], []);
  });

  test('a visitor payment from before deadlines reached KV is neither shown nor kept', async () => {
    const legacy = payment('DEMO-OLD-01', { demoOwner: 'OLD', demoExpiresAt: new Date(Date.now() - 1000).toISOString() });
    kv.plant('payment:DEMO-OLD-01', legacy);
    await kv.sadd('payments:list', 'DEMO-OLD-01');

    assert.equal(await getPayment('DEMO-OLD-01'), null);
    assert.deepEqual(await getAllPayments(), []);
    assert.equal(kv.values.has('payment:DEMO-OLD-01'), false, 'the expired record is still stored');
  });
});

describe('a public lookup does not read every payment', () => {
  test('finding a payment by token reads its index, not the list', async () => {
    for (const id of ['T-1', 'T-2', 'T-3']) await savePayment(payment(id));
    kv.calls = [];

    assert.equal((await getPaymentByToken('mock_token_T-2'))?.invoiceNo, 'T-2');
    assert.equal(kv.count('smembers') + kv.count('mget'), 0, `calls: ${kv.calls.join(', ')}`);
    assert.ok(kv.calls.length <= 3, `calls: ${kv.calls.join(', ')}`);
  });

  test('payments saved before the index are found, indexed once, and then a miss is an answer', async () => {
    kv.plant('payment:OLD-1', payment('OLD-1'));
    await kv.sadd('payments:list', 'OLD-1');

    assert.equal((await getPaymentByToken('mock_token_OLD-1'))?.invoiceNo, 'OLD-1');
    assert.ok(kv.values.has('payref:mock_token_OLD-1'), 'the old payment was not indexed');

    kv.calls = [];
    assert.equal(await getPaymentByToken('mock_token_nobody'), null);
    assert.equal(kv.count('smembers'), 0, 'a miss after indexing read every payment again');
  });

  test('an Omise charge is found by charge id or by invoice number', async () => {
    await savePayment(payment('OM-1', { provider: 'omise', paymentToken: undefined, omiseChargeId: 'chrg_test_abc' }));
    await savePayment(payment('2C-1'));
    kv.calls = [];

    assert.equal((await getOmiseCharge('chrg_test_abc'))?.invoiceNo, 'OM-1');
    assert.equal((await getOmiseCharge('OM-1'))?.invoiceNo, 'OM-1');
    assert.equal(kv.count('smembers'), 0);
    assert.equal(await getOmiseCharge('2C-1'), null, 'a 2C2P payment answered as an Omise charge');
  });

  test('deleting a payment deletes its index entry', async () => {
    await savePayment(payment('DEL-1'));
    await deletePayment('DEL-1');

    assert.equal(kv.values.has('payref:mock_token_DEL-1'), false);
    assert.equal(await getPaymentByToken('mock_token_DEL-1'), null);
  });

  test('reading every payment takes a request per two hundred, not one each', async () => {
    for (let i = 0; i < 450; i++) await savePayment(payment(`BULK-${i}`));
    kv.calls = [];

    assert.equal((await getAllPayments()).length, 450);
    assert.equal(kv.count('mget'), 3);
    assert.equal(kv.count('get'), 0);
  });
});

test('an invoice number stored as a number is read back as a string', async () => {
  kv.plant('payment:12345', payment(12345));
  await kv.sadd('payments:list', '12345');

  assert.equal((await getAllPayments())[0].invoiceNo, '12345');
  assert.equal((await getPayment('12345')).invoiceNo, '12345');
});

test('live demo visitors are counted from their own index', async () => {
  const visitor = ms => ({ expiresAt: new Date(Date.now() + ms).toISOString() });
  await saveDemoVisitor('a'.repeat(64), visitor(DAY));
  await saveDemoVisitor('b'.repeat(64), visitor(DAY));
  await kv.zadd('demo:visitors', { score: Date.now() - 1000, member: 'c'.repeat(64) });
  kv.calls = [];

  assert.equal(await countLiveDemoVisitors(), 2);
  assert.equal(kv.count('smembers') + kv.count('mget'), 0);
});

describe('a log write costs one round trip', () => {
  test('writes the entry and its index entry, and checks nothing else on the way', async (t) => {
    t.mock.method(Math, 'random', () => 0.99);
    await saveLog({ id: 'L-1', type: 'token', timestamp: new Date().toISOString() });

    assert.deepEqual([...kv.calls].sort(), ['set', 'zadd']);
  });

  test('trimming keeps the newest five hundred, and drops the entries with their index members', async () => {
    for (let i = 0; i < 503; i++) {
      kv.plant(`log:${i}:x`, '{}');
      await kv.zadd('logs:list', { score: i, member: `log:${i}:x` });
    }

    assert.equal(await trimLogIndex(), 3);
    assert.equal(kv.zsets.get('logs:list').size, 500);
    assert.deepEqual(['log:0:x', 'log:1:x', 'log:2:x', 'log:3:x'].map(k => kv.values.has(k)), [false, false, false, true]);
  });
});

describe('the simulation reads its config once a request', () => {
  test('the delay and the forced-error check share one read', async () => {
    const request = { headers: {} };
    await applyDelay(request);
    await checkForceError(request, 'omise');

    assert.equal(kv.count('get'), 1, `calls: ${kv.calls.join(', ')}`);
  });

  test('the next request reads it again, so a change takes effect at once', async () => {
    await kv.set('config:simulation', JSON.stringify({ forceErrorOmise: null }));
    assert.equal(await checkForceError({ headers: {} }, 'omise'), null);

    await kv.set('config:simulation', JSON.stringify({ forceErrorOmise: 'failed_processing' }));
    assert.equal(await checkForceError({ headers: {} }, 'omise'), 'failed_processing');
  });
});

