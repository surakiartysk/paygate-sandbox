/**
 * POST /api/2c2p/inquiry
 * Mock 2C2P Payment Inquiry API
 * 
 * Query payment status by invoice number.
 * Returns payment details with current status and response codes.
 * 
 * @see https://developer.2c2p.com/docs/api-payment-inquiry
 */

import { getPayment } from './storage.js';
import { applyDelay, checkForceError, getErrorResponse, maxHeaderDelay } from './simulation.js';
import { logRequest } from './logger.js';
import { generateReferenceNo } from './tokenGenerator.js';
import { enforceRateLimit } from './rateLimit.js';
import { 
  RESP_CODES, 
  STATUS_TO_RESP_CODE, 
  STATUS_TO_RESP_DESC,
  getRespCodeForStatus,
  getRespDesc
} from './constants.js';

// ============================================================================
// Constants
// ============================================================================

const LOG_TIMEOUT_MS = 2000;
const API_PATH = '/api/2c2p/inquiry';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format datetime for 2C2P response (YYYYMMDDHHmmss)
 * @param {string} isoDate - ISO date string
 * @returns {string} Formatted datetime
 */
function formatTransactionDateTime(isoDate) {
  if (!isoDate) {
    return new Date().toISOString().replace(/[-:]/g, '').replace('T', '').slice(0, 14);
  }
  return isoDate.replace(/[-:]/g, '').replace('T', '').slice(0, 14);
}

/**
 * Build inquiry response from payment data
 * @param {Object} payment - Payment record
 * @returns {Object} Formatted inquiry response
 */
function buildInquiryResponse(payment) {
  const defaultRespCode = getRespCodeForStatus(payment.status);
  const defaultRespDesc = getRespDesc(payment.status);
  
  const respCode = payment.respCode || defaultRespCode;
  const respDesc = payment.respDesc || defaultRespDesc;
  
  const channelCode = payment.channelCode || payment.paymentChannel?.[0] || 'CC';
  const agentCode = payment.agentCode || (channelCode === 'QR' ? 'EMVQR' : '');
  
  return {
    cardNo: payment.cardNo || '',
    cardToken: payment.cardToken || '',
    loyaltyPoints: payment.loyaltyPoints || null,
    merchantID: payment.merchantID,
    invoiceNo: payment.invoiceNo,
    amount: parseFloat(payment.amount).toFixed(2),
    monthlyPayment: payment.monthlyPayment || null,
    userDefined1: payment.userDefined1 || '',
    userDefined2: payment.userDefined2 || '',
    userDefined3: payment.userDefined3 || '',
    userDefined4: payment.userDefined4 || '',
    userDefined5: payment.userDefined5 || '',
    currencyCode: payment.currencyCode,
    recurringUniqueID: payment.recurringUniqueID || '',
    tranRef: payment.tranRef,
    referenceNo: payment.referenceNo || generateReferenceNo(),
    approvalCode: payment.approvalCode || null,
    eci: payment.eci || '',
    transactionDateTime: formatTransactionDateTime(payment.updatedAt),
    agentCode,
    channelCode,
    issuerCountry: payment.issuerCountry || '',
    issuerBank: payment.issuerBank || '',
    installmentMerchantAbsorbRate: payment.installmentMerchantAbsorbRate || null,
    cardType: payment.cardType || (channelCode === 'CC' || channelCode === '3DS' ? 'CREDIT' : ''),
    idempotencyID: payment.idempotencyID || '',
    paymentScheme: payment.paymentScheme || channelCode,
    displayProcessingAmount: payment.displayProcessingAmount ?? false,
    respCode,
    respDesc
  };
}

/**
 * Create a logging helper with timeout protection
 * @param {Object} request - HTTP request object
 * @param {Object} body - Request body
 * @param {number} startTime - Request start time
 * @returns {Function} Log and respond function
 */
function createLogAndRespond(request, response, body, startTime) {
  const log = async (statusCode, responseBody, invoiceNo) => {
    const duration = Date.now() - startTime;
    
    // Log with timeout protection (serverless functions may terminate after response)
    try {
      await Promise.race([
        logRequest('inquiry', invoiceNo, {
          method: request.method,
          path: API_PATH,
          headers: request.headers,
          body
        }, {
          status: statusCode,
          body: responseBody,
          duration
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Log timeout')), LOG_TIMEOUT_MS)
        )
      ]);
    } catch (err) {
      console.error('Inquiry logging error:', err.message);
    }
  };

  const logAndRespond = async (statusCode, responseBody, invoiceNo = null) => {
    await log(statusCode, responseBody, invoiceNo);
    return response.status(statusCode).json(responseBody);
  };
  // For the one path that must record a request without answering it.
  logAndRespond.logOnly = log;
  return logAndRespond;
}

// ============================================================================
// Main Handler
// ============================================================================

export default async function handler(request, response) {
  // CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mock-Delay, X-Mock-Error');
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (enforceRateLimit(request, response)) return;
  
  if (request.method !== 'POST') {
    return response.status(405).json({ 
      respCode: RESP_CODES.PENDING, 
      respDesc: 'Method not allowed' 
    });
  }
  
  const startTime = Date.now();
  const body = request.body;
  const logAndRespond = createLogAndRespond(request, response, body, startTime);
  
  try {
    // Apply simulation delay if configured
    await applyDelay(request);
    
    // Extract invoice number (support both field names for flexibility)
    const invoiceNo = body.invoiceNo || body.invoiceObject;
    
    // Check for forced errors (simulation)
    const forceError = await checkForceError(request, '2c2p');
    if (forceError) {
      return logAndRespond(200, getErrorResponse(forceError), invoiceNo);
    }
    
    // Validate required field
    if (!invoiceNo) {
      return logAndRespond(200, {
        respCode: RESP_CODES.PENDING,
        respDesc: 'Invoice number is required'
      }, body.invoiceNo || body.invoiceObject || 'MISSING');
    }
    
    // Find payment
    const payment = await getPayment(invoiceNo);
    
    if (!payment) {
      return logAndRespond(200, {
        respCode: RESP_CODES.NOT_FOUND,
        respDesc: 'Transaction not found.'
      }, invoiceNo);
    }
    
    // Handle simulation behaviors
    const behavior = payment.inquiryBehavior || 'normal';
    
    // Timeout simulation: never answer, so the caller's own timeout fires.
    //
    // This used to log through `logAndRespond`, which answered 200 with
    // `{ _timeout: true }` in a few milliseconds and only then hung — so the
    // client got a prompt success, the timeout under test never fired, and the
    // function was held open afterwards for nothing. The request is logged
    // with status 0, the convention for "no response", and left unanswered.
    //
    // A demo visitor's payment is configured by a stranger, so its waits get
    // the ceiling decision 9 gave the delay header, for the same reason: a
    // number anyone can choose must not decide how long this server holds a
    // request. After the ceiling it answers 504 — a gateway timeout, which is
    // what a caller that waited that long would have concluded anyway. The
    // admin's payments keep the unbounded wait decision 9 left them.
    const ceiling = payment.demoOwner ? maxHeaderDelay() : Infinity;

    if (behavior === 'timeout') {
      await logAndRespond.logOnly(0, {
        _timeout: true,
        message: 'Simulated timeout: no answer sent'
      }, payment.invoiceNo);
      if (ceiling === Infinity) {
        await new Promise(() => {}); // Hang until the caller gives up
        return;
      }
      await new Promise(resolve => setTimeout(resolve, ceiling));
      return response.status(504).json({
        error: 'Simulated timeout',
        message: `No answer for ${ceiling}ms, the longest a demo payment may hold a request.`
      });
    }
    
    // Delay simulation
    if (behavior === 'delay' && payment.inquiryDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(payment.inquiryDelay, ceiling)));
    }
    
    // Error simulation
    if (behavior === 'error' && payment.inquiryErrorCode) {
      return logAndRespond(200, getErrorResponse(payment.inquiryErrorCode), payment.invoiceNo);
    }
    
    // Normal response
    const inquiryResponse = buildInquiryResponse(payment);
    return logAndRespond(200, inquiryResponse, payment.invoiceNo);
    
  } catch (error) {
    console.error('Payment inquiry error:', error);
    return logAndRespond(200, {
      respCode: RESP_CODES.SYSTEM_ERROR,
      respDesc: 'System error.'
    }, body?.invoiceNo || body?.invoiceObject);
  }
}
