/**
 * POST /api/2c2p/token
 * Mock 2C2P Payment API (Redirect API + Direct API)
 * 
 * This endpoint supports two payment flows:
 * 
 * 1. Redirect API (default):
 *    - Creates a payment token and returns webPaymentUrl
 *    - User is redirected to mock payment page to complete payment
 *    - After payment, callback is sent to backendReturnUrl
 * 
 * 2. Direct API (when paymentMethod is included):
 *    - Processes payment directly (card, QR, wallet, etc.)
 *    - Returns immediate status without redirect
 * 
 * @see https://developer.2c2p.com/docs/redirect-api
 * @see https://developer.2c2p.com/docs/direct-api
 * 
 * @module api/2c2p/token
 */

import { savePayment, getPayment, updatePayment } from '../../lib/storage.js';
import { generatePaymentToken, generateTranRef, generateApprovalCode, generateReferenceNo } from '../../lib/tokenGenerator.js';
import { applyDelay, checkForceError, getErrorResponse } from '../../lib/simulation.js';
import { logRequest } from '../../lib/logger.js';
import { sendCallback } from '../../lib/callback.js';
import { rewriteUrl } from '../../lib/urlUtils.js';
import { RESP_CODES, getRespCodeForStatus } from '../../lib/constants.js';
import { enforceRateLimit } from '../../lib/rateLimit.js';

// ============================================================================
// Constants
// ============================================================================

const LOG_TIMEOUT_MS = 2000;
const API_PATH = '/api/2c2p/token';

export default async function handler(request, response) {
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mock-Delay, X-Mock-Error');
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (enforceRateLimit(request, response)) return;
  
  if (request.method !== 'POST') {
    return response.status(405).json({ respCode: '0001', respDesc: 'Method not allowed' });
  }
  
  const startTime = Date.now();
  const body = request.body;
  
  // Helper to log and respond
  const logAndRespond = async (statusCode, responseBody, invoiceNo = null) => {
    const duration = Date.now() - startTime;
    
    console.log('=== LOGGING 2C2P TOKEN REQUEST ===', {
      logPath: '/api/2c2p/token',
      logType: 'token',
      method: request.method,
      invoiceNo: invoiceNo || 'null',
      statusCode,
      hasBody: !!request.body,
      timestamp: new Date().toISOString()
    });
    
    // CRITICAL: In serverless environments (Vercel), if we don't await the log,
    // the function may terminate before the log is saved, causing logs to be lost.
    // We need to ensure the log completes before returning the response.
    // However, to not slow down responses, we'll use a timeout approach.
    // But actually, Vercel serverless functions can handle awaited async operations
    // as long as they complete within the timeout limit. Let's await it.
    
    // Log request/response - NOW AWAITED to ensure it completes
    // This ensures logs are saved even in serverless environments
    const logStartTime = Date.now();
    try {
      const logResult = await Promise.race([
        logRequest('token', invoiceNo, {
          method: request.method,
          path: '/api/2c2p/token',
          headers: request.headers,
          body: body
        }, {
          status: statusCode,
          body: responseBody,
          duration
        }),
        // Timeout after 2 seconds to not block response too long
        new Promise((_, reject) => setTimeout(() => reject(new Error('Log timeout')), 2000))
      ]).catch(err => {
        // If timeout or error, log it but don't block response
        console.error('❌ 2C2P token logging error or timeout:', {
          error: err.message,
          logPath: '/api/2c2p/token',
          invoiceNo: invoiceNo || 'null',
          duration: `${Date.now() - logStartTime}ms`,
          timestamp: new Date().toISOString()
        });
        return null;
      });
      
      const logDuration = Date.now() - logStartTime;
      
      if (logResult && logResult.id) {
        console.log('✅ 2C2P token request logged successfully (awaited):', { 
          type: 'token', 
          logPath: '/api/2c2p/token',
          invoiceNo: invoiceNo || 'null',
          logId: logResult.id,
          duration: `${logDuration}ms`,
          timestamp: new Date().toISOString()
        });
      } else {
        console.warn('⚠️ 2C2P token request logged but no ID returned:', { 
          type: 'token', 
          logPath: '/api/2c2p/token',
          invoiceNo: invoiceNo || 'null',
          result: logResult || 'null',
          duration: `${logDuration}ms`
        });
      }
    } catch (err) {
      console.error('❌ 2C2P token logging error (CRITICAL):', {
        error: err.message,
        stack: err.stack,
        logPath: '/api/2c2p/token',
        invoiceNo: invoiceNo || 'null',
        duration: `${Date.now() - logStartTime}ms`,
        timestamp: new Date().toISOString()
      });
    }
    
    return response.status(statusCode).json(responseBody);
  };
  
  try {
    // Apply simulation delay
    await applyDelay(request);
    
    // Check for forced errors
    const forceError = await checkForceError(request, '2c2p');
    if (forceError) {
      const errorResp = getErrorResponse(forceError);
      return logAndRespond(200, errorResp, body?.invoiceNo);
    }
    
    // Detect API type from request structure
    // Direct API indicators: paymentMethod, channelCode, cardToken, securePayToken, customerToken
    // Or explicit query parameter: ?api=direct
    const isDirectAPI = !!(body.paymentMethod || body.channelCode || body.cardToken || 
                           body.securePayToken || body.customerToken || 
                           request.query?.api === 'direct');
    
    if (isDirectAPI) {
      // Handle Direct API flow
      return handleDirectPayment(request, response, body, logAndRespond);
    } else {
      // Handle Redirect API flow (current behavior)
      return handleRedirectPayment(request, response, body, logAndRespond);
    }
    
  } catch (error) {
    console.error('Payment token error:', error);
    const errorResp = {
      respCode: '9999',
      respDesc: 'System error: ' + error.message
    };
    return logAndRespond(200, errorResp, body?.invoiceNo);
  }
}

/**
 * Handle Redirect API flow (Payment Token API)
 * Creates a payment token and returns webPaymentUrl for redirect
 */
async function handleRedirectPayment(request, response, body, logAndRespond) {
  console.log('🔵 handleRedirectPayment called:', {
    hasBody: !!body,
    bodyKeys: body ? Object.keys(body) : [],
    invoiceNo: body?.invoiceNo || 'missing',
    timestamp: new Date().toISOString()
  });
  
  // Validate required fields - LOG ALL REQUESTS (even invalid ones)
  if (!body.invoiceNo) {
    console.warn('❌ 2C2P Redirect API validation failed: missing invoiceNo');
    return logAndRespond(200, {
      respCode: '0001',
      respDesc: 'Invalid invoice number'
    }, 'MISSING_INVOICE'); // Use placeholder so validation errors are still logged
  }
  
  // Parse and validate amount (handles zero-padded strings like "000000001909.62000")
  const parsedAmount = parseFloat(body.amount);
  if (!body.amount || isNaN(parsedAmount) || parsedAmount <= 0) {
    console.warn('❌ 2C2P Redirect API validation failed: invalid amount', { 
      amount: body.amount, 
      parsed: parsedAmount,
      invoiceNo: body.invoiceNo 
    });
    return logAndRespond(200, {
      respCode: '0002',
      respDesc: 'Invalid amount'
    }, body.invoiceNo);
  }
  
  console.log('💰 2C2P Redirect API - Amount parsed:', { 
    raw: body.amount, 
    parsed: parsedAmount,
    invoiceNo: body.invoiceNo 
  });
  
  // Check if invoice already exists
  const existing = await getPayment(body.invoiceNo);
  if (existing) {
    console.warn('❌ 2C2P Redirect API validation failed: duplicate invoice', { 
      invoiceNo: body.invoiceNo, 
      existingInvoice: existing.invoiceNo 
    });
    return logAndRespond(200, {
      respCode: '0003',
      respDesc: 'Duplicate invoice number'
    }, body.invoiceNo);
  }
  
  // Generate token and URLs
  const paymentToken = generatePaymentToken();
  // Use http for localhost, https for production
  const host = request.headers.host || 'localhost:3000';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isLocalhost ? 'http' : 'https';
  const serverUrl = process.env.MOCK_SERVER_URL || `${protocol}://${host}`;
  const webPaymentUrl = `${serverUrl}/mock-pay/${encodeURIComponent(paymentToken)}`;
  
  // Create payment record
  const now = new Date().toISOString();
  
  // Parse paymentExpiry (format: YYYY-MM-DD HH:mm:ss or ISO string)
  let paymentExpiry = null;
  if (body.paymentExpiry) {
    try {
      // Handle 2C2P format: YYYY-MM-DD HH:mm:ss
      const expiryDate = new Date(body.paymentExpiry.replace(' ', 'T'));
      if (!isNaN(expiryDate.getTime())) {
        paymentExpiry = expiryDate.toISOString();
      }
    } catch (e) {
      console.warn('Invalid paymentExpiry format:', body.paymentExpiry);
    }
  }
  
  const payment = {
    provider: '2c2p',  // Explicitly set provider for 2C2P payments
    invoiceNo: body.invoiceNo,
    paymentToken,
    merchantID: body.merchantID || 'MOCK_MERCHANT',
    amount: parsedAmount,
    currencyCode: body.currencyCode || 'THB',
    description: body.description || '',
    status: 'pending',
    backendReturnUrl: rewriteUrl(body.backendReturnUrl || process.env.DEFAULT_CALLBACK_URL || null),
    frontendReturnUrl: rewriteUrl(body.frontendReturnUrl || null),
    paymentChannel: body.paymentChannel || ['CC'],
    paymentExpiry,
    locale: body.locale || 'en',
    createdAt: now,
    updatedAt: now,
    tranRef: generateTranRef(),
    respCode: '2001',  // 2C2P: 2001 = Transaction in progress, updated to 0000 when success
    respDesc: 'Transaction in progress.',
    statusHistory: [
      {
        status: 'pending',
        respCode: '2001',
        respDesc: 'Transaction in progress.',
        changedAt: now,
        changedBy: 'system'
      }
    ],
    callbackHistory: [],
    callbackCount: 0
  };
  
  // Save payment
  try {
    await savePayment(payment);
    console.log('💾 2C2P payment saved successfully:', { 
      invoiceNo: body.invoiceNo, 
      paymentToken,
      amount: payment.amount,
      currencyCode: payment.currencyCode,
      provider: '2c2p'
    });
  } catch (saveError) {
    console.error('❌ CRITICAL: Failed to save 2C2P payment:', {
      error: saveError.message,
      invoiceNo: body.invoiceNo,
      stack: saveError.stack
    });
    // Continue anyway - payment might still be logged
  }
  
  // Return response (flat format, no data wrapper)
  const successResp = {
    paymentToken,
    webPaymentUrl,
    respCode: '0000',
    respDesc: 'Success'
  };
  
  console.log('✅ 2C2P Redirect payment created successfully, calling logAndRespond:', { 
    invoiceNo: body.invoiceNo, 
    paymentToken,
    amount: payment.amount,
    statusCode: 200,
    willLog: true
  });
  
  // CRITICAL: Ensure we always call logAndRespond, even if something goes wrong
  try {
    const result = await logAndRespond(200, successResp, body.invoiceNo);
    console.log('✅ logAndRespond completed for 2C2P Redirect payment:', { invoiceNo: body.invoiceNo });
    return result;
  } catch (logError) {
    console.error('❌ CRITICAL: logAndRespond threw an error (payment was saved but not logged):', {
      error: logError.message,
      invoiceNo: body.invoiceNo,
      stack: logError.stack
    });
    // Still return the response even if logging fails - don't break the API
    return response.status(200).json(successResp);
  }
}

/**
 * Handle Direct API flow (Do Payment)
 * Processes payment directly and returns immediate status
 */
async function handleDirectPayment(request, response, body, logAndRespond) {
  // Validate required fields
  if (!body.invoiceNo) {
    return logAndRespond(200, {
      respCode: '0001',
      respDesc: 'Invalid invoice number'
    });
  }
  
  // Parse and validate amount (handles zero-padded strings like "000000001909.62000")
  const parsedAmount = parseFloat(body.amount);
  if (!body.amount || isNaN(parsedAmount) || parsedAmount <= 0) {
    return logAndRespond(200, {
      respCode: '0002',
      respDesc: 'Invalid amount'
    }, body.invoiceNo);
  }
  
  // Check if invoice already exists
  const existing = await getPayment(body.invoiceNo);
  if (existing) {
    return logAndRespond(200, {
      respCode: '0003',
      respDesc: 'Duplicate invoice number'
    }, body.invoiceNo);
  }
  
  // Determine payment method
  const paymentMethod = body.paymentMethod || body.channelCode || 'CC';
  
  // Route to appropriate payment method handler
  switch (paymentMethod) {
    case 'CC':  // Non-3DS Card
      return handleNon3DSCardPayment(request, response, body, logAndRespond);
    case '3DS':  // 3D Secure Card
      return handle3DSecurePayment(request, response, body, logAndRespond);
    case 'QR':  // QR Payment
      return handleQRPayment(request, response, body, logAndRespond);
    case 'DPAY':  // Digital Wallet
      return handleDigitalWalletPayment(request, response, body, logAndRespond);
    case 'PC':  // Pay At Counter
      return handlePayAtCounter(request, response, body, logAndRespond);
    case 'SSM':  // Self Service Machines
      return handleSelfServiceMachine(request, response, body, logAndRespond);
    case 'IB':  // Internet Banking
      return handleInternetBanking(request, response, body, logAndRespond);
    default:
      return logAndRespond(200, {
        merchantID: body.merchantID || 'MOCK_MERCHANT',
        invoiceNo: body.invoiceNo,
        amount: body.amount.toFixed(2),
        currencyCode: body.currencyCode || 'THB',
        respCode: '0001',
        respDesc: `Unsupported payment method: ${paymentMethod}`
      }, body.invoiceNo);
  }
}

/**
 * Handle Non-3DS Card Payment (CC)
 * Immediate processing, returns success/failed status
 */
async function handleNon3DSCardPayment(request, response, body, logAndRespond) {
  const now = new Date().toISOString();
  const paymentToken = generatePaymentToken();
  const tranRef = generateTranRef();
  
  // Parse amount (already validated in handleDirectPayment, but parse again for safety)
  const parsedAmount = parseFloat(body.amount);
  
  // Create payment record
  const payment = {
    provider: '2c2p',
    invoiceNo: body.invoiceNo,
    paymentToken,
    merchantID: body.merchantID || 'MOCK_MERCHANT',
    amount: parsedAmount,
    currencyCode: body.currencyCode || 'THB',
    description: body.description || '',
    status: 'pending', // Will be updated to success after callback
    backendReturnUrl: rewriteUrl(body.backendReturnUrl || process.env.DEFAULT_CALLBACK_URL || null),
    frontendReturnUrl: rewriteUrl(body.frontendReturnUrl || null),
    paymentMethod: 'CC',
    channelCode: 'CC',
    cardToken: body.cardToken || null,
    securePayToken: body.securePayToken || null,
    customerToken: body.customerToken || null,
    paymentChannel: ['CC'],
    createdAt: now,
    updatedAt: now,
    tranRef,
    respCode: '2001',  // 2C2P: 2001 = Transaction in progress, updated to 0000 when success
    respDesc: 'Transaction in progress.',
    statusHistory: [
      {
        status: 'pending',
        respCode: '2001',
        respDesc: 'Transaction in progress.',
        changedAt: now,
        changedBy: 'system'
      }
    ],
    callbackHistory: [],
    callbackCount: 0
  };
  
  await savePayment(payment);
  
  // Simulate immediate processing - set to success
  // In real scenario, this would be processed by payment gateway
  const successResp = {
    merchantID: payment.merchantID,
    invoiceNo: payment.invoiceNo,
    amount: payment.amount.toFixed(2),
    currencyCode: payment.currencyCode,
    tranRef: payment.tranRef,
    channelCode: 'CC',
    respCode: '0000',
    respDesc: 'Success',
    status: 'success'
  };
  
  // Update payment status to success
  await updatePayment(payment.invoiceNo, {
    status: 'success',
    respCode: '0000',
    respDesc: 'Success',
    approvalCode: generateApprovalCode(),
    referenceNo: generateReferenceNo(),
    updatedAt: new Date().toISOString(),
    statusHistory: [
      ...payment.statusHistory,
      {
        status: 'success',
        respCode: '0000',
        respDesc: 'Success',
        changedAt: new Date().toISOString(),
        changedBy: 'system'
      }
    ]
  });
  
  // Send callback if URL is provided
  if (payment.backendReturnUrl) {
    sendCallback(payment.invoiceNo, { callbackUrl: payment.backendReturnUrl })
      .catch(err => console.error('Callback error:', err));
  }
  
  return logAndRespond(200, successResp, body.invoiceNo);
}

/**
 * Handle 3D Secure Card Payment (3DS)
 * Returns paymentToken + webPaymentUrl for redirection
 */
async function handle3DSecurePayment(request, response, body, logAndRespond) {
  const now = new Date().toISOString();
  const paymentToken = generatePaymentToken();
  const tranRef = generateTranRef();
  
  // Parse amount (already validated in handleDirectPayment, but parse again for safety)
  const parsedAmount = parseFloat(body.amount);
  
  // Build redirect URL
  const host = request.headers.host || 'localhost:3000';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isLocalhost ? 'http' : 'https';
  const serverUrl = process.env.MOCK_SERVER_URL || `${protocol}://${host}`;
  const webPaymentUrl = `${serverUrl}/mock-pay/${encodeURIComponent(paymentToken)}`;
  
  // Create payment record
  const payment = {
    provider: '2c2p',
    invoiceNo: body.invoiceNo,
    paymentToken,
    merchantID: body.merchantID || 'MOCK_MERCHANT',
    amount: parsedAmount,
    currencyCode: body.currencyCode || 'THB',
    description: body.description || '',
    status: 'pending',
    backendReturnUrl: rewriteUrl(body.backendReturnUrl || process.env.DEFAULT_CALLBACK_URL || null),
    frontendReturnUrl: rewriteUrl(body.frontendReturnUrl || null),
    paymentMethod: '3DS',
    channelCode: '3DS',
    cardToken: body.cardToken || null,
    securePayToken: body.securePayToken || null,
    customerToken: body.customerToken || null,
    redirectUrl: webPaymentUrl,
    paymentChannel: ['3DS'],
    createdAt: now,
    updatedAt: now,
    tranRef,
    respCode: '2001',
    statusHistory: [
      {
        status: 'pending',
        respCode: '2001',
        respDesc: '3D Secure authentication required',
        changedAt: now,
        changedBy: 'system'
      }
    ],
    callbackHistory: [],
    callbackCount: 0
  };
  
  await savePayment(payment);
  
  // Return response with redirect URL (flat format)
  const responseData = {
    merchantID: payment.merchantID,
    invoiceNo: payment.invoiceNo,
    amount: payment.amount.toFixed(2),
    currencyCode: payment.currencyCode,
    tranRef: payment.tranRef,
    channelCode: '3DS',
    respCode: '2001',
    respDesc: '3D Secure authentication required',
    status: 'pending',
    paymentToken,
    webPaymentUrl
  };
  
  return logAndRespond(200, responseData, body.invoiceNo);
}

/**
 * Handle QR Payment (QR)
 * Generates QR code data/URL
 */
async function handleQRPayment(request, response, body, logAndRespond) {
  const now = new Date().toISOString();
  const paymentToken = generatePaymentToken();
  const tranRef = generateTranRef();
  
  // Parse amount (already validated in handleDirectPayment, but parse again for safety)
  const parsedAmount = parseFloat(body.amount);
  
  // Generate QR code data
  const qrCode = `QR-${tranRef}-${Date.now()}`;
  const host = request.headers.host || 'localhost:3000';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isLocalhost ? 'http' : 'https';
  const serverUrl = process.env.MOCK_SERVER_URL || `${protocol}://${host}`;
  const qrPaymentUrl = `${serverUrl}/qr-pay/${encodeURIComponent(qrCode)}`;
  
  // Create payment record
  const payment = {
    provider: '2c2p',
    invoiceNo: body.invoiceNo,
    paymentToken,
    merchantID: body.merchantID || 'MOCK_MERCHANT',
    amount: parsedAmount,
    currencyCode: body.currencyCode || 'THB',
    description: body.description || '',
    status: 'pending',
    backendReturnUrl: rewriteUrl(body.backendReturnUrl || process.env.DEFAULT_CALLBACK_URL || null),
    frontendReturnUrl: rewriteUrl(body.frontendReturnUrl || null),
    paymentMethod: 'QR',
    channelCode: 'QR',
    qrCode,
    redirectUrl: qrPaymentUrl,
    paymentChannel: ['QR'],
    createdAt: now,
    updatedAt: now,
    tranRef,
    respCode: '2001',
    statusHistory: [
      {
        status: 'pending',
        respCode: '2001',
        respDesc: 'QR code generated, waiting for scan',
        changedAt: now,
        changedBy: 'system'
      }
    ],
    callbackHistory: [],
    callbackCount: 0
  };
  
  await savePayment(payment);
  
  // Return response with QR code data (flat format)
  const responseData = {
    merchantID: payment.merchantID,
    invoiceNo: payment.invoiceNo,
    amount: payment.amount.toFixed(2),
    currencyCode: payment.currencyCode,
    tranRef: payment.tranRef,
    channelCode: 'QR',
    respCode: '2001',
    respDesc: 'QR code generated',
    status: 'pending',
    paymentToken,
    qrCode,
    qrPaymentUrl,
    webPaymentUrl: qrPaymentUrl  // Alias for compatibility
  };
  
  return logAndRespond(200, responseData, body.invoiceNo);
}

/**
 * Handle Digital Wallet Payment (DPAY)
 * Returns redirect URL for wallet app
 */
async function handleDigitalWalletPayment(request, response, body, logAndRespond) {
  const now = new Date().toISOString();
  const paymentToken = generatePaymentToken();
  const tranRef = generateTranRef();
  
  // Parse amount (already validated in handleDirectPayment, but parse again for safety)
  const parsedAmount = parseFloat(body.amount);
  
  // Build redirect URL
  const host = request.headers.host || 'localhost:3000';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isLocalhost ? 'http' : 'https';
  const serverUrl = process.env.MOCK_SERVER_URL || `${protocol}://${host}`;
  const webPaymentUrl = `${serverUrl}/wallet-pay/${encodeURIComponent(paymentToken)}`;
  
  // Create payment record
  const payment = {
    provider: '2c2p',
    invoiceNo: body.invoiceNo,
    paymentToken,
    merchantID: body.merchantID || 'MOCK_MERCHANT',
    amount: parsedAmount,
    currencyCode: body.currencyCode || 'THB',
    description: body.description || '',
    status: 'pending',
    backendReturnUrl: rewriteUrl(body.backendReturnUrl || process.env.DEFAULT_CALLBACK_URL || null),
    frontendReturnUrl: rewriteUrl(body.frontendReturnUrl || null),
    paymentMethod: 'DPAY',
    channelCode: 'DPAY',
    redirectUrl: webPaymentUrl,
    paymentChannel: ['DPAY'],
    createdAt: now,
    updatedAt: now,
    tranRef,
    respCode: '2001',
    statusHistory: [
      {
        status: 'pending',
        respCode: '2001',
        respDesc: 'Waiting for wallet confirmation',
        changedAt: now,
        changedBy: 'system'
      }
    ],
    callbackHistory: [],
    callbackCount: 0
  };
  
  await savePayment(payment);
  
  // Return response with redirect URL (flat format)
  const responseData = {
    merchantID: payment.merchantID,
    invoiceNo: payment.invoiceNo,
    amount: payment.amount.toFixed(2),
    currencyCode: payment.currencyCode,
    tranRef: payment.tranRef,
    channelCode: 'DPAY',
    respCode: '2001',
    respDesc: 'Redirect to wallet app required',
    status: 'pending',
    paymentToken,
    webPaymentUrl
  };
  
  return logAndRespond(200, responseData, body.invoiceNo);
}

/**
 * Handle Pay At Counter Payment (PC)
 * Generates payment reference number
 */
async function handlePayAtCounter(request, response, body, logAndRespond) {
  const now = new Date().toISOString();
  const paymentToken = generatePaymentToken();
  const tranRef = generateTranRef();
  const paymentReference = `PC-${tranRef}`;
  
  // Parse amount (already validated in handleDirectPayment, but parse again for safety)
  const parsedAmount = parseFloat(body.amount);
  
  // Create payment record
  const payment = {
    provider: '2c2p',
    invoiceNo: body.invoiceNo,
    paymentToken,
    merchantID: body.merchantID || 'MOCK_MERCHANT',
    amount: parsedAmount,
    currencyCode: body.currencyCode || 'THB',
    description: body.description || '',
    status: 'pending',
    backendReturnUrl: rewriteUrl(body.backendReturnUrl || process.env.DEFAULT_CALLBACK_URL || null),
    frontendReturnUrl: rewriteUrl(body.frontendReturnUrl || null),
    paymentMethod: 'PC',
    channelCode: 'PC',
    paymentReference,
    paymentChannel: ['PC'],
    createdAt: now,
    updatedAt: now,
    tranRef,
    respCode: '2001',
    statusHistory: [
      {
        status: 'pending',
        respCode: '2001',
        respDesc: 'Payment reference generated, pay at counter',
        changedAt: now,
        changedBy: 'system'
      }
    ],
    callbackHistory: [],
    callbackCount: 0
  };
  
  await savePayment(payment);
  
  // Return response with payment reference (flat format)
  const responseData = {
    merchantID: payment.merchantID,
    invoiceNo: payment.invoiceNo,
    amount: payment.amount.toFixed(2),
    currencyCode: payment.currencyCode,
    tranRef: payment.tranRef,
    channelCode: 'PC',
    respCode: '2001',
    respDesc: 'Payment reference generated',
    status: 'pending',
    paymentToken,
    paymentReference
  };
  
  return logAndRespond(200, responseData, body.invoiceNo);
}

/**
 * Handle Self Service Machine Payment (SSM)
 * Generates machine payment reference
 */
async function handleSelfServiceMachine(request, response, body, logAndRespond) {
  const now = new Date().toISOString();
  const paymentToken = generatePaymentToken();
  const tranRef = generateTranRef();
  const paymentReference = `SSM-${tranRef}`;
  
  // Parse amount (already validated in handleDirectPayment, but parse again for safety)
  const parsedAmount = parseFloat(body.amount);
  
  // Create payment record
  const payment = {
    provider: '2c2p',
    invoiceNo: body.invoiceNo,
    paymentToken,
    merchantID: body.merchantID || 'MOCK_MERCHANT',
    amount: parsedAmount,
    currencyCode: body.currencyCode || 'THB',
    description: body.description || '',
    status: 'pending',
    backendReturnUrl: rewriteUrl(body.backendReturnUrl || process.env.DEFAULT_CALLBACK_URL || null),
    frontendReturnUrl: rewriteUrl(body.frontendReturnUrl || null),
    paymentMethod: 'SSM',
    channelCode: 'SSM',
    paymentReference,
    paymentChannel: ['SSM'],
    createdAt: now,
    updatedAt: now,
    tranRef,
    respCode: '2001',
    statusHistory: [
      {
        status: 'pending',
        respCode: '2001',
        respDesc: 'Payment reference generated, pay at machine',
        changedAt: now,
        changedBy: 'system'
      }
    ],
    callbackHistory: [],
    callbackCount: 0
  };
  
  await savePayment(payment);
  
  // Return response with payment reference (flat format)
  const responseData = {
    merchantID: payment.merchantID,
    invoiceNo: payment.invoiceNo,
    amount: payment.amount.toFixed(2),
    currencyCode: payment.currencyCode,
    tranRef: payment.tranRef,
    channelCode: 'SSM',
    respCode: '2001',
    respDesc: 'Payment reference generated',
    status: 'pending',
    paymentToken,
    paymentReference
  };
  
  return logAndRespond(200, responseData, body.invoiceNo);
}

/**
 * Handle Internet Banking Payment (IB)
 * Returns redirect URL for bank
 */
async function handleInternetBanking(request, response, body, logAndRespond) {
  const now = new Date().toISOString();
  const paymentToken = generatePaymentToken();
  const tranRef = generateTranRef();
  
  // Parse amount (already validated in handleDirectPayment, but parse again for safety)
  const parsedAmount = parseFloat(body.amount);
  
  // Build redirect URL
  const host = request.headers.host || 'localhost:3000';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isLocalhost ? 'http' : 'https';
  const serverUrl = process.env.MOCK_SERVER_URL || `${protocol}://${host}`;
  const webPaymentUrl = `${serverUrl}/bank-pay/${encodeURIComponent(paymentToken)}`;
  
  // Create payment record
  const payment = {
    provider: '2c2p',
    invoiceNo: body.invoiceNo,
    paymentToken,
    merchantID: body.merchantID || 'MOCK_MERCHANT',
    amount: parsedAmount,
    currencyCode: body.currencyCode || 'THB',
    description: body.description || '',
    status: 'pending',
    backendReturnUrl: rewriteUrl(body.backendReturnUrl || process.env.DEFAULT_CALLBACK_URL || null),
    frontendReturnUrl: rewriteUrl(body.frontendReturnUrl || null),
    paymentMethod: 'IB',
    channelCode: 'IB',
    redirectUrl: webPaymentUrl,
    paymentChannel: ['IB'],
    createdAt: now,
    updatedAt: now,
    tranRef,
    respCode: '2001',
    statusHistory: [
      {
        status: 'pending',
        respCode: '2001',
        respDesc: 'Redirect to bank required',
        changedAt: now,
        changedBy: 'system'
      }
    ],
    callbackHistory: [],
    callbackCount: 0
  };
  
  await savePayment(payment);
  
  // Return response with redirect URL (flat format)
  const responseData = {
    merchantID: payment.merchantID,
    invoiceNo: payment.invoiceNo,
    amount: payment.amount.toFixed(2),
    currencyCode: payment.currencyCode,
    tranRef: payment.tranRef,
    channelCode: 'IB',
    respCode: '2001',
    respDesc: 'Redirect to bank required',
    status: 'pending',
    paymentToken,
    webPaymentUrl
  };
  
  return logAndRespond(200, responseData, body.invoiceNo);
}
