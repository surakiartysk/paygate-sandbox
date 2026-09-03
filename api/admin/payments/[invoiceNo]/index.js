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
  const invoiceNo = pathMatch?.[1] || request.query?.invoiceNo;
  
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
