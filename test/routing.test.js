/**
 * Catch-all route dispatch.
 *
 * Vercel exposes catch-all segments under the literal query key '...slug'
 * (three dots), while the local dev server passes 'slug'. A handler that reads
 * only one of the two dispatches correctly in development and answers "endpoint
 * not found" for every route in production — which is exactly what happened to
 * the 2C2P routes on the first deploy.
 *
 * These tests call the handlers directly with each shape, since the difference
 * lives in the platform's query object rather than in anything HTTP-visible.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Minimal stand-in for the response object the handlers are given.
 * @returns {object} Recorder exposing the status and JSON body written to it
 */
function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    end() { return this; }
  };
}

describe('2C2P catch-all dispatch', () => {
  /**
   * @param {object} query - Query object as the platform would supply it
   * @returns {Promise<object>} The response recorder
   */
  async function callWith(query) {
    const handler = (await import('../api/2c2p/[...slug].js')).default;
    const response = mockResponse();
    await handler(
      { method: 'POST', url: '/api/2c2p/inquiry', headers: {}, query, body: { invoiceNo: 'NOPE' } },
      response
    );
    return response;
  }

  test("dispatches when segments arrive under Vercel's '...slug' key", async () => {
    const response = await callWith({ '...slug': ['inquiry'] });
    assert.notEqual(response.body?.respDesc, 'Endpoint not found');
  });

  test("dispatches when segments arrive under the dev server's 'slug' key", async () => {
    const response = await callWith({ slug: ['inquiry'] });
    assert.notEqual(response.body?.respDesc, 'Endpoint not found');
  });

  test('dispatches from the URL when the query carries no segments at all', async () => {
    const response = await callWith({});
    assert.notEqual(response.body?.respDesc, 'Endpoint not found');
  });

  test('a genuinely unknown route still reports not found', async () => {
    const handler = (await import('../api/2c2p/[...slug].js')).default;
    const response = mockResponse();
    await handler(
      { method: 'POST', url: '/api/2c2p/nonsense', headers: {}, query: { '...slug': ['nonsense'] }, body: {} },
      response
    );
    assert.equal(response.body?.respDesc, 'Endpoint not found');
  });
});

describe('inspector catch-all dispatch', () => {
  /**
   * @param {object} request - Request fields to send
   * @returns {Promise<object>} The response recorder
   */
  async function call(request) {
    const handler = (await import('../api/inspect/[[...slug]].js')).default;
    const response = mockResponse();
    await handler({ headers: {}, body: {}, ...request }, response);
    return response;
  }

  test('mints a session when reached with no path segments', async () => {
    // The bare /api/inspect path is why this route needs an optional catch-all.
    const response = await call({ method: 'POST', url: '/api/inspect', query: {} });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body?.sessionId, 'expected a session id');
  });

  test("reads a session id from Vercel's '...slug' key", async () => {
    const response = await call({
      method: 'GET',
      url: '/api/inspect/s_test123',
      query: { '...slug': ['s_test123'] }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body?.sessionId, 's_test123');
  });

  test('rejects a session id outside the permitted character set', async () => {
    const response = await call({
      method: 'GET',
      url: '/api/inspect/../etc/passwd',
      query: { '...slug': ['../etc/passwd'] }
    });
    assert.equal(response.statusCode, 400);
  });
});
