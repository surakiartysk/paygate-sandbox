/**
 * Consolidated admin payment routes:
 * GET /api/admin/payments/:invoiceNo - Get payment details
 * DELETE /api/admin/payments/:invoiceNo - Delete payment
 * 
 * For sub-paths (/status, /callback, /inquiry-config), see [...slug].js
 */

import { getPayment, deletePayment } from '../../../../lib/storage.js';
import { isAuthenticated, unauthorized } from '../../../../lib/auth.js';
import { buildCallbackPayload } from '../../../../lib/callback.js';

/**
 * Read an invoice number out of a URL path segment.
 *
 * The segment is percent-encoded by whoever built the URL, because an invoice
 * number is whatever the caller of the provider API sent and nothing validates
 * its character set — `AB/CD` is an ordinary value to end up with, and a raw
 * slash there splits the path into a different route.
 *
 * So it is decoded here. Both halves have to agree: the dashboard encodes on
 * the way out, and without this the encoded form was looked up literally and
 * matched nothing, which left such a payment creatable by anyone through the
 * public API and then unmanageable — status, callback and delete all missed
 * it.
 *
 * A malformed escape throws rather than decoding, so the raw segment is used;
 * it will not match a stored payment either, and a 404 is a better answer than
 * a 500.
 *
 * @param {string|undefined} segment - Raw path segment
 * @returns {string|undefined} The decoded invoice number
 */
function decodeInvoiceNo(segment) {
  if (typeof segment !== 'string') return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

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
  
  // Helper to respond
  const respondWithJson = (statusCode, responseBody) => {
    return response.status(statusCode).json(responseBody);
  };
  
  // Parse invoiceNo from URL path
  const urlPath = request.url?.split('?')[0] || '';
  const pathMatch = urlPath.match(/\/api\/admin\/payments\/([^\/]+)$/);
  const invoiceNo = decodeInvoiceNo(pathMatch?.[1]) || request.query?.invoiceNo;
  
  if (!invoiceNo) {
    return respondWithJson(400, { success: false, error: 'Invoice number is required' });
  }
  
  try {
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
