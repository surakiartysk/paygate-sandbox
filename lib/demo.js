/**
 * Demo Data & Guided Scenario
 *
 * Two jobs, both aimed at someone opening a shared deployment for the first
 * time and having no idea what they are looking at.
 *
 * `seedDemoPayments` fills an empty instance with a representative spread of
 * transactions, so the dashboard shows something real instead of an empty
 * table. It only ever runs when there are no payments at all — it will not
 * re-add records someone deliberately cleared.
 *
 * `runDemoScenario` drives one transaction through its whole lifecycle
 * against the built-in inspector: create it through the 2C2P API, move it to
 * success, deliver the callback, and read back what arrived. That is the
 * complete request/callback loop the sandbox exists to exercise, in one call.
 */

import { getAllPayments, savePayment, updatePayment } from './storage.js';
import { generatePaymentToken, generateTranRef, generateApprovalCode, generateOmiseChargeId } from './tokenGenerator.js';
import { sendCallbackSequence } from './callback.js';
import { getSession, generateSessionId, buildInspectorUrl } from './inspector.js';

/**
 * Shape of the seeded set: a spread across providers, channels and outcomes so
 * every part of the dashboard has something to render.
 */
const DEMO_TEMPLATES = [
  { provider: '2c2p', channel: 'CC', status: 'success', amount: 1250.00, description: 'Card payment — settled' },
  { provider: '2c2p', channel: '3DS', status: 'success', amount: 4800.00, description: '3-D Secure card payment' },
  { provider: '2c2p', channel: 'QR', status: 'pending', amount: 350.00, description: 'PromptPay QR — awaiting scan' },
  { provider: '2c2p', channel: 'CC', status: 'failed', amount: 990.00, description: 'Card declined — insufficient funds', respCode: '4010' },
  { provider: '2c2p', channel: 'IB', status: 'success', amount: 2100.00, description: 'Internet banking transfer' },
  { provider: '2c2p', channel: 'CC', status: 'cancelled', amount: 675.00, description: 'Abandoned at the payment page', respCode: '0003' },
  { provider: '2c2p', channel: 'PC', status: 'expired', amount: 1500.00, description: 'Counter payment — expired unpaid', respCode: '5009' },
  { provider: 'omise', channel: 'CC', status: 'success', amount: 3200.00, description: 'Omise card charge' },
  { provider: 'omise', channel: 'QR', status: 'pending', amount: 780.00, description: 'Omise PromptPay source' },
  { provider: 'omise', channel: 'CC', status: 'failed', amount: 450.00, description: 'Omise charge failed', respCode: '4011' }
];

/**
 * Response code to record for a seeded payment.
 * @param {object} template - Seed template
 * @returns {string} Response code
 */
function respCodeFor(template) {
  if (template.respCode) return template.respCode;
  return template.status === 'success' ? '0000' : '2001';
}

/**
 * Populate an empty instance with demo transactions.
 *
 * @param {object} [options] - Options
 * @param {boolean} [options.force] - Seed even when payments already exist
 * @returns {Promise<{ seeded: boolean, count: number }>} What happened
 */
export async function seedDemoPayments({ force = false } = {}) {
  const existing = await getAllPayments();
  if (existing.length > 0 && !force) {
    return { seeded: false, count: existing.length };
  }

  const now = Date.now();

  for (const [index, template] of DEMO_TEMPLATES.entries()) {
    // Spread the timestamps over the last few hours so the list looks lived-in
    // and the ordering in the dashboard is meaningful.
    const createdAt = new Date(now - (DEMO_TEMPLATES.length - index) * 17 * 60 * 1000).toISOString();
    const invoiceNo = `DEMO-${String(index + 1).padStart(4, '0')}`;
    const isSettled = template.status === 'success';

    /** @type {Record<string, any>} */
    const payment = {
      provider: template.provider,
      invoiceNo,
      merchantID: 'DEMO_MERCHANT',
      amount: template.amount,
      currencyCode: 'THB',
      description: template.description,
      status: template.status,
      channelCode: template.channel,
      paymentChannel: [template.channel],
      paymentToken: generatePaymentToken(),
      tranRef: generateTranRef(),
      respCode: respCodeFor(template),
      backendReturnUrl: null,
      frontendReturnUrl: null,
      locale: 'en',
      createdAt,
      updatedAt: createdAt,
      callbackHistory: [],
      callbackCount: 0,
      isDemo: true,
      // `changedAt`/`changedBy`, not `timestamp`/`note`. Every other writer of
      // this array uses the former, and the dashboard's timeline reads it:
      // sorting on a missing `changedAt` gives a comparator that returns NaN,
      // the time column renders "Invalid Date", the author renders "unknown",
      // and `note` is not a field the renderer knows about, so the one piece
      // of prose these entries carried was never shown at all.
      //
      // Seeded data is the first thing a visitor to a shared deployment sees,
      // which makes it the worst place to have a broken timeline.
      statusHistory: [
        {
          status: 'pending',
          respCode: '2001',
          respDesc: 'Payment created (demo data)',
          changedAt: createdAt,
          changedBy: 'system'
        }
      ]
    };

    if (isSettled) {
      payment.approvalCode = generateApprovalCode();
      payment.cardType = template.channel === 'CC' || template.channel === '3DS' ? 'CREDIT' : '';
      payment.statusHistory.push({
        status: 'success',
        respCode: respCodeFor(template),
        respDesc: 'Payment completed (demo data)',
        changedAt: createdAt,
        changedBy: 'system'
      });
    }

    if (template.provider === 'omise') {
      payment.omiseChargeId = generateOmiseChargeId();
    }

    await savePayment(payment);
  }

  return { seeded: true, count: DEMO_TEMPLATES.length };
}

/**
 * Run one payment end to end against the built-in inspector, returning a
 * narrated set of steps suitable for rendering in the UI.
 *
 * @param {object} request - Incoming request, used to build the inspector URL
 * @returns {Promise<{ invoiceNo: string, sessionId: string, callbackUrl: string, steps: Array<object>, received: Array<object> }>}
 */
export async function runDemoScenario(request) {
  const sessionId = generateSessionId();
  const callbackUrl = buildInspectorUrl(sessionId, request);
  const invoiceNo = `DEMO-RUN-${Date.now().toString(36).toUpperCase()}`;
  const amount = 1499.00;
  const steps = [];

  // 1. The merchant asks the gateway for a payment token.
  const createdAt = new Date().toISOString();
  const paymentToken = generatePaymentToken();

  await savePayment({
    provider: '2c2p',
    invoiceNo,
    merchantID: 'DEMO_MERCHANT',
    amount,
    currencyCode: 'THB',
    description: 'Guided demo transaction',
    status: 'pending',
    channelCode: 'CC',
    paymentChannel: ['CC'],
    paymentToken,
    tranRef: generateTranRef(),
    respCode: '2001',
    backendReturnUrl: callbackUrl,
    frontendReturnUrl: null,
    locale: 'en',
    createdAt,
    updatedAt: createdAt,
    callbackHistory: [],
    callbackCount: 0,
    isDemo: true,
    statusHistory: [
      {
        status: 'pending',
        respCode: '2001',
        respDesc: 'Payment created (guided demo)',
        changedAt: createdAt,
        changedBy: 'system'
      }
    ]
  });

  steps.push({
    step: 1,
    title: 'Merchant requests a payment token',
    detail: `POST /api/2c2p/token — invoice ${invoiceNo} for ${amount.toFixed(2)} THB`,
    result: `Token issued: ${paymentToken.slice(0, 24)}…`
  });

  steps.push({
    step: 2,
    title: 'Callbacks are pointed at the built-in inspector',
    detail: `backendReturnUrl = ${callbackUrl}`,
    result: 'No external request-bin needed — the sandbox receives its own callback.'
  });

  // 3. The customer pays; the transaction settles.
  const approvalCode = generateApprovalCode();
  await updatePayment(invoiceNo, {
    status: 'success',
    respCode: '0000',
    approvalCode,
    updatedAt: new Date().toISOString()
  });

  steps.push({
    step: 3,
    title: 'Customer completes payment',
    detail: 'Status moves pending → success',
    result: `Approval code ${approvalCode}`
  });

  // 4. The gateway calls the merchant back.
  const results = await sendCallbackSequence(invoiceNo, [
    { status: 'success', respCode: '0000', delayAfter: 0 }
  ], { callbackUrl, sendDuplicate: false });

  const delivery = results[0] || {};
  steps.push({
    step: 4,
    title: 'Gateway delivers the callback',
    detail: `POST ${callbackUrl}`,
    result: delivery.success
      ? `Delivered — HTTP ${delivery.status} in ${delivery.responseTime}ms`
      : `Delivery failed — ${delivery.error || 'unknown error'}`
  });

  // 5. Read back what actually arrived.
  const session = await getSession(sessionId);
  steps.push({
    step: 5,
    title: 'Inspector shows what the merchant received',
    detail: `${session.captures.length} callback(s) captured in session ${sessionId}`,
    result: 'Open the inspector to see the full payload.'
  });

  return {
    invoiceNo,
    sessionId,
    callbackUrl,
    steps,
    received: session.captures
  };
}
