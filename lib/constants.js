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
  INSUFFICIENT_FUNDS: '4010',
  INVALID_CARD: '4011',
  EXPIRED_CARD: '4051',
  TIMEOUT: '5002',
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
  expired: RESP_CODES.FAILED,  // No specific expiry code, treat as failed
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
  expired: 'Transaction expired.',
};

/**
 * Map response code to description (for reverse lookup)
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
  [RESP_CODES.INSUFFICIENT_FUNDS]: 'Insufficient funds',
  [RESP_CODES.INVALID_CARD]: 'Invalid card number',
  [RESP_CODES.EXPIRED_CARD]: 'Expired card',
  [RESP_CODES.TIMEOUT]: 'Timeout',
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
  return STATUS_TO_RESP_DESC[statusOrCode] 
    || RESP_CODE_TO_DESC[statusOrCode] 
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
