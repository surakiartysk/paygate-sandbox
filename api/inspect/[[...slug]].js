/**
 * Callback Inspector endpoint
 *
 * POST   /api/inspect/{sessionId}  — receive and record a callback
 * GET    /api/inspect/{sessionId}  — read back what was received
 * DELETE /api/inspect/{sessionId}  — discard a session
 * POST   /api/inspect              — mint a new session id and its URL
 *
 * Deliberately unauthenticated: the whole point is that the sandbox can post
 * to it the same way a merchant backend would, and that anyone trying the demo
 * can watch the result. Sessions carry a TTL and a per-session capture cap.
 */

import { recordCapture, getSession, clearSession, isValidSessionId, generateSessionId, buildInspectorUrl } from '../../lib/inspector.js';
import { enforceRateLimit } from '../../lib/rateLimit.js';

/**
 * @param {object} request - Incoming request
 * @param {object} response - Outgoing response
 */
export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (enforceRateLimit(request, response)) return;

  try {
    const sessionId = resolveSessionId(request);

    // No session in the path: mint one.
    if (!sessionId) {
      if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Method not allowed' });
      }
      const newId = generateSessionId();
      return response.status(200).json({
        success: true,
        sessionId: newId,
        callbackUrl: buildInspectorUrl(newId, request)
      });
    }

    if (!isValidSessionId(sessionId)) {
      return response.status(400).json({
        error: 'Invalid session id',
        message: 'Session ids may contain letters, digits, hyphen and underscore, up to 64 characters.'
      });
    }

    if (request.method === 'POST') {
      const { count } = await recordCapture(sessionId, {
        method: request.method,
        headers: pickHeaders(request.headers),
        body: request.body ?? null
      });

      // Answer the way a merchant backend would, so the sandbox records a
      // successful delivery.
      return response.status(200).json({ received: true, sessionId, count });
    }

    if (request.method === 'GET') {
      const session = await getSession(sessionId);
      return response.status(200).json({
        success: true,
        ...session,
        callbackUrl: buildInspectorUrl(sessionId, request)
      });
    }

    if (request.method === 'DELETE') {
      await clearSession(sessionId);
      return response.status(200).json({ success: true, sessionId, cleared: true });
    }

    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Inspector error:', error);
    return response.status(500).json({ error: 'Internal error', message: error.message });
  }
}

/**
 * Pull the session id out of the request path.
 * @param {object} request - Incoming request
 * @returns {string|null} Session id, or null when the path carries none
 */
function resolveSessionId(request) {
  // Vercel exposes catch-all segments under the literal key '...slug'; the dev
  // server uses 'slug'. Accept either, then fall back to the URL.
  const fromQuery = request.query?.['...slug'] ?? request.query?.slug;
  if (Array.isArray(fromQuery) && fromQuery.length > 0) return fromQuery[0];
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery.split('/')[0];

  const path = (request.url || '').split('?')[0];
  const match = path.match(/\/api\/inspect\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Keep the headers that matter for debugging an integration, and drop the rest
 * so a captured request never carries stray credentials into storage.
 *
 * @param {object} headers - Incoming headers
 * @returns {object} Filtered headers
 */
function pickHeaders(headers = {}) {
  const keep = ['content-type', 'user-agent', 'x-forwarded-for'];
  const result = {};
  for (const key of keep) {
    if (headers[key]) result[key] = headers[key];
  }
  return result;
}
