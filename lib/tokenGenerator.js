/**
 * Token Generator
 * Generates mock payment tokens and transaction references
 */

import { randomBytes } from 'crypto';

/**
 * Generate a mock payment token
 * Format: mock_token_{random_string}
 */
export function generatePaymentToken() {
  const randomPart = randomBytes(24).toString('base64url');
  return `mock_token_${randomPart}`;
}

/**
 * Generate a transaction reference
 * Format: TXN{timestamp}{random}
 */
export function generateTranRef() {
  const timestamp = Date.now().toString().slice(-8);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `TXN${timestamp}${random}`;
}

/**
 * Generate a reference number
 * Format: REF{random}
 */
export function generateReferenceNo() {
  const random = Math.floor(Math.random() * 10000000).toString().padStart(7, '0');
  return `REF${random}`;
}

/**
 * Generate an approval code
 * Format: 6 digit number
 */
export function generateApprovalCode() {
  return Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
}

/**
 * Generate Omise-style IDs for charges, tokens, sources, events
 * Format: {prefix}_test_{random_string} (test mode) or {prefix}_{random_string} (live)
 */
export function generateOmiseId(prefix, livemode = false) {
  const randomPart = randomBytes(12).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 24);
  return livemode ? `${prefix}_${randomPart}` : `${prefix}_test_${randomPart}`;
}

export function generateOmiseChargeId(livemode = false) {
  return generateOmiseId('chrg', livemode);
}

export function generateOmiseTokenId(livemode = false) {
  return generateOmiseId('tokn', livemode);
}

export function generateOmiseSourceId(livemode = false) {
  return generateOmiseId('src', livemode);
}

export function generateOmiseEventId(livemode = false) {
  return generateOmiseId('evnt', livemode);
}
