/**
 * The admin's browser session, end to end over HTTP.
 *
 * The unit tests in auth.test.js pin what a session cookie is. These pin what
 * the dashboard relies on: that signing in sets one, that it is enough on its
 * own to reach an admin route, that signing out ends it, and that the password
 * never comes back to the browser.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, postJson } from './helpers.js';

/** Every Set-Cookie line a response carried. */
const setCookies = (response) => response.headers.getSetCookie();

/** The cookie=value pairs a browser would send back. */
const asCookieHeader = (lines) => lines.map(line => line.split(';')[0]).join('; ');

async function signIn(baseUrl, password) {
  return fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
}

describe('admin browser session', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('signing in sets an HttpOnly session cookie and returns no secret', async () => {
    const response = await signIn(sandbox.baseUrl, 'test-password');
    assert.equal(response.status, 200);

    const [cookie] = setCookies(response);
    assert.match(cookie, /^paygate_admin=v1\./);
    assert.match(cookie, /HttpOnly/);

    const body = await response.text();
    assert.doesNotMatch(body, /test-password/);
    assert.doesNotMatch(cookie, /test-password/);
  });

  test('the session alone reaches an admin route', async () => {
    const cookie = asCookieHeader(setCookies(await signIn(sandbox.baseUrl, 'test-password')));
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments`, { headers: { cookie } });
    assert.equal(response.status, 200);
  });

  test('a wrong password sets no session', async () => {
    const response = await signIn(sandbox.baseUrl, 'wrong-password');
    assert.equal(response.status, 401);
    assert.deepEqual(setCookies(response), []);
  });

  test('signing out expires the session in the browser', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/logout`, { method: 'POST' });
    assert.equal(response.status, 200);

    const cleared = setCookies(response);
    assert.ok(cleared.some(line => /^paygate_admin=;.*Max-Age=0/.test(line)));
    assert.ok(cleared.some(line => /^admin_password=;.*Max-Age=0/.test(line)));
  });

  /*
   * The admin wins when a request carries both an admin credential and a demo
   * token, so a browser that signed in as admin and then as demo would keep
   * the admin's view. Only the server can clear an HttpOnly cookie, so the
   * demo sign-in has to.
   */
  test('signing in as demo ends an admin session in the same browser', async () => {
    const response = await signIn(sandbox.baseUrl, 'demo');
    assert.equal(response.status, 200);
    assert.ok(setCookies(response).some(line => /^paygate_admin=;.*Max-Age=0/.test(line)));
  });

  test('the password in the old admin_password cookie is refused', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments`, {
      headers: { cookie: 'admin_password=test-password' }
    });
    assert.equal(response.status, 401);
  });

  test('scripts still authenticate with the X-Admin-Password header', async () => {
    const { status } = await postJson(
      `${sandbox.baseUrl}/api/admin/config`,
      {},
      { 'Content-Type': 'application/json', 'X-Admin-Password': 'test-password' }
    );
    assert.notEqual(status, 401);
  });
});
