/**
 * Centralized constants for Paygate Sandbox
 * 
 * This file contains all shared constants used across the application.
 * Centralizing these values makes maintenance easier and ensures consistency.
 * 
 * Reference: https://developer.2c2p.com/v4.0.2/docs/response-code-payment
 */

// ============================================================================
// 2C2P Response Codes
// ============================================================================

/**
 * 2C2P Payment Response Codes
 * Used in: inquiry responses, callback payloads, status updates
 */
export const RESP_CODES = {
  SUCCESS: '0000',           // Transaction successful
  PENDING: '0001',           // Transaction is pending (alternative)
  IN_PROGRESS: '2001',       // Transaction in progress (preferred for pending)
  NOT_FOUND: '2002',         // Transaction not found
  FAILED: '2003',            // Payment / Inquiry Failed
  CANCELLED: '0003',         // Transaction is cancelled
  SYSTEM_ERROR: '0999',      // System error
  
  // Bank/Issuer decline codes (for failed scenarios)
  INSUFFICIENT_FUNDS: '4051',
  INVALID_CARD: '4014',
  EXPIRED_CARD: '4054',
  TIMEOUT: '5002',
};

/**
 * What 2C2P says each code means, word for word, for every code this sandbox
 * can send or offer. The forced errors and the dashboard's pickers read it
 * directly; a stored payment and a callback read it through `getRespDesc`,
 * which prefers the wording 2C2P's own payloads use for the status codes
 * ("Success", where this reference says "Successful") and falls through to
 * this table for everything else.
 *
 * Copied from the provider's payment response code reference
 * (https://developer.2c2p.com/docs/response-code-payment). Card declines are
 * 40 followed by the ISO 8583 response code.
 */
export const RESP_DESCRIPTIONS = {
  '0000': 'Successful',
  '0001': 'Transaction is pending',
  '0003': 'Transaction is cancelled',
  '0999': 'System error',
  '2001': 'Transaction in progress',
  '2002': 'Transaction not found',
  '2003': 'Payment / Inquiry Failed',
  '4001': 'Refer to card issuer',
  '4005': 'Do not honor',
  '4014': 'Invalid Card Number',
  '4041': 'Lost Card - Pick Up',
  '4043': 'Stolen Card - Pick Up',
  '4051': 'Insufficient Funds',
  '4054': 'Expired Card',
  '4057': 'Transaction Not Permitted to Cardholder',
  '4061': 'Exceeds Withdrawal Amount Limits',
  '4065': 'Exceeds Withdrawal Frequency Limit',
  '4078': 'Invalid Three Digits Format',
  '4080': 'User Cancellation by Closing Internet Browser',
  '4094': 'Duplicate Transmission',
  '5002': 'Timeout',
  '5005': 'Duplicated Invoice',
  '5006': 'Invalid Amount',
  '5009': 'Payment Expired',
  '5014': 'Authentication Failed',
  '5998': 'Internal Error',
  '9004': 'The [ParameterName] value is not valid',
  '9005': 'Some mandatory fields are missing',
  '9009': 'Amount is invalid',
  '9010': 'Invalid Currency Code',
  '9015': 'Existing Invoice Number',
  '9020': 'Payment Expired ( From V4 Payment API )',
  '9035': 'Payment failed',
  '9040': 'The token is invalid',
  '9058': 'Payment channel invalid',
  '9999': 'Request to merchant backend has failed',
};

/**
 * Map payment status to 2C2P response code
 * @type {Object.<string, string>}
 */
export const STATUS_TO_RESP_CODE = {
  success: RESP_CODES.SUCCESS,
  pending: RESP_CODES.IN_PROGRESS,
  failed: RESP_CODES.FAILED,
  cancelled: RESP_CODES.CANCELLED,
  expired: '5009',  // Payment Expired
};

/**
 * Map payment status to response description
 * @type {Object.<string, string>}
 */
export const STATUS_TO_RESP_DESC = {
  success: 'Success',
  pending: 'Transaction in progress.',
  failed: 'Payment / Inquiry Failed.',
  cancelled: 'Transaction is cancelled.',
  expired: 'Payment Expired',
};

/**
 * The status codes, worded as 2C2P's own responses word them rather than as
 * its code reference does. Only codes whose payload wording differs belong
 * here; any other code is described from RESP_DESCRIPTIONS.
 * @type {Object.<string, string>}
 */
export const RESP_CODE_TO_DESC = {
  [RESP_CODES.SUCCESS]: 'Success',
  [RESP_CODES.PENDING]: 'Transaction is pending.',
  [RESP_CODES.IN_PROGRESS]: 'Transaction in progress.',
  [RESP_CODES.NOT_FOUND]: 'Transaction not found.',
  [RESP_CODES.FAILED]: 'Payment / Inquiry Failed.',
  [RESP_CODES.CANCELLED]: 'Transaction is cancelled.',
  [RESP_CODES.SYSTEM_ERROR]: 'System error.',
};

// ============================================================================
// Payment Statuses
// ============================================================================

/**
 * Valid payment statuses
 * @type {string[]}
 */
export const VALID_STATUSES = ['pending', 'success', 'failed', 'cancelled', 'expired'];

/**
 * Valid inquiry behaviors for simulation
 * @type {string[]}
 */
export const VALID_INQUIRY_BEHAVIORS = ['normal', 'delay', 'error', 'timeout'];

// ============================================================================
// Payment Channels
// ============================================================================

/**
 * Supported payment channels
 * @type {Object.<string, string>}
 */
export const PAYMENT_CHANNELS = {
  CREDIT_CARD: 'CC',
  THREE_D_SECURE: '3DS',
  QR_CODE: 'QR',
  DIGITAL_WALLET: 'DPAY',
  PAY_AT_COUNTER: 'PC',
  SELF_SERVICE: 'SSM',
  INTERNET_BANKING: 'IB',
};

// ============================================================================
// Providers
// ============================================================================

/**
 * Supported payment providers
 * @type {Object.<string, string>}
 */
export const PROVIDERS = {
  TWO_C_TWO_P: '2c2p',
  OMISE: 'omise',
};

// ============================================================================
// Configuration Defaults
// ============================================================================

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  globalDelay: 0,
  forceError2c2p: null,
  forceErrorOmise: null,
  duplicateCallback: false,
  failureRate: 0,
  logTTLDays: 7,
  autoRefreshEnabled: false,
  customFieldPresets: [],
};

/**
 * Storage limits
 */
export const STORAGE_LIMITS = {
  MAX_LOGS_PER_PAYMENT: 50,
  MAX_TOTAL_LOGS: 1000,
  LOG_TTL_DAYS: 7,
};

// ============================================================================
// HTTP Status Codes (for reference)
// ============================================================================

export const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get response code for a payment status
 * @param {string} status - Payment status
 * @returns {string} Response code
 */
export function getRespCodeForStatus(status) {
  return STATUS_TO_RESP_CODE[status] || RESP_CODES.IN_PROGRESS;
}

/**
 * Get response description for a status or code
 * @param {string} statusOrCode - Payment status or response code
 * @returns {string} Response description
 */
export function getRespDesc(statusOrCode) {
  // RESP_DESCRIPTIONS before 'Unknown': without it, any code outside the
  // short table above — every card decline but three, 5014, 9009 — was
  // stored and called back as "Unknown", and since 'Unknown' is truthy a
  // caller's `getRespDesc(code) || getRespDesc(status)` never fell back.
  return STATUS_TO_RESP_DESC[statusOrCode]
    || RESP_CODE_TO_DESC[statusOrCode]
    || RESP_DESCRIPTIONS[statusOrCode]
    || 'Unknown';
}

/**
 * Check if a status is valid
 * @param {string} status - Status to validate
 * @returns {boolean}
 */
export function isValidStatus(status) {
  return VALID_STATUSES.includes(status);
}

/**
 * Check if a provider is valid
 * @param {string} provider - Provider to validate
 * @returns {boolean}
 */
export function isValidProvider(provider) {
  return Object.values(PROVIDERS).includes(provider);
}
