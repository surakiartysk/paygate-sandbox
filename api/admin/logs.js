/**
 * GET /api/admin/logs
 * DELETE /api/admin/logs
 * 
 * Fetch and manage request/response logs
 */

import { getLogs, clearAllLogs, cleanupOldLogs, getConfig, updateConfig } from '../../lib/storage.js';
import { isAuthenticated, unauthorized } from '../../lib/auth.js';
import { refuseDemo, resolveDemoVisitor } from '../../lib/demoAccess.js';

export default async function handler(request, response) {
  // No CORS headers: the admin API answers this origin's own pages and
  // scripts, and neither needs one — decision 19 in docs/decisions.md.
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }
  
  // Admin only. The request log holds every caller's traffic, including the
  // callback addresses other people's integrations registered. A demo visitor
  // is told so rather than answered 401, which would sign them out.
  if (!isAuthenticated(request)) {
    if (await resolveDemoVisitor(request)) return refuseDemo(response);
    return unauthorized(response);
  }
  
  try {
    if (request.method === 'GET') {
      // Pagination parameters (optimized for free tier)
      const page = Math.max(1, parseInt(request.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit, 10) || 50)); // Default 50, max 100 for free tier
      const offset = (page - 1) * limit;
      
      // Get logs with server-side pagination (efficient for KV)
      const { logs: allLogs, total: totalCount } = await getLogs({ 
        offset, 
        limit, 
        reverse: true 
      });
      
      // Apply filters on fetched logs (small dataset, efficient)
      let filteredLogs = allLogs;
      const { type, invoiceNo } = request.query;
      
      if (type) {
        filteredLogs = filteredLogs.filter(log => log.type === type);
      }
      
      if (invoiceNo) {
        filteredLogs = filteredLogs.filter(log => log.invoiceNo === invoiceNo);
      }
      
      // Note: When filtering, we might have fewer items than requested
      // This is acceptable for the free tier optimization
      const filteredTotal = type || invoiceNo ? filteredLogs.length : totalCount;
      const totalPages = Math.ceil(filteredTotal / limit);
      
      // Get TTL config
      const config = await getConfig();
      
      return response.status(200).json({
        success: true,
        logs: filteredLogs,
        pagination: {
          page,
          limit,
          total: filteredTotal,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1
        },
        logTTLDays: config.logTTLDays || 7
      });
    }
    
    if (request.method === 'DELETE') {
      const { action } = request.query;
      
      if (action === 'cleanup') {
        // Run TTL cleanup
        const deletedCount = await cleanupOldLogs();
        return response.status(200).json({
          success: true,
          message: `Cleaned up ${deletedCount} old logs`
        });
      }
      
      // Clear all logs
      await clearAllLogs();
      return response.status(200).json({
        success: true,
        message: 'All logs cleared'
      });
    }
    
    return response.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Logs API error:', error);
    return response.status(500).json({
      error: 'Failed to process logs request',
      message: error.message
    });
  }
}
