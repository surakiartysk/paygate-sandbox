/**
 * URL rewrite rules — pure unit tests, no server needed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRewriteRules, rewriteUrl } from '../lib/urlUtils.js';

describe('parseRewriteRules', () => {
  test('returns no rules when unset', () => {
    assert.deepEqual(parseRewriteRules(undefined), []);
    assert.deepEqual(parseRewriteRules(''), []);
  });

  test('parses a comma-separated list', () => {
    assert.deepEqual(
      parseRewriteRules('api.example.com=>staging-api.example.com,example.com=>staging.example.com'),
      [
        { from: 'api.example.com', to: 'staging-api.example.com' },
        { from: 'example.com', to: 'staging.example.com' }
      ]
    );
  });

  test('skips malformed entries instead of throwing', () => {
    assert.deepEqual(parseRewriteRules('good.com=>ok.com,garbage'), [{ from: 'good.com', to: 'ok.com' }]);
  });
});

describe('rewriteUrl', () => {
  test('passes URLs through when no rules are configured', () => {
    delete process.env.URL_REWRITE_RULES;
    assert.equal(rewriteUrl('https://api.example.com/hook'), 'https://api.example.com/hook');
  });

  test('rewrites a matching host and preserves path and query', () => {
    process.env.URL_REWRITE_RULES = 'api.example.com=>staging-api.example.com';
    assert.equal(
      rewriteUrl('https://api.example.com/payment/callback?x=1'),
      'https://staging-api.example.com/payment/callback?x=1'
    );
  });

  test('leaves non-matching hosts alone', () => {
    process.env.URL_REWRITE_RULES = 'api.example.com=>staging-api.example.com';
    assert.equal(rewriteUrl('https://other.com/hook'), 'https://other.com/hook');
  });

  test('matches the host exactly, not as a substring', () => {
    process.env.URL_REWRITE_RULES = 'example.com=>staging.example.com';
    // A subdomain is a different host and must not be rewritten by this rule.
    assert.equal(rewriteUrl('https://api.example.com/hook'), 'https://api.example.com/hook');
  });

  test('returns unparseable input untouched', () => {
    process.env.URL_REWRITE_RULES = 'api.example.com=>staging-api.example.com';
    assert.equal(rewriteUrl('not a url'), 'not a url');
    assert.equal(rewriteUrl(''), '');
    assert.equal(rewriteUrl(null), null);
  });
});
