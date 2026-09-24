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
const { isAuthenticated, verifyPassword, issueAdminSession, sessionIsValid, clearAdminSession } =
  await import('../lib/auth.js');

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

  test('refuses a request carrying neither', () => {
    assert.equal(isAuthenticated(request()), false);
  });

  test('refuses a wrong password in the header', () => {
    assert.equal(isAuthenticated(request({ 'x-admin-password': 'nope' })), false);
  });

  /*
   * The password used to be accepted from this cookie, which the dashboard
   * set for thirty days where any script on the page could read it. A browser
   * still carrying one from before must get a 401, not a session.
   */
  test('no longer accepts the password from the admin_password cookie', () => {
    assert.equal(isAuthenticated(request({ cookie: `admin_password=${PASSWORD}` })), false);
    assert.equal(
      isAuthenticated(request({ cookie: `admin_password=${encodeURIComponent(PASSWORD)}` })),
      false
    );
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
});

/** The cookie=value pair from a Set-Cookie line, as a browser would send it back. */
const sent = (setCookie) => setCookie.split(';')[0];
const HOUR = 60 * 60 * 1000;

describe('admin browser sessions', () => {
  test('a session this instance issued signs the browser in', () => {
    assert.equal(isAuthenticated(request({ cookie: sent(issueAdminSession(request())) })), true);
  });

  test('works alongside other cookies', () => {
    const cookie = `theme=dark; ${sent(issueAdminSession(request()))}; seen=1`;
    assert.equal(isAuthenticated(request({ cookie })), true);
  });

  test('lasts twelve hours and no longer', () => {
    const issuedAt = Date.now();
    const value = sent(issueAdminSession(request(), issuedAt)).split('=')[1];
    assert.equal(sessionIsValid(value, issuedAt + 12 * HOUR - 1000), true);
    assert.equal(sessionIsValid(value, issuedAt + 12 * HOUR + 1000), false);
  });

  /*
   * The expiry is in the cookie, in the clear, so the MAC is all that stops a
   * browser from extending its own session.
   */
  test('refuses a session whose expiry was edited', () => {
    const value = sent(issueAdminSession(request(), Date.now() - 24 * HOUR)).split('=')[1];
    const [version, , nonce, mac] = value.split('.');
    const extended = [version, String(Date.now() + 24 * HOUR), nonce, mac].join('.');
    assert.equal(sessionIsValid(extended), false);
  });

  test('refuses a session with a forged MAC', () => {
    const value = sent(issueAdminSession(request())).split('=')[1];
    const forged = value.slice(0, value.lastIndexOf('.') + 1) + 'A'.repeat(43);
    assert.equal(sessionIsValid(forged), false);
  });

  /*
   * The key is derived from ADMIN_PASSWORD, so rotating the password is how
   * every outstanding session is revoked — the one revocation this design has.
   * A second copy of the module, loaded under a different password, stands in
   * for the redeploy.
   */
  test('changing the password ends every session', async () => {
    const value = sent(issueAdminSession(request())).split('=')[1];
    process.env.ADMIN_PASSWORD = 'a-different-long-password';
    const rotated = await import('../lib/auth.js?rotated');
    process.env.ADMIN_PASSWORD = PASSWORD;
    assert.equal(sessionIsValid(value), true);
    assert.equal(rotated.sessionIsValid(value), false);
  });

  test('refuses malformed values without throwing', () => {
    for (const value of [undefined, null, '', 'v1', 'v1...', 'v2.1.a.b', 'v1.1.a.b.c', '....', {}]) {
      assert.equal(sessionIsValid(value), false);
    }
  });

  /*
   * HttpOnly is the point of the change: it is what keeps a script on the page
   * from reading the session. SameSite=Strict is what keeps another site from
   * making the browser send it.
   */
  test('is HttpOnly and SameSite=Strict', () => {
    const cookie = issueAdminSession(request());
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Strict/);
    assert.match(cookie, /; Path=\//);
  });

  test('is Secure behind HTTPS, and not on plain-HTTP local runs', () => {
    assert.match(issueAdminSession(request({ 'x-forwarded-proto': 'https' })), /; Secure/);
    assert.doesNotMatch(issueAdminSession(request()), /; Secure/);
  });

  test('signing out expires the session and the old password cookie', () => {
    const [session, legacy] = clearAdminSession(request());
    assert.match(session, /^paygate_admin=; .*Max-Age=0/);
    assert.match(legacy, /^admin_password=; .*Max-Age=0/);
  });
});
