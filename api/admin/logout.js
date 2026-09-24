/**
 * POST /api/admin/logout
 *
 * Ends the admin session in this browser. It has to be a route: the session
 * cookie is HttpOnly, so the page cannot clear it itself.
 *
 * Always 200, signed in or not, so signing out never fails. It also expires
 * the `admin_password` cookie older dashboards set, which held the password
 * itself.
 */

import { clearAdminSession } from '../../lib/auth.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }
  response.setHeader('Set-Cookie', clearAdminSession(request));
  return response.status(200).json({ success: true });
}
