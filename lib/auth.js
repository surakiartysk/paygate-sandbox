/**
 * Simple Password Authentication
 * Protects admin dashboard and admin APIs
 * 
 * SECURITY MODEL:
 * - Public APIs (no auth required): /api/2c2p/* and /api/omise/*
 *   These are for external services to integrate with the payment gateway
 * - Protected APIs (auth required): /api/admin/*
 *   These require password authentication via X-Admin-Password header or admin_password cookie
 * - Password is set via ADMIN_PASSWORD environment variable (default: 'mockpay')
 * - Authentication is checked on every admin API request
 */

// Get password from environment variable
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mockpay';

/**
 * Check if the request has valid admin authentication
 * Checks for X-Admin-Password header or admin_password cookie
 */
export function isAuthenticated(request) {
  const headerPassword = request.headers['x-admin-password'];
  const cookiePassword = parseCookie(request.headers.cookie || '')['admin_password'];
  
  return headerPassword === ADMIN_PASSWORD || cookiePassword === ADMIN_PASSWORD;
}

/**
 * Return 401 Unauthorized response
 */
export function unauthorized(response) {
  return response.status(401).json({
    error: 'Unauthorized',
    message: 'Invalid or missing password. Please login first.'
  });
}

/**
 * Verify password and return result
 */
export function verifyPassword(password) {
  return password === ADMIN_PASSWORD;
}

/**
 * Parse cookie string into object
 */
function parseCookie(cookieString) {
  const cookies = {};
  if (!cookieString) return cookies;
  
  cookieString.split(';').forEach(cookie => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) {
      cookies[key] = decodeURIComponent(value);
    }
  });
  
  return cookies;
}

/**
 * Get the configured admin password (for login verification)
 */
export function getAdminPassword() {
  return ADMIN_PASSWORD;
}
