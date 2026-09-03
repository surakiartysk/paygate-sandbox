/**
 * Admin API: authentication and configuration.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox, adminHeaders, postJson } from './helpers.js';

describe('admin API', () => {
  let sandbox;

  before(async () => {
    sandbox = await startSandbox();
  });

  after(async () => {
    await sandbox?.stop();
  });

  test('rejects requests without the admin password', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments`);
    assert.equal(response.status, 401);
  });

  test('rejects requests with the wrong admin password', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments`, {
      headers: { 'X-Admin-Password': 'wrong-password' }
    });
    assert.equal(response.status, 401);
  });

  test('accepts requests with the correct admin password', async () => {
    const response = await fetch(`${sandbox.baseUrl}/api/admin/payments`, {
      headers: adminHeaders()
    });
    assert.equal(response.status, 200);
  });

  test('rejects unknown configuration keys', async () => {
    const { status, body } = await postJson(
      `${sandbox.baseUrl}/api/admin/config`,
      { notARealSetting: true },
      adminHeaders()
    );

    assert.equal(status, 400);
    assert.match(body.error, /invalid config keys/i);
  });

  test('stores and returns custom field presets', async () => {
    const presets = [
      { name: 'Order context', fields: { orderRef: 'ORD-1', tenant: 'acme' } }
    ];

    const saved = await postJson(
      `${sandbox.baseUrl}/api/admin/config`,
      { customFieldPresets: presets },
      adminHeaders()
    );
    assert.equal(saved.status, 200);

    const response = await fetch(`${sandbox.baseUrl}/api/admin/config`, { headers: adminHeaders() });
    const body = await response.json();
    assert.deepEqual(body.config.customFieldPresets, presets);
  });

  test('rejects malformed custom field presets', async () => {
    const { status } = await postJson(
      `${sandbox.baseUrl}/api/admin/config`,
      { customFieldPresets: [{ name: '', fields: 'not-an-object' }] },
      adminHeaders()
    );

    assert.equal(status, 400);
  });

  test('validates numeric configuration bounds', async () => {
    const { status } = await postJson(
      `${sandbox.baseUrl}/api/admin/config`,
      { failureRate: 150 },
      adminHeaders()
    );

    assert.equal(status, 400, 'failureRate above 100 is rejected');
  });
});
