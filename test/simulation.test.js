/**
 * Forced errors, per provider.
 *
 * The dashboard offers one error dropdown per provider. `forceError2c2p`
 * selected nothing for months: `detectProvider` matched `/api/payment`, which
 * is not a path this sandbox serves, so every 2C2P route fell through to null
 * and the setting could never apply. Its Omise twin matched `/api/omise` and
 * worked, which is why testing the feature was likely to test the half that
 * was fine.
 *
 * Every test below has a partner asserting the *other* provider is untouched.
 * Without that pair, forcing an error for everything would pass.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSandbox, postJson, adminHeaders, uniqueInvoice } from './helpers.js';

describe('provider-specific forced errors', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  beforeEach(async () => {
    await setConfig({ forceError2c2p: '', forceErrorOmise: '' });
  });

  const setConfig = async (updates) =>
    postJson(`${sandbox.baseUrl}/api/admin/config`, updates, adminHeaders());

  const token2c2p = async () =>
    (
      await postJson(`${sandbox.baseUrl}/api/2c2p/token`, {
        invoiceNo: uniqueInvoice(),
        amount: 100
      })
    ).body;

  const omiseCharge = async () =>
    (
      await postJson(`${sandbox.baseUrl}/api/omise/charges`, {
        amount: 10000,
        currency: 'thb',
        card: 'tokn_test'
      })
    ).body;

  test('neither provider fails when nothing is forced', async () => {
    // The baseline the rest depend on: without it, a suite where everything
    // errors would still look like the settings were working.
    assert.equal((await token2c2p()).respCode, '0000');
    assert.equal((await omiseCharge()).object, undefined, 'a successful charge is not an error');
  });

  test('forceError2c2p applies to a 2C2P request', async () => {
    await setConfig({ forceError2c2p: '9999' });

    assert.equal((await token2c2p()).respCode, '9999');
  });

  test('forceError2c2p leaves Omise alone', async () => {
    await setConfig({ forceError2c2p: '9999' });

    const charge = await omiseCharge();
    assert.notEqual(charge.object, 'error', 'the 2C2P setting must not reach Omise');
  });

  test('forceErrorOmise applies to an Omise request', async () => {
    await setConfig({ forceErrorOmise: 'processing_error' });

    const charge = await omiseCharge();
    assert.equal(charge.object, 'error');
    assert.equal(charge.code, 'processing_error');
  });

  test('forceErrorOmise leaves 2C2P alone', async () => {
    await setConfig({ forceErrorOmise: 'processing_error' });

    assert.equal((await token2c2p()).respCode, '0000', 'the Omise setting must not reach 2C2P');
  });

  test('the x-mock-error header still overrides both', async () => {
    // The header is documented as a per-request override that outranks config.
    await setConfig({ forceError2c2p: '9999' });

    const { body } = await postJson(
      `${sandbox.baseUrl}/api/2c2p/token`,
      { invoiceNo: uniqueInvoice(), amount: 100 },
      { 'Content-Type': 'application/json', 'x-mock-error': '0002' }
    );

    assert.equal(body.respCode, '0002');
  });
});

/*
 * The explicit provider argument, which the HTTP tests above do not reach.
 *
 * Every real route's path now identifies its provider, so correcting
 * `detectProvider` alone makes those tests pass — removing the argument again
 * leaves them all green. That was measured, not assumed: it is exactly the
 * shape of redundancy that rots, because nothing tells you when it stops
 * working.
 *
 * It earns its place anyway. Path matching is the weaker signal and broke
 * silently once already; a caller that knows its provider should not have to
 * hope the router agrees. So it is pinned here, at the level where the two can
 * actually disagree.
 */
describe('the provider a caller states', () => {
  let checkForceError;

  before(async () => {
    // Point storage at a throwaway directory before it is imported — it reads
    // DATA_DIR once, at module load.
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'paygate-sim-'));
    const storage = await import('../lib/storage.js');
    await storage.updateConfig({ forceError2c2p: '9999', forceErrorOmise: 'processing_error' });
    ({ checkForceError } = await import('../lib/simulation.js'));
  });

  after(() => {
    rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  });

  test('outranks whatever the path would have guessed', async () => {
    const onAnOmisePath = await checkForceError({ url: '/api/omise/charges', headers: {} }, '2c2p');

    assert.equal(onAnOmisePath, '9999', 'the stated provider decides, not the URL');
  });

  test('falls back to the path when the caller states nothing', async () => {
    assert.equal(await checkForceError({ url: '/api/omise/charges', headers: {} }), 'processing_error');
    assert.equal(await checkForceError({ url: '/api/2c2p/token', headers: {} }), '9999');
  });

  test('applies neither when the path names no provider and none is stated', async () => {
    // A path outside both namespaces must not inherit either setting.
    assert.equal(await checkForceError({ url: '/api/inspect/abc', headers: {} }), null);
  });
});

/*
 * The delay header, and why it has a ceiling.
 *
 * `x-mock-delay` takes a number from whoever sends the request. Unbounded,
 * `x-mock-delay: 99999999` held a request open for about 27 hours — measured
 * against a running sandbox, not reasoned about. That is the same shape as a
 * rate limit keyed on a header the caller controls: a value nobody validated,
 * doing exactly what it was told.
 */
describe('the delay header has a ceiling', () => {
  let sandbox;

  // A one-second ceiling, so the test proves the clamp instead of waiting out
  // the real one. Thirty seconds of sleeping per run would be a cost the suite
  // pays forever to assert something a lower bound shows just as well.
  const CEILING_MS = 1000;

  before(async () => {
    sandbox = await startSandbox({ MOCK_MAX_DELAY_MS: String(CEILING_MS) });
  });

  after(async () => {
    await sandbox?.stop();
  });

  const timedToken = async (delayHeader) => {
    const started = Date.now();
    await postJson(
      `${sandbox.baseUrl}/api/2c2p/token`,
      { invoiceNo: uniqueInvoice(), amount: 100 },
      { 'Content-Type': 'application/json', 'x-mock-delay': String(delayHeader) }
    );
    return Date.now() - started;
  };

  test('honours a delay below the ceiling', async () => {
    const elapsed = await timedToken(400);

    // The pair matters: a cap that ignored the header entirely would pass the
    // test below on its own.
    assert.ok(elapsed >= 350, `expected roughly 400ms, took ${elapsed}ms`);
    assert.ok(elapsed < CEILING_MS + 4000, `expected roughly 400ms, took ${elapsed}ms`);
  });

  /*
   * The explicit timeout is the point, not decoration.
   *
   * Without it, removing the cap does not fail this test — it hangs it, for
   * the 27 hours the header asked for, because the assertion is only reached
   * once the request returns. A suite that hangs in CI is worse than one that
   * goes red: nobody gets a failure to read.
   */
  test('refuses to sleep for a day because a header said so', { timeout: 15000 }, async () => {
    const elapsed = await timedToken(99999999);

    assert.ok(
      elapsed < CEILING_MS + 4000,
      `a 27-hour delay was not clamped to the ${CEILING_MS}ms ceiling — took ${elapsed}ms`
    );
  });
});

