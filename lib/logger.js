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
 * @param {string} type - Log type. The ones actually produced are 'token',
 *   'payment', 'inquiry', 'omise-charge-get' and 'callback'. Admin routes are
 *   deliberately not logged: the log is a record of what an integrator's code
 *   did, and the dashboard driving it would drown that out.
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
 * Header names that always carry a credential.
 *
 * `x-admin-password` was not on this list, and it is the one credential this
 * application actually defines. Sending it to any logged route stored it in
 * plaintext beside a neatly redacted `authorization` — a request carrying both
 * logged `"authorization": "[REDACTED]"` and `"x-admin-password": "mockpay"`.
 * The redaction was not broken; it had simply never been told about the secret
 * this sandbox uses.
 */
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-api-key', 'api-key', 'x-admin-password'];

/**
 * Names that look like a credential even though nobody listed them.
 *
 * A four-name denylist was wrong the moment a fifth header existed, and the
 * next one will be wrong the same way. This catches the shape instead: the
 * list above stays for the names that do not contain any of these words.
 *
 * It over-matches on purpose. A header genuinely called `x-token-count` is
 * redacted and someone loses a number from a log; the other error publishes a
 * secret with a seven-day TTL into a store the dashboard renders. Those are
 * not comparable, so the check leans to the harmless side.
 */
const SENSITIVE_PATTERN = /(password|secret|token|api[-_]?key|auth|credential|signature)/i;

/**
 * Remove sensitive headers.
 *
 * Matching is case-insensitive on the name. Node lowercases the headers it
 * parses, so incoming requests were fine, but headers this application builds
 * for outbound callbacks are written in their conventional casing
 * (`Content-Type`, `User-Agent`) — and the previous version compared a
 * lowercase list against whatever key it was given, twice, which is the same
 * comparison written out two ways rather than two comparisons.
 *
 * Exported for its own tests. Node lowercases the headers it parses, and
 * `logCallback` passes no headers at all, so no request a test can send
 * exercises the casing. Untested insurance is the kind that quietly stops
 * working, so it is pinned directly rather than hoped for.
 *
 * @param {object} headers - Headers to sanitise
 * @returns {object} A copy with credential-bearing values replaced
 */
export function sanitizeHeaders(headers) {
  if (!headers) return {};
  
  const sanitized = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const sensitive = SENSITIVE_HEADERS.includes(lower) || SENSITIVE_PATTERN.test(lower);
    sanitized[name] = sensitive ? '[REDACTED]' : value;
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
