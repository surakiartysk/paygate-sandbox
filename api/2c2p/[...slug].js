/**
 * Catch-all handler for 2C2P API endpoints
 * 
 * Routes:
 * - GET /api/2c2p/info?token=xxx
 * - POST /api/2c2p/optionDetails
 * - POST /api/2c2p/payment
 * - GET /api/2c2p/qr/:invoiceNo
 * 
 * Also: POST /api/2c2p/inquiry, folded in here from lib/inquiryHandler.js.
 * /api/2c2p/token keeps a file of its own (see the note on it below).
 */

import { getPaymentByToken, getPayment, updatePayment } from '../../lib/storage.js';
import { applyDelay, checkForceError, getErrorResponse } from '../../lib/simulation.js';
import { logRequest } from '../../lib/logger.js';
import { RESP_CODES } from '../../lib/constants.js';
import { enforceRateLimit } from '../../lib/rateLimit.js';
import handleInquiry from '../../lib/inquiryHandler.js';
import { publicOrigin } from '../../lib/urlUtils.js';
import { renderMockQr } from '../../lib/qrImage.js';

const LOG_TIMEOUT_MS = 2000;

// QR Code channel codes
const QR_CHANNELS = ['PPQR', 'QRCS', 'EMVQR', 'QR'];
const QR_RESP_CODES = {
  PENDING_SCAN: '1005',
  SUCCESS: '0000',
  EXPIRED: '2003',
  CANCELLED: '0003',
};

/**
 * Resolve the path segments this catch-all was reached with.
 *
 * Vercel exposes them under the literal key '...slug' (three dots) rather than
 * 'slug'; the local dev server passes 'slug'. Reading only one of the two left
 * the path empty in production, which made every route here answer "endpoint
 * not found". The URL is the last resort, so a routing change cannot silently
 * break dispatch again.
 *
 * @param {object} request - Incoming request
 * @returns {string} Slash-joined path below /api/2c2p, e.g. "inquiry"
 */
function resolvePath(request) {
  const slug = request.query?.['...slug'] ?? request.query?.slug;

  if (Array.isArray(slug)) return slug.filter(Boolean).join('/');
  if (typeof slug === 'string' && slug) return slug.split('/').filter(Boolean).join('/');

  const pathname = (request.url || '').split('?')[0];
  return pathname.replace(/^\/api\/2c2p\/?/, '').replace(/\/$/, '');
}

export default async function handler(request, response) {
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mock-Delay, X-Mock-Error');
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (enforceRateLimit(request, response)) return;
  
  const path = resolvePath(request);
  
  // Inquiry lives in lib/ rather than its own file: Vercel's Hobby plan caps a
  // deployment at 12 serverless functions, and this route is cheap to fold in.
  if (path === 'inquiry') {
    return handleInquiry(request, response);
  }

  // token keeps its own function — it is the busiest route, and isolating it
  // keeps its cold starts independent of the rest.
  if (path === 'token') {
    return response.status(404).json({
      respCode: '0002',
      respDesc: 'Endpoint not found'
    });
  }
  
  // Route: GET /api/2c2p/info
  if (path === 'info' && request.method === 'GET') {
    return handleInfo(request, response);
  }
  
  // Route: POST /api/2c2p/optionDetails
  if (path === 'optionDetails' && request.method === 'POST') {
    return handleOptionDetails(request, response);
  }
  
  // Route: POST /api/2c2p/payment
  if (path === 'payment' && request.method === 'POST') {
    return handlePayment(request, response);
  }
  
  // Route: GET /api/2c2p/qr/:invoiceNo
  const qrMatch = path.match(/^qr\/(.+)$/);
  if (qrMatch && request.method === 'GET') {
    return handleQR(request, response, qrMatch[1]);
  }
  
  // Not found
  return response.status(404).json({ 
    respCode: '0002',
    respDesc: 'Endpoint not found' 
  });
}

// ============================================================================
// Info Handler
// ============================================================================

async function handleInfo(request, response) {
  try {
    const { token } = request.query;
    
    if (!token) {
      return response.status(400).json({
        success: false,
        error: 'Token is required'
      });
    }
    
    const payment = await getPaymentByToken(token);
    
    if (!payment) {
      return response.status(404).json({
        success: false,
        error: 'Payment not found or expired'
      });
    }
    
    return response.status(200).json({
      success: true,
      payment: {
        invoiceNo: payment.invoiceNo,
        merchantID: payment.merchantID,
        amount: payment.amount,
        currencyCode: payment.currencyCode,
        description: payment.description,
        status: payment.status,
        frontendReturnUrl: payment.frontendReturnUrl,
        paymentChannel: payment.paymentChannel,
        createdAt: payment.createdAt
      }
    });
  } catch (error) {
    console.error('Payment info error:', error);
    return response.status(500).json({
      success: false,
      error: 'Failed to get payment info'
    });
  }
}

// ============================================================================
// Option Details Handler
// ============================================================================

async function handleOptionDetails(request, response) {
  const startTime = Date.now();
  const body = request.body;
  
  const logAndRespond = async (statusCode, responseBody, invoiceNo = null) => {
    const duration = Date.now() - startTime;
    try {
      await Promise.race([
        logRequest('optionDetails', invoiceNo, {
          method: request.method,
          path: '/api/2c2p/optionDetails',
          headers: request.headers,
          body
        }, {
          status: statusCode,
          body: responseBody,
          duration
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Log timeout')), LOG_TIMEOUT_MS))
      ]);
    } catch (err) {
      console.error('Option details logging error:', err.message);
    }
    return response.status(statusCode).json(responseBody);
  };
  
  try {
    await applyDelay(request);
    
    const forceError = await checkForceError(request, '2c2p');
    if (forceError) {
      return logAndRespond(200, getErrorResponse(forceError), null);
    }
    
    if (!body.paymentToken) {
      return logAndRespond(200, {
        respCode: '0001',
        respDesc: 'Payment token is required'
      });
    }
    
    const payment = await getPaymentByToken(body.paymentToken);
    if (!payment) {
      return logAndRespond(200, {
        respCode: '0002',
        respDesc: 'Invalid payment token'
      });
    }
    
    const categoryCode = body.categoryCode || null;
    const groupCode = body.groupCode || null;
    const paymentChannels = payment.paymentChannel || ['CC'];
    const paymentAmount = payment.amount || 0;
    
    let availableOptions = [];
    
    if (paymentChannels.includes('DPAY') || paymentChannels.includes('CC')) {
      availableOptions.push(
        { channelCode: 'SHOPEE', channelName: 'ShopeePay', categoryCode: 'DPAY', groupCode: 'DPAY', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true },
        { channelCode: 'TRUEMONEY', channelName: 'TrueMoney Wallet', categoryCode: 'DPAY', groupCode: 'DPAY', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true },
        { channelCode: 'GRABPAY', channelName: 'GrabPay', categoryCode: 'DPAY', groupCode: 'DPAY', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true },
        { channelCode: 'LINEPAY', channelName: 'LINE Pay', categoryCode: 'DPAY', groupCode: 'DPAY', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true },
        { channelCode: 'ALIPAY', channelName: 'Alipay', categoryCode: 'DPAY', groupCode: 'DPAY', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true }
      );
    }
    
    if (paymentChannels.includes('QR')) {
      availableOptions.push(
        { channelCode: 'PROMPTPAY', channelName: 'PromptPay', categoryCode: 'QR', groupCode: 'QR', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true },
        { channelCode: 'TRUEMONEYQR', channelName: 'TrueMoney QR', categoryCode: 'QR', groupCode: 'QR', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true }
      );
    }
    
    if (paymentChannels.includes('CC') || paymentChannels.includes('3DS')) {
      availableOptions.push(
        { channelCode: 'VISA', channelName: 'Visa', categoryCode: 'CC', groupCode: 'CC', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true },
        { channelCode: 'MASTERCARD', channelName: 'Mastercard', categoryCode: 'CC', groupCode: 'CC', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true }
      );
    }
    
    if (paymentChannels.includes('IB')) {
      availableOptions.push(
        { channelCode: 'SCB', channelName: 'Siam Commercial Bank', categoryCode: 'IB', groupCode: 'IB', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true },
        { channelCode: 'BBL', channelName: 'Bangkok Bank', categoryCode: 'IB', groupCode: 'IB', logoUrl: '', minAmount: 0, maxAmount: 1000000, currencyCode: payment.currencyCode || 'THB', enabled: true }
      );
    }
    
    const optionDetailsResponse = {
      respCode: '0000',
      respDesc: 'Success',
      paymentToken: body.paymentToken,
      paymentOptions: availableOptions
    };
    
    if (categoryCode) {
      optionDetailsResponse.paymentOptions = optionDetailsResponse.paymentOptions.filter(
        option => option.categoryCode === categoryCode
      );
    }
    
    if (groupCode) {
      optionDetailsResponse.paymentOptions = optionDetailsResponse.paymentOptions.filter(
        option => option.groupCode === groupCode
      );
    }
    
    optionDetailsResponse.paymentOptions = optionDetailsResponse.paymentOptions.filter(
      option => paymentAmount >= option.minAmount && paymentAmount <= option.maxAmount
    );
    
    return logAndRespond(200, optionDetailsResponse, payment.invoiceNo);
  } catch (error) {
    console.error('Payment option details error:', error);
    return logAndRespond(200, {
      respCode: '9999',
      respDesc: 'System error: ' + error.message
    }, null);
  }
}

// ============================================================================
// Payment Handler (QR Code)
// ============================================================================

async function handlePayment(request, response) {
  const startTime = Date.now();
  const body = request.body;
  
  const logAndRespond = async (statusCode, responseBody, invoiceNo = null) => {
    const duration = Date.now() - startTime;
    try {
      await Promise.race([
        logRequest('payment', invoiceNo, {
          method: request.method,
          path: '/api/2c2p/payment',
          headers: request.headers,
          body
        }, {
          status: statusCode,
          body: responseBody,
          duration
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Log timeout')), LOG_TIMEOUT_MS))
      ]);
    } catch (err) {
      console.error('Payment logging error:', err.message);
    }
    return response.status(statusCode).json(responseBody);
  };
  
  try {
    await applyDelay(request);
    
    const forceError = await checkForceError(request, '2c2p');
    if (forceError) {
      return logAndRespond(200, getErrorResponse(forceError), null);
    }
    
    const { paymentToken, payment } = body;
    
    if (!paymentToken) {
      return logAndRespond(200, {
        respCode: '0001',
        respDesc: 'Payment token is required'
      }, null);
    }
    
    const paymentRecord = await getPaymentByToken(paymentToken);
    if (!paymentRecord) {
      return logAndRespond(200, {
        respCode: '0002',
        respDesc: 'Invalid or expired payment token'
      }, null);
    }
    
    const invoiceNo = paymentRecord.invoiceNo;
    const channelCode = payment?.code?.channelCode || 'PPQR';
    const paymentData = payment?.data || {};
    
    if (QR_CHANNELS.includes(channelCode)) {
      const qrType = paymentData.qrType || 'URL';
      const qrCodeUrl = `${publicOrigin(request)}/api/2c2p/qr/${encodeURIComponent(invoiceNo)}?t=${Date.now()}`;
      
      let expiryDate = paymentRecord.paymentExpiry 
        ? new Date(paymentRecord.paymentExpiry)
        : new Date(Date.now() + 15 * 60 * 1000);
      const expiryDesc = `Please scan the QR code and complete the payment before ${expiryDate.toISOString().replace('T', ' ').slice(0, 19)}`;
      
      await updatePayment(invoiceNo, {
        status: 'pending',
        channelCode: channelCode,
        agentCode: channelCode === 'PPQR' ? 'EMVQR' : channelCode,
        qrType: qrType,
        qrCodeUrl: qrCodeUrl,
        qrGeneratedAt: new Date().toISOString(),
        customerName: paymentData.name || '',
        customerEmail: paymentData.email || '',
        customerMobile: paymentData.mobileNo || '',
        respCode: QR_RESP_CODES.PENDING_SCAN,
        respDesc: 'Pending for user scan QR.'
      });
      
      return logAndRespond(200, {
        type: qrType,
        expiryDescription: expiryDesc,
        data: qrCodeUrl,
        channelCode: channelCode,
        respCode: QR_RESP_CODES.PENDING_SCAN,
        respDesc: 'Pending for user scan QR.'
      }, invoiceNo);
    }
    
    return logAndRespond(200, {
      respCode: '0001',
      respDesc: `Payment channel ${channelCode} is not supported in mock`
    }, invoiceNo);
  } catch (error) {
    console.error('Payment API error:', error);
    return logAndRespond(200, {
      respCode: RESP_CODES.SYSTEM_ERROR,
      respDesc: 'System error.'
    }, body?.paymentToken ? 'unknown' : null);
  }
}

// ============================================================================
// QR Image Handler
// ============================================================================

async function handleQR(request, response, invoiceNo) {
  if (!invoiceNo) {
    return response.status(400).json({ error: 'Invoice number required' });
  }
  
  const payment = await getPayment(invoiceNo);
  const amount = payment ? parseFloat(payment.amount || 0).toFixed(2) : '0.00';
  const currency = payment?.currencyCode || 'THB';
  
  const svg = renderMockQr({ reference: invoiceNo, detail: `${amount} ${currency}` });
  
  response.setHeader('Content-Type', 'image/svg+xml');
  response.setHeader('Cache-Control', 'no-cache');
  return response.status(200).send(svg);
}
