/**
 * Simulation Engine
 * Handles delays, errors, and other simulation behaviors
 */

import { getConfig } from './storage.js';

/**
 * Apply simulation delay
 * Checks both per-request header and global config
 */
export async function applyDelay(request) {
  // Check per-request header first
  const headerDelay = request.headers?.['x-mock-delay'];
  if (headerDelay) {
    const delay = parseInt(headerDelay, 10);
    if (!isNaN(delay) && delay > 0) {
      await sleep(delay);
      return { delayed: true, duration: delay, source: 'header' };
    }
  }
  
  // Check global config
  const config = await getConfig();
  if (config.globalDelay && config.globalDelay > 0) {
    await sleep(config.globalDelay);
    return { delayed: true, duration: config.globalDelay, source: 'config' };
  }
  
  return { delayed: false };
}

/**
 * Work out which provider a request belongs to, from its path.
 *
 * This guessed `2c2p` from `/api/payment`, which is not a route this sandbox
 * serves — every 2C2P endpoint lives under `/api/2c2p`. So the guess returned
 * null for all of them, `forceError2c2p` could never fire, and the dashboard
 * offered a dropdown that did nothing. Its Omise twin worked, which is exactly
 * why it went unnoticed: testing the feature at all was likely to test the
 * half that worked.
 *
 * A caller that knows its provider should say so rather than leave it to this.
 *
 * @param {object} request - Incoming request
 * @returns {string|null} '2c2p', 'omise', or null when the path says neither
 */
function detectProvider(request) {
  const url = request.url || '';
  const pathname = request.pathname || url.split('?')[0] || '';
  
  if (pathname.startsWith('/api/omise') || url.startsWith('/api/omise')) {
    return 'omise';
  }
  if (pathname.startsWith('/api/2c2p') || url.startsWith('/api/2c2p')) {
    return '2c2p';
  }
  
  return null;
}

/**
 * Check if should force error
 * Returns error code if error should be forced, null otherwise
 * Now checks provider-specific force error settings
 */
export async function checkForceError(request, knownProvider = null) {
  // Check per-request header first (global override)
  const headerError = request.headers?.['x-mock-error'];
  if (headerError) {
    return headerError;
  }
  
  // Check global config with provider-specific settings
  const config = await getConfig();
  // A caller that knows which provider it is answering for passes it. Path
  // matching stays as the fallback for anything that does not, but it is the
  // weaker signal: it broke silently once already when the routes it matched
  // were not the routes that exist.
  const provider = knownProvider || detectProvider(request);
  
  if (provider === 'omise' && config.forceErrorOmise) {
    return config.forceErrorOmise;
  }
  
  if (provider === '2c2p' && config.forceError2c2p) {
    return config.forceError2c2p;
  }
  
  // Fallback to legacy forceError for backward compatibility
  if (config.forceError) {
    return config.forceError;
  }
  
  // Check failure rate (random failures)
  if (config.failureRate && config.failureRate > 0) {
    const random = Math.random() * 100;
    if (random < config.failureRate) {
      // Return provider-appropriate default error
      return provider === 'omise' ? 'processing_error' : '9999';
    }
  }
  
  return null;
}

/**
 * Check if duplicate callback should be sent
 */
export async function shouldDuplicateCallback() {
  const config = await getConfig();
  return config.duplicateCallback === true;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get error response for 2C2P format
 * Also handles Omise error codes by converting them to 2C2P format
 */
export function getErrorResponse(errorCode) {
  // If it's an Omise error code (string with underscores), convert to 2C2P format
  if (typeof errorCode === 'string' && (errorCode.includes('_') || errorCode === 'failed' || errorCode === 'successful')) {
    // Map Omise error codes to 2C2P error codes
    const omiseTo2C2PMap = {
      'processing_error': { respCode: '9999', respDesc: 'System error' },
      'insufficient_funds': { respCode: '4010', respDesc: 'Insufficient funds' },
      'invalid_card': { respCode: '4011', respDesc: 'Invalid card number' },
      'invalid_card_number': { respCode: '4011', respDesc: 'Invalid card number' },
      'invalid_cvc': { respCode: '4011', respDesc: 'Invalid card details' },
      'expired_card': { respCode: '4051', respDesc: 'Expired card' },
      'card_declined': { respCode: '4010', respDesc: 'Card declined' },
      'failed': { respCode: '9035', respDesc: 'Payment failed' },
      'authentication_failure': { respCode: '0001', respDesc: 'Invalid merchant' },
      'invalid_amount': { respCode: '0002', respDesc: 'Invalid amount' },
      'invalid_currency': { respCode: '0003', respDesc: 'Invalid currency' },
      'duplicate_charge': { respCode: '5005', respDesc: 'Duplicated Invoice' }
    };
    
    const mapped = omiseTo2C2PMap[errorCode];
    if (mapped) {
      return mapped;
    }
    
    // Default for unknown Omise codes
    return { respCode: '9999', respDesc: `Error: ${errorCode}` };
  }
  
  // Handle 2C2P numeric error codes
  const errorMap = {
    '0001': { respCode: '0001', respDesc: 'Invalid merchant' },
    '0002': { respCode: '0002', respDesc: 'Invalid amount' },
    '0003': { respCode: '0003', respDesc: 'Invalid currency' },
    '0999': { respCode: '0999', respDesc: 'System temporarily unavailable' },
    '9999': { respCode: '9999', respDesc: 'System error' },
    // Add more common 2C2P error codes
    '4010': { respCode: '4010', respDesc: 'Insufficient funds' },
    '4011': { respCode: '4011', respDesc: 'Invalid card number' },
    '4051': { respCode: '4051', respDesc: 'Expired card' },
    '5002': { respCode: '5002', respDesc: 'Timeout' },
    '5005': { respCode: '5005', respDesc: 'Duplicated Invoice' },
    '5006': { respCode: '5006', respDesc: 'Invalid Amount' },
    '5009': { respCode: '5009', respDesc: 'Payment Expired' },
    '9035': { respCode: '9035', respDesc: 'Payment failed' },
  };
  
  return errorMap[errorCode] || { respCode: errorCode, respDesc: 'Unknown error' };
}

/**
 * Get Omise error response format
 * Maps 2C2P error codes to Omise error codes, or returns Omise format directly
 */
export function getOmiseErrorResponse(errorCode) {
  // If already in Omise format (string with underscores), return it directly
  if (typeof errorCode === 'string' && (errorCode.includes('_') || errorCode === 'failed' || errorCode === 'successful')) {
    // Map Omise error codes to full error objects
    const omiseErrorMap = {
      'processing_error': {
        object: 'error',
        code: 'processing_error',
        message: 'An unexpected error occurred'
      },
      'insufficient_funds': {
        object: 'error',
        code: 'insufficient_funds',
        message: 'Insufficient funds'
      },
      'invalid_card': {
        object: 'error',
        code: 'invalid_card',
        message: 'Invalid card number'
      },
      'invalid_card_number': {
        object: 'error',
        code: 'invalid_card_number',
        message: 'Invalid card number format'
      },
      'invalid_cvc': {
        object: 'error',
        code: 'invalid_cvc',
        message: 'Invalid CVC'
      },
      'expired_card': {
        object: 'error',
        code: 'expired_card',
        message: 'Card has expired'
      },
      'card_declined': {
        object: 'error',
        code: 'card_declined',
        message: 'Card was declined by bank'
      },
      'failed': {
        object: 'error',
        code: 'failed',
        message: 'Charge failed'
      },
      'authentication_failure': {
        object: 'error',
        code: 'authentication_failure',
        message: 'Authentication failed'
      },
      'invalid_amount': {
        object: 'error',
        code: 'invalid_amount',
        message: 'Invalid amount'
      },
      'invalid_currency': {
        object: 'error',
        code: 'invalid_currency',
        message: 'Invalid currency code'
      },
      'duplicate_charge': {
        object: 'error',
        code: 'duplicate_charge',
        message: 'Duplicate charge'
      }
    };
    
    return omiseErrorMap[errorCode] || {
      object: 'error',
      code: errorCode,
      message: 'An error occurred'
    };
  }
  
  // Map 2C2P numeric codes to Omise error codes
  const codeMapping = {
    '0001': { code: 'authentication_failure', message: 'Invalid merchant' },
    '0002': { code: 'invalid_amount', message: 'Invalid amount' },
    '0003': { code: 'invalid_currency', message: 'Invalid currency' },
    '0999': { code: 'processing_error', message: 'System temporarily unavailable' },
    '9999': { code: 'processing_error', message: 'System error' },
    '4010': { code: 'insufficient_funds', message: 'Insufficient funds' },
    '4011': { code: 'invalid_card', message: 'Invalid card number' },
    '4051': { code: 'expired_card', message: 'Expired card' },
    '5002': { code: 'processing_error', message: 'Timeout' },
    '5005': { code: 'duplicate_charge', message: 'Duplicated Invoice' },
    '5006': { code: 'invalid_amount', message: 'Invalid Amount' },
    '5009': { code: 'expired', message: 'Payment Expired' },
    '9035': { code: 'failed', message: 'Payment failed' }
  };
  
  const mapped = codeMapping[errorCode];
  if (mapped) {
    return {
      object: 'error',
      code: mapped.code,
      message: mapped.message
    };
  }
  
  // Default: return as processing error
  return {
    object: 'error',
    code: 'processing_error',
    message: `Error ${errorCode}`
  };
}
