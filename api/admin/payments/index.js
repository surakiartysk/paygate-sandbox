/**
 * GET /api/admin/payments - List all payments
 * POST /api/admin/payments/clear - Clear all payments (handled here via path check)
 */

import { getAllPayments, clearAllPayments } from '../../../lib/storage.js';
import { isAuthenticated, unauthorized } from '../../../lib/auth.js';

export default async function handler(request, response) {
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }
  
  // Check authentication
  if (!isAuthenticated(request)) {
    return unauthorized(response);
  }
  
  try {
    // Check if this is the clear endpoint (handles both direct and rewritten routes)
    // Vercel rewrites route /api/admin/payments/clear to /api/admin/payments, so we check URL path
    const urlPath = request.url?.split('?')[0] || '';
    // Check if this is a clear request (either direct or rewritten via vercel.json)
    if (urlPath.endsWith('/clear') || urlPath.includes('/clear') || request.query?.action === 'clear' || request.headers['x-rewrite-target']?.includes('/clear')) {
      if (request.method === 'POST') {
        await clearAllPayments();
        return response.status(200).json({
          success: true,
          message: 'All payments cleared'
        });
      }
      return response.status(405).json({ error: 'Method not allowed' });
    }
    
    // Handle list payments (default - GET /api/admin/payments)
    if (request.method === 'GET') {
      const payments = await getAllPayments();
      
      // Apply filters if provided
      const { status, search, provider, method } = request.query;
      
      let filtered = payments;
      
      // Filter by provider (backward compat: default to '2c2p' if not set)
      if (provider && provider !== 'all') {
        filtered = filtered.filter(p => (p.provider || '2c2p') === provider);
      }
      
      // Filter by payment method
      if (method && method !== 'all') {
        filtered = filtered.filter(p => {
          const paymentMethod = p.paymentMethod || p.channelCode || p.paymentChannel?.[0];
          return paymentMethod === method;
        });
      }
      
      if (status && status !== 'all') {
        filtered = filtered.filter(p => p.status === status);
      }
      
      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(p => 
          p.invoiceNo.toLowerCase().includes(searchLower) ||
          p.description?.toLowerCase().includes(searchLower)
        );
      }
      
      // Sort by creation date (newest first) - use createdAt
      filtered.sort((a, b) => {
        const dateA = new Date(a.createdAt || 0);
        const dateB = new Date(b.createdAt || 0);
        return dateB - dateA; // Descending (newest first)
      });
      
      // Pagination parameters (optimized for free tier)
      const page = Math.max(1, parseInt(request.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit, 10) || 50)); // Default 50, max 100 for free tier
      const offset = (page - 1) * limit;
      const total = filtered.length;
      const totalPages = Math.ceil(total / limit);
      
      // Apply pagination
      const paginated = filtered.slice(offset, offset + limit);
      
      return response.status(200).json({
        success: true,
        payments: paginated,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1
        }
      });
    }
    
    return response.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Payments API error:', error);
    return response.status(500).json({
      success: false,
      error: error.message
    });
  }
}
