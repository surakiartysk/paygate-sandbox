/**
 * Callback Inspector
 *
 * A built-in endpoint that receives callbacks and keeps them for inspection.
 *
 * Testing a payment integration normally needs somewhere for the gateway to
 * POST back to. Locally that is your own service; on a shared demo there is no
 * such place, and pointing callbacks at an external request-bin means leaving
 * the sandbox to see what happened. The inspector closes that loop: point
 * `backendReturnUrl` at `/api/inspect/{sessionId}` and the callback lands in a
 * session you can read back through the UI.
 *
 * Sessions are namespaced by an arbitrary id chosen by the caller, so parallel
 * users of a shared deployment do not see each other's traffic. Storage applies
 * a 24-hour TTL, so a shared demo never accumulates.
 */

import { getInspectorSession, saveInspectorSession, deleteInspectorSession } from './storage.js';

/** Cap per session, so one noisy client cannot exhaust storage. */
const MAX_CAPTURES_PER_SESSION = 50;

/**
 * A session id is user-supplied and used as a storage key, so constrain it to
 * a short, safe character set.
 *
 * @param {string} sessionId - Candidate id
 * @returns {boolean} True when the id is acceptable
 */
export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sessionId);
}

/**
 * Generate a fresh session id.
 * @returns {string} New session id
 */
export function generateSessionId() {
  return `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Record one received callback against a session.
 *
 * @param {string} sessionId - Session to record into
 * @param {object} capture - What was received
 * @param {string} capture.method - HTTP method
 * @param {object} capture.headers - Request headers
 * @param {any} capture.body - Parsed request body
 * @returns {Promise<{ sessionId: string, count: number }>} Session state after recording
 */
export async function recordCapture(sessionId, capture) {
  const session = (await getInspectorSession(sessionId))
    || { createdAt: new Date().toISOString(), captures: [] };

  session.captures.push({
    receivedAt: new Date().toISOString(),
    method: capture.method,
    headers: capture.headers,
    body: capture.body
  });

  // Keep the most recent captures only, so one noisy client cannot grow
  // a session without bound.
  if (session.captures.length > MAX_CAPTURES_PER_SESSION) {
    session.captures = session.captures.slice(-MAX_CAPTURES_PER_SESSION);
  }

  await saveInspectorSession(sessionId, session);

  return { sessionId, count: session.captures.length };
}

/**
 * Read back everything captured for a session.
 *
 * @param {string} sessionId - Session to read
 * @returns {Promise<{ sessionId: string, createdAt: string|null, captures: Array<object> }>}
 */
export async function getSession(sessionId) {
  const session = await getInspectorSession(sessionId);

  return {
    sessionId,
    createdAt: session?.createdAt || null,
    captures: session?.captures || []
  };
}

/**
 * Discard a session's captures.
 * @param {string} sessionId - Session to clear
 */
export async function clearSession(sessionId) {
  await deleteInspectorSession(sessionId);
}

/**
 * Build the absolute URL a caller should use as their callback target.
 *
 * @param {string} sessionId - Session id
 * @param {object} request - Incoming request, used to infer the origin
 * @returns {string} Absolute inspector URL
 */
export function buildInspectorUrl(sessionId, request) {
  const configured = process.env.MOCK_SERVER_URL;
  if (configured) return `${configured.replace(/\/$/, '')}/api/inspect/${sessionId}`;

  const host = request?.headers?.host || 'localhost:3000';
  const forwardedProto = request?.headers?.['x-forwarded-proto'];
  // Local hosts are served over plain HTTP; anything else (a real deployment
  // behind a proxy that did not set x-forwarded-proto) is assumed to be HTTPS.
  const hostname = host.split(':')[0];
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    || hostname.endsWith('.localhost');
  const proto = forwardedProto || (isLocal ? 'http' : 'https');
  return `${proto}://${host}/api/inspect/${sessionId}`;
}
