/**
 * Consolidated Omise API Handler
 * Handles all Omise endpoints via catch-all route:
 * - POST /api/omise/charges - Create charge
 * - GET /api/omise/charges/:id - Retrieve charge
 * - POST /api/omise/tokens - Create token
 * - POST /api/omise/sources - Create source
 * 
 * Provider is automatically set to 'omise' for all payments created through this handler
 */

import { savePayment, getPayment, getAllPayments } from '../../lib/storage.js';
import { generateOmiseChargeId, generateOmiseTokenId, generateOmiseSourceId, generateTranRef, generateReferenceNo } from '../../lib/tokenGenerator.js';
import { applyDelay, checkForceError, getErrorResponse, getOmiseErrorResponse } from '../../lib/simulation.js';
import { logRequest } from '../../lib/logger.js';
import { rewriteUrl } from '../../lib/urlUtils.js';
import { enforceRateLimit } from '../../lib/rateLimit.js';

const OMISE_STATUS_MAP = {
  pending: 'pending',
  success: 'successful',
  failed: 'failed',
  cancelled: 'reversed',
  expired: 'expired'
};

/**
 * Build complete Omise charge object with all fields from real API
 */
function buildOmiseChargeObject(payment, amountInt, chargeId, request = null) {
  const now = payment.createdAt || new Date().toISOString();
  const updatedAt = payment.updatedAt || now;
  const omiseStatus = OMISE_STATUS_MAP[payment.status] || 'pending';
  
  // Calculate fee based on transaction_fees (default 1.0% for THB)
  const feeRate = 1.0; // Default fee rate percentage
  const vatRate = 7.0; // VAT rate percentage
  const fee = Math.round(amountInt * feeRate / 100);
  const feeVat = Math.round(fee * vatRate / 100);
  const net = amountInt - fee;
  
  // Calculate expires_at (7 days from creation for pending charges)
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + 7);
  const expiresAtISO = expiresAt.toISOString();
  
  // Determine boolean flags based on status
  const isPaid = payment.status === 'success';
  const isAuthorized = payment.status === 'success';
  const isExpired = payment.status === 'expired';
  const isVoided = payment.status === 'cancelled';
  const isReversed = payment.status === 'cancelled';
  
  // Get IP from request if available
  const ip = request?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || 
             request?.headers?.['x-real-ip'] || 
             null;
  
  // Build refunds object with from/to fields
  const refunds = {
    object: 'list',
    data: [],
    limit: 20,
    offset: 0,
    total: 0,
    location: `/charges/${chargeId}/refunds`,
    order: 'chronological',
    from: '1970-01-01T00:00:00Z',
    to: updatedAt
  };
  
  // Build transaction_fees object
  const transactionFees = {
    fee_flat: '0.0',
    fee_rate: feeRate.toString(),
    vat_rate: vatRate.toString()
  };
  
  // Build platform_fee object
  const platformFee = {
    fixed: null,
    amount: null,
    percentage: null
  };
  
  // Build complete charge object
  const charge = {
    object: 'charge',
    id: chargeId,
    location: `/charges/${chargeId}`,
    amount: amountInt,
    acquirer_reference_number: null,
    net: net,
    fee: fee,
    fee_vat: feeVat,
    interest: 0,
    interest_vat: 0,
    funding_amount: amountInt,
    refunded_amount: 0,
    transaction_fees: transactionFees,
    platform_fee: platformFee,
    currency: (payment.currencyCode || 'THB').toLowerCase(),
    funding_currency: (payment.currencyCode || 'THB').toLowerCase(),
    ip: ip,
    refunds: refunds,
    link: null,
    description: payment.description || null,
    metadata: payment.omiseMetadata || {},
    card: payment.omiseCard || null,
    source: payment.omiseSource || null,
    schedule: null,
    linked_account: null,
    customer: null,
    dispute: null,
    transaction: payment.tranRef || (isPaid ? generateReferenceNo() : null),
    failure_code: null,
    failure_message: null,
    merchant_advice: null,
    status: omiseStatus,
    authorize_uri: payment.status === 'pending' && payment.omiseCard ? 
      `https://3dsms.omise.co/payments/pay2_${chargeId.substring(0, 20)}/authorize` : null,
    return_uri: payment.frontendReturnUrl ? rewriteUrl(payment.frontendReturnUrl) : null,
    created_at: now,
    paid_at: isPaid ? updatedAt : null,
    authorized_at: isAuthorized ? updatedAt : null,
    expires_at: expiresAtISO,
    expired_at: isExpired ? updatedAt : null,
    reversed_at: isReversed ? updatedAt : null,
    multi_capture: false,
    zero_interest_installments: false,
    branch: null,
    terminal: null,
    device: null,
    authorized: isAuthorized,
    capturable: false,
    capture: true,
    disputable: isPaid,
    livemode: false,
    refundable: isPaid,
    partially_refundable: isPaid,
    reversed: isReversed,
    reversible: false,
    voided: isVoided,
    paid: isPaid,
    expired: isExpired,
    can_perform_void: false,
    approval_code: payment.approvalCode || null
  };
  
  return charge;
}

export default async function handler(request, response) {
  const startTime = Date.now();
  
  // CRITICAL: Log immediately to verify Vercel is calling this function
  // If you don't see this log in Vercel function logs, Vercel isn't routing to this function
  // This log should appear for ALL requests (GET, POST, etc.)
  console.log('=== OMISE HANDLER CALLED ===', {
    method: request.method,
    url: request.url,
    pathname: request.pathname,
    fullUrl: request.url,
    queryKeys: Object.keys(request.query || {}),
    query: JSON.stringify(request.query),
    hasSlug: !!(request.query?.['...slug'] || request.query?.slug),
    slugValue: request.query?.['...slug'] || request.query?.slug || 'none',
    headers: JSON.stringify(Object.keys(request.headers || {}))
  });
  
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mock-Delay, X-Mock-Error, Authorization');
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (enforceRateLimit(request, response)) return;
  
  // Note: For catch-all routes, Vercel should pass the path segments via request.query
  // Early return for root /api/omise (no slug) - but this should be handled by path parsing below
  // We'll let path parsing handle it to get better error messages
  
  // Helper to log and respond with automatic log type detection
  const logAndRespond = async (statusCode, responseBody, invoiceNo = null) => {
    const duration = Date.now() - startTime;
    
    // Get correct path for logging - try multiple methods
    let logPath = '/api/omise';
    const urlPath = request.url?.split('?')[0] || '';
    if (urlPath && urlPath.startsWith('/api/omise')) {
      logPath = urlPath;
    } else {
      // Try to reconstruct path from slug or pathname
      // Vercel uses "...slug" (three dots) as the key for catch-all routes
      const slug = request.query?.["...slug"] || request.query?.slug;
      if (slug) {
        const segments = Array.isArray(slug) ? slug : slug.split('/').filter(Boolean);
        if (segments.length > 0) {
          logPath = `/api/omise/${segments.join('/')}`;
        }
      } else if (request.pathname && request.pathname.startsWith('/api/omise')) {
        logPath = request.pathname;
      }
    }
    
    // Determine log type from path
    let logType = 'omise'; // default
    if (logPath.includes('/charges')) {
      logType = 'omise-charge';
    } else if (logPath.includes('/tokens')) {
      logType = 'omise-token';
    } else if (logPath.includes('/sources')) {
      logType = 'omise-source';
    }
    
    console.log('=== LOGGING REQUEST ===', {
      logPath,
      logType,
      method: request.method,
      invoiceNo: invoiceNo || 'null',
      statusCode,
      hasBody: !!request.body,
      timestamp: new Date().toISOString()
    });
    
    // CRITICAL: In serverless environments (Vercel), if we don't await the log,
    // the function may terminate before the log is saved, causing logs to be lost.
    // We need to ensure the log completes before returning the response.
    // Use a timeout approach to prevent blocking too long.
    
    // Log request/response - NOW AWAITED with timeout to ensure completion
    const logStartTime = Date.now();
    try {
      const logResult = await Promise.race([
        logRequest(logType, invoiceNo, {
          method: request.method,
          path: logPath,
          headers: request.headers,
          body: request.body
        }, {
          status: statusCode,
          body: responseBody,
          duration
        }),
        // Timeout after 2 seconds to not block response too long
        new Promise((_, reject) => setTimeout(() => reject(new Error('Log timeout')), 2000))
      ]).catch(err => {
        // If timeout or error, log it but don't block response
        console.error(`❌ Omise ${logType} logging error or timeout:`, {
          error: err.message,
          logPath,
          invoiceNo: invoiceNo || 'null',
          duration: `${Date.now() - logStartTime}ms`,
          timestamp: new Date().toISOString()
        });
        return null;
      });
      
      const logDuration = Date.now() - logStartTime;
      
      if (logResult && logResult.id) {
        console.log(`✅ Omise ${logType} request logged successfully (awaited):`, { 
          type: logType, 
          logPath,
          invoiceNo: invoiceNo || 'null',
          logId: logResult.id,
          duration: `${logDuration}ms`,
          timestamp: new Date().toISOString()
        });
      } else {
        console.warn(`⚠️ Omise ${logType} request logged but no ID returned:`, { 
          type: logType, 
          logPath,
          invoiceNo: invoiceNo || 'null',
          result: logResult || 'null',
          duration: `${logDuration}ms`
        });
      }
    } catch (err) {
      console.error(`❌ Omise ${logType} logging error (CRITICAL):`, {
        error: err.message,
        stack: err.stack,
        logPath,
        invoiceNo: invoiceNo || 'null',
        duration: `${Date.now() - logStartTime}ms`,
        timestamp: new Date().toISOString()
      });
    }
    
    return response.status(statusCode).json(responseBody);
  };
  
  try {
    // Log that the Omise handler was called (before any processing)
    console.log('🔵 Omise API request received:', {
      method: request.method,
      url: request.url,
      hasBody: !!request.body,
      timestamp: new Date().toISOString()
    });
    
    // Apply simulation delay
    await applyDelay(request);
    
    // Check for forced errors (Omise provider)
    const forceError = await checkForceError(request, 'omise');
    if (forceError) {
      console.log('⚠️ Force error enabled for Omise:', forceError);
      const errorResp = getOmiseErrorResponse(forceError);
      return logAndRespond(200, errorResp, null); // Log error response even with no invoiceNo
    }
    
    // Parse URL path to detect action
    // PRIMARY METHOD: Vercel catch-all routes pass segments via request.query['...slug']
    // This is the MOST RELIABLE method for Vercel catch-all routes
    let pathSegments = [];
    
    // CRITICAL: Vercel catch-all routes use '...slug' (three dots, no brackets) as the query key
    // For route api/omise/[...slug].js, Vercel passes segments as request.query['...slug']
    const vercelSlug = request.query?.['...slug'] || request.query?.slug;
    
    if (vercelSlug) {
      if (Array.isArray(vercelSlug)) {
        pathSegments = vercelSlug.filter(Boolean);
        console.log('✅ PRIMARY: Parsed from Vercel catch-all query[...slug] (array):', { 
          pathSegments,
          segmentCount: pathSegments.length,
          firstSegment: pathSegments[0],
          secondSegment: pathSegments[1] || 'none'
        });
      } else if (typeof vercelSlug === 'string' && vercelSlug.length > 0) {
        pathSegments = vercelSlug.split('/').filter(Boolean);
        console.log('✅ PRIMARY: Parsed from Vercel catch-all query[...slug] (string):', { 
          pathSegments,
          segmentCount: pathSegments.length,
          firstSegment: pathSegments[0],
          secondSegment: pathSegments[1] || 'none'
        });
      }
    }
    
    // FALLBACK 1: Parse directly from URL path (works if Vercel doesn't populate query)
    if (pathSegments.length === 0) {
      const urlPath = request.url?.split('?')[0] || '';
      const urlMatch = urlPath.match(/^\/api\/omise\/(.+)$/);
      if (urlMatch && urlMatch[1]) {
        pathSegments = urlMatch[1].split('/').filter(Boolean);
        console.log('✅ FALLBACK 1: Parsed from URL path:', { 
          urlPath, 
          pathSegments,
          segmentCount: pathSegments.length,
          firstSegment: pathSegments[0],
          secondSegment: pathSegments[1] || 'none'
        });
      }
    }
    
    // FALLBACK 2: Try other query key variations
    if (pathSegments.length === 0) {
      const queryKeys = Object.keys(request.query || {});
      console.log('⚠️ Primary parsing failed, trying alternative query keys:', {
        url: request.url,
        pathname: request.pathname,
        queryKeys,
        fullQuery: JSON.stringify(request.query)
      });
      
      // Try alternative query key formats
      const possibleSlugKeys = queryKeys.filter(k => k.includes('slug') || k.includes('param'));
      for (const key of possibleSlugKeys) {
        const slug = request.query?.[key];
        if (slug) {
          if (Array.isArray(slug)) {
            pathSegments = slug.filter(Boolean);
            if (pathSegments.length > 0) {
              console.log(`✅ FALLBACK 2: Parsed from query.${key} (array):`, pathSegments);
              break;
            }
          } else if (typeof slug === 'string' && slug.length > 0) {
            pathSegments = slug.includes('/') 
              ? slug.split('/').filter(Boolean)
              : slug.split(',').filter(Boolean);
            if (pathSegments.length > 0) {
              console.log(`✅ FALLBACK 2: Parsed from query.${key} (string):`, pathSegments);
              break;
            }
          }
        }
      }
    }
    
    // FALLBACK 2: WHATWG URL API (for complex URLs)
    if (pathSegments.length === 0 && request.url) {
      try {
        // Construct full URL if needed
        let fullUrl = request.url;
        if (!fullUrl.startsWith('http')) {
          const host = request.headers?.host || request.headers?.['x-forwarded-host'] || 'localhost';
          const protocol = request.headers?.['x-forwarded-proto'] || 'https';
          fullUrl = `${protocol}://${host}${fullUrl}`;
        }
        
        const urlObj = new URL(fullUrl);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        const omiseIndex = pathParts.indexOf('omise');
        
        if (omiseIndex >= 0 && omiseIndex < pathParts.length - 1) {
          pathSegments = pathParts.slice(omiseIndex + 1);
          console.log('✅ Parsed using WHATWG URL API (FALLBACK 2):', {
            fullUrl,
            pathname: urlObj.pathname,
            pathParts,
            omiseIndex,
            pathSegments
          });
        }
      } catch (urlError) {
        console.error('❌ URL API parsing failed:', {
          error: urlError.message,
          url: request.url,
          stack: urlError.stack
        });
      }
    }
    
    // FALLBACK 3: Direct pathname extraction (if available)
    if (pathSegments.length === 0 && request.pathname) {
      const pathParts = request.pathname.split('/').filter(Boolean);
      const omiseIndex = pathParts.indexOf('omise');
      if (omiseIndex >= 0 && omiseIndex < pathParts.length - 1) {
        pathSegments = pathParts.slice(omiseIndex + 1);
        console.log('✅ Parsed from request.pathname (FALLBACK 3):', {
          pathname: request.pathname,
          pathSegments
        });
      }
    }
    
    console.log('=== FINAL PATH SEGMENTS ===', pathSegments);
    
    if (pathSegments.length === 0) {
      console.error('=== ERROR: No path segments found - Handler was called but path parsing failed ===');
      console.error('This should NOT happen if Vercel is routing correctly');
      // Return a helpful error that shows we ARE in the handler, but path parsing failed
      return response.status(404).json({ 
        object: 'error', 
        code: 'path_parsing_failed',
        message: 'Not Found - Unable to parse Omise API path',
        location: '/api/omise',
        debug: {
          url: request.url,
          pathname: request.pathname,
          query: request.query,
          note: 'Handler was called, but path segments could not be extracted'
        }
      });
    }
    
    const action = pathSegments[0]; // charges, tokens, sources
    const id = pathSegments[1] || null; // Optional ID for GET /charges/:id
    
    console.log('=== ROUTING DECISION ===', { 
      action, 
      id, 
      method: request.method, 
      segments: pathSegments,
      expectedPath: id ? `/api/omise/${action}/${id}` : `/api/omise/${action}`
    });
    
    // Route to appropriate handler (log type is auto-detected from path)
    if (action === 'charges') {
      if (request.method === 'POST') {
        console.log('📝 Routing to handleCreateCharge for POST /api/omise/charges');
        return handleCreateCharge(request, response, logAndRespond);
      } else if (request.method === 'GET') {
        // GET /api/omise/charges/:id or GET /api/omise/charges
        if (id) {
          // GET with ID - retrieve specific charge
          return handleGetCharge(request, response, id, logAndRespond);
        } else {
          // GET without ID - list all charges (not in Omise API spec, but handle gracefully)
          return logAndRespond(404, { 
            object: 'error', 
            message: 'Charge ID is required',
            location: '/api/omise/charges'
          });
        }
      } else {
        return logAndRespond(405, { object: 'error', message: 'Method not allowed' });
      }
    } else if (action === 'tokens' && request.method === 'POST') {
      return handleCreateToken(request, response, logAndRespond);
    } else if (action === 'sources' && request.method === 'POST') {
      return handleCreateSource(request, response, logAndRespond);
    } else {
      return logAndRespond(404, { 
        object: 'error', 
        message: 'Not Found',
        location: '/api/omise'
      });
    }
    
  } catch (error) {
    console.error('Omise API error:', error);
    return logAndRespond(500, {
      object: 'error',
      message: 'System error: ' + error.message
    });
  }
}

/**
 * Handle POST /api/omise/charges - Create charge
 */
async function handleCreateCharge(request, response, logAndRespond) {
  const body = request.body;
  
  // Parse amount as integer (Omise sends amount as integer in smallest currency unit)
  const amountInt = typeof body.amount === 'string' ? parseInt(body.amount, 10) : Math.floor(Number(body.amount)) || 0;
  
  // Generate invoiceNo EARLY (before validation) so we can log even validation errors
  // This ensures every request gets logged, even if it fails validation
  const tempInvoiceNo = body.metadata?.invoiceNo || `OMISE_TEMP_${Date.now()}`;
  
  // Validate required fields (Omise format)
  if (!amountInt || amountInt <= 0 || isNaN(amountInt)) {
    console.warn('⚠️ Omise charge validation failed: invalid amount', { amountInt, body: body.amount });
    return logAndRespond(400, {
      object: 'error',
      code: 'invalid_amount',
      message: 'amount must be a positive integer'
    }, tempInvoiceNo); // Log with temp invoiceNo so it appears in logs
  }
  
  if (!body.currency) {
    console.warn('⚠️ Omise charge validation failed: missing currency');
    return logAndRespond(400, {
      object: 'error',
      code: 'invalid_currency',
      message: 'currency is required'
    }, tempInvoiceNo); // Log with temp invoiceNo so it appears in logs
  }
  
  // Generate Omise charge ID
  const chargeId = generateOmiseChargeId(false); // test mode
  const now = new Date().toISOString();
  
  // Create payment record (using invoiceNo from metadata if provided, otherwise use charge ID)
  // Use underscore instead of hyphen for better compatibility
  const invoiceNo = body.metadata?.invoiceNo || `OMISE_${Date.now()}_${chargeId.substring(0, 10)}`;
  
  // Check if invoice already exists
  const existing = await getPayment(invoiceNo);
  if (existing) {
    console.warn('⚠️ Omise charge validation failed: duplicate invoice', { invoiceNo });
    return logAndRespond(400, {
      object: 'error',
      code: 'duplicate_invoice',
      message: 'Invoice number already exists'
    }, invoiceNo);
  }
  
  // Build mock payment URL
  const host = request.headers.host || 'localhost:3000';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isLocalhost ? 'http' : 'https';
  const serverUrl = process.env.MOCK_SERVER_URL || `${protocol}://${host}`;
  const paymentToken = `omise_token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const returnUri = body.return_uri ? rewriteUrl(body.return_uri) : null;
  
  // Process webhook_endpoints with URL replacement
  const webhookEndpoints = body.webhook_endpoints ? 
    body.webhook_endpoints.map(url => rewriteUrl(url)) : 
    [];
  
  // Convert amount from smallest currency unit (satangs for THB) to main unit
  // Omise uses smallest currency unit: 100000 satangs = 1000.00 THB
  const amountInMainUnit = amountInt / 100;
  
  // Create payment record with provider: 'omise'
  const payment = {
    provider: 'omise',  // Explicitly set provider for Omise payments
    invoiceNo,
    omiseChargeId: chargeId,
    paymentToken,
    merchantID: body.metadata?.merchantId || 'MOCK_OMISE_MERCHANT',
    amount: amountInMainUnit, // Store in main currency unit (THB)
    currencyCode: body.currency.toUpperCase(),
    description: body.description || body.metadata?.description || '',
    status: 'pending',
    backendReturnUrl: webhookEndpoints.length > 0 ? webhookEndpoints[0] : 
      (body.metadata?.callbackUrl ? rewriteUrl(body.metadata.callbackUrl) : 
       (process.env.DEFAULT_CALLBACK_URL ? rewriteUrl(process.env.DEFAULT_CALLBACK_URL) : null)),
    frontendReturnUrl: returnUri,
    paymentChannel: ['CC'], // Default to credit card
    createdAt: now,
    updatedAt: now,
    tranRef: generateTranRef(),
    respCode: 'pending', // Omise uses status field, not respCode, but we store it for consistency
    statusHistory: [
      {
        status: 'pending',
        respCode: 'pending',
        respDesc: 'Charge created',
        changedAt: now,
        changedBy: 'system'
      }
    ],
    callbackHistory: [],
    callbackCount: 0,
    // Omise-specific fields
    omiseCard: body.card ? { object: 'card', id: body.card } : null,
    omiseSource: body.source || null,
    omiseMetadata: body.metadata || {}
  };
  
  // Save payment
  try {
    await savePayment(payment);
    console.log('💾 Omise payment saved successfully:', { 
      invoiceNo, 
      chargeId, 
      amount: amountInMainUnit,
      currency: body.currency,
      provider: 'omise'
    });
  } catch (saveError) {
    console.error('❌ CRITICAL: Failed to save Omise payment:', {
      error: saveError.message,
      invoiceNo,
      chargeId,
      stack: saveError.stack
    });
    // Continue anyway - payment might still be logged
  }
  
  // Build complete charge object with all fields
  const chargeObject = buildOmiseChargeObject(payment, amountInt, chargeId, request);
  
  // Wrap in data object to match real API response
  const chargeResponse = {
    data: chargeObject
  };
  
  console.log('✅ Omise charge created successfully, calling logAndRespond:', { 
    invoiceNo, 
    chargeId,
    amount: amountInMainUnit,
    statusCode: 200,
    willLog: true
  });
  
  // CRITICAL: Ensure we always call logAndRespond, even if something goes wrong
  try {
    const result = await logAndRespond(200, chargeResponse, invoiceNo);
    console.log('✅ logAndRespond completed for Omise charge:', { invoiceNo, chargeId });
    return result;
  } catch (logError) {
    console.error('❌ CRITICAL: logAndRespond threw an error (payment was saved but not logged):', {
      error: logError.message,
      invoiceNo,
      chargeId,
      stack: logError.stack
    });
    // Still return the response even if logging fails - don't break the API
    return response.status(200).json(chargeResponse);
  }
}

/**
 * Handle GET /api/omise/charges/:id - Retrieve charge
 */
async function handleGetCharge(request, response, chargeId, logAndRespond) {
  // Find payment by Omise charge ID or invoiceNo
  const payments = await getAllPayments();
  const payment = payments.find(p => 
    (p.provider === 'omise' && (p.omiseChargeId === chargeId || p.invoiceNo === chargeId))
  );
  
  if (!payment) {
    return logAndRespond(404, {
      object: 'error',
      code: 'not_found',
      message: `No such charge: ${chargeId}`
    }, null);
  }
  
  // Convert amount from main unit (THB) back to smallest currency unit (satangs)
  const amountInSmallestUnit = Math.round((payment.amount || 0) * 100);
  
  // Build complete charge object with all fields
  const chargeObject = buildOmiseChargeObject(payment, amountInSmallestUnit, payment.omiseChargeId || chargeId, request);
  
  console.log('✅ Omise charge retrieved, logging response with invoiceNo:', payment.invoiceNo);
  return logAndRespond(200, chargeObject, payment.invoiceNo);
}

/**
 * Handle POST /api/omise/tokens - Create token
 */
async function handleCreateToken(request, response, logAndRespond) {
  const body = request.body;
  
  // Validate required fields
  if (!body.card || !body.card.number || !body.card.name) {
    return logAndRespond(400, {
      object: 'error',
      code: 'invalid_card',
      message: 'Card information is required'
    });
  }
  
  const tokenId = generateOmiseTokenId(false); // test mode
  const now = new Date().toISOString();
  
  // Detect card brand
  const cardNumber = body.card.number.replace(/\D/g, '');
  let brand = 'unknown';
  if (/^4/.test(cardNumber)) brand = 'Visa';
  else if (/^5[1-5]/.test(cardNumber)) brand = 'Mastercard';
  else if (/^3[47]/.test(cardNumber)) brand = 'American Express';
  else if (/^6(?:011|5)/.test(cardNumber)) brand = 'Discover';
  
  // Return Omise token response format
  const tokenResponse = {
    object: 'token',
    id: tokenId,
    livemode: false,
    location: `/tokens/${tokenId}`,
    used: false,
    card: {
      object: 'card',
      id: `card_test_${Math.random().toString(36).substr(2, 9)}`,
      livemode: false,
      country: body.card.country || 'th',
      city: body.card.city || null,
      postal_code: body.card.postal_code || null,
      financing: body.card.financing || 'credit',
      last_digits: cardNumber ? cardNumber.slice(-4) : '0000',
      brand: brand,
      exp_month: body.card.expiration_month || 12,
      exp_year: body.card.expiration_year || 2030,
      fingerprint: `fp_${Math.random().toString(36).substr(2, 16)}`,
      name: body.card.name,
      created: now,
      created_at: now
    },
    created: now,
    created_at: now
  };
  
  return logAndRespond(200, tokenResponse);
}

/**
 * Handle POST /api/omise/sources - Create source
 */
async function handleCreateSource(request, response, logAndRespond) {
  const body = request.body;
  
  if (!body.type || !body.amount || !body.currency) {
    return logAndRespond(400, {
      object: 'error',
      code: 'invalid_source',
      message: 'type, amount, and currency are required'
    });
  }
  
  const sourceId = generateOmiseSourceId(false); // test mode
  const now = new Date().toISOString();
  
  const sourceResponse = {
    object: 'source',
    id: sourceId,
    livemode: false,
    location: `/sources/${sourceId}`,
    type: body.type, // e.g., 'internet_banking_scb', 'truemoney', etc.
    flow: body.flow || 'redirect',
    amount: body.amount,
    currency: body.currency.toLowerCase(),
    created: now,
    created_at: now
  };
  
  // Add type-specific fields based on Omise API documentation
  // Internet Banking (Thailand)
  if (body.type === 'internet_banking_scb' || body.type === 'internet_banking_bbl' || 
      body.type === 'internet_banking_kbank' || body.type === 'internet_banking_ktb' ||
      body.type === 'internet_banking_bay' || body.type === 'internet_banking_tmb') {
    sourceResponse.scannable_code = null;
    sourceResponse.references = {};
    sourceResponse.charge_status = 'pending';
    sourceResponse.authorize_uri = `https://mock-payment-gateway.vercel.app/omise-authorize/${sourceId}`;
  }
  
  // QR Payment (PromptPay, PayNow)
  else if (body.type === 'promptpay' || body.type === 'paynow' || body.type === 'truemoney') {
    sourceResponse.scannable_code = {
      object: 'barcode',
      type: 'qr',
      image: {
        download_uri: `https://api.omise.co/sources/${sourceId}/downloads/qr.png`,
        filename: 'qr.png'
      }
    };
    sourceResponse.references = {
      reference: `QR-${sourceId.substring(0, 8).toUpperCase()}`,
      reference_number: `QR${Date.now()}`
    };
  }
  
  // Alipay (CN, HK)
  else if (body.type === 'alipay' || body.type === 'alipay_cn' || body.type === 'alipay_hk') {
    sourceResponse.scannable_code = null;
    sourceResponse.references = {};
    sourceResponse.charge_status = 'pending';
    sourceResponse.authorize_uri = `https://mock-payment-gateway.vercel.app/alipay-authorize/${sourceId}`;
  }
  
  // Alipay+ (Online, Offline)
  else if (body.type === 'alipay_plus' || body.type === 'alipay_plus_online' || body.type === 'alipay_plus_offline') {
    if (body.flow === 'offline') {
      // Offline: QR code for customer to scan
      sourceResponse.scannable_code = {
        object: 'barcode',
        type: 'qr',
        image: {
          download_uri: `https://api.omise.co/sources/${sourceId}/downloads/qr.png`,
          filename: 'qr.png'
        }
      };
      sourceResponse.references = {
        reference: `ALIPAY-${sourceId.substring(0, 8).toUpperCase()}`
      };
    } else {
      // Online: redirect flow
      sourceResponse.scannable_code = null;
      sourceResponse.references = {};
      sourceResponse.charge_status = 'pending';
      sourceResponse.authorize_uri = `https://mock-payment-gateway.vercel.app/alipay-authorize/${sourceId}`;
    }
  }
  
  // WeChat Pay
  else if (body.type === 'wechat_pay' || body.type === 'wechat') {
    sourceResponse.scannable_code = {
      object: 'barcode',
      type: 'qr',
      image: {
        download_uri: `https://api.omise.co/sources/${sourceId}/downloads/qr.png`,
        filename: 'qr.png'
      }
    };
    sourceResponse.references = {
      reference: `WECHAT-${sourceId.substring(0, 8).toUpperCase()}`
    };
  }
  
  // ShopeePay
  else if (body.type === 'shopee_pay' || body.type === 'shopee') {
    sourceResponse.scannable_code = null;
    sourceResponse.references = {};
    sourceResponse.charge_status = 'pending';
    sourceResponse.authorize_uri = `https://mock-payment-gateway.vercel.app/shopee-authorize/${sourceId}`;
  }
  
  // WiPay
  else if (body.type === 'wipay') {
    sourceResponse.scannable_code = {
      object: 'barcode',
      type: 'qr',
      image: {
        download_uri: `https://api.omise.co/sources/${sourceId}/downloads/qr.png`,
        filename: 'qr.png'
      }
    };
    sourceResponse.references = {
      reference: `WIPAY-${sourceId.substring(0, 8).toUpperCase()}`
    };
  }
  
  // Mobile Banking (Thailand)
  else if (body.type === 'mobile_banking_scb' || body.type === 'scb_easy' ||
           body.type === 'mobile_banking_kbank' || body.type === 'k_plus' ||
           body.type === 'mobile_banking_ktb' || body.type === 'ktb_next' ||
           body.type === 'mobile_banking_bay' || body.type === 'kma' ||
           body.type === 'mobile_banking_ocbc') {
    sourceResponse.scannable_code = null;
    sourceResponse.references = {};
    sourceResponse.charge_status = 'pending';
    sourceResponse.authorize_uri = `https://mock-payment-gateway.vercel.app/mobile-authorize/${sourceId}`;
  }
  
  // GrabPay, Boost, Touch 'n Go, etc.
  else if (body.type === 'grabpay' || body.type === 'boost' || body.type === 'touch_n_go') {
    sourceResponse.scannable_code = null;
    sourceResponse.references = {};
    sourceResponse.charge_status = 'pending';
    sourceResponse.authorize_uri = `https://mock-payment-gateway.vercel.app/wallet-authorize/${sourceId}`;
  }
  
  // Rabbit LINE Pay
  else if (body.type === 'rabbit_line_pay' || body.type === 'line_pay') {
    sourceResponse.scannable_code = null;
    sourceResponse.references = {};
    sourceResponse.charge_status = 'pending';
    sourceResponse.authorize_uri = `https://mock-payment-gateway.vercel.app/line-authorize/${sourceId}`;
  }
  
  // Atome, PayPay, Konbini, etc.
  else if (body.type === 'atome' || body.type === 'paypay' || body.type === 'konbini') {
    if (body.flow === 'offline' || body.type === 'konbini') {
      sourceResponse.scannable_code = {
        object: 'barcode',
        type: body.type === 'konbini' ? 'barcode' : 'qr',
        image: {
          download_uri: `https://api.omise.co/sources/${sourceId}/downloads/qr.png`,
          filename: 'qr.png'
        }
      };
      sourceResponse.references = {
        reference: `${body.type.toUpperCase()}-${sourceId.substring(0, 8)}`
      };
    } else {
      sourceResponse.scannable_code = null;
      sourceResponse.references = {};
      sourceResponse.charge_status = 'pending';
      sourceResponse.authorize_uri = `https://mock-payment-gateway.vercel.app/${body.type}-authorize/${sourceId}`;
    }
  }
  
  // Default: Generic QR payment for unknown types
  else {
    // Default to QR code for most payment methods
    sourceResponse.scannable_code = {
      object: 'barcode',
      type: 'qr',
      image: {
        download_uri: `https://api.omise.co/sources/${sourceId}/downloads/qr.png`,
        filename: 'qr.png'
      }
    };
    sourceResponse.references = {
      reference: `${body.type.toUpperCase()}-${sourceId.substring(0, 8)}`
    };
  }
  
  return logAndRespond(200, sourceResponse);
}

// getOmiseErrorResponse is now imported from lib/simulation.js (removed local implementation)
