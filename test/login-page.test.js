/**
 * The login page opens on the demo (decision 30).
 *
 * Read as text, like the design-system checks: the page is static HTML, and
 * what matters is its order and what is folded away, which the markup states.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
const body = html.slice(html.indexOf('<body'));

test('leads with the demo, as the primary button, before any password field', () => {
  const demo = body.indexOf('id="demo-signin"');
  const password = body.indexOf('type="password"');
  assert.ok(demo !== -1, 'the demo button is on the page');
  assert.ok(demo < password, 'the demo comes first');
  assert.match(body, /class="btn btn-primary" id="demo-signin"/);
});

test('keeps the owner sign-in folded away, shut until it is asked for', () => {
  const owner = /<details class="login-owner"([^>]*)>([\s\S]*?)<\/details>/.exec(body);
  assert.ok(owner, 'the owner sign-in is a <details>');
  assert.doesNotMatch(owner[1], /\bopen\b/, 'it starts shut');
  assert.match(owner[2], /type="password"/, 'the password field is inside it');
  assert.doesNotMatch(body, /autofocus/, 'nothing pulls focus to the password');
});

test('signs the demo in without touching the owner form', () => {
  assert.match(body, /function signInAsDemo\(\) \{\s*(?:\/\/[^\n]*\n\s*)*signIn\('demo'\);\s*\}/);
});
