/**
 * The terminal snippet on the landing page works on the instance showing it.
 *
 * It settled the payment through the admin API with the local default
 * password, `mockpay`, and a public deployment refuses the default — so on the
 * one instance a visitor could reach, step 2 was a 401, and a guess spent
 * against their sign-in allowance. Its fixed invoice number was a duplicate
 * for every visitor after the first.
 *
 * So this takes the snippet from the page's own script, with this sandbox as
 * its origin, and runs it in a shell the way a visitor pasting it would. The
 * sandbox's admin password is not `mockpay`, as on any real deployment.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { startSandbox } from './helpers.js';

const PAGE_SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'landing.js'),
  'utf8'
);

/**
 * The snippet the landing page shows when served from `origin`.
 * @param {string} origin - The page's origin
 * @returns {string} The snippet's text
 */
function snippetFor(origin) {
  const elements = {};
  const element = () => ({ textContent: '', innerHTML: '', addEventListener() {}, disabled: false });
  vm.runInContext(
    PAGE_SCRIPT,
    vm.createContext({
      location: { origin },
      document: { getElementById: (id) => (elements[id] ??= element()) },
      console
    })
  );
  return elements['quickstart-code'].textContent;
}

describe('landing page terminal snippet', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('asks for no admin password', () => {
    assert.doesNotMatch(snippetFor(sandbox.baseUrl), /X-Admin-Password|mockpay/);
  });

  test('delivers a callback when pasted into a shell, twice in a row', () => {
    // Twice, because the second visitor is the one a fixed invoice number fails.
    for (const attempt of [1, 2]) {
      const output = execFileSync('bash', ['-c', snippetFor(sandbox.baseUrl)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });

      // Step 3's answer is the last JSON document printed.
      const session = JSON.parse(output.slice(output.lastIndexOf('{"success":true,"sessionId"')));
      assert.equal(session.captures.length, 1, `attempt ${attempt}: no callback reached the inspector`);
      assert.equal(session.captures[0].body.payload.respCode, '0000', `attempt ${attempt}`);
    }
  });
});
