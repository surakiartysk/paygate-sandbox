/**
 * Consolidated admin payment routes:
 * GET /api/admin/payments/:invoiceNo - Get payment details
 * DELETE /api/admin/payments/:invoiceNo - Delete payment
 * POST /api/admin/payments/:invoiceNo/status - Update payment status
 * POST /api/admin/payments/:invoiceNo/callback - Send callback
 * GET/POST /api/admin/payments/:invoiceNo/inquiry-config - Inquiry config
 */

import { getPayment, deletePayment, updatePayment } from '../../../../lib/storage.js';
import { isAuthenticated, unauthorized } from '../../../../lib/auth.js';
import { generateApprovalCode, generateReferenceNo } from '../../../../lib/tokenGenerator.js';
import { sendCallback, sendCallbackSequence, buildCallbackPayload, executeCallback } from '../../../../lib/callback.js';

const VALID_STATUSES = ['pending', 'success', 'failed', 'cancelled', 'expired'];
const VALID_BEHAVIORS = ['normal', 'delay', 'error', 'timeout'];

/**
 * A sequence is delivered synchronously, sleeping between steps, so its total
 * duration is bounded by the platform's function timeout. Exceeding it means
 * the request is killed and the remaining callbacks are silently never sent —
 * a confusing failure. These caps keep a sequence comfortably inside the
 * default 10-second serverless limit and reject anything longer up front.
 */
const MAX_SEQUENCE_LENGTH = 10;
const MAX_SEQUENCE_DELAY_MS = 8000;
const MAX_SEQUENCE_TOTAL_DELAY_MS = 8000;

/**
 * Validate a callback sequence.
 *
 * @param {unknown} sequence - Caller-supplied sequence
 * @returns {string|null} An error message, or null when the sequence is usable
 */
function validateSequence(sequence) {
  if (!Array.isArray(sequence)) {
    return 'sequence must be an array';
  }
  if (sequence.length === 0) {
    return 'sequence must contain at least one callback';
  }
  if (sequence.length > MAX_SEQUENCE_LENGTH) {
    return `sequence may contain at most ${MAX_SEQUENCE_LENGTH} callbacks`;
  }

  let totalDelay = 0;

  for (const [index, item] of sequence.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return `sequence[${index}] must be an object`;
    }
    if (item.status !== undefined && !VALID_STATUSES.includes(item.status)) {
      return `sequence[${index}].status must be one of: ${VALID_STATUSES.join(', ')}`;
    }

    const delay = item.delayAfter;
    if (delay !== undefined) {
      if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
        return `sequence[${index}].delayAfter must be a non-negative number of milliseconds`;
      }
      if (delay > MAX_SEQUENCE_DELAY_MS) {
        return `sequence[${index}].delayAfter may not exceed ${MAX_SEQUENCE_DELAY_MS}ms`;
      }
      // The delay after the final callback is never applied.
      if (index < sequence.length - 1) totalDelay += delay;
    }
  }

  if (totalDelay > MAX_SEQUENCE_TOTAL_DELAY_MS) {
    return `total delay across the sequence may not exceed ${MAX_SEQUENCE_TOTAL_DELAY_MS}ms`;
  }

  return null;
}

const RESPONSE_CODES = {
  '0000': { status: 'success', desc: 'Successful' },
  '0001': { status: 'pending', desc: 'Transaction is pending' },
  '0003': { status: 'cancelled', desc: 'Transaction is cancelled' },
  '4010': { status: 'failed', desc: 'Insufficient funds' },
  '9035': { status: 'failed', desc: 'Payment failed' },
  '5009': { status: 'failed', desc: 'Payment Expired' },
  '9999': { status: 'failed', desc: 'System error' },
};

const DEFAULT_RESP_CODES = {
  success: '0000',
  pending: '0001',
  failed: '9035',
  cancelled: '0003',
  expired: '5009'
};

export default async function handler(request, response) {
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }
  
  // Check authentication
  if (!isAuthenticated(request)) {
    return unauthorized(response);
  }
  
  // Helper to respond (no logging for internal admin calls)
  const respondWithJson = (statusCode, responseBody) => {
    return response.status(statusCode).json(responseBody);
  };
  
  // Parse invoiceNo and action from URL path
  // For catch-all route [...slug], Vercel passes remaining segments via query['...slug']
  const urlPath = request.url?.split('?')[0] || '';
  const pathMatch = urlPath.match(/\/api\/admin\/payments\/([^\/]+)(?:\/(.+))?$/);
  const invoiceNo = pathMatch?.[1] || request.query?.invoiceNo;
  
  // Get action from path match (most reliable) or from catch-all slug
  let action = pathMatch?.[2] || request.query?.action;
  
  // If no action in path, try catch-all slug (Vercel passes via '...slug' query param)
  if (!action) {
    const vercelSlug = request.query?.['...slug'] || request.query?.slug;
    if (vercelSlug) {
      const slugArray = Array.isArray(vercelSlug) ? vercelSlug : (typeof vercelSlug === 'string' ? vercelSlug.split('/').filter(Boolean) : []);
      action = slugArray.length > 0 ? slugArray[0] : null;
    }
  }
  
  if (!invoiceNo) {
    return respondWithJson(400, { success: false, error: 'Invoice number is required' });
  }
  
  try {
    // Handle inquiry-config action
    if (action === 'inquiry-config') {
      const payment = await getPayment(invoiceNo);
      if (!payment) {
        return respondWithJson(404, { success: false, error: 'Payment not found' });
      }
      
      // GET - Get inquiry config
      if (request.method === 'GET') {
        return respondWithJson(200, {
          success: true,
          config: {
            behavior: payment.inquiryBehavior || 'normal',
            delay: payment.inquiryDelay || 0,
            errorCode: payment.inquiryErrorCode || null
          }
        });
      }
      
      // POST - Update inquiry config
      if (request.method === 'POST') {
        const { behavior, delay, errorCode } = request.body;
        
        if (behavior && !VALID_BEHAVIORS.includes(behavior)) {
          return respondWithJson(400, { success: false, error: `Invalid behavior. Valid: ${VALID_BEHAVIORS.join(', ')}` });
        }
        
        await updatePayment(invoiceNo, {
          inquiryBehavior: behavior || 'normal',
          inquiryDelay: parseInt(delay, 10) || 0,
          inquiryErrorCode: errorCode || null
        });
        
        return respondWithJson(200, { success: true, message: 'Inquiry config updated' });
      }
      
      return respondWithJson(405, { error: 'Method not allowed' });
    }
    
    // Handle status action
    if (action === 'status') {
      if (request.method !== 'POST') {
        return respondWithJson(405, { error: 'Method not allowed' });
      }
      
      const payment = await getPayment(invoiceNo);
      if (!payment) {
        return respondWithJson(404, { success: false, error: 'Payment not found' });
      }
      
      const { status, respCode } = request.body;
      
      if (!status || !VALID_STATUSES.includes(status)) {
        return respondWithJson(400, { success: false, error: `Invalid status. Valid: ${VALID_STATUSES.join(', ')}` });
      }
      
      const finalRespCode = respCode || DEFAULT_RESP_CODES[status];
      const respInfo = RESPONSE_CODES[finalRespCode] || { desc: 'Unknown' };
      
      const now = new Date().toISOString();
      const updates = {
        status,
        respCode: finalRespCode,
        respDesc: respInfo.desc,
        statusHistory: [
          ...(payment.statusHistory || []),
          { status, respCode: finalRespCode, respDesc: respInfo.desc, changedAt: now, changedBy: 'admin', source: 'admin' }
        ]
      };
      
      if (status === 'success' && !payment.approvalCode) {
        updates.approvalCode = generateApprovalCode();
        updates.referenceNo = generateReferenceNo();
      }
      
      await updatePayment(invoiceNo, updates);
      return respondWithJson(200, { success: true, message: `Status updated to ${status}` });
    }
    
    // Handle callback action
    if (action === 'callback') {
      if (request.method !== 'POST') {
        return respondWithJson(405, { error: 'Method not allowed' });
      }
      
      const payment = await getPayment(invoiceNo);
      if (!payment) {
        return respondWithJson(404, { success: false, error: 'Payment not found' });
      }
      
      const { callbackUrl, sequence, customPayload, customFields } = request.body || {};
      const targetUrl = callbackUrl || payment.backendReturnUrl;
      
      if (!targetUrl) {
        return respondWithJson(400, { success: false, error: 'No callback URL configured' });
      }
      
      if (customFields !== undefined
          && (typeof customFields !== 'object' || customFields === null || Array.isArray(customFields))) {
        return respondWithJson(400, {
          success: false,
          error: 'customFields must be an object of key/value pairs'
        });
      }
      
      if (sequence !== undefined) {
        const invalid = validateSequence(sequence);
        if (invalid) {
          return respondWithJson(400, { success: false, error: invalid });
        }
      }
      
      // Handle custom payload (single callback only, not sequences)
      if (customPayload && !sequence) {
        // Validate custom payload has required fields
        const provider = payment.provider || '2c2p';
        if (provider === 'omise') {
          // Omise webhook format requires data.id or invoiceNo
          if (!customPayload.data?.id && !customPayload.data?.charge?.id && !customPayload.invoiceNo) {
            return respondWithJson(400, { success: false, error: 'Custom payload missing required field: data.id or invoiceNo' });
          }
        } else {
          // 2C2P format requires invoiceNo and amount
          if (!customPayload.invoiceNo || customPayload.amount === undefined) {
            return respondWithJson(400, { success: false, error: 'Custom payload missing required fields: invoiceNo and amount' });
          }
        }
        
        // Execute callback with custom payload
        const result = await executeCallback(targetUrl, customPayload, payment);
        
        // Record in history
        const historyEntry = {
          sentAt: new Date().toISOString(),
          url: targetUrl,
          responseStatus: result.status,
          responseTime: result.responseTime,
          success: result.success,
          error: result.error || null,
          customPayload: true
        };
        
        // Update payment with callback history
        const updatedHistory = [...(payment.callbackHistory || []), historyEntry];
        await updatePayment(invoiceNo, {
          callbackHistory: updatedHistory,
          callbackCount: updatedHistory.length
        });
        
        return respondWithJson(200, { success: true, result: { ...result, historyEntry } });
      }
      
      if (sequence && Array.isArray(sequence) && sequence.length > 0) {
        // Send callback sequence - never auto-retry for sequences
        const results = await sendCallbackSequence(invoiceNo, sequence, { callbackUrl: targetUrl, sendDuplicate: false, customFields });
        return respondWithJson(200, { success: true, results });
      } else {
        // Single callback - respects duplicateCallback config
        const result = await sendCallback(invoiceNo, { callbackUrl: targetUrl });
        return respondWithJson(200, { success: true, result });
      }
    }
    
    // Default: Handle GET (payment details) and DELETE (delete payment)
    // GET - Get payment details or preview callback payload
    if (request.method === 'GET') {
      const payment = await getPayment(invoiceNo);
      if (!payment) {
        return respondWithJson(404, { success: false, error: 'Payment not found' });
      }
      
      // Check if preview=callback query parameter is present
      const query = request.query || {};
      const preview = query.preview;
      
      if (preview === 'callback') {
        // Build and return callback payload preview
        const previewPayload = buildCallbackPayload(payment);
        return respondWithJson(200, { success: true, preview: previewPayload });
      }
      
      // Default: return payment details
      return respondWithJson(200, { success: true, payment });
    }
    
    // DELETE - Delete payment
    if (request.method === 'DELETE') {
      const payment = await getPayment(invoiceNo);
      if (!payment) {
        return respondWithJson(404, { success: false, error: 'Payment not found' });
      }
      await deletePayment(invoiceNo);
      return respondWithJson(200, { success: true, message: `Payment ${invoiceNo} deleted successfully` });
    }
    
    return respondWithJson(405, { error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Payment API error:', error);
    return respondWithJson(500, { success: false, error: error.message });
  }
}
