/**
 * The callback guard judges where a name points, not only how it is spelled.
 *
 * It used to check the URL's text and nothing else. A name is not an address,
 * so `169.254.169.254.nip.io` — a public DNS service that answers with the
 * address written in the name — went through in every mode, while
 * docs/architecture.md said the metadata address is refused "regardless of
 * mode". So did `localtest.me` (127.0.0.1) on a deployment that refuses
 * loopback, the fully qualified `localhost.` and `metadata.google.internal.`,
 * and IPv6 spellings of private and metadata addresses the prefix checks did
 * not know: `fe90::1`, `64:ff9b::a9fe:a9fe`, `2002:a9fe:a9fe::1`.
 *
 * Names are answered here by a stand-in resolver, so the suite asks nothing of
 * real DNS.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCallbackTargetAllowed,
  BlockedCallbackUrlError,
  checkCallbackUrl,
  setHostResolverForTests
} from '../lib/urlGuard.js';
import { executeCallback } from '../lib/callback.js';

/** Answer each name from a table, the way `dns.lookup({ all: true })` does. */
const resolveFrom = table => async host => {
  if (!Object.hasOwn(table, host)) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }
  return table[host].map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
};

const NAMES = {
  'metadata-by-name.test': ['169.254.169.254'],
  'loopback-by-name.test': ['127.0.0.1'],
  'private-by-name.test': ['10.0.0.5'],
  'v6-metadata-by-name.test': ['64:ff9b::a9fe:a9fe'],
  'public.test': ['93.184.215.14'],
  'one-of-each.test': ['93.184.215.14', '10.0.0.5']
};

/** Whether the resolved check refuses a URL, and how. */
async function verdict(url) {
  try {
    await assertCallbackTargetAllowed(url);
    return 'allowed';
  } catch (error) {
    return error instanceof BlockedCallbackUrlError ? 'blocked' : `failed: ${error.message}`;
  }
}

afterEach(() => {
  setHostResolverForTests(null);
  delete process.env.ALLOW_PRIVATE_CALLBACKS;
});

describe('a name is judged by the addresses it resolves to', () => {
  beforeEach(() => setHostResolverForTests(resolveFrom(NAMES)));

  test('a name pointing at the metadata address is refused in every mode', async () => {
    for (const mode of ['true', 'false']) {
      process.env.ALLOW_PRIVATE_CALLBACKS = mode;
      assert.equal(await verdict('http://metadata-by-name.test/latest'), 'blocked', `mode ${mode}`);
      assert.equal(await verdict('http://v6-metadata-by-name.test/'), 'blocked', `mode ${mode}, NAT64`);
    }
  });

  test('a name pointing at a private address is refused where private targets are', async () => {
    process.env.ALLOW_PRIVATE_CALLBACKS = 'false';
    assert.equal(await verdict('http://loopback-by-name.test:3001/cb'), 'blocked');
    assert.equal(await verdict('http://private-by-name.test/cb'), 'blocked');
  });

  test('…and allowed where they are, so local development still works', async () => {
    process.env.ALLOW_PRIVATE_CALLBACKS = 'true';
    assert.equal(await verdict('http://loopback-by-name.test:3001/cb'), 'allowed');
  });

  test('every address counts, not only the first', async () => {
    process.env.ALLOW_PRIVATE_CALLBACKS = 'false';
    assert.equal(await verdict('https://one-of-each.test/cb'), 'blocked');
  });

  test('a public name is allowed', async () => {
    process.env.ALLOW_PRIVATE_CALLBACKS = 'false';
    assert.equal(await verdict('https://public.test/cb'), 'allowed');
  });

  test('a name that does not resolve fails as a failure, not as a block', async () => {
    process.env.ALLOW_PRIVATE_CALLBACKS = 'false';
    assert.match(await verdict('https://nowhere.test/cb'), /^failed: .*could not be resolved/);
  });

  test('a callback to a name pointing somewhere private is never sent', async () => {
    process.env.ALLOW_PRIVATE_CALLBACKS = 'false';
    const result = await executeCallback('http://loopback-by-name.test:9/cb', { invoiceNo: 'DNS-1' }, null);
    assert.equal(result.blocked, true, `expected a block, got ${JSON.stringify(result)}`);
    assert.equal(result.code, 'BLOCKED_CALLBACK_URL');
  });
});

describe('spellings the text check missed', () => {
  test('a trailing dot does not hide a name the guard knows', () => {
    process.env.ALLOW_PRIVATE_CALLBACKS = 'false';
    assert.equal(checkCallbackUrl('http://localhost.:3001/cb').allowed, false);
    assert.equal(checkCallbackUrl('http://api.localhost./cb').allowed, false);

    process.env.ALLOW_PRIVATE_CALLBACKS = 'true';
    assert.equal(checkCallbackUrl('http://metadata.google.internal./').allowed, false);
    assert.equal(checkCallbackUrl('http://metadata.google.internal../').allowed, false);
  });

  test('IPv6 forms that carry the metadata address are refused in every mode', () => {
    for (const mode of ['true', 'false']) {
      process.env.ALLOW_PRIVATE_CALLBACKS = mode;
      for (const url of [
        'http://[64:ff9b::a9fe:a9fe]/',       // NAT64
        'http://[64:ff9b::169.254.169.254]/', // NAT64, dotted
        'http://[2002:a9fe:a9fe::1]/',        // 6to4
        'http://[::169.254.169.254]/'         // IPv4-compatible
      ]) {
        assert.equal(checkCallbackUrl(url).allowed, false, `${url} in mode ${mode}`);
      }
    }
  });

  test('the whole of each private IPv6 range is refused, not its first spelling', () => {
    process.env.ALLOW_PRIVATE_CALLBACKS = 'false';
    for (const url of [
      'http://[fe90::1]/', 'http://[febf::1]/', // link-local runs fe80 to febf
      'http://[fec0::1]/',                      // site-local
      'http://[ff02::1]/',                      // multicast
      'http://[2001:db8::1]/',                  // documentation
      'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', // Teredo
      'http://[64:ff9b::a00:5]/',               // NAT64 of 10.0.0.5
      'http://[2002:a00:5::1]/',                // 6to4 of 10.0.0.5
      'http://[0:0:0:0:0:0:0:1]/'               // loopback, written out
    ]) {
      assert.equal(checkCallbackUrl(url).allowed, false, `${url} must be refused`);
    }
  });

  test('public IPv6 addresses are still allowed', () => {
    process.env.ALLOW_PRIVATE_CALLBACKS = 'false';
    assert.equal(checkCallbackUrl('http://[2606:4700:4700::1111]/cb').allowed, true);
    assert.equal(checkCallbackUrl('http://[64:ff9b::5db8:d70e]/cb').allowed, true); // NAT64 of a public address
    assert.equal(checkCallbackUrl('http://[2001:4860:4860::8888]/cb').allowed, true); // 2001: but not Teredo
  });
});
