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

/** Share of log writes that also trim the log index back to MAX_TOTAL_LOGS. */
const LOG_TRIM_CHANCE = 1 / 20;

/**
 * How long a payment is kept, counted from the first time it is saved.
 *
 * The provider APIs are unauthenticated on purpose, so anyone can create a
 * payment, and every payment used to be kept for ever. The public routes that
 * read payments back then had more to read on every request, for as long as
 * the instance lived. A week covers any integration test worth running against
 * a sandbox; a payment needed for longer can be created again.
 */
const DEFAULT_PAYMENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Keys fetched per KV round trip when reading every payment. */
const MGET_CHUNK = 200;

/**
 * Set once every payment's references are in the `payref:` index, so a lookup
 * that misses can stop there instead of reading every payment to be sure.
 */
const REFS_INDEXED_FLAG = 'payments:refsIndexed';

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
let useKV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

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

/**
 * Point this module at a KV client other than the one the environment names.
 *
 * For tests only. The suite never talks to a real store, and without this the
 * KV half of every function here — the half production runs — would go
 * untested.
 *
 * @param {object} client - Something with the @vercel/kv methods used here
 */
export function useKvClientForTests(client) {
  kvClient = client;
  useKV = true;
}

// ============================================================================
// Payment Retention
// ============================================================================

/**
 * @returns {number} Seconds a new payment is kept. Configurable so a test can
 *   watch one expire.
 */
function paymentTTLSeconds() {
  const configured = Number(process.env.PAYMENT_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PAYMENT_TTL_SECONDS;
}

/**
 * When the store may drop a payment, or null for one it keeps.
 *
 * `purgeAt` is set on every payment saved since retention existed. A demo
 * visitor's payment saved before then has only `demoExpiresAt`, which means
 * the same thing; a payment that has neither predates both and is kept.
 *
 * @param {Record<string, any>} payment - Payment record
 * @returns {number|null} Time in ms
 */
function paymentDeadline(payment) {
  const deadline = Date.parse(payment?.purgeAt ?? payment?.demoExpiresAt ?? '');
  return Number.isFinite(deadline) ? deadline : null;
}

/**
 * @param {Record<string, any>} payment - Payment record
 * @param {number} [now] - Time in ms
 * @returns {boolean} Whether the payment is past its deadline
 */
function isPastDeadline(payment, now = Date.now()) {
  const deadline = paymentDeadline(payment);
  return deadline !== null && deadline <= now;
}

/**
 * The `ex` option that makes KV drop a key at the payment's deadline.
 * @param {Record<string, any>} payment - Payment record
 * @returns {{ ex: number }|undefined} Undefined for a payment that is kept
 */
function expiryOption(payment) {
  const deadline = paymentDeadline(payment);
  if (deadline === null) return undefined;
  return { ex: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) };
}

/**
 * The values a public route looks a payment up by, other than its invoice
 * number: the 2C2P payment token and the Omise charge id.
 * @param {Record<string, any>} payment - Payment record
 * @returns {string[]} References
 */
function refsOf(payment) {
  return [payment.paymentToken, payment.omiseChargeId].filter(ref => typeof ref === 'string' && ref);
}

/**
 * Bring a stored record to the shape every reader expects.
 *
 * The invoice number is made a string because it once was not always one:
 * the public API took `"invoiceNo": 12345` as given, and a number where the
 * dashboard expects a string stopped the whole Payments tab rendering. The
 * API refuses that now; this covers what was stored before it did.
 *
 * @param {Record<string, any>} payment - Payment record, modified in place
 * @returns {Record<string, any>} The same record
 */
function normalisePayment(payment) {
  // A payment with no provider recorded is a 2C2P one
  if (!payment.provider) payment.provider = '2c2p';
  if (typeof payment.invoiceNo !== 'string') payment.invoiceNo = String(payment.invoiceNo);
  return payment;
}

/**
 * @param {unknown} data - A value read from KV, which may arrive parsed
 * @returns {Record<string, any>|null} The record, or null when unreadable
 */
function parseStored(data) {
  if (!data) return null;
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ============================================================================
// Local JSON Storage Helpers
// ============================================================================

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Read the local payment store, leaving out payments past their deadline —
 * the local counterpart of KV dropping the key. What is left out is gone for
 * good at the next write.
 * @returns {{ payments: Object, paymentsList: string[] }}
 */
function readLocalPayments() {
  ensureDataDir();
  if (!existsSync(PAYMENTS_FILE)) {
    return { payments: {}, paymentsList: [] };
  }
  try {
    const data = JSON.parse(readFileSync(PAYMENTS_FILE, 'utf-8'));
    const now = Date.now();
    for (const [invoiceNo, payment] of Object.entries(data.payments)) {
      if (isPastDeadline(payment, now)) delete data.payments[invoiceNo];
    }
    data.paymentsList = data.paymentsList.filter(id => Object.hasOwn(data.payments, id));
    return data;
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
 * Save a payment record.
 *
 * A payment saved without a deadline is given one, a retention period from
 * now, and keeps it through every later save — the window is absolute, for
 * the reason `inspectorTTLRemaining` gives. One already past its deadline is
 * not written at all, rather than brought back.
 *
 * @param {Object} payment - Payment data with invoiceNo
 * @returns {Promise<Object>} The record as saved
 */
export async function savePayment(payment) {
  const record = paymentDeadline(payment) === null
    ? { ...payment, purgeAt: new Date(Date.now() + paymentTTLSeconds() * 1000).toISOString() }
    : payment;
  if (isPastDeadline(record)) return record;

  const { invoiceNo } = record;

  if (useKV) {
    try {
      const expiry = expiryOption(record);
      await Promise.all([
        kvClient.set(`payment:${invoiceNo}`, JSON.stringify(record), expiry),
        kvClient.sadd('payments:list', invoiceNo),
        ...refsOf(record).map(ref => kvClient.set(`payref:${ref}`, JSON.stringify({ invoiceNo }), expiry))
      ]);
    } catch (error) {
      console.error('Failed to save payment to KV:', error);
      throw error;
    }
  } else {
    const data = readLocalPayments();
    data.payments[invoiceNo] = record;
    if (!data.paymentsList.includes(invoiceNo)) {
      data.paymentsList.push(invoiceNo);
    }
    writeLocalPayments(data);
  }

  return record;
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
      payment = parseStored(await kvClient.get(`payment:${invoiceNo}`));
    } catch (error) {
      console.error('Failed to get payment from KV:', error);
      return null;
    }
    // KV drops a payment at its deadline; one saved before deadlines were
    // passed to KV is still there, and is treated as gone all the same.
    if (payment && isPastDeadline(payment)) payment = null;
  } else {
    const data = readLocalPayments();
    payment = Object.hasOwn(data.payments, invoiceNo) ? data.payments[invoiceNo] : null;
  }
  
  return payment ? normalisePayment(payment) : null;
}

/**
 * Find a payment by one of its references, without reading every payment.
 *
 * The 2C2P payment page and the Omise charge route look a payment up by
 * something other than its key, and both are public. They used to read every
 * payment and search the result, so each request cost one KV read per payment
 * the instance held — and anyone could add to that number.
 *
 * KV now holds a `payref:` key per reference, written beside the payment and
 * dropped with it. Payments saved before that index existed are added to it
 * once, by the first lookup that misses; after that a miss is an answer.
 *
 * @param {string} ref - Payment token or Omise charge id
 * @param {(payment: Object) => boolean} matches - Whether a payment is the one
 * @returns {Promise<Object|null>} Payment record or null
 */
async function findPaymentByRef(ref, matches) {
  if (typeof ref !== 'string' || !ref) return null;
  if (!useKV) return (await getAllPayments()).find(matches) || null;

  const indexed = parseStored(await kvClient.get(`payref:${ref}`));
  if (indexed?.invoiceNo !== undefined) {
    const payment = await getPayment(String(indexed.invoiceNo));
    return payment && matches(payment) ? payment : null;
  }

  if (await kvClient.get(REFS_INDEXED_FLAG)) return null;

  const payments = await getAllPayments();
  const writes = payments.flatMap(payment => refsOf(payment).map(r =>
    () => kvClient.set(`payref:${r}`, JSON.stringify({ invoiceNo: payment.invoiceNo }), expiryOption(payment))));
  // In batches, so a store of thousands is not thousands of requests at once.
  for (let i = 0; i < writes.length; i += MGET_CHUNK) {
    await Promise.all(writes.slice(i, i + MGET_CHUNK).map(write => write()));
  }
  await kvClient.set(REFS_INDEXED_FLAG, '1');
  return payments.find(matches) || null;
}

/**
 * Get a payment by token
 * @param {string} token - Payment token
 * @returns {Promise<Object|null>} Payment record or null
 */
export async function getPaymentByToken(token) {
  return findPaymentByRef(token, p => p.paymentToken === token);
}

/**
 * Get an Omise payment by its charge id, or by its invoice number — the
 * charge routes accept either.
 * @param {string} chargeId - Charge id or invoice number
 * @returns {Promise<Object|null>} Payment record or null
 */
export async function getOmiseCharge(chargeId) {
  if (typeof chargeId !== 'string' || !chargeId) return null;
  const byInvoice = await getPayment(chargeId);
  if (byInvoice?.provider === 'omise') return byInvoice;
  return findPaymentByRef(chargeId, p => p.provider === 'omise' && p.omiseChargeId === chargeId);
}

/**
 * Get all payments.
 *
 * On KV the records are fetched `MGET_CHUNK` to a request rather than one
 * request each. Members of the list whose payment KV has dropped are removed
 * from it here, and so are payments past their deadline that KV was never
 * told to drop — there is no scheduler to do either, and this is the read
 * that would otherwise keep paying for them.
 *
 * @returns {Promise<Array>} Array of payment records
 */
export async function getAllPayments() {
  let payments = [];
  
  if (useKV) {
    try {
      const invoiceNos = ((await kvClient.smembers('payments:list')) || []).map(String);
      const chunks = [];
      for (let i = 0; i < invoiceNos.length; i += MGET_CHUNK) chunks.push(invoiceNos.slice(i, i + MGET_CHUNK));
      const values = (await Promise.all(chunks.map(chunk =>
        kvClient.mget(...chunk.map(id => `payment:${id}`))))).flat();

      const now = Date.now();
      const gone = [];
      const expired = [];
      invoiceNos.forEach((invoiceNo, i) => {
        const payment = parseStored(values[i]);
        if (!payment) gone.push(invoiceNo);
        else if (isPastDeadline(payment, now)) expired.push(invoiceNo);
        else payments.push(payment);
      });

      if (gone.length || expired.length) {
        await Promise.all([
          kvClient.srem('payments:list', ...gone, ...expired),
          ...(expired.length ? [kvClient.del(...expired.map(id => `payment:${id}`))] : [])
        ]).catch(error => console.error('Failed to prune payments:', error.message));
      }
    } catch (error) {
      console.error('Failed to get all payments from KV:', error);
      return [];
    }
  } else {
    const data = readLocalPayments();
    payments = Object.values(data.payments);
  }
  
  return payments.map(normalisePayment);
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
 * Append one entry to a payment's callback history.
 *
 * This exists as its own function because the read-modify-write it performs
 * has to be as short as the backend allows, and the caller is the wrong place
 * to decide that. Doing it through `getPayment` then `updatePayment` spans two
 * awaits, and a caller that read the payment earlier — before sending the
 * callback over the network — spans the whole outbound request. Concurrent
 * callbacks on one invoice then overwrite each other's history: six delivered,
 * three recorded, and the API answering success to all six.
 *
 * On the local store this is genuinely atomic. `readLocalPayments` and
 * `writeLocalPayments` are synchronous, so with no await between them nothing
 * else runs in the interval — an interleave has nowhere to happen.
 *
 * On KV it is not, and cannot be made so here: this client has no
 * compare-and-set, and a serverless deployment can run two instances that
 * share nothing but the store. The window is reduced to two adjacent calls
 * instead of a network round trip, which is the whole of the improvement.
 * Saying that is better than implying the problem is gone.
 *
 * @param {string} invoiceNo - Invoice number
 * @param {Object} entry - History entry to append
 * @returns {Promise<number|null>} New history length, or null when absent
 */
export async function appendCallbackHistory(invoiceNo, entry) {
  if (useKV) {
    const payment = await getPayment(invoiceNo);
    if (!payment) return null;

    const callbackHistory = [...(payment.callbackHistory || []), entry];
    await savePayment({ ...payment, callbackHistory, callbackCount: callbackHistory.length });
    return callbackHistory.length;
  }

  const data = readLocalPayments();
  const payment = data.payments[invoiceNo];
  if (!payment) return null;

  const callbackHistory = [...(payment.callbackHistory || []), entry];
  data.payments[invoiceNo] = {
    ...payment,
    callbackHistory,
    callbackCount: callbackHistory.length
  };
  writeLocalPayments(data);
  return callbackHistory.length;
}

/**
 * Delete a payment
 * @param {string} invoiceNo - Invoice number
 * @returns {Promise<boolean>} Success status
 */
export async function deletePayment(invoiceNo) {
  if (useKV) {
    try {
      const payment = parseStored(await kvClient.get(`payment:${invoiceNo}`));
      await Promise.all([
        kvClient.del(`payment:${invoiceNo}`, ...(payment ? refsOf(payment) : []).map(ref => `payref:${ref}`)),
        kvClient.srem('payments:list', invoiceNo)
      ]);
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
    const payments = await getAllPayments();
    const keys = payments.flatMap(p => [`payment:${p.invoiceNo}`, ...refsOf(p).map(ref => `payref:${ref}`)]);
    for (let i = 0; i < keys.length; i += MGET_CHUNK) await kvClient.del(...keys.slice(i, i + MGET_CHUNK));
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

      // The entry and its place in the index in one round trip, and nothing
      // else on the way back to the caller. Every provider route awaits this
      // before it answers, and it used to be four calls one after another —
      // set, zadd, a zscore to check the zadd, a zcard to decide on cleanup.
      // On the deployed instance an answer refused before any other work
      // still took 1.3 to 2 seconds, and these calls were most of what it did.
      const [saved, indexed] = await Promise.allSettled([
        kvClient.set(key, JSON.stringify(entry), { ex: ttlSeconds }),
        kvClient.zadd('logs:list', { score: timestamp, member: key })
      ]);
      if (saved.status === 'rejected') throw saved.reason;
      if (indexed.status === 'rejected') console.error('Failed to index log:', indexed.reason?.message);

      // The index is trimmed now and then rather than checked every time, so
      // it can run a few entries over MAX_TOTAL_LOGS between trims. Each entry
      // expires on its own TTL either way.
      if (Math.random() < LOG_TRIM_CHANCE) {
        trimLogIndex().catch(error => console.error('Failed to trim logs:', error.message));
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
 * Drop the oldest logs past MAX_TOTAL_LOGS, entries and index members both.
 * @returns {Promise<number>} Logs dropped
 */
export async function trimLogIndex() {
  const size = (await kvClient.zcard('logs:list')) || 0;
  if (size <= MAX_TOTAL_LOGS) return 0;
  const oldest = await kvClient.zrange('logs:list', 0, size - MAX_TOTAL_LOGS - 1);
  if (!oldest?.length) return 0;
  await Promise.all([kvClient.del(...oldest), kvClient.zrem('logs:list', ...oldest)]);
  return oldest.length;
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

// ============================================================================
// Demo Visitors
// ============================================================================

const DEMO_VISITORS_FILE = join(DATA_DIR, 'demo-visitors.json');

/** KV sorted set of visitors, scored by when each expires. */
const DEMO_VISITORS_INDEX = 'demo:visitors';

/**
 * Read the local demo-visitor store, dropping visitors past `expiresAt`.
 * @returns {Object} Visitors keyed by the hash of their token
 */
function readLocalDemoVisitors() {
  ensureDataDir();
  if (!existsSync(DEMO_VISITORS_FILE)) return {};
  try {
    const visitors = JSON.parse(readFileSync(DEMO_VISITORS_FILE, 'utf-8'));
    const now = Date.now();
    const live = {};
    for (const [key, visitor] of Object.entries(visitors)) {
      if (Date.parse(visitor.expiresAt) > now) live[key] = visitor;
    }
    return live;
  } catch {
    return {};
  }
}

/**
 * Read one demo visitor.
 *
 * Keyed by a hash of the visitor's token rather than the token itself, so
 * reading the store does not hand out working credentials.
 *
 * @param {string} tokenHash - sha256 of the visitor's token, hex
 * @returns {Promise<Object|null>} Visitor, or null when absent
 */
export async function getDemoVisitor(tokenHash) {
  if (useKV) {
    try {
      const data = await kvClient.get(`demo:${tokenHash}`);
      if (!data) return null;
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (error) {
      console.error('Failed to read demo visitor:', error);
      return null;
    }
  }
  return readLocalDemoVisitors()[tokenHash] || null;
}

/**
 * Persist one demo visitor until its `expiresAt`.
 *
 * The TTL is absolute, from the visitor's own `expiresAt`, for the reason
 * `inspectorTTLRemaining` gives: a sliding window would let the KV path keep
 * what the local path drops.
 *
 * @param {string} tokenHash - sha256 of the visitor's token, hex
 * @param {Object} visitor - Visitor record, with an ISO `expiresAt`
 */
export async function saveDemoVisitor(tokenHash, visitor) {
  if (useKV) {
    const ttl = Math.floor((Date.parse(visitor.expiresAt) - Date.now()) / 1000);
    if (!(ttl > 0)) return;
    await Promise.all([
      kvClient.set(`demo:${tokenHash}`, JSON.stringify(visitor), { ex: ttl }),
      kvClient.zadd(DEMO_VISITORS_INDEX, { score: Date.parse(visitor.expiresAt), member: tokenHash })
    ]);
    return;
  }
  const visitors = readLocalDemoVisitors();
  visitors[tokenHash] = visitor;
  ensureDataDir();
  writeFileSync(DEMO_VISITORS_FILE, JSON.stringify(visitors, null, 2));
}

/**
 * How many demo visitors are live.
 *
 * Counted from an index of visitors rather than from their payments, because
 * the count is taken on every demo sign-in and counting payments meant reading
 * all of them — every visitor's and every caller's — to answer a question
 * about a few hundred. On KV the index is a sorted set scored by expiry, so
 * the expired end is cut off and what is left is the answer.
 *
 * Visitors signed in before the index existed are not in it. They expire
 * within a day of it existing, so the count is low by at most that for at
 * most that long.
 *
 * @returns {Promise<number>} Live visitors
 */
export async function countLiveDemoVisitors() {
  if (useKV) {
    await kvClient.zremrangebyscore(DEMO_VISITORS_INDEX, 0, Date.now());
    return (await kvClient.zcard(DEMO_VISITORS_INDEX)) || 0;
  }
  return Object.keys(readLocalDemoVisitors()).length;
}
