/**
 * GET /api/omise/charges/:id - Retrieve charge
 * Explicit route for GET requests with charge ID (Vercel catch-all doesn't work for multi-segment GET)
 */

import { getAllPayments } from '../../../lib/storage.js';
import { logRequest } from '../../../lib/logger.js';
import { generateReferenceNo } from '../../../lib/tokenGenerator.js';
import { rewriteUrl } from '../../../lib/urlUtils.js';
import { enforceRateLimit } from '../../../lib/rateLimit.js';

const OMISE_STATUS_MAP = {
  pending: 'pending',
  success: 'successful',
  failed: 'failed',
  cancelled: 'reversed',
  expired: 'expired'
};

export default async function handler(request, response) {
  const startTime = Date.now();
  
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mock-Delay, X-Mock-Error');
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (enforceRateLimit(request, response)) return;
  
  if (request.method !== 'GET') {
    return response.status(405).json({
      object: 'error',
      code: 'method_not_allowed',
      message: 'Method not allowed'
    });
  }
  
  // Get charge ID from query parameter (Vercel passes [id] as request.query.id)
  const chargeId = request.query?.id;
  
  if (!chargeId) {
    return response.status(400).json({
      object: 'error',
      code: 'invalid_request',
      message: 'Charge ID is required'
    });
  }
  
  // Helper to log and respond
  const logAndRespond = async (statusCode, responseBody, invoiceNo = null) => {
    const duration = Date.now() - startTime;
    
    // Log request/response
    const logStartTime = Date.now();
    try {
      const logResult = await Promise.race([
        logRequest('omise-charge-get', invoiceNo, {
          method: request.method,
          path: `/api/omise/charges/${chargeId}`,
          headers: request.headers,
          body: null
        }, {
          status: statusCode,
          body: responseBody,
          duration
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Log timeout')), 2000))
      ]).catch(err => {
        console.error('❌ Omise charge GET logging error or timeout:', {
          error: err.message,
          chargeId,
          duration: `${Date.now() - logStartTime}ms`
        });
        return null;
      });
      
      if (logResult && logResult.id) {
        console.log('✅ Omise charge GET request logged successfully:', { 
          chargeId,
          logId: logResult.id,
          duration: `${Date.now() - logStartTime}ms`
        });
      }
    } catch (err) {
      console.error('❌ Error during logRequest for Omise charge GET:', {
        error: err.message,
        chargeId
      });
    }
    
    return response.status(statusCode).json(responseBody);
  };
  
  try {
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
    
    // Convert payment to Omise charge format
    const omiseStatus = OMISE_STATUS_MAP[payment.status] || 'pending';
    
    // Convert amount from main unit (THB) back to smallest currency unit (satangs)
    const amountInSmallestUnit = Math.round((payment.amount || 0) * 100);
    
    // Calculate fee based on transaction_fees (default 1.0% for THB)
    const feeRate = 1.0;
    const vatRate = 7.0;
    const fee = Math.round(amountInSmallestUnit * feeRate / 100);
    const feeVat = Math.round(fee * vatRate / 100);
    const net = amountInSmallestUnit - fee;
    
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
      location: `/charges/${payment.omiseChargeId || chargeId}/refunds`,
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
    
    const chargeResponse = {
      object: 'charge',
      id: payment.omiseChargeId || chargeId,
      location: `/charges/${payment.omiseChargeId || chargeId}`,
      amount: amountInSmallestUnit,
      acquirer_reference_number: null,
      net: net,
      fee: fee,
      fee_vat: feeVat,
      interest: 0,
      interest_vat: 0,
      funding_amount: amountInSmallestUnit,
      refunded_amount: 0,
      transaction_fees: transactionFees,
      platform_fee: platformFee,
      currency: payment.currencyCode.toLowerCase(),
      funding_currency: payment.currencyCode.toLowerCase(),
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
        `https://3dsms.omise.co/payments/pay2_${(payment.omiseChargeId || chargeId).substring(0, 20)}/authorize` : null,
      return_uri: payment.frontendReturnUrl ? rewriteUrl(payment.frontendReturnUrl) : null,
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
    
    console.log('✅ Omise charge retrieved:', { 
      chargeId, 
      invoiceNo: payment.invoiceNo,
      status: omiseStatus 
    });
    
    return logAndRespond(200, chargeResponse, payment.invoiceNo);
    
  } catch (error) {
    console.error('Omise charge GET error:', error);
    return logAndRespond(500, {
      object: 'error',
      code: 'server_error',
      message: error.message
    }, null);
  }
}
