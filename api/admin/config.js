/**
 * GET/POST /api/admin/config
 * GET /api/admin/response-codes (handled here via query param)
 * Get or update simulation configuration, or get response codes
 */

import { getConfig, updateConfig } from '../../lib/storage.js';
import { isAuthenticated, unauthorized } from '../../lib/auth.js';

// Response codes organized by provider
// Reference: https://developer.2c2p.com/docs/response-code-payment (2C2P)
// Reference: https://docs.omise.co/api/errors (Omise)
const RESPONSE_CODES = {
  '2c2p': {
    success: [
      { code: '0000', desc: 'Successful' }
    ],
    pending: [
      { code: '0001', desc: 'Transaction is pending' },
      { code: '2001', desc: 'Transaction in progress' }
    ],
    cancelled: [
      { code: '0003', desc: 'Transaction is cancelled' }
    ],
    failed: [
      // Card Issues
      { code: '4010', desc: 'Insufficient funds', category: 'Card' },
      { code: '4011', desc: 'Invalid card number', category: 'Card' },
      { code: '4012', desc: 'Invalid CVV', category: 'Card' },
      { code: '4013', desc: 'Transaction not allowed', category: 'Card' },
      { code: '4019', desc: 'Invalid card number', category: 'Card' },
      { code: '4051', desc: 'Expired card', category: 'Card' },
      { code: '4057', desc: 'Card stolen', category: 'Card' },
      { code: '4058', desc: 'Card lost', category: 'Card' },
      
      // Transaction Issues
      { code: '2002', desc: 'Transaction not found', category: 'Transaction' },
      { code: '4033', desc: 'Exceeds amount limit', category: 'Transaction' },
      { code: '4034', desc: 'Exceeds frequency limit', category: 'Transaction' },
      { code: '4094', desc: 'Duplicate Transmission', category: 'Transaction' },
      
      // System/Timeout
      { code: '0999', desc: 'System error', category: 'System' },
      { code: '5002', desc: 'Timeout', category: 'System' },
      { code: '5998', desc: 'Internal Error', category: 'System' },
      
      // Validation
      { code: '5005', desc: 'Duplicated Invoice', category: 'Validation' },
      { code: '5006', desc: 'Invalid Amount', category: 'Validation' },
      { code: '5009', desc: 'Payment Expired', category: 'Validation' },
      { code: '9015', desc: 'Existing Invoice Number', category: 'Validation' },
      { code: '9035', desc: 'Payment failed (Default)', category: 'General' },
      { code: '9040', desc: 'The token is invalid', category: 'Validation' },
      
      // Backend
      { code: '9999', desc: 'Request to merchant backend has failed', category: 'Backend' }
    ],
    expired: [
      { code: '5009', desc: 'Payment Expired' },
      { code: '9020', desc: 'Payment Expired (V4 API)' }
    ]
  },
  'omise': {
    success: [
      { code: 'successful', desc: 'Charge successful' }
    ],
    pending: [
      { code: 'pending', desc: 'Charge is pending' }
    ],
    failed: [
      // Authentication & Authorization
      { code: 'authentication_failure', desc: 'Authentication failed', category: 'Authentication' },
      { code: 'card_declined', desc: 'Card was declined by bank', category: 'Card' },
      { code: 'insufficient_funds', desc: 'Insufficient funds', category: 'Card' },
      { code: 'invalid_card', desc: 'Invalid card number', category: 'Card' },
      { code: 'invalid_card_number', desc: 'Invalid card number format', category: 'Card' },
      { code: 'invalid_card_token', desc: 'Invalid card token', category: 'Card' },
      { code: 'invalid_cvc', desc: 'Invalid CVC', category: 'Card' },
      { code: 'invalid_expiry_date', desc: 'Invalid expiry date', category: 'Card' },
      { code: 'expired_card', desc: 'Card has expired', category: 'Card' },
      { code: 'stolen_card', desc: 'Card reported as stolen', category: 'Card' },
      { code: 'lost_card', desc: 'Card reported as lost', category: 'Card' },
      
      // Processing Errors
      { code: 'processing_error', desc: 'Processing error occurred', category: 'System' },
      { code: 'failed', desc: 'Charge failed', category: 'General' },
      { code: 'api_error', desc: 'API error', category: 'System' },
      { code: 'network_error', desc: 'Network error', category: 'System' },
      { code: 'server_error', desc: 'Server error', category: 'System' },
      
      // Validation
      { code: 'invalid_amount', desc: 'Invalid amount', category: 'Validation' },
      { code: 'invalid_currency', desc: 'Invalid currency code', category: 'Validation' },
      { code: 'invalid_source', desc: 'Invalid source', category: 'Validation' },
      { code: 'duplicate_charge', desc: 'Duplicate charge', category: 'Validation' },
      
      // Charge Status
      { code: 'reversed', desc: 'Charge was reversed', category: 'Transaction' },
      { code: 'expired', desc: 'Charge expired', category: 'Validation' }
    ],
    cancelled: [
      { code: 'reversed', desc: 'Charge was reversed' }
    ],
    expired: [
      { code: 'expired', desc: 'Charge expired' }
    ]
  }
};

const DEFAULT_CODES = {
  '2c2p': {
    success: '0000',
    pending: '0001',
    failed: '9035',
    cancelled: '0003',
    expired: '5009'
  },
  'omise': {
    success: 'successful',
    pending: 'pending',
    failed: 'failed',
    cancelled: 'reversed',
    expired: 'expired'
  }
};

// Legacy support: return flat structure for backward compatibility
const LEGACY_RESPONSE_CODES = RESPONSE_CODES['2c2p'];
const LEGACY_DEFAULT_CODES = DEFAULT_CODES['2c2p'];

export default async function handler(request, response) {
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }
  
  // Check authentication
  if (!isAuthenticated(request)) {
    return unauthorized(response);
  }
  
  try {
    // Handle response-codes endpoint (check URL path - handles both direct and rewritten routes)
    // Vercel rewrites route /api/admin/response-codes to /api/admin/config, so we check URL path
    const urlPath = request.url?.split('?')[0] || '';
    // Check if this is a response-codes request (either direct or rewritten via vercel.json)
    if (urlPath.endsWith('/response-codes') || urlPath.includes('/response-codes') || request.query?.type === 'response-codes' || request.headers['x-rewrite-target']?.includes('/response-codes')) {
      if (request.method === 'GET') {
        // Support provider filter via query parameter
        const provider = request.query?.provider || 'all';
        
        if (provider === 'all') {
          // Return all providers
          return response.status(200).json({
            success: true,
            responseCodes: RESPONSE_CODES,
            defaultCodes: DEFAULT_CODES,
            // Legacy support: include flat structure for backward compatibility
            legacy: {
              responseCodes: LEGACY_RESPONSE_CODES,
              defaultCodes: LEGACY_DEFAULT_CODES
            }
          });
        } else if (RESPONSE_CODES[provider]) {
          // Return specific provider
          return response.status(200).json({
            success: true,
            provider,
            responseCodes: RESPONSE_CODES[provider],
            defaultCodes: DEFAULT_CODES[provider]
          });
        } else {
          return response.status(400).json({
            success: false,
            error: `Invalid provider: ${provider}. Supported: 2c2p, omise, all`
          });
        }
      }
      return response.status(405).json({ error: 'Method not allowed' });
    }
    
    // Handle config endpoints (default)
    if (request.method === 'GET') {
      const config = await getConfig();
      return response.status(200).json({
        success: true,
        config
      });
    }
    
    if (request.method === 'POST') {
      const updates = request.body;
      
      // Validate updates
      const validKeys = ['globalDelay', 'forceError', 'forceError2c2p', 'forceErrorOmise', 'duplicateCallback', 'failureRate', 'logTTLDays', 'customFieldPresets'];
      const invalidKeys = Object.keys(updates).filter(k => !validKeys.includes(k));
      
      if (invalidKeys.length > 0) {
        return response.status(400).json({
          success: false,
          error: `Invalid config keys: ${invalidKeys.join(', ')}`
        });
      }
      
      // Validate values
      if (updates.globalDelay !== undefined && (typeof updates.globalDelay !== 'number' || updates.globalDelay < 0)) {
        return response.status(400).json({
          success: false,
          error: 'globalDelay must be a non-negative number'
        });
      }
      
      if (updates.failureRate !== undefined && (typeof updates.failureRate !== 'number' || updates.failureRate < 0 || updates.failureRate > 100)) {
        return response.status(400).json({
          success: false,
          error: 'failureRate must be a number between 0 and 100'
        });
      }
      
      if (updates.logTTLDays !== undefined && (typeof updates.logTTLDays !== 'number' || updates.logTTLDays < 1)) {
        return response.status(400).json({
          success: false,
          error: 'logTTLDays must be a number >= 1'
        });
      }
      
      if (updates.customFieldPresets !== undefined) {
        const presets = updates.customFieldPresets;
        const isValid = Array.isArray(presets) && presets.every(p =>
          p && typeof p.name === 'string' && p.name.trim() !== '' &&
          p.fields && typeof p.fields === 'object' && !Array.isArray(p.fields)
        );
        if (!isValid) {
          return response.status(400).json({
            success: false,
            error: 'customFieldPresets must be an array of { name: string, fields: object }'
          });
        }
      }
      
      const newConfig = await updateConfig(updates);
      
      return response.status(200).json({
        success: true,
        message: 'Configuration updated',
        config: newConfig
      });
    }
    
    return response.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Config error:', error);
    return response.status(500).json({
      success: false,
      error: error.message
    });
  }
}
