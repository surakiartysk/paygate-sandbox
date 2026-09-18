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
import { createServer } from 'node:http';
import { checkCallbackUrl, assertCallbackUrlAllowed, BlockedCallbackUrlError } from '../lib/urlGuard.js';
import { executeCallback } from '../lib/callback.js';
import { isAuthenticated, verifyPassword } from '../lib/auth.js';
import { deploymentProblems } from '../lib/deployment.js';

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

  /*
   * The same metadata service, spelled differently.
   *
   * ALWAYS_BLOCKED_HOSTS says these must be refused "regardless of mode", and
   * the test above proves it for the dotted form. It was a string-match Set, so
   * the guarantee only ever held for that one spelling: an IPv4-mapped IPv6
   * literal reaches the identical address and, in this mode, was allowed.
   *
   * Strict mode caught it for a different reason — it refuses everything
   * private, and link-local is private — which is why the gap only existed on
   * the default, and why it survived: the deployment that would suffer from it
   * is a self-hosted one that never set ALLOW_PRIVATE_CALLBACKS=false.
   *
   * Node's URL parser normalises the other classic spellings — decimal, hex,
   * octal, and the 127.1 short form — back to dotted quads before the guard
   * sees them, so those were never a way through. Checked, rather than assumed.
   */
  test('refuses the metadata address however it is spelled', () => {
    delete process.env.ALLOW_PRIVATE_CALLBACKS;

    for (const url of [
      'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://2852039166/latest/meta-data/',
      'http://0xa9fea9fe/latest/meta-data/'
    ]) {
      assert.equal(checkCallbackUrl(url).allowed, false, `${url} must be refused`);
    }
  });

  /*
   * And the mode still means something: an ordinary private address is the
   * thing this mode exists to permit. Without this, tightening the rule above
   * into "block all link-local always" would pass while quietly breaking local
   * development, which is what the default is for.
   */
  test('permits ordinary private targets, which is the point of this mode', () => {
    delete process.env.ALLOW_PRIVATE_CALLBACKS;
    assert.equal(checkCallbackUrl('http://10.0.0.5/cb').allowed, true);
    assert.equal(checkCallbackUrl('http://192.168.1.20:3001/cb').allowed, true);
    assert.equal(checkCallbackUrl('http://[::ffff:127.0.0.1]/cb').allowed, true);
  });
});

/**
 * The guard is only a choke point if nothing routes around it.
 *
 * `executeCallback` calls it on the URL it is given and then hands that URL to
 * `fetch`, whose default is `redirect: 'follow'`. So the guard saw the first
 * URL and the runtime followed whatever came back — an attacker supplies a
 * public `backendReturnUrl` that passes, their server answers 302 with a
 * Location pointing anywhere, and the request is made without the guard ever
 * being consulted about the destination.
 *
 * Confirmed before fixing: a redirect to http://169.254.169.254/ was followed,
 * with `blocked` undefined on the result because nothing had refused it.
 */
describe('callback redirects', () => {
  /** A server that answers every request with a redirect to `target`. */
  const redirectorTo = async (target) => {
    const server = createServer((req, res) => {
      res.writeHead(302, { Location: target });
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/cb` };
  };

  test('does not follow a redirect to somewhere the guard would refuse', async () => {
    delete process.env.ALLOW_PRIVATE_CALLBACKS;

    const { server, url } = await redirectorTo('http://169.254.169.254/latest/meta-data/');

    try {
      const result = await executeCallback(url, { invoiceNo: 'REDIR-1' }, null);

      // The 3xx is the answer, reported as-is. What must not happen is a
      // second request to a destination the guard never saw.
      assert.equal(result.status, 302);
    } finally {
      server.close();
    }
  });

  test('does not follow a redirect even to an allowed target', async () => {
    delete process.env.ALLOW_PRIVATE_CALLBACKS;

    let secondHopReached = false;
    const destination = createServer((req, res) => {
      secondHopReached = true;
      res.end('ok');
    });
    await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));

    const { server, url } = await redirectorTo(
      `http://127.0.0.1:${destination.address().port}/internal`
    );

    try {
      const result = await executeCallback(url, { invoiceNo: 'REDIR-2' }, null);

      assert.equal(result.status, 302);
      assert.equal(
        secondHopReached,
        false,
        'the redirect target was requested — the guard is not the only path out'
      );
    } finally {
      server.close();
      destination.close();
    }
  });
});

/**
 * The two settings docs/deployment.md calls required, enforced.
 *
 * That table says ADMIN_PASSWORD must be "something long and random" because
 * "the default is public knowledge", and marks ALLOW_PRIVATE_CALLBACKS=false
 * "**Required for a public instance**". Nothing enforced either: a deployment
 * that forgot them served a dashboard whose password is printed in the README,
 * with the callback guard in its permissive mode, and said nothing at all.
 *
 * The companion dashboard solved this with assertDeployable, which refuses to
 * serve and names the problem. That shape needs a single entry point and this
 * has none — every file under api/ is its own function — so the same idea is
 * applied at the two chokepoints every affected path already goes through.
 */
describe('deployment configuration', () => {
  afterEach(() => {
    delete process.env.VERCEL;
    delete process.env.ALLOW_PRIVATE_CALLBACKS;
  });

  test('says nothing when running locally', () => {
    delete process.env.VERCEL;
    assert.deepEqual(deploymentProblems(), []);
  });

  test('names both settings when deployed without them', () => {
    process.env.VERCEL = '1';
    const problems = deploymentProblems().join(' ');

    assert.match(problems, /ADMIN_PASSWORD/);
    assert.match(problems, /ALLOW_PRIVATE_CALLBACKS/);
  });

  /*
   * Locking the owner out is the safe direction and it is recoverable: set the
   * variable and redeploy. An admin surface open to anyone holding a password
   * printed in the README is not.
   */
  test('refuses admin access rather than accept the published default', () => {
    process.env.VERCEL = '1';

    assert.equal(verifyPassword('mockpay'), false);
    assert.equal(
      isAuthenticated({ headers: { 'x-admin-password': 'mockpay' } }),
      false
    );
  });

  test('accepts it locally, where the default is the point', () => {
    delete process.env.VERCEL;

    assert.equal(verifyPassword('mockpay'), true);
  });

  /*
   * Unset means "local yes, deployed no". An explicit `true` still works, so a
   * deployment that genuinely wants private targets says so rather than
   * getting them by forgetting.
   */
  test('defaults the callback guard to strict once deployed', () => {
    process.env.VERCEL = '1';
    assert.equal(checkCallbackUrl('http://10.0.0.5/cb').allowed, false);

    process.env.ALLOW_PRIVATE_CALLBACKS = 'true';
    assert.equal(checkCallbackUrl('http://10.0.0.5/cb').allowed, true);
  });
});
