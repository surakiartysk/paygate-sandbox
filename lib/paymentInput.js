/**
 * Checks on what a caller sends when creating a payment.
 *
 * The provider APIs are unauthenticated, so whatever passes here is stored and
 * later rendered on the admin's dashboard. Two things went through unchecked:
 *
 * - **The invoice number's type.** `"invoiceNo": 12345` was stored as a
 *   number, and one such row stopped the dashboard's Payments and Logs tabs
 *   rendering and made the admin search answer 500 — for the admin, until the
 *   row was deleted by hand. Anyone could do it without signing in.
 * - **The size of the request.** Every field was stored at whatever length it
 *   arrived, so one request could hold megabytes for as long as the payment
 *   lived.
 */

/** The longest invoice number 2C2P accepts. */
export const MAX_INVOICE_NO_LENGTH = 50;

/**
 * The largest request body a payment may be created from, serialised. A
 * realistic one is well under 2 KB; this leaves room for long descriptions
 * and metadata without letting one request hold megabytes.
 */
export const MAX_PAYMENT_REQUEST_BYTES = 16 * 1024;

/**
 * Why an invoice number the caller supplied cannot be used, or null when it
 * can. A missing one is the caller's own check: each route answers that in
 * its provider's words.
 *
 * @param {unknown} invoiceNo - Value from the request
 * @returns {string|null} Reason, or null when acceptable
 */
export function invoiceNoProblem(invoiceNo) {
  if (typeof invoiceNo !== 'string') return 'invoiceNo must be a string';
  if (invoiceNo.length > MAX_INVOICE_NO_LENGTH) {
    return `invoiceNo must be at most ${MAX_INVOICE_NO_LENGTH} characters`;
  }
  // Control characters have no business in an identifier, and a line break in
  // one would split the log line it is written to.
  if (/[\u0000-\u001f\u007f]/.test(invoiceNo)) return 'invoiceNo must not contain control characters';
  return null;
}

/**
 * Whether a request body is too large to create a payment from.
 *
 * Measured in UTF-8 bytes of its JSON, which is what the store holds — a
 * character count would let a string of four-byte characters through at four
 * times the limit.
 *
 * @param {unknown} body - Parsed request body
 * @returns {boolean} True when over the limit
 */
export function isOversizedPaymentRequest(body) {
  let serialised;
  try {
    serialised = JSON.stringify(body ?? null);
  } catch {
    return true;
  }
  return Buffer.byteLength(serialised ?? '', 'utf8') > MAX_PAYMENT_REQUEST_BYTES;
}
