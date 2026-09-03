/**
 * Request/Response Logger
 * Logs all API requests with automatic TTL-based cleanup
 */

import { saveLog, getLogs, cleanupOldLogs, getSimulationConfig } from './storage.js';

// Maximum size for request/response bodies (10KB)
const MAX_BODY_SIZE = 10 * 1024;

// Default TTL in days
const DEFAULT_TTL_DAYS = 7;

/**
 * Log an API request/response
 * @param {string} type - Log type: 'token', 'inquiry', 'callback', 'admin'
 * @param {string} invoiceNo - Associated invoice number (optional)
 * @param {object} request - Request details
 * @param {object} response - Response details
 */
export async function logRequest(type, invoiceNo, request, response) {
  const startLogTime = Date.now();
  const entryId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  
  console.log('📝 logRequest called:', {
    type,
    invoiceNo: invoiceNo || 'null',
    entryId,
    timestamp: new Date().toISOString()
  });
  
  try {
    const entry = {
      id: entryId,
      type,
      invoiceNo: invoiceNo || null,
      timestamp: new Date().toISOString(),
      request: sanitizeRequest(request),
      response: sanitizeResponse(response)
    };
    
    console.log('💾 logRequest - Calling saveLog:', {
      type,
      invoiceNo: invoiceNo || 'null',
      entryId,
      timestamp: new Date().toISOString()
    });
    
    // Save log (with error handling inside saveLog)
    // CRITICAL: await this to ensure it completes before function terminates
    const saved = await saveLog(entry);
    
    const logDuration = Date.now() - startLogTime;
    
    if (saved && saved.id) {
      console.log('✅ logRequest completed successfully:', {
        type,
        invoiceNo: invoiceNo || 'null',
        entryId: saved.id,
        duration: `${logDuration}ms`,
        timestamp: new Date().toISOString()
      });
    } else {
      console.warn('⚠️ logRequest completed but saveLog returned no ID:', {
        type,
        invoiceNo: invoiceNo || 'null',
        entryId,
        saved: saved || 'null',
        duration: `${logDuration}ms`
      });
    }
    
    // Lazy cleanup - run occasionally (1% chance per request)
    // Don't await this - it's background maintenance
    if (Math.random() < 0.01) {
      cleanupOldLogs().catch(err => console.error('Log cleanup error:', err));
    }
    
    return saved || entry;
  } catch (error) {
    const logDuration = Date.now() - startLogTime;
    console.error('❌ logRequest failed:', {
      type,
      invoiceNo: invoiceNo || 'null',
      entryId,
      error: error.message,
      stack: error.stack,
      duration: `${logDuration}ms`,
      timestamp: new Date().toISOString()
    });
    return null;
  }
}

/**
 * Log an outgoing callback
 */
export async function logCallback(invoiceNo, callbackUrl, payload, result) {
  return logRequest('callback', invoiceNo, {
    method: 'POST',
    path: callbackUrl,
    body: payload,
    direction: 'outgoing'
  }, {
    status: result.status,
    body: result.success ? { success: true } : { error: result.error },
    duration: result.responseTime
  });
}

/**
 * Get logs with optional filters
 * @param {object} filters - { type, invoiceNo, limit }
 */
export async function getRequestLogs(filters = {}) {
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;
  
  // Use paginated getLogs for efficiency (fetches only what we need)
  const { logs } = await getLogs({ offset, limit, reverse: true });
  
  let filtered = logs;
  
  if (filters.type) {
    filtered = filtered.filter(log => log.type === filters.type);
  }
  
  if (filters.invoiceNo) {
    filtered = filtered.filter(log => log.invoiceNo === filters.invoiceNo);
  }
  
  // Already sorted by getLogs with reverse=true
  return filtered;
}

/**
 * Get TTL days from config
 */
export async function getLogTTLDays() {
  try {
    const config = await getSimulationConfig();
    return config.logTTLDays || DEFAULT_TTL_DAYS;
  } catch {
    return DEFAULT_TTL_DAYS;
  }
}

/**
 * Sanitize request object for logging
 */
function sanitizeRequest(request) {
  if (!request) return null;
  
  return {
    method: request.method || 'UNKNOWN',
    path: request.path || request.url || '',
    headers: sanitizeHeaders(request.headers),
    body: truncateBody(request.body),
    direction: request.direction || 'incoming'
  };
}

/**
 * Sanitize response object for logging
 */
function sanitizeResponse(response) {
  if (!response) return null;
  
  return {
    status: response.status || response.statusCode || 0,
    body: truncateBody(response.body),
    duration: response.duration || 0
  };
}

/**
 * Remove sensitive headers
 */
function sanitizeHeaders(headers) {
  if (!headers) return {};
  
  const sanitized = { ...headers };
  
  // Remove sensitive headers
  const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'api-key'];
  for (const header of sensitiveHeaders) {
    if (sanitized[header]) {
      sanitized[header] = '[REDACTED]';
    }
    if (sanitized[header.toLowerCase()]) {
      sanitized[header.toLowerCase()] = '[REDACTED]';
    }
  }
  
  return sanitized;
}

/**
 * Truncate body if too large
 */
function truncateBody(body) {
  if (!body) return null;
  
  try {
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    
    if (str.length > MAX_BODY_SIZE) {
      return {
        _truncated: true,
        _originalSize: str.length,
        preview: str.slice(0, 1000) + '...'
      };
    }
    
    return typeof body === 'string' ? body : JSON.parse(str);
  } catch {
    return { _error: 'Failed to serialize body' };
  }
}
