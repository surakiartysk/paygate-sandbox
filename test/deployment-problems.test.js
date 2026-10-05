/**
 * What a deployment is told about the settings it is missing.
 *
 * The list named two — the admin password and the private-callback guard — and
 * both are enforced where they bite, so it was only ever printed when one of
 * those two tripped. Two more settings change what a deployment *does* without
 * making anything fail loudly:
 *
 * - Without `TRUST_PROXY=true` behind the platform's proxy, every client arrives
 *   from the proxy's address and shares one rate-limit bucket: the cap becomes
 *   per-instance, and a handful of visitors can lock each other out.
 * - Without a KV store, a serverless deployment falls back to files it cannot
 *   keep, and what was written is gone with the instance.
 *
 * Neither has a safe default to fall back to, so they are reported, not
 * enforced; and since a report nobody triggers is not a report, the rate limiter,
 * which every API request passes, triggers it.
 *
 * Each file here runs in its own process, so the once-per-process memory of
 * what was printed starts empty.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentProblems } from '../lib/deployment.js';
import { enforceRateLimit } from '../lib/rateLimit.js';

const VARIABLES = ['RATE_LIMIT_MAX', 'VERCEL', 'ADMIN_PASSWORD', 'ALLOW_PRIVATE_CALLBACKS', 'TRUST_PROXY', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
});

afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const deployedAndOtherwiseConfigured = () => {
  process.env.VERCEL = '1';
  process.env.ADMIN_PASSWORD = 'a-long-random-password';
  process.env.ALLOW_PRIVATE_CALLBACKS = 'false';
};

describe('deploymentProblems', () => {
  test('names TRUST_PROXY and the missing KV store on a deployment without them', () => {
    deployedAndOtherwiseConfigured();
    const problems = deploymentProblems().join('\n');

    assert.match(problems, /TRUST_PROXY/);
    assert.match(problems, /KV_REST_API_URL/);
  });

  test('is empty once everything is set', () => {
    deployedAndOtherwiseConfigured();
    process.env.TRUST_PROXY = 'true';
    process.env.KV_REST_API_URL = 'https://kv.example';
    process.env.KV_REST_API_TOKEN = 'token';

    assert.deepEqual(deploymentProblems(), []);
  });

  test('still reports KV when only half of the pair is set', () => {
    deployedAndOtherwiseConfigured();
    process.env.TRUST_PROXY = 'true';
    process.env.KV_REST_API_URL = 'https://kv.example';

    assert.match(deploymentProblems().join('\n'), /KV_REST_API_TOKEN/);
  });

  test('says nothing locally, where files and the socket address are the point', () => {
    assert.deepEqual(deploymentProblems(), []);
  });
});

describe('the rate limiter reports them', () => {
  const request = { headers: {}, socket: { remoteAddress: '203.0.113.9' } };
  const response = { setHeader() {}, status() { return this; }, json() {} };
  const handle = () => enforceRateLimit(request, response);

  function captured(run) {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      run();
    } finally {
      console.error = original;
    }
    return lines.join('\n');
  }

  test('on the first request of a deployment, naming what is missing', () => {
    deployedAndOtherwiseConfigured();
    const output = captured(handle);

    assert.match(output, /TRUST_PROXY/);
    assert.match(output, /KV_REST_API_URL/);
  });

  test('even with the limiter switched off', () => {
    deployedAndOtherwiseConfigured();
    process.env.RATE_LIMIT_MAX = '0';
    delete process.env.ADMIN_PASSWORD; // a list unlike the others, so it counts as new

    assert.match(captured(handle), /KV_REST_API_URL/);
  });

  test('once, not on every request', () => {
    // A different list from the test above, so what it printed does not count as already said.
    deployedAndOtherwiseConfigured();
    process.env.TRUST_PROXY = 'true';
    const first = captured(handle);
    const second = captured(handle);

    assert.notEqual(first, '');
    assert.equal(second, '');
  });

  test('not at all when running locally', () => {
    assert.equal(captured(handle), '');
  });
});
