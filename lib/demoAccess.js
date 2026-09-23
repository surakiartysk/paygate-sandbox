/**
 * Demo visitors: a way into the dashboard for anyone, scoped so that handing
 * out the password costs nothing.
 *
 * The admin password opens the whole instance — global config, every caller's
 * logs, deleting everything, and callbacks to any address. None of that can be
 * published. A demo visitor gets none of it: signing in with the published
 * password mints a token of their own, with ten sample payments of their own,
 * and every admin route either scopes itself to those payments or refuses.
 *
 * The shape follows two rules, both in docs/decisions.md, decision 17:
 *
 * - **Refused unless allowed.** `isAuthenticated` still means the admin and
 *   nothing else, so a route that has not been written with demo visitors in
 *   mind turns them away. A route opts in by calling `resolvePrincipal`, and
 *   has to check ownership itself.
 * - **Nothing a visitor sends decides where a request goes.** Their callbacks
 *   go to their own inspector session, fixed when they signed in — not to a
 *   URL in the request, and not to the one stored on the payment. Nothing can
 *   change that stored one today, but it lives in a record every writer of
 *   payments shares; the visitor record is written once, here.
 */

import { createHash, randomBytes } from 'node:crypto';
import { isAuthenticated } from './auth.js';
import { buildDemoPayment, DEMO_TEMPLATES } from './demo.js';
import { buildInspectorUrl } from './inspector.js';
import { deletePayment, getAllPayments, getDemoVisitor, saveDemoVisitor, savePayment } from './storage.js';

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Live visitor payments the instance will hold before it refuses new demo
 * sign-ins. Ten per visitor, so two hundred visitors in any 24 hours. Seeded
 * payments measured 0.83–1.06 KB serialised, so this is about 1.8 MB before
 * any callback history is added to them.
 */
const DEFAULT_MAX_LIVE_PAYMENTS = 2000;

/** `demo_` and 32 random bytes, base64url: 43 characters. */
const TOKEN_PATTERN = /^demo_[A-Za-z0-9_-]{43}$/;

/**
 * How long a visitor lasts. Configurable so a test can watch one expire.
 * @returns {number} Seconds
 */
function ttlSeconds() {
  const configured = Number(process.env.DEMO_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_SECONDS;
}

/**
 * The ceiling on live visitor payments. Configurable so a test can reach it.
 * @returns {number} Payments
 */
function maxLivePayments() {
  const configured = Number(process.env.DEMO_MAX_LIVE_PAYMENTS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MAX_LIVE_PAYMENTS;
}

/**
 * The key a visitor is stored under. A hash, so the store holds no token that
 * would work if read back.
 * @param {string} token - Visitor token
 * @returns {string} sha256, hex
 */
function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * @param {Record<string, any>} payment - Payment record
 * @param {number} now - Time in ms
 * @returns {boolean} Whether the payment belongs to a visitor whose time is up
 */
function isExpiredVisitorPayment(payment, now) {
  return Boolean(payment.demoOwner) && !(Date.parse(payment.demoExpiresAt) > now);
}

/**
 * Delete visitor payments whose visitor has expired.
 *
 * Run on every demo sign-in rather than on a timer: there is no scheduler
 * here, and sign-in is the one event that adds visitor payments, so sweeping
 * there keeps the count bounded by the same thing that grows it.
 *
 * @returns {Promise<number>} Payments deleted
 */
export async function sweepExpiredVisitorPayments() {
  const now = Date.now();
  const expired = (await getAllPayments()).filter(p => isExpiredVisitorPayment(p, now));
  for (const payment of expired) await deletePayment(payment.invoiceNo);
  return expired.length;
}

/**
 * Sign a new demo visitor in: mint their token, their inspector session and
 * their ten sample payments.
 *
 * @param {object} request - Incoming request, for the inspector URL's origin
 * @returns {Promise<{ full: true } | { full: false, token: string, visitor: object }>}
 */
export async function createDemoVisitor(request) {
  await sweepExpiredVisitorPayments();

  const now = Date.now();
  const live = (await getAllPayments()).filter(p => p.demoOwner && !isExpiredVisitorPayment(p, now)).length;
  if (live + DEMO_TEMPLATES.length > maxLivePayments()) return { full: true };

  const token = `demo_${randomBytes(32).toString('base64url')}`;
  // Not secret: it appears in the visitor's invoice numbers. It is what the
  // payments are owned by, so the token itself never has to be written to a
  // payment record, where the public inquiry API could read it back.
  const ownerId = randomBytes(5).toString('hex').toUpperCase();
  // Unguessable, unlike the inspector's own ids, because anyone holding it can
  // read what arrived.
  const inspectorSessionId = `s_demo_${randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(now + ttlSeconds() * 1000).toISOString();

  const visitor = {
    ownerId,
    inspectorSessionId,
    callbackUrl: buildInspectorUrl(inspectorSessionId, request),
    createdAt: new Date(now).toISOString(),
    expiresAt
  };

  await saveDemoVisitor(tokenHash(token), visitor);

  for (const [index, template] of DEMO_TEMPLATES.entries()) {
    const invoiceNo = `DEMO-${ownerId}-${String(index + 1).padStart(2, '0')}`;
    await savePayment({
      ...buildDemoPayment(template, index, now, { invoiceNo, backendReturnUrl: visitor.callbackUrl }),
      demoOwner: ownerId,
      demoExpiresAt: expiresAt
    });
  }

  return { full: false, token, visitor };
}

/**
 * The demo visitor a request carries, if it carries a live one.
 *
 * Read from `X-Demo-Token` only. Not from a cookie: a cookie is sent on
 * requests the visitor did not mean to make, and the dashboard has no need of
 * one — it sets the header itself.
 *
 * @param {object} request - Incoming request
 * @returns {Promise<object|null>} The visitor, or null
 */
export async function resolveDemoVisitor(request) {
  const token = request.headers?.['x-demo-token'];
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;

  const visitor = await getDemoVisitor(tokenHash(token));
  if (!visitor || !(Date.parse(visitor.expiresAt) > Date.now())) return null;
  return visitor;
}

/**
 * Who is asking: the admin, a demo visitor, or nobody.
 *
 * The admin wins when a request carries both, so a demo token left in a
 * browser never narrows what its admin can see.
 *
 * @param {object} request - Incoming request
 * @returns {Promise<{ role: 'admin' } | { role: 'demo', visitor: object } | null>}
 */
export async function resolvePrincipal(request) {
  if (isAuthenticated(request)) return { role: 'admin' };
  const visitor = await resolveDemoVisitor(request);
  return visitor ? { role: 'demo', visitor } : null;
}

/**
 * Whether a payment is this visitor's. A payment another visitor or the
 * admin's own callers made is not, and neither is one past its expiry.
 *
 * @param {object} visitor - Demo visitor
 * @param {Record<string, any>|null} payment - Payment record
 * @returns {boolean}
 */
export function ownsPayment(visitor, payment) {
  return Boolean(visitor && payment && payment.demoOwner)
    && payment.demoOwner === visitor.ownerId
    && Date.parse(payment.demoExpiresAt) > Date.now();
}

/**
 * Answer a demo visitor on a route they may not use.
 *
 * 403, not 401: the token is valid and the dashboard should keep it. A 401
 * would sign the visitor out for opening a tab they are not allowed.
 *
 * @param {object} response - Outgoing response
 * @returns {object} The response
 */
export function refuseDemo(response) {
  return response.status(403).json({
    error: 'Not available in the demo',
    message: 'Demo visitors can see and change their own sample payments only.'
  });
}
