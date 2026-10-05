/**
 * The README's quick start, run as written.
 *
 * Step 2 said "Settle it and fire the callback" and made one call: the callback
 * route. That route delivers a webhook and leaves the stored status alone, so
 * the payment stayed pending and an inquiry answered 2001 — the first thing a
 * reader following the page would have tried, and it did not do what the page
 * said. Nothing noticed, because nothing ran the page.
 *
 * This takes the first shell block under "Quick start", points it at a throwaway
 * sandbox in place of localhost:3000, runs it, and checks what the comments in
 * it claim.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSandbox } from './helpers.js';

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
const quickStart = readme.slice(readme.indexOf('## Quick start'), readme.indexOf('## What it does'));
const script = [...quickStart.matchAll(/```bash\n([\s\S]*?)```/g)]
  .map((match) => match[1])
  .find((block) => block.includes('SESSION='));

const haveCurl = spawnSync('curl', ['--version']).status === 0;

describe('the README quick start', { skip: !haveCurl && 'curl is not installed' }, () => {
  let sandbox;
  let output;

  before(async () => {
    // The password the README tells a reader to use, which is not the suite's usual one.
    sandbox = await startSandbox({ ADMIN_PASSWORD: 'mockpay' });
    assert.ok(script, 'found the quick-start block');
    const aimed = script.replaceAll('http://localhost:3000', sandbox.baseUrl);
    // -s is already in the block's first curl; the rest print progress to stderr, which is ignored.
    output = execFileSync('bash', ['-c', aimed], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('leaves the payment settled, as its second step says', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments/INV-0001`, { headers: { 'X-Admin-Password': 'mockpay' } });
    const { payment } = await response.json();
    assert.equal(payment.status, 'success');
  });

  test('delivers the callback it promises, and reads it back', () => {
    assert.match(output, /"captures":\[\{/, 'the inspector had captured a callback');
    assert.match(output, /INV-0001/);
  });
});
