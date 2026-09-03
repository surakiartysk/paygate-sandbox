/**
 * Callback URL guard (SSRF protection).
 *
 * The guard runs in two modes. Local development permits loopback targets,
 * because posting to your own service is the normal case. A public deployment
 * sets ALLOW_PRIVATE_CALLBACKS=false, and then only publicly routable HTTP(S)
 * endpoints are accepted.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkCallbackUrl, assertCallbackUrlAllowed, BlockedCallbackUrlError } from '../lib/urlGuard.js';

describe('callback URL guard — strict mode', () => {
  beforeEach(() => {
    process.env.ALLOW_PRIVATE_CALLBACKS = 'false';
  });

  afterEach(() => {
    delete process.env.ALLOW_PRIVATE_CALLBACKS;
  });

  test('allows public https endpoints', () => {
    assert.equal(checkCallbackUrl('https://api.example.com/payment/callback').allowed, true);
    assert.equal(checkCallbackUrl('http://example.com:8080/hook').allowed, true);
  });

  test('blocks cloud metadata endpoints', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://metadata.google.internal/computeMetadata/v1/'
    ]) {
      assert.equal(checkCallbackUrl(url).allowed, false, `${url} must be blocked`);
    }
  });

  test('blocks loopback targets', () => {
    for (const url of ['http://localhost:3001/cb', 'http://127.0.0.1/cb', 'http://[::1]/cb']) {
      assert.equal(checkCallbackUrl(url).allowed, false, `${url} must be blocked`);
    }
  });

  test('blocks RFC 1918 private ranges', () => {
    for (const url of ['http://10.0.0.5/x', 'http://172.16.4.2/x', 'http://192.168.1.1/x']) {
      assert.equal(checkCallbackUrl(url).allowed, false, `${url} must be blocked`);
    }
  });

  test('blocks IPv4-mapped IPv6 loopback', () => {
    assert.equal(checkCallbackUrl('http://[::ffff:127.0.0.1]/x').allowed, false);
  });

  test('blocks non-HTTP schemes', () => {
    for (const url of ['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/x']) {
      assert.equal(checkCallbackUrl(url).allowed, false, `${url} must be blocked`);
    }
  });

  test('rejects missing and malformed URLs', () => {
    assert.equal(checkCallbackUrl('').allowed, false);
    assert.equal(checkCallbackUrl(null).allowed, false);
    assert.equal(checkCallbackUrl('not-a-url').allowed, false);
  });

  test('throws a typed error carrying the rejected URL', () => {
    assert.throws(
      () => assertCallbackUrlAllowed('http://169.254.169.254/'),
      error => error instanceof BlockedCallbackUrlError
        && error.code === 'BLOCKED_CALLBACK_URL'
        && error.url === 'http://169.254.169.254/'
    );
  });
});

describe('callback URL guard — local development', () => {
  test('permits loopback so local integrations work', () => {
    delete process.env.ALLOW_PRIVATE_CALLBACKS;
    assert.equal(checkCallbackUrl('http://localhost:3001/payment/callback').allowed, true);
    assert.equal(checkCallbackUrl('http://127.0.0.1:4000/cb').allowed, true);
  });

  test('still refuses metadata endpoints and non-HTTP schemes', () => {
    delete process.env.ALLOW_PRIVATE_CALLBACKS;
    assert.equal(checkCallbackUrl('http://169.254.169.254/').allowed, false);
    assert.equal(checkCallbackUrl('file:///etc/passwd').allowed, false);
  });
});
