/**
 * Every place the admin password is accepted is held to one guess allowance.
 *
 * Sign-in stopped a client after ten wrong passwords a minute. Every admin
 * route also accepts the password in X-Admin-Password, and that path counted
 * nothing: thirty wrong guesses through /api/admin/logs all answered 401, and
 * the right password worked straight after — while sign-in was already
 * answering 429. A limit with an unlimited door beside it is not a limit.
 *
 * Each test boots its own instance: the allowance is per client, and every
 * request from this process is the same client.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from './helpers.js';

const RIGHT = 'test-password';

async function withSandbox(fn) {
  const sandbox = await startSandbox({ RATE_LIMIT_MAX: '60' });
  try {
    await fn(sandbox);
  } finally {
    await sandbox.stop();
  }
}

const guessByHeader = (sandbox, password) =>
  fetch(`${sandbox.baseUrl}/api/admin/logs`, { headers: { 'x-admin-password': password } });

const signIn = (sandbox, password) =>
  fetch(`${sandbox.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });

describe('admin password guessing', () => {
  test('the header stops accepting the password once the guesses run out', async () => {
    await withSandbox(async (sandbox) => {
      for (let i = 0; i < 10; i++) {
        assert.equal((await guessByHeader(sandbox, `wrong-${i}`)).status, 401);
      }
      const right = await guessByHeader(sandbox, RIGHT);
      assert.equal(right.status, 401, 'the guess that lands must not be accepted during the lockout');
    });
  });

  test('guesses through the header spend the sign-in allowance', async () => {
    await withSandbox(async (sandbox) => {
      for (let i = 0; i < 10; i++) await guessByHeader(sandbox, `wrong-${i}`);
      assert.equal((await signIn(sandbox, RIGHT)).status, 429);
    });
  });

  test('the right header still works for a client that has not been guessing', async () => {
    await withSandbox(async (sandbox) => {
      assert.equal((await guessByHeader(sandbox, RIGHT)).status, 200);
    });
  });
});
