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
 * users of a shared deployment do not see each other's traffic — as far as the
 * id is unguessable, which is the whole of the separation and is worth saying
 * plainly. `generateSessionId` mints one with enough entropy for that; a caller
 * who picks `test` is sharing with everyone else who picked `test`. Nothing
 * here is a place to send a callback carrying anything real.
 *
 * Storage applies an absolute 24-hour TTL, so a shared demo never accumulates.
 */

import { getInspectorSession, saveInspectorSession, deleteInspectorSession } from './storage.js';

/**
 * What bounds a session, and what does not.
 *
 * These two caps bound one session: fifty captures, each at most 64 KB once
 * serialised. Both are needed — a count alone bounds nothing, because a single
 * capture carries whatever body was posted, and a 5 MB one is stored whole.
 *
 * Neither bounds *total* storage, and nothing here does. The number of
 * sessions is uncapped by design: ids are chosen by the caller, so a cap would
 * mean either refusing new callers once a shared demo filled up, or evicting
 * someone mid-debug. What bounds session creation is the rate limit on the
 * endpoint, and what reclaims them is the 24-hour TTL in storage. That is a
 * real limit rather than a comfortable one, and it is the right size for a
 * sandbox rather than for a service holding anything valuable.
 *
 * 64 KB is three orders of magnitude above a payment callback, which runs to a
 * few hundred bytes.
 */
const MAX_CAPTURES_PER_SESSION = 50;
const MAX_CAPTURE_BYTES = 64 * 1024;

/**
 * Bound one captured body, keeping a readable head of anything oversized.
 *
 * Truncating rather than refusing is the point: this endpoint answers a
 * gateway, and the reason it exists is to show that a callback arrived. A 413
 * would tell the caller their delivery failed and leave nothing to inspect,
 * which is the opposite of the job.
 *
 * @param {any} body - Parsed request body
 * @returns {any} The body, or a marked-up excerpt of it
 */
function boundBody(body) {
  let serialised;
  try {
    serialised = JSON.stringify(body);
  } catch {
    // Circular or otherwise unserialisable. It cannot reach storage as-is
    // either, so say that rather than storing something that will not load.
    return { truncated: true, reason: 'body could not be serialised' };
  }

  if (serialised === undefined || serialised.length <= MAX_CAPTURE_BYTES) return body;

  return {
    truncated: true,
    originalBytes: serialised.length,
    preview: serialised.slice(0, MAX_CAPTURE_BYTES)
  };
}

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
    body: boundBody(capture.body)
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
