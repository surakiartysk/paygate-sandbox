/**
 * Admin password checking.
 *
 * `lib/auth.js` is the single gate in front of every `/api/admin/*` route, so
 * what it accepts and refuses is worth pinning down. The comparison is
 * constant-time — see the note on `secretsMatch` for why, and for what that
 * deliberately does not buy.
 *
 * `ADMIN_PASSWORD` is read once when the module loads, so these tests set it
 * before importing and the import is dynamic for that reason. A static import
 * would be hoisted above the assignment and the module would capture the
 * default instead.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';
const { isAuthenticated, verifyPassword } = await import('../lib/auth.js');

const PASSWORD = 'correct-horse-battery-staple';

/** A request carrying only the headers a test cares about. */
const request = (headers = {}) => ({ headers });

describe('verifyPassword', () => {
  test('accepts the configured password', () => {
    assert.equal(verifyPassword(PASSWORD), true);
  });

  test('refuses a wrong password of the same length', () => {
    const wrong = 'x'.repeat(PASSWORD.length);
    assert.equal(wrong.length, PASSWORD.length);
    assert.equal(verifyPassword(wrong), false);
  });

  /*
   * The case the constant-time comparison is actually about: a value sharing
   * every byte but the last used to take measurably longer to reject than one
   * differing at the first byte. This asserts the answer, not the timing —
   * timing is not assertable in a unit test without being flaky, which is
   * exactly the kind of test this repo's siblings warn against.
   */
  test('refuses a password differing only in the final byte', () => {
    const almost = PASSWORD.slice(0, -1) + 'X';
    assert.equal(almost.length, PASSWORD.length);
    assert.equal(verifyPassword(almost), false);
  });

  test('refuses a prefix of the password', () => {
    assert.equal(verifyPassword(PASSWORD.slice(0, 5)), false);
  });

  /*
   * `timingSafeEqual` throws a RangeError when the two buffers differ in
   * length. Without the length check in front of it, any wrong-length password
   * would crash the route with a 500 instead of returning a 401 — turning a
   * hardening change into an availability bug.
   */
  test('refuses a longer password without throwing', () => {
    assert.equal(verifyPassword(PASSWORD + 'extra'), false);
  });

  test('refuses an empty string', () => {
    assert.equal(verifyPassword(''), false);
  });

  /*
   * Anything that is not a string reaches this from a JSON body, where a
   * caller controls the type. `Buffer.from(undefined)` throws, so these would
   * be 500s rather than 401s if the type guard were removed.
   */
  test('refuses non-string values without throwing', () => {
    for (const value of [undefined, null, 0, {}, [], true]) {
      assert.equal(verifyPassword(value), false);
    }
  });
});

describe('isAuthenticated', () => {
  test('accepts the password in the X-Admin-Password header', () => {
    assert.equal(isAuthenticated(request({ 'x-admin-password': PASSWORD })), true);
  });

  test('accepts the password in the admin_password cookie', () => {
    assert.equal(isAuthenticated(request({ cookie: `admin_password=${PASSWORD}` })), true);
  });

  test('accepts a cookie alongside other cookies', () => {
    assert.equal(
      isAuthenticated(request({ cookie: `theme=dark; admin_password=${PASSWORD}; seen=1` })),
      true
    );
  });

  test('refuses a request carrying neither', () => {
    assert.equal(isAuthenticated(request()), false);
  });

  test('refuses a wrong password in either place', () => {
    assert.equal(isAuthenticated(request({ 'x-admin-password': 'nope' })), false);
    assert.equal(isAuthenticated(request({ cookie: 'admin_password=nope' })), false);
  });

  /*
   * A wrong header must not be rescued by a right cookie being absent, and a
   * malformed cookie header must not throw — both reach this from the open
   * internet.
   */
  test('survives a malformed cookie header', () => {
    for (const cookie of ['', '=', ';;;', 'admin_password', 'admin_password=']) {
      assert.equal(isAuthenticated(request({ cookie })), false);
    }
  });

  test('accepts a URL-encoded cookie value', () => {
    assert.equal(
      isAuthenticated(request({ cookie: `admin_password=${encodeURIComponent(PASSWORD)}` })),
      true
    );
  });
});
