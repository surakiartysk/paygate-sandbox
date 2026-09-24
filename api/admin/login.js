/**
 * POST /api/admin/login
 *
 * The admin password answers `{ role: 'admin' }` and sets an HttpOnly session
 * cookie — the dashboard keeps nothing secret, see "Browser sessions" in
 * lib/auth.js. The published demo password answers
 * `{ role: 'demo', token }` instead: a new visitor with sample payments of
 * their own, and the token is their credential — see lib/demoAccess.js.
 */

import { clearAdminSession, DEMO_PASSWORD, issueAdminSession, verifyPassword } from '../../lib/auth.js';
import { createDemoVisitor } from '../../lib/demoAccess.js';
import { enforceRateLimit } from '../../lib/rateLimit.js';

/**
 * Attempts per client per minute, admin and demo together. A demo sign-in
 * writes ten payments, and an admin attempt is a guess at the password, so
 * both are held well below the provider APIs' allowance — in a bucket of their
 * own, so browsing the sandbox does not spend them.
 */
const LOGIN_ATTEMPTS_PER_MINUTE = 10;

export default async function handler(request, response) {
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }
  
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  if (enforceRateLimit(request, response, LOGIN_ATTEMPTS_PER_MINUTE, 'login')) return;
  
  try {
    const { password } = request.body;
    
    if (!password) {
      return response.status(400).json({
        success: false,
        error: 'Password is required'
      });
    }
    
    if (verifyPassword(password)) {
      response.setHeader('Set-Cookie', issueAdminSession(request));
      return response.status(200).json({
        success: true,
        role: 'admin',
        message: 'Login successful'
      });
    } else if (password === DEMO_PASSWORD) {
      const result = await createDemoVisitor(request);
      if (result.full) {
        return response.status(503).json({
          success: false,
          error: 'The demo is full right now. Sample payments expire after a day; try again later.'
        });
      }
      // Signing in as demo ends an admin session in the same browser. The admin
      // wins when a request carries both, so leaving it would show the demo
      // visitor the admin's view — and only the server can clear an HttpOnly
      // cookie.
      response.setHeader('Set-Cookie', clearAdminSession(request));
      return response.status(200).json({
        success: true,
        role: 'demo',
        token: result.token,
        expiresAt: result.visitor.expiresAt,
        inspectorSessionId: result.visitor.inspectorSessionId
      });
    } else {
      return response.status(401).json({
        success: false,
        error: 'Invalid password'
      });
    }
    
  } catch (error) {
    console.error('Login error:', error);
    return response.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
}
