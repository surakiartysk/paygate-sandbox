/**
 * Rate limiting, and who the limit is actually applied to.
 *
 * The provider APIs are unauthenticated on purpose — that is what makes this a
 * drop-in for a real gateway in tests — so a per-IP cap is the only thing
 * standing between a public instance and whoever finds it.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { consume, resetRateLimits } from '../lib/rateLimit.js';

/** A request as the server sees it, with a real socket address. */
const from = (remoteAddress, headers = {}) => ({
  headers,
  socket: { remoteAddress }
});

describe('rate limiting', () => {
  beforeEach(() => {
    resetRateLimits();
    delete process.env.TRUST_PROXY;
  });

  afterEach(() => {
    resetRateLimits();
    delete process.env.TRUST_PROXY;
  });

  test('caps a single client', () => {
    const request = from('203.0.113.7');

    for (let i = 0; i < 3; i++) {
      assert.equal(consume(request, 3).allowed, true, `request ${i + 1} should be allowed`);
    }

    assert.equal(consume(request, 3).allowed, false, 'the fourth should be refused');
  });

  /*
   * The one that matters.
   *
   * `X-Forwarded-For` is a header the client sends. Keying the bucket on it
   * meant a caller could hand itself a fresh allowance on every request by
   * changing one string — verified against a running server before this test
   * existed: with the cap at five, eight requests carrying eight different
   * values all succeeded.
   *
   * The module's own comment says the limit "still stops the runaway script or
   * crawler this is meant to stop", and docs/deployment.md scopes out only a
   * "distributed attacker". Neither covers one client with one header, which is
   * what this was.
   */
  test('a client cannot mint itself a new bucket with a header', () => {
    for (let i = 0; i < 3; i++) {
      const request = from('203.0.113.7', { 'x-forwarded-for': `10.9.9.${i}` });
      assert.equal(consume(request, 3).allowed, true, `request ${i + 1} should be allowed`);
    }

    const spoofed = from('203.0.113.7', { 'x-forwarded-for': '10.9.9.99' });
    assert.equal(
      consume(spoofed, 3).allowed,
      false,
      'a fresh X-Forwarded-For must not reset the allowance'
    );
  });

  /*
   * Behind a proxy the header is the only way to tell clients apart, so a
   * deployment that knows what sits in front can opt back in. Explicit,
   * because the cost of being wrong differs by direction: trusting it when
   * nothing overwrites it removes the limit, while not trusting it only
   * groups everyone behind that proxy into one bucket.
   */
  test('honours the header when the deployment says it is trustworthy', () => {
    process.env.TRUST_PROXY = 'true';

    const a = from('10.0.0.1', { 'x-forwarded-for': '198.51.100.1' });
    const b = from('10.0.0.1', { 'x-forwarded-for': '198.51.100.2' });

    for (let i = 0; i < 3; i++) assert.equal(consume(a, 3).allowed, true);

    assert.equal(consume(a, 3).allowed, false, 'the first client is capped');
    assert.equal(consume(b, 3).allowed, true, 'a genuinely different client is not');
  });

  test('separates clients by socket address when it does not trust the header', () => {
    const a = from('203.0.113.1');
    const b = from('203.0.113.2');

    for (let i = 0; i < 3; i++) assert.equal(consume(a, 3).allowed, true);

    assert.equal(consume(a, 3).allowed, false);
    assert.equal(consume(b, 3).allowed, true);
  });
});
