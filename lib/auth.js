/**
 * Simple Password Authentication
 * Protects admin dashboard and admin APIs
 *
 * SECURITY MODEL:
 * - Public APIs (no auth required): /api/2c2p/* and /api/omise/*
 *   These are for external services to integrate with the payment gateway
 * - Protected APIs (auth required): /api/admin/*
 *   A script sends the password in the X-Admin-Password header. A browser signs
 *   in once and holds a session cookie instead — see "Browser sessions" below
 * - Password is set via ADMIN_PASSWORD environment variable (default: 'mockpay')
 * - Authentication is checked on every admin API request
 * - `isAuthenticated` means the admin and only the admin. A demo visitor is a
 *   separate principal (lib/demoAccess.js), so every route that checks this and
 *   nothing else refuses a demo visitor without having been told to.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { announceDeploymentProblems, isPublicDeployment } from './deployment.js';

// Get password from environment variable
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mockpay';

/**
 * The demo sign-in password. Published on the login page on purpose: what it
 * grants is scoped narrowly enough to hand to anyone — see lib/demoAccess.js
 * and docs/decisions.md, decision 17.
 */
export const DEMO_PASSWORD = 'demo';

/**
 * An admin password equal to the published demo one is no password at all.
 *
 * Refused everywhere, not only when deployed. Unlike the default, no local
 * workflow depends on it, and the failure it prevents is total: the password
 * printed on the login page would open the admin surface instead of the demo.
 */
const ADMIN_PASSWORD_IS_DEMO = ADMIN_PASSWORD === DEMO_PASSWORD;

/**
 * Whether the password is the one printed in this repository.
 *
 * Captured at import beside the password itself, because they have to agree:
 * reading one at import and the other per request is how the two drift.
 */
const USING_PUBLISHED_DEFAULT = !process.env.ADMIN_PASSWORD;

/**
 * A deployment running on the published default has no admin password at all,
 * and is treated that way.
 *
 * docs/deployment.md says ADMIN_PASSWORD must be "something long and random"
 * because "the default is public knowledge". Nothing enforced it, so an
 * instance that forgot served its dashboard, its logs and its config API to
 * anyone who had read the README.
 *
 * Refusing locks the owner out until they set the variable. That is the safe
 * direction and it is recoverable in one redeploy; an admin surface open to
 * everyone is neither. Locally it does not apply — the quick start depends on
 * `mockpay` working, and a check that broke that is a check people disable.
 */
function passwordIsUsable() {
  if (ADMIN_PASSWORD_IS_DEMO) return false;
  if (!isPublicDeployment() || !USING_PUBLISHED_DEFAULT) return true;
  announceDeploymentProblems();
  return false;
}

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
  if (!passwordIsUsable()) return false;

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
 * Check if the request has valid admin authentication: the password in the
 * X-Admin-Password header, or a live session cookie.
 *
 * The password is no longer accepted from a cookie. It used to be, and the
 * dashboard put it there and in localStorage for thirty days, where any
 * script running on the page could read it back.
 */
export function isAuthenticated(request) {
  const headerOk = secretsMatch(request.headers['x-admin-password'], ADMIN_PASSWORD);
  const sessionOk = sessionIsValid(parseCookie(request.headers.cookie || '')[SESSION_COOKIE]);
  return headerOk || sessionOk;
}

// ── Browser sessions ────────────────────────────────────────────────────────
//
// Signing in on the dashboard sets an HttpOnly cookie holding a signed expiry,
// and the page keeps nothing secret at all. Before this the page stored the
// password itself, in localStorage and in a script-readable cookie, so a single
// unescaped value anywhere in the dashboard would have handed it to whoever
// planted it — and a password, unlike a session, does not expire.
//
// **Signed, not stored.** The cookie is `v1.<expiry>.<nonce>.<mac>`, the MAC
// keyed by a hash of ADMIN_PASSWORD. Nothing is written server-side, so
// `isAuthenticated` stays synchronous for the routes that call it, and changing
// the password ends every session at once.
//
// **The cost.** Signing out clears the cookie in that browser, but a copy
// taken before then stays valid until it expires; only rotating the password
// revokes it early. HttpOnly is what makes taking a copy hard — a script can
// act as the admin while the page is open, but cannot carry the session away —
// and the twelve-hour lifetime bounds what a copy is worth.
//
// **CSRF.** A cookie is sent on requests the page did not make, which is why
// demo tokens travel in a header (lib/demoAccess.js). This one is
// SameSite=Strict, so a cross-site page cannot make the browser send it.

const SESSION_COOKIE = 'paygate_admin';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** The MAC key: derived, so the password itself is never the key. */
function sessionKey() {
  return createHash('sha256').update('paygate admin session\0').update(ADMIN_PASSWORD).digest();
}

function sessionMac(payload) {
  return createHmac('sha256', sessionKey()).update(payload).digest('base64url');
}

/**
 * Whether a cookie value is a session this instance issued and has not expired.
 * @param {unknown} value - The cookie's value
 * @param {number} [now] - Time in ms
 * @returns {boolean}
 */
export function sessionIsValid(value, now = Date.now()) {
  if (typeof value !== 'string') return false;
  // A session minted while the password was usable must not outlive it.
  if (!passwordIsUsable()) return false;

  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const [version, expiry, nonce, mac] = parts;

  const expected = Buffer.from(sessionMac(`${version}.${expiry}.${nonce}`));
  const presented = Buffer.from(mac);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return false;

  return Number(expiry) > now;
}

/**
 * Whether the request arrived over HTTPS, so the cookie can be marked Secure.
 * Not on plain-HTTP local runs, where a Secure cookie would never come back.
 */
function isHttps(request) {
  return request.headers?.['x-forwarded-proto'] === 'https' || isPublicDeployment();
}

function cookieAttributes(request, maxAge) {
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(request) ? '; Secure' : ''}`;
}

/**
 * A Set-Cookie value starting an admin session.
 * @param {object} request - The sign-in request
 * @param {number} [now] - Time in ms
 * @returns {string}
 */
export function issueAdminSession(request, now = Date.now()) {
  const expiry = now + SESSION_TTL_SECONDS * 1000;
  const payload = `v1.${expiry}.${randomBytes(16).toString('base64url')}`;
  return `${SESSION_COOKIE}=${payload}.${sessionMac(payload)}; ${cookieAttributes(request, SESSION_TTL_SECONDS)}`;
}

/**
 * Set-Cookie values ending the session, and the password cookie older
 * dashboards left behind.
 * @param {object} request - The sign-out request
 * @returns {string[]}
 */
export function clearAdminSession(request) {
  return [
    `${SESSION_COOKIE}=; ${cookieAttributes(request, 0)}`,
    'admin_password=; Path=/; Max-Age=0'
  ];
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
