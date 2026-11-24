/**
 * A demo visitor's own settings — decision 31 in docs/decisions.md.
 *
 * The instance's settings apply to every caller, so a visitor could only ever
 * look at them. Each visitor now has a copy of their own, which lasts as long
 * as their sandbox and applies to what is theirs:
 *
 * - a provider request that carries their `X-Demo-Token` header — the delay,
 *   the forced errors and the failure rate;
 * - a callback for one of their payments, whoever sends it — the duplicate;
 * - their dashboard — auto-refresh and the custom-field presets.
 *
 * The log's retention is the instance's, not a visitor's, so it is not here.
 */

import { DEFAULT_CONFIG } from './constants.js';
import { resolveDemoVisitor } from './demoAccess.js';
import { getDemoSettings, saveDemoSettings } from './storage.js';

/** What a visitor may set. Everything the settings dialog offers but retention. */
export const VISITOR_SETTING_KEYS = Object.freeze([
  'globalDelay',
  'forceError2c2p',
  'forceErrorOmise',
  'duplicateCallback',
  'failureRate',
  'autoRefresh',
  'customFieldPresets',
]);

/**
 * A new visitor's settings: the defaults, not the owner's. Starting from the
 * owner's would show a stranger how the owner has the instance set, and would
 * change under them when the owner changed it.
 *
 * @returns {Object} Settings
 */
export function visitorDefaults() {
  return Object.fromEntries(VISITOR_SETTING_KEYS.map((key) => [key, structuredClone(DEFAULT_CONFIG[key])]));
}

/**
 * The settings for a visitor, by owner id: theirs over the defaults.
 *
 * @param {string} ownerId - The visitor's owner id
 * @returns {Promise<Object>} Settings
 */
export async function settingsForOwner(ownerId) {
  const record = await getDemoSettings(ownerId);
  const saved = record?.settings ?? {};
  const picked = Object.fromEntries(VISITOR_SETTING_KEYS.filter((key) => key in saved).map((key) => [key, saved[key]]));
  return { ...visitorDefaults(), ...picked };
}

/**
 * Merge an update into a visitor's settings and keep them until the visitor
 * expires. The update is validated by the caller; this only drops keys a
 * visitor may not set, so a key that slipped past cannot be stored.
 *
 * @param {object} visitor - The visitor, as resolved from their token
 * @param {Object} updates - Validated changes
 * @returns {Promise<Object>} The settings now stored
 */
export async function saveVisitorSettings(visitor, updates) {
  const current = await settingsForOwner(visitor.ownerId);
  const allowed = Object.fromEntries(
    Object.entries(updates).filter(([key]) => VISITOR_SETTING_KEYS.includes(key))
  );
  const next = { ...current, ...allowed };
  await saveDemoSettings(visitor.ownerId, next, visitor.expiresAt);
  return next;
}

/**
 * The visitor settings a provider request asks for, or null when it asks for
 * none: no `X-Demo-Token`, or one that is not a live visitor's.
 *
 * Marked `fromVisitor`, so the code that applies them can hold a visitor's
 * delay to the ceiling every visitor-set wait is held to (decision 9).
 *
 * @param {object} request - Incoming provider request
 * @returns {Promise<Object|null>} Settings
 */
export async function visitorSettingsFor(request) {
  if (!request?.headers?.['x-demo-token']) return null;
  const visitor = await resolveDemoVisitor(request);
  if (!visitor) return null;
  return { ...(await settingsForOwner(visitor.ownerId)), fromVisitor: true };
}

/**
 * The settings that decide whether a callback for this payment is sent twice:
 * its visitor's when it is a live visitor's payment, otherwise null, and the
 * caller falls back to the instance's.
 *
 * @param {Record<string, any>|null} payment - The payment the callback is for
 * @returns {Promise<Object|null>} Settings
 */
export async function visitorSettingsForPayment(payment) {
  if (!payment?.demoOwner || !(Date.parse(payment.demoExpiresAt) > Date.now())) return null;
  return settingsForOwner(payment.demoOwner);
}
