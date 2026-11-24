/**
 * GET /api/admin/logs
 * DELETE /api/admin/logs
 * 
 * Fetch and manage request/response logs
 */

import { getLogs, clearAllLogs, cleanupOldLogs, getConfig, updateConfig } from '../../lib/storage.js';
import { unauthorized } from '../../lib/auth.js';
import { refuseDemo, resolvePrincipal } from '../../lib/demoAccess.js';
import { enforceRateLimit } from '../../lib/rateLimit.js';

export default async function handler(request, response) {
  // No CORS headers: the admin API answers this origin's own pages and
  // scripts, and neither needs one — decision 19 in docs/decisions.md.
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }
  
  // The request log holds every caller's traffic, including the callback
  // addresses other people's integrations registered. The admin reads all of
  // it. A demo visitor reads the entries for their own invoices and nothing
  // else (decision 31), and may not clear anything: clearing is the instance's.
  const principal = await resolvePrincipal(request);
  if (!principal) return unauthorized(response);
  const visitor = principal.role === 'demo' ? principal.visitor : null;
  if (visitor) {
    if (enforceRateLimit(request, response)) return;
    if (request.method !== 'GET') return refuseDemo(response);
  }
  
  try {
    if (request.method === 'GET') {
      // Pagination parameters (optimized for free tier)
      const page = Math.max(1, parseInt(request.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit, 10) || 50)); // Default 50, max 100 for free tier
      const offset = (page - 1) * limit;
      
      const { type, invoiceNo } = request.query;
      // A visitor's view is always a filtered one: every log is read and only
      // theirs are kept, so a page of fifty is fifty of theirs and not the few
      // of theirs among the newest fifty of everyone's.
      const filtering = Boolean(type || invoiceNo || visitor);

      // A filter has to see every log, not the page being shown: filtering the
      // newest fifty can only ever find what is already among the newest fifty.
      // Retention is capped (MAX_TOTAL_LOGS in lib/storage.js, 500), so reading them all is bounded;
      // an unfiltered request still reads only its own page.
      const { logs: fetched, total: totalCount } = await getLogs(
        filtering ? { reverse: true } : { offset, limit, reverse: true }
      );

      let filteredLogs = fetched;
      if (visitor) {
        // By the invoice number the entry was written with: a visitor's
        // invoices all start with their owner id, and the trailing dash stops
        // owner AB12 matching AB123's. Anyone may send a provider request that
        // names one of these numbers, and it shows here — but that is a
        // stranger putting their own request in front of this visitor, escaped
        // when drawn, never the visitor reading someone else's traffic.
        const prefix = `DEMO-${visitor.ownerId}-`;
        filteredLogs = filteredLogs.filter(log => typeof log.invoiceNo === 'string' && log.invoiceNo.startsWith(prefix));
      }
      if (type) {
        filteredLogs = filteredLogs.filter(log => log.type === type);
      }
      if (invoiceNo) {
        filteredLogs = filteredLogs.filter(log => log.invoiceNo === invoiceNo);
      }

      const filteredTotal = filtering ? filteredLogs.length : totalCount;
      if (filtering) {
        filteredLogs = filteredLogs.slice(offset, offset + limit);
      }
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
      error: 'Failed to process logs request'
    });
  }
}
