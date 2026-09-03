/**
 * Callback Service
 * 
 * Handles sending payment callbacks/webhooks to merchant backends.
 * Supports both 2C2P and Omise payment providers with automatic detection.
 * 
 * Features:
 * - Auto-detects provider from payment record
 * - Supports callback sequences with delays
 * - Tracks callback history with response times
 * - Handles duplicate callbacks for testing idempotency
 * 
 * @module callback
 */

import { getPayment, updatePayment } from './storage.js';
import { generateApprovalCode, generateReferenceNo, generateOmiseEventId } from './tokenGenerator.js';
import { shouldDuplicateCallback } from './simulation.js';
import { logCallback } from './logger.js';
import { rewriteUrl } from './urlUtils.js';
import { assertCallbackUrlAllowed, BlockedCallbackUrlError } from './urlGuard.js';
import { 
  STATUS_TO_RESP_CODE, 
  STATUS_TO_RESP_DESC,
  RESP_CODES,
  getRespCodeForStatus,
  getRespDesc
} from './constants.js';

/**
 * Send callback to merchant's backend
 * @param {string} invoiceNo - Invoice number
 * @param {object} options - Additional options
 * @returns {object} Callback result
 */
export async function sendCallback(invoiceNo, options = {}) {
  const payment = await getPayment(invoiceNo);
  
  if (!payment) {
    throw new Error(`Payment not found: ${invoiceNo}`);
  }
  
  let callbackUrl = options.callbackUrl || payment.backendReturnUrl;
  
  if (!callbackUrl) {
    throw new Error('No callback URL configured for this payment');
  }
  
  // Replace production URLs with dev URLs
  callbackUrl = rewriteUrl(callbackUrl);
  
  // Build callback payload - auto-detects provider from payment.provider field
  const payload = buildCallbackPayload(payment);
  
  // Send the callback (pass payment for User-Agent header)
  const result = await executeCallback(callbackUrl, payload, payment);
  
  // Record in history
  const historyEntry = {
    sentAt: new Date().toISOString(),
    url: callbackUrl,
    responseStatus: result.status,
    responseTime: result.responseTime,
    success: result.success,
    error: result.error || null
  };
  
  // Update payment with callback history
  const updatedHistory = [...(payment.callbackHistory || []), historyEntry];
  await updatePayment(invoiceNo, {
    callbackHistory: updatedHistory,
    callbackCount: updatedHistory.length
  });
  
  // Check if we should send duplicate callback
  if (options.sendDuplicate !== false && await shouldDuplicateCallback()) {
    // Send duplicate after short delay (using await for serverless compatibility)
    // This ensures the duplicate is sent before the function returns
    await sleep(1000); // Wait 1 second
    
    try {
      // Send the duplicate callback (with sendDuplicate: false to prevent infinite loop)
      const duplicateResult = await sendCallback(invoiceNo, { ...options, sendDuplicate: false });
      console.log('✅ Duplicate callback sent successfully:', { 
        invoiceNo, 
        status: duplicateResult.status,
        responseTime: duplicateResult.responseTime 
      });
    } catch (e) {
      console.error('❌ Duplicate callback failed:', e);
      // Don't throw - duplicate callback failure shouldn't break the main callback
    }
  }
  
  return {
    ...result,
    historyEntry
  };
}

/**
 * Build callback payload - auto-detects provider from payment.provider field
 * Uses stored respCode/respDesc if available, otherwise uses defaults
 */
export function buildCallbackPayload(payment) {
  // Auto-detect provider from payment record (not from request)
  const provider = payment.provider || '2c2p';
  
  if (provider === 'omise') {
    return buildOmiseWebhookPayload(payment);
  }
  
  // Default: 2C2P format
  return build2C2PCallbackPayload(payment);
}

/**
 * Build 2C2P callback payload (flat format)
 * @param {Object} payment - Payment record
 * @returns {Object} Formatted callback payload
 */
export function build2C2PCallbackPayload(payment) {
  const respCode = payment.respCode || getRespCodeForStatus(payment.status);
  const respDesc = payment.respDesc || getRespDesc(payment.status);
  
  // Format transactionDateTime (YYYYMMDDHHmmss)
  const transactionDateTime = payment.updatedAt 
    ? payment.updatedAt.replace(/[-:]/g, '').replace('T', '').slice(0, 14)
    : new Date().toISOString().replace(/[-:]/g, '').replace('T', '').slice(0, 14);
  
  // Determine channelCode and agentCode
  const channelCode = payment.channelCode || payment.paymentChannel?.[0] || 'CC';
  const agentCode = payment.agentCode || (channelCode === 'QR' ? 'EMVQR' : '');
  
  // Build payload with all fields from real webhook (flat format)
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
      approvalCode: payment.approvalCode || (payment.status === 'success' ? generateApprovalCode() : null),
      eci: payment.eci || ' ',
      transactionDateTime: transactionDateTime,
      agentCode: agentCode,
      channelCode: channelCode,
      issuerCountry: payment.issuerCountry || '',
      issuerBank: payment.issuerBank || '',
      installmentMerchantAbsorbRate: payment.installmentMerchantAbsorbRate || null,
      cardType: payment.cardType || (channelCode === 'CC' || channelCode === '3DS' ? 'CREDIT' : ''),
      idempotencyID: payment.idempotencyID || '',
      paymentScheme: payment.paymentScheme || channelCode,
      displayProcessingAmount: payment.displayProcessingAmount !== undefined ? payment.displayProcessingAmount : false,
      respCode: respCode,
      respDesc: respDesc
  };
}

/**
 * Build Omise webhook payload (event format)
 */
export function buildOmiseWebhookPayload(payment) {
  const now = new Date().toISOString();
  
  // Map payment status to Omise charge status
  const omiseStatusMap = {
    pending: 'pending',
    success: 'successful',
    failed: 'failed',
    cancelled: 'reversed',
    expired: 'expired'
  };
  
  // Map payment status to Omise event key
  const eventKeyMap = {
    pending: 'charge.create',
    success: 'charge.complete',
    failed: 'charge.failure',
    cancelled: 'charge.reverse',
    expired: 'charge.expire'
  };
  
  const chargeStatus = omiseStatusMap[payment.status] || 'pending';
  const eventKey = eventKeyMap[payment.status] || 'charge.create';
  
  // Convert amount to smallest currency unit
  const amountInt = Math.round((payment.amount || 0) * 100);
  
  // Calculate fee based on transaction_fees (default 1.0% for THB)
  const feeRate = 1.0;
  const vatRate = 7.0;
  const fee = Math.round(amountInt * feeRate / 100);
  const feeVat = Math.round(fee * vatRate / 100);
  const net = amountInt - fee;
  
  // Calculate expires_at (7 days from creation for pending charges)
  const createdAt = new Date(payment.createdAt);
  const expiresAt = new Date(createdAt);
  expiresAt.setDate(expiresAt.getDate() + 7);
  const expiresAtISO = expiresAt.toISOString();
  
  // Determine boolean flags based on status
  const isPaid = payment.status === 'success';
  const isAuthorized = payment.status === 'success';
  const isExpired = payment.status === 'expired';
  const isVoided = payment.status === 'cancelled';
  const isReversed = payment.status === 'cancelled';
  
  // Build refunds object with from/to fields
  const refunds = {
    object: 'list',
    data: [],
    limit: 20,
    offset: 0,
    total: 0,
    location: `/charges/${payment.omiseChargeId || payment.invoiceNo}/refunds`,
    order: 'chronological',
    from: '1970-01-01T00:00:00Z',
    to: payment.updatedAt || payment.createdAt
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
  
  // Build complete charge data object with all fields
  const chargeData = {
    object: 'charge',
    id: payment.omiseChargeId || `chrg_test_${payment.invoiceNo}`,
    location: `/charges/${payment.omiseChargeId || payment.invoiceNo}`,
    amount: amountInt,
    authorization_type: null,
    authorized_amount: isAuthorized ? amountInt : null,
    captured_amount: isPaid ? amountInt : null,
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
    ip: null,
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
    status: chargeStatus,
    authorize_uri: payment.status === 'pending' && payment.omiseCard ? 
      `https://3dsms.omise.co/payments/pay2_${(payment.omiseChargeId || payment.invoiceNo).substring(0, 20)}/authorize` : null,
    return_uri: payment.frontendReturnUrl || null,
    created_at: payment.createdAt,
    paid_at: isPaid ? payment.updatedAt : null,
    authorized_at: isAuthorized ? payment.updatedAt : null,
    expires_at: expiresAtISO,
    expired_at: isExpired ? payment.updatedAt : null,
    reversed_at: isReversed ? payment.updatedAt : null,
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
  
  // Build webhook event (Omise webhook format) with all fields
  const eventId = generateOmiseEventId(false);
  return {
    object: 'event',
    id: eventId,
    livemode: false,
    location: `/events/${eventId}`,
    webhook_deliveries: [],
    data: chargeData,
    key: eventKey,
    created_at: now,
    team_uid: 'team_mock',
    user_uid: 'acct_mock'
  };
}

/**
 * Execute HTTP callback
 * @param {string} url - Callback URL
 * @param {object} payload - Callback payload (provider-specific format)
 * @param {object|string} paymentOrInvoiceNo - Payment object or invoice number
 */
export async function executeCallback(url, payload, paymentOrInvoiceNo = null) {
  const startTime = Date.now();
  
  try {
    // Refuse to make the request at all when the target is not a safe public
    // endpoint. This is the single choke point for every outbound callback.
    assertCallbackUrlAllowed(url);
    
    // Get payment object (if invoiceNo string is passed, fetch payment)
    let payment = typeof paymentOrInvoiceNo === 'string' 
      ? await getPayment(paymentOrInvoiceNo)
      : paymentOrInvoiceNo;
    
    // Determine provider for User-Agent header (for identification only)
    const provider = payment?.provider || '2c2p';
    const userAgent = provider === 'omise' ? 'Mock-Omise-Gateway/1.0' : 'Mock-2C2P-Gateway/1.0';
    
    // Get invoiceNo for logging (support both 2C2P and Omise payloads)
    const invoiceNo = payment?.invoiceNo || payload.invoiceNo || payload.data?.id || null;
    
    // Wrap 2C2P payload in { payload: ... } format
    // Omise uses its own webhook format (not wrapped)
    const wrappedPayload = provider === 'omise' ? payload : { payload };
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
    
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent
      },
      body: JSON.stringify(wrappedPayload),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    const responseTime = Date.now() - startTime;
    
    const result = {
      success: res.ok,
      status: res.status,
      responseTime,
      payload: wrappedPayload  // Log the wrapped payload that was actually sent
    };
    
    // Log the callback (async, don't block)
    if (invoiceNo) {
      logCallback(invoiceNo, url, wrappedPayload, result)
        .catch(err => console.error('Callback logging error:', err));
    }
    
    return result;
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    // Get invoiceNo for logging
    let payment = typeof paymentOrInvoiceNo === 'string' 
      ? await getPayment(paymentOrInvoiceNo)
      : paymentOrInvoiceNo;
    const invoiceNo = payment?.invoiceNo || payload.invoiceNo || payload.data?.id || null;
    
    const result = {
      success: false,
      status: 0,
      responseTime,
      error: error.message,
      payload
    };
    
    // Distinguish "we refused to send this" from "the send failed", so the
    // dashboard can explain a blocked target rather than showing a timeout.
    if (error instanceof BlockedCallbackUrlError) {
      result.blocked = true;
      result.code = error.code;
      console.warn(`🛑 Blocked callback to ${url}: ${error.message}`);
    }
    
    // Log the failed callback (async, don't block)
    if (invoiceNo) {
      logCallback(invoiceNo, url, payload, result)
        .catch(err => console.error('Callback logging error:', err));
    }
    
    return result;
  }
}

/**
 * Send a sequence of callbacks with custom status/respCode for each
 * NOTE: Sequences never auto-retry or duplicate - they send exactly what's defined
 * @param {string} invoiceNo - Invoice number
 * @param {Array} sequence - Array of { status, respCode, delayAfter }
 * @param {object} options - Additional options (sendDuplicate is always false for sequences)
 * @returns {Array} Array of callback results
 */
export async function sendCallbackSequence(invoiceNo, sequence, options = {}) {
  const payment = await getPayment(invoiceNo);
  
  if (!payment) {
    throw new Error(`Payment not found: ${invoiceNo}`);
  }
  
  let callbackUrl = options.callbackUrl || payment.backendReturnUrl;
  
  if (!callbackUrl) {
    throw new Error('No callback URL configured for this payment');
  }
  
  // Replace production URLs with dev URLs
  callbackUrl = rewriteUrl(callbackUrl);
  
  const results = [];
  
  // Sequences never auto-retry or duplicate - send exactly what's defined
  console.log(`📋 Starting callback sequence: ${sequence.length} callback(s) for invoice ${invoiceNo}`);
  
  for (let i = 0; i < sequence.length; i++) {
    const item = sequence[i];
    const callbackStartTime = Date.now();
    console.log(`📤 [${new Date().toISOString()}] Sending callback ${i + 1}/${sequence.length}: status=${item.status}, respCode=${item.respCode}, delayAfter=${item.delayAfter}ms`);
    
    // Get fresh payment data for each callback in sequence
    const currentPayment = await getPayment(invoiceNo);
    if (!currentPayment) {
      throw new Error(`Payment not found: ${invoiceNo}`);
    }
    
    // Build custom payload for this callback (respects provider)
    // Pass custom fields from options to be merged into the payload
    const payload = buildCustomCallbackPayload(currentPayment, { ...item, customFields: options.customFields });
    
    // Execute callback directly (no duplicate logic for sequences)
    // Continue even if callback fails (404, etc.) - record the result
    let result;
    try {
      result = await executeCallback(callbackUrl, payload, currentPayment);
      console.log(`✅ Callback ${i + 1}/${sequence.length} completed: status=${result.status}, success=${result.success}`);
    } catch (error) {
      console.error(`❌ Callback ${i + 1}/${sequence.length} failed:`, error);
      // Create error result but continue with sequence
      result = {
        success: false,
        status: 0,
        responseTime: 0,
        error: error.message,
        payload: payload
      };
    }
    
    // Record in history
    const historyEntry = {
      sentAt: new Date().toISOString(),
      url: callbackUrl,
      responseStatus: result.status,
      responseTime: result.responseTime,
      success: result.success,
      error: result.error || null,
      sequenceIndex: i + 1,
      sequenceTotal: sequence.length,
      customStatus: item.status,
      customRespCode: item.respCode
    };
    
    // Update payment with callback history
    const updatedPayment = await getPayment(invoiceNo);
    const updatedHistory = [...(updatedPayment.callbackHistory || []), historyEntry];
    await updatePayment(invoiceNo, {
      callbackHistory: updatedHistory,
      callbackCount: updatedHistory.length
    });
    
    results.push({
      ...result,
      historyEntry,
      sequenceIndex: i + 1
    });
    
    // Wait for delay before next callback (if not last)
    // delayAfter is already in milliseconds from the UI
    if (i < sequence.length - 1 && item.delayAfter > 0) {
      const delayStartTime = Date.now();
      console.log(`⏳ [${new Date().toISOString()}] Waiting ${item.delayAfter}ms before next callback (${i + 2}/${sequence.length})`);
      await sleep(item.delayAfter);
      const actualDelay = Date.now() - delayStartTime;
      console.log(`✅ [${new Date().toISOString()}] Delay completed (actual: ${actualDelay}ms), sending next callback`);
    } else if (i < sequence.length - 1) {
      console.log(`⏭️  No delay configured for callback ${i + 1}, proceeding immediately to next`);
    } else if (i === sequence.length - 1 && item.delayAfter > 0) {
      console.log(`ℹ️  Note: delayAfter=${item.delayAfter}ms on last callback (${i + 1}) will not be applied (no next callback)`);
    }
  }
  
  return results;
}

/**
 * Build callback payload with custom status/respCode
 * Auto-detects provider from payment.provider field
 */
/**
 * Build callback payload with custom status/respCode
 * @param {Object} payment - Payment record  
 * @param {Object} customData - Custom data { status, respCode, customFields }
 * @returns {Object} Formatted callback payload
 */
function buildCustomCallbackPayload(payment, customData) {
  const provider = payment.provider || '2c2p';
  
  // For Omise, temporarily update payment status for webhook generation
  if (provider === 'omise') {
    const webhook = buildOmiseWebhookPayload({
      ...payment,
      status: customData.status || payment.status
    });
    // Omise exposes arbitrary merchant data through the charge's metadata object
    if (customData.customFields && webhook.data) {
      webhook.data.metadata = {
        ...(webhook.data.metadata || {}),
        ...omitReservedFields(customData.customFields)
      };
    }
    return webhook;
  }
  
  // 2C2P format - use centralized constants
  const status = customData.status || payment.status;
  const respCode = customData.respCode || getRespCodeForStatus(status);
  const respDesc = getRespDesc(respCode) || getRespDesc(status);
  
  // Format transactionDateTime
  const transactionDateTime = payment.updatedAt 
    ? payment.updatedAt.replace(/[-:]/g, '').replace('T', '').slice(0, 14)
    : new Date().toISOString().replace(/[-:]/g, '').replace('T', '').slice(0, 14);
  
  // Determine channelCode and agentCode
  const channelCode = payment.channelCode || payment.paymentChannel?.[0] || 'CC';
  const agentCode = payment.agentCode || (channelCode === 'QR' ? 'EMVQR' : '');
  
  // Build payload with all fields (flat format)
  const payload = {
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
    approvalCode: payment.approvalCode || (status === 'success' ? generateApprovalCode() : null),
    eci: payment.eci || ' ',
    transactionDateTime: transactionDateTime,
    agentCode: agentCode,
    channelCode: channelCode,
    issuerCountry: payment.issuerCountry || '',
    issuerBank: payment.issuerBank || '',
    installmentMerchantAbsorbRate: payment.installmentMerchantAbsorbRate || null,
    cardType: payment.cardType || (channelCode === 'CC' || channelCode === '3DS' ? 'CREDIT' : ''),
    idempotencyID: payment.idempotencyID || '',
    paymentScheme: payment.paymentScheme || channelCode,
    displayProcessingAmount: payment.displayProcessingAmount !== undefined ? payment.displayProcessingAmount : false,
    respCode: respCode,
    respDesc: respDesc
  };
  
  // Merge merchant-specific fields alongside the provider schema.
  //
  // Fields that carry the transaction's identity and outcome are not
  // overridable: silently rewriting respCode or invoiceNo here would make the
  // callback disagree with the stored payment and with what the dashboard
  // shows, which is worse than useless when the point is to reproduce a
  // provider's behaviour faithfully. Use `customPayload` to send something
  // arbitrary instead.
  if (customData.customFields) {
    Object.assign(payload, omitReservedFields(customData.customFields));
  }
  
  return payload;
}

/**
 * Fields a custom-field merge must never overwrite.
 * These identify the transaction and state its outcome.
 */
const RESERVED_CALLBACK_FIELDS = new Set([
  'invoiceNo', 'amount', 'currencyCode', 'merchantID',
  'respCode', 'respDesc', 'tranRef', 'referenceNo', 'approvalCode'
]);

/**
 * Drop reserved keys from a custom-field object.
 *
 * @param {object} fields - Caller-supplied fields
 * @returns {object} Fields safe to merge
 */
function omitReservedFields(fields) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_CALLBACK_FIELDS.has(key)) {
      console.warn(`[callback] Ignoring reserved custom field "${key}"`);
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get callback history for a payment
 */
export async function getCallbackHistory(invoiceNo) {
  const payment = await getPayment(invoiceNo);
  if (!payment) return [];
  
  return payment.callbackHistory || [];
}
