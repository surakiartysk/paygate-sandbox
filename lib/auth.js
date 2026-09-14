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

import { timingSafeEqual } from 'node:crypto';

// Get password from environment variable
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mockpay';

/**
 * Compare a presented secret against the configured one without leaking its
 * length or contents through how long the comparison takes.
 *
 * `===` on strings returns as soon as two bytes differ, so the time it takes
 * correlates with how much of the prefix was right. That is the textbook shape
 * of a timing oracle, and it is the kind of thing a reader checks for first in
 * anything called `auth.js`.
 *
 * **The honest trade-off.** This is a sandbox holding invented payments, it
 * sits behind a rate limit, and it is served over the public internet where
 * network jitter is orders of magnitude larger than the few nanoseconds a
 * string comparison would ever reveal. Nobody is realistically extracting this
 * password by timing it. The reason to do it anyway is that the alternative —
 * a comment explaining why the obvious thing was skipped — costs more to read
 * than the five lines below, and "it did not matter here" is a judgement every
 * future reader has to re-derive.
 *
 * What this deliberately does *not* buy: the password is still a single shared
 * secret compared in full on every request, with no hashing, no salt, no
 * rotation and no lockout. Constant time closes one channel; it does not turn
 * this into an authentication system. The security of a public instance rests
 * on `ADMIN_PASSWORD` being long and random — see docs/deployment.md.
 *
 * @param {unknown} presented - The value supplied by the caller
 * @param {string} expected - The configured password
 * @returns {boolean} True when they match
 */
function secretsMatch(presented, expected) {
  if (typeof presented !== 'string') return false;

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  // `timingSafeEqual` throws when the lengths differ, and returning early here
  // does leak the length — which is the one fact this cannot hide without
  // hashing both sides first. A length is not the secret, and hashing to hide
  // it would be ceremony on a sandbox password.
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * Check if the request has valid admin authentication
 * Checks for X-Admin-Password header or admin_password cookie
 */
export function isAuthenticated(request) {
  const headerPassword = request.headers['x-admin-password'];
  const cookiePassword = parseCookie(request.headers.cookie || '')['admin_password'];

  // Both are compared, rather than short-circuiting on the header, so the work
  // done does not depend on which credential the caller happened to send.
  const headerOk = secretsMatch(headerPassword, ADMIN_PASSWORD);
  const cookieOk = secretsMatch(cookiePassword, ADMIN_PASSWORD);

  return headerOk || cookieOk;
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
  return secretsMatch(password, ADMIN_PASSWORD);
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
