/**
 * Demo endpoints
 *
 * POST /api/demo/scenario — run one payment end to end and narrate each step
 * POST /api/demo/seed     — populate an empty instance with sample transactions
 *
 * Unauthenticated by design: these exist so someone opening a shared
 * deployment can see the sandbox work without reading any documentation first.
 * Both are rate limited, and seeding refuses to overwrite existing data.
 */

import { runDemoScenario, seedDemoPayments } from '../../lib/demo.js';
import { enforceRateLimit } from '../../lib/rateLimit.js';

/**
 * @param {object} request - Incoming request
 * @param {object} response - Outgoing response
 */
export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  // The guided scenario writes several records and sends a callback, so it is
  // held to a tighter limit than the ordinary provider APIs.
  if (enforceRateLimit(request, response, 10)) return;

  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const action = resolveAction(request);

  try {
    if (action === 'scenario') {
      const result = await runDemoScenario(request);
      return response.status(200).json({ success: true, ...result });
    }

    if (action === 'seed') {
      const result = await seedDemoPayments();
      return response.status(200).json({
        success: true,
        ...result,
        message: result.seeded
          ? `Seeded ${result.count} demo payments.`
          : `Instance already has ${result.count} payments; nothing was added.`
      });
    }

    return response.status(404).json({
      error: 'Unknown demo action',
      message: 'Expected /api/demo/scenario or /api/demo/seed'
    });
  } catch (error) {
    console.error('Demo error:', error);
    return response.status(500).json({ error: 'Internal error', message: error.message });
  }
}

/**
 * Pull the action out of the request path.
 * @param {object} request - Incoming request
 * @returns {string|null} Action name
 */
function resolveAction(request) {
  // Vercel exposes catch-all segments under the literal key '...slug'; the dev
  // server uses 'slug'. Accept either, then fall back to the URL.
  const slug = request.query?.['...slug'] ?? request.query?.slug;
  if (Array.isArray(slug) && slug.length > 0) return slug[0];
  if (typeof slug === 'string' && slug) return slug.split('/')[0];

  const path = (request.url || '').split('?')[0];
  const match = path.match(/\/api\/demo\/([^/]+)/);
  return match ? match[1] : null;
}
