/**
 * Storage Adapter
 * 
 * Provides a unified storage interface that works with:
 * - Vercel KV (Redis) in production
 * - Local JSON files in development
 * 
 * @module storage
 */

import { createClient } from '@vercel/kv';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ============================================================================
// Configuration
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR is overridable so a test run can point at a throwaway directory
// instead of the working data/ files.
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
const PAYMENTS_FILE = join(DATA_DIR, 'payments.json');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const LOGS_FILE = join(DATA_DIR, 'logs.json');

/** Default TTL for logs in days */
const DEFAULT_LOG_TTL_DAYS = 7;

/** Maximum logs per payment query */
const MAX_LOGS_PER_PAYMENT = 50;

/** Maximum total logs to store */
const MAX_TOTAL_LOGS = 500;

/** Default configuration */
const DEFAULT_CONFIG = {
  globalDelay: 0,
  forceError2c2p: null,
  forceErrorOmise: null,
  duplicateCallback: false,
  failureRate: 0,
  logTTLDays: DEFAULT_LOG_TTL_DAYS,
  customFieldPresets: [],
};

// ============================================================================
// Initialization
// ============================================================================

// Check if we're using Vercel KV
const useKV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

// Suppress url.parse() deprecation warnings from @vercel/kv dependency
if (typeof process !== 'undefined' && process.on) {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function(warning, type, code, ...args) {
    if (code === 'DEP0169' || (typeof warning === 'string' && warning.includes('url.parse()'))) {
      return;
    }
    return originalEmitWarning.call(process, warning, type, code, ...args);
  };
}

let kvClient = null;
if (useKV) {
  kvClient = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

// ============================================================================
// Local JSON Storage Helpers
// ============================================================================

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readLocalPayments() {
  ensureDataDir();
  if (!existsSync(PAYMENTS_FILE)) {
    return { payments: {}, paymentsList: [] };
  }
  try {
    return JSON.parse(readFileSync(PAYMENTS_FILE, 'utf-8'));
  } catch {
    return { payments: {}, paymentsList: [] };
  }
}

function writeLocalPayments(data) {
  ensureDataDir();
  writeFileSync(PAYMENTS_FILE, JSON.stringify(data, null, 2));
}

function readLocalConfig() {
  ensureDataDir();
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    // Migrate old forceError to forceError2c2p
    if (config.forceError !== undefined && config.forceError2c2p === undefined) {
      config.forceError2c2p = config.forceError;
      delete config.forceError;
    }
    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeLocalConfig(config) {
  ensureDataDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function readLocalLogs() {
  ensureDataDir();
  if (!existsSync(LOGS_FILE)) {
    return { logs: [] };
  }
  try {
    return JSON.parse(readFileSync(LOGS_FILE, 'utf-8'));
  } catch {
    return { logs: [] };
  }
}

function writeLocalLogs(data) {
  ensureDataDir();
  writeFileSync(LOGS_FILE, JSON.stringify(data, null, 2));
}

// ============================================================================
// Payment Storage
// ============================================================================

/**
 * Save a payment record
 * @param {Object} payment - Payment data with invoiceNo
 * @returns {Promise<void>}
 */
export async function savePayment(payment) {
  const { invoiceNo } = payment;
  
  if (useKV) {
    try {
      await kvClient.set(`payment:${invoiceNo}`, JSON.stringify(payment));
      await kvClient.sadd('payments:list', invoiceNo);
    } catch (error) {
      console.error('Failed to save payment to KV:', error);
      throw error;
    }
  } else {
    const data = readLocalPayments();
    data.payments[invoiceNo] = payment;
    if (!data.paymentsList.includes(invoiceNo)) {
      data.paymentsList.push(invoiceNo);
    }
    writeLocalPayments(data);
  }
}

/**
 * Get a payment by invoice number
 * @param {string} invoiceNo - Invoice number
 * @returns {Promise<Object|null>} Payment record or null
 */
export async function getPayment(invoiceNo) {
  let payment = null;
  
  if (useKV) {
    try {
      const data = await kvClient.get(`payment:${invoiceNo}`);
      payment = data ? (typeof data === 'string' ? JSON.parse(data) : data) : null;
    } catch (error) {
      console.error('Failed to get payment from KV:', error);
      return null;
    }
  } else {
    const data = readLocalPayments();
    payment = data.payments[invoiceNo] || null;
  }
  
  // Ensure backward compatibility: default provider to '2c2p'
  if (payment && !payment.provider) {
    payment.provider = '2c2p';
  }
  
  return payment;
}

/**
 * Get a payment by token
 * @param {string} token - Payment token
 * @returns {Promise<Object|null>} Payment record or null
 */
export async function getPaymentByToken(token) {
  const payments = await getAllPayments();
  return payments.find(p => p.paymentToken === token) || null;
}

/**
 * Get all payments
 * @returns {Promise<Array>} Array of payment records
 */
export async function getAllPayments() {
  let payments = [];
  
  if (useKV) {
    try {
      const invoiceNos = await kvClient.smembers('payments:list');
      if (invoiceNos && invoiceNos.length > 0) {
        const results = await Promise.all(
          invoiceNos.map(async (invoiceNo) => {
            try {
              const data = await kvClient.get(`payment:${invoiceNo}`);
              return data ? (typeof data === 'string' ? JSON.parse(data) : data) : null;
            } catch {
              return null;
            }
          })
        );
        payments = results.filter(Boolean);
      }
    } catch (error) {
      console.error('Failed to get all payments from KV:', error);
      return [];
    }
  } else {
    const data = readLocalPayments();
    payments = Object.values(data.payments);
  }
  
  // Ensure backward compatibility: default provider to '2c2p'
  return payments.map(payment => {
    if (!payment.provider) {
      payment.provider = '2c2p';
    }
    return payment;
  });
}

/**
 * Update a payment record
 * @param {string} invoiceNo - Invoice number
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object|null>} Updated payment or null
 */
export async function updatePayment(invoiceNo, updates) {
  try {
    const payment = await getPayment(invoiceNo);
    if (!payment) return null;
    
    const updatedPayment = { ...payment, ...updates };
    await savePayment(updatedPayment);
    return updatedPayment;
  } catch (error) {
    console.error('Failed to update payment:', error);
    return null;
  }
}

/**
 * Delete a payment
 * @param {string} invoiceNo - Invoice number
 * @returns {Promise<boolean>} Success status
 */
export async function deletePayment(invoiceNo) {
  if (useKV) {
    try {
      await kvClient.del(`payment:${invoiceNo}`);
      await kvClient.srem('payments:list', invoiceNo);
      return true;
    } catch (error) {
      console.error('Failed to delete payment from KV:', error);
      return false;
    }
  } else {
    const data = readLocalPayments();
    delete data.payments[invoiceNo];
    data.paymentsList = data.paymentsList.filter(id => id !== invoiceNo);
    writeLocalPayments(data);
    return true;
  }
}

/**
 * Clear all payments
 * @returns {Promise<void>}
 */
export async function clearAllPayments() {
  if (useKV) {
    const invoiceNos = await kvClient.smembers('payments:list');
    if (invoiceNos?.length > 0) {
      await Promise.all(invoiceNos.map(id => kvClient.del(`payment:${id}`)));
    }
    await kvClient.del('payments:list');
  } else {
    writeLocalPayments({ payments: {}, paymentsList: [] });
  }
}

// ============================================================================
// Configuration Storage
// ============================================================================

/**
 * Get simulation config
 * @returns {Promise<Object>} Configuration object
 */
export async function getConfig() {
  if (useKV) {
    try {
      const config = await kvClient.get('config:simulation');
      if (!config) return { ...DEFAULT_CONFIG };
      
      const parsed = typeof config === 'string' ? JSON.parse(config) : config;
      // Migrate old forceError field
      if (parsed.forceError !== undefined && parsed.forceError2c2p === undefined) {
        parsed.forceError2c2p = parsed.forceError;
        delete parsed.forceError;
      }
      return parsed;
    } catch (error) {
      console.error('Failed to get config from KV:', error);
      return { ...DEFAULT_CONFIG };
    }
  }
  return readLocalConfig();
}

/**
 * Update simulation config
 * @param {Object} updates - Config fields to update
 * @returns {Promise<Object>} Updated configuration
 */
export async function updateConfig(updates) {
  const currentConfig = await getConfig();
  const newConfig = { ...currentConfig, ...updates };
  
  // Migrate old field name
  if (newConfig.forceError !== undefined) {
    newConfig.forceError2c2p = newConfig.forceError;
    delete newConfig.forceError;
  }
  
  if (useKV) {
    await kvClient.set('config:simulation', JSON.stringify(newConfig));
  } else {
    writeLocalConfig(newConfig);
  }
  
  return newConfig;
}

/**
 * Alias for getConfig (used by logger)
 * @returns {Promise<Object>} Configuration object
 */
export async function getSimulationConfig() {
  return getConfig();
}

// ============================================================================
// Log Storage
// ============================================================================

/**
 * Save a log entry
 * @param {Object} entry - Log entry with id and type
 * @returns {Promise<Object>} The saved entry
 */
export async function saveLog(entry) {
  try {
    if (useKV) {
      const timestamp = Date.now();
      const key = `log:${timestamp}:${entry.id}`;
      const ttlSeconds = DEFAULT_LOG_TTL_DAYS * 24 * 60 * 60;
      
      // Save log entry with TTL
      await kvClient.set(key, JSON.stringify(entry), { ex: ttlSeconds });
      
      // Index in sorted set for efficient retrieval
      try {
        await kvClient.zadd('logs:list', { score: timestamp, member: key });
        
        // Verify indexing
        const score = await kvClient.zscore('logs:list', key);
        if (score === null) {
          console.warn('Log saved but not indexed:', { key, type: entry.type });
        }
      } catch (zaddError) {
        console.error('Failed to index log:', zaddError.message);
      }
      
      // Cleanup old logs if needed
      try {
        const size = await kvClient.zcard('logs:list');
        if (size > MAX_TOTAL_LOGS) {
          const oldKeys = await kvClient.zrange('logs:list', 0, size - MAX_TOTAL_LOGS);
          if (oldKeys?.length > 0) {
            await Promise.all([
              ...oldKeys.map(k => kvClient.del(k)),
              ...oldKeys.map(k => kvClient.zrem('logs:list', k))
            ]);
          }
        }
      } catch (cleanupError) {
        // Non-critical, continue
      }
    } else {
      const data = readLocalLogs();
      data.logs.push(entry);
      
      if (data.logs.length > MAX_TOTAL_LOGS) {
        data.logs = data.logs.slice(-MAX_TOTAL_LOGS);
      }
      
      writeLocalLogs(data);
    }
    
    return entry;
  } catch (error) {
    console.error('Failed to save log:', error.message);
    return entry; // Don't throw - logging shouldn't break the app
  }
}

/**
 * Get logs with pagination support
 * @param {Object} options - { offset, limit, reverse }
 * @returns {Promise<{logs: Array, total: number}>}
 */
export async function getLogs(options = {}) {
  const { offset = 0, limit = null, reverse = true } = options;
  
  if (useKV) {
    try {
      const total = await kvClient.zcard('logs:list') || 0;
      
      if (total === 0) {
        return { logs: [], total: 0 };
      }
      
      // Calculate range
      const start = offset;
      const stop = limit ? Math.min(total - 1, offset + limit - 1) : total - 1;
      
      // Get keys (newest first if reverse)
      let keys = [];
      try {
        keys = reverse
          ? await kvClient.zrange('logs:list', start, stop, { rev: true })
          : await kvClient.zrange('logs:list', start, stop);
      } catch (rangeError) {
        // Fallback for older Redis versions
        if (reverse) {
          const revStart = Math.max(0, total - 1 - stop);
          const revStop = Math.max(0, total - 1 - start);
          keys = await kvClient.zrange('logs:list', revStart, revStop);
          keys = keys?.reverse() || [];
        } else {
          keys = await kvClient.zrange('logs:list', start, stop);
        }
      }
      
      if (!keys?.length) {
        return { logs: [], total };
      }
      
      // Fetch log data
      const logs = await Promise.all(
        keys.map(async (key) => {
          try {
            const log = await kvClient.get(key);
            return log ? (typeof log === 'string' ? JSON.parse(log) : log) : null;
          } catch {
            return null;
          }
        })
      );
      
      return { logs: logs.filter(Boolean), total };
    } catch (error) {
      console.error('Failed to get logs:', error.message);
      return { logs: [], total: 0 };
    }
  }
  
  // Local storage
  const data = readLocalLogs();
  const allLogs = data.logs || [];
  const sortedLogs = [...allLogs].sort((a, b) => {
    const dateA = new Date(a.timestamp);
    const dateB = new Date(b.timestamp);
    return reverse ? dateB - dateA : dateA - dateB;
  });
  
  const paginated = limit 
    ? sortedLogs.slice(offset, offset + limit)
    : sortedLogs.slice(offset);
  
  return { logs: paginated, total: allLogs.length };
}

/**
 * Get all logs (backward compatibility)
 * @deprecated Use getLogs() with pagination instead
 * @returns {Promise<Array>}
 */
export async function getAllLogs() {
  const result = await getLogs({ offset: 0, limit: MAX_TOTAL_LOGS });
  return result.logs;
}

/**
 * Cleanup old logs based on TTL
 * @returns {Promise<number>} Number of deleted logs
 */
export async function cleanupOldLogs() {
  const config = await getConfig();
  const ttlDays = config.logTTLDays || DEFAULT_LOG_TTL_DAYS;
  const cutoffTime = Date.now() - (ttlDays * 24 * 60 * 60 * 1000);
  
  if (useKV) {
    const keys = await kvClient.zrange('logs:list', 0, -1);
    if (!keys?.length) return 0;
    
    let deletedCount = 0;
    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length >= 2) {
        const timestamp = parseInt(parts[1], 10);
        if (timestamp < cutoffTime) {
          await kvClient.del(key);
          await kvClient.zrem('logs:list', key);
          deletedCount++;
        }
      }
    }
    return deletedCount;
  }
  
  const data = readLocalLogs();
  const originalCount = data.logs.length;
  data.logs = data.logs.filter(log => new Date(log.timestamp).getTime() >= cutoffTime);
  writeLocalLogs(data);
  return originalCount - data.logs.length;
}

/**
 * Get logs for a specific payment
 * @param {string} invoiceNo - Invoice number
 * @returns {Promise<Array>}
 */
export async function getPaymentLogs(invoiceNo) {
  const { logs } = await getLogs({ offset: 0, limit: MAX_LOGS_PER_PAYMENT, reverse: true });
  return logs.filter(log => log.invoiceNo === invoiceNo);
}

/**
 * Clear all logs
 * @returns {Promise<void>}
 */
export async function clearAllLogs() {
  if (useKV) {
    const keys = await kvClient.zrange('logs:list', 0, -1);
    
    if (keys?.length > 0) {
      await Promise.all(
        keys
          .filter(key => key?.startsWith('log:'))
          .map(key => kvClient.del(key))
      );
    }
    
    await kvClient.del('logs:list');
  } else {
    writeLocalLogs({ logs: [] });
  }
}

/**
 * Check if using Vercel KV
 * @returns {boolean}
 */
export function isUsingKV() {
  return useKV;
}

// ============================================================================
// Inspector Sessions
// ============================================================================

/** Inspector sessions expire on their own so a shared demo never accumulates. */
const INSPECTOR_TTL_SECONDS = 24 * 60 * 60;

const INSPECTOR_FILE = join(DATA_DIR, 'inspector.json');

/**
 * Read the local inspector store, dropping expired sessions.
 * @returns {Object} Sessions keyed by id
 */
function readLocalInspector() {
  ensureDataDir();
  if (!existsSync(INSPECTOR_FILE)) return {};
  try {
    const sessions = JSON.parse(readFileSync(INSPECTOR_FILE, 'utf-8'));
    const cutoff = Date.now() - INSPECTOR_TTL_SECONDS * 1000;
    const live = {};
    for (const [id, session] of Object.entries(sessions)) {
      if (new Date(session.createdAt).getTime() >= cutoff) live[id] = session;
    }
    return live;
  } catch {
    return {};
  }
}

/**
 * Persist the local inspector store.
 * @param {Object} sessions - Sessions keyed by id
 */
function writeLocalInspector(sessions) {
  ensureDataDir();
  writeFileSync(INSPECTOR_FILE, JSON.stringify(sessions, null, 2));
}

/**
 * Read one inspector session.
 * @param {string} sessionId - Session id
 * @returns {Promise<Object|null>} Session, or null when absent/expired
 */
export async function getInspectorSession(sessionId) {
  if (useKV) {
    try {
      const data = await kvClient.get(`inspect:${sessionId}`);
      if (!data) return null;
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (error) {
      console.error('Failed to read inspector session:', error);
      return null;
    }
  }
  return readLocalInspector()[sessionId] || null;
}

/**
 * Seconds a session has left, counted from when it was created.
 *
 * The TTL is absolute rather than sliding, and the two backends have to agree
 * on that. The local store expires from `createdAt`, so a full 24 hours on
 * every KV write would have meant a session receiving a callback once a day
 * living forever on the deployed path and expiring on the dev one — while both
 * comments above promise a shared demo never accumulates. Only an absolute TTL
 * keeps that promise.
 *
 * Its cost is that a debugging session running longer than a day loses its
 * captures mid-flight, with no warning beyond an empty list. For a sandbox
 * whose sessions are minted freely and cost nothing to replace, that is the
 * cheaper side of the trade.
 *
 * Exported for its own tests: it is the only place the two backends' agreement
 * is decided, and getting it wrong fails silently — a session that outlives its
 * window looks exactly like one that has not reached it yet.
 *
 * @param {Object} session - Session payload
 * @returns {number} Whole seconds remaining, or 0 once expired
 */
export function inspectorTTLRemaining(session) {
  const createdAt = new Date(session?.createdAt ?? NaN).getTime();
  // An unreadable timestamp gets a full window rather than immediate expiry:
  // dropping a live session over a parsing problem is the worse failure.
  if (!Number.isFinite(createdAt)) return INSPECTOR_TTL_SECONDS;

  const elapsed = Math.floor((Date.now() - createdAt) / 1000);
  return Math.max(0, INSPECTOR_TTL_SECONDS - elapsed);
}

/**
 * Persist one inspector session.
 * @param {string} sessionId - Session id
 * @param {Object} session - Session payload
 */
export async function saveInspectorSession(sessionId, session) {
  if (useKV) {
    const ttl = inspectorTTLRemaining(session);
    // Already past its window — write nothing rather than resurrect it for
    // another day, which is what an unconditional `ex` would have done.
    if (ttl === 0) return;

    await kvClient.set(`inspect:${sessionId}`, JSON.stringify(session), { ex: ttl });
    return;
  }
  const sessions = readLocalInspector();
  sessions[sessionId] = session;
  writeLocalInspector(sessions);
}

/**
 * Delete one inspector session.
 * @param {string} sessionId - Session id
 */
export async function deleteInspectorSession(sessionId) {
  if (useKV) {
    await kvClient.del(`inspect:${sessionId}`);
    return;
  }
  const sessions = readLocalInspector();
  delete sessions[sessionId];
  writeLocalInspector(sessions);
}
