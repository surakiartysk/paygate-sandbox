/**
 * Rate Limiting
 *
 * The provider APIs are deliberately unauthenticated — that is what makes the
 * sandbox usable as a drop-in replacement for a real gateway in tests. On a
 * public deployment that also means anyone can create records in it, so
 * requests are capped per client IP.
 *
 * The counter is process-local. On serverless that means the limit applies per
 * warm instance rather than globally, which is the right trade-off here: it
 * costs no storage round-trip on the hot path and still stops the runaway
 * script or crawler this is meant to stop. It is not a defence against a
 * distributed attacker, and does not pretend to be.
 *
 * What it counts *per* is the part that has to be right — see `getClientKey`.
 * A limit keyed on something the caller chooses is not a limit.
 */

/** Window length. */
const WINDOW_MS = 60 * 1000;

/** Requests permitted per IP per window. */
const DEFAULT_MAX_REQUESTS = 60;

/** @type {Map<string, { count: number, resetAt: number }>} */
const buckets = new Map();

/**
 * Identify the client a request came from.
 *
 * `X-Forwarded-For` is a header the *client* sends. Keying the bucket on it
 * meant a caller could hand itself a fresh allowance on every request by
 * changing one string: with the cap at five, eight requests carrying eight
 * different values all succeeded. That is not the "distributed attacker" this
 * module and docs/deployment.md both scope out — it is one client with one
 * header, which is exactly the runaway script the limit exists to stop.
 *
 * So the socket address is the default, and the header is trusted only when a
 * deployment says it should be. The asymmetry is the reason: trusting the
 * header where nothing overwrites it removes the limit entirely, while
 * refusing to trust it only groups everyone behind a shared proxy into one
 * bucket — too strict rather than absent.
 *
 * Behind a proxy the header is the only way to tell clients apart, so set
 * `TRUST_PROXY=true` there. Whether a given platform lets a client prepend to
 * the header it sets is that platform's business, and not something this code
 * can check; opting in is a statement that you know what sits in front.
 *
 * @param {object} request - Incoming request
 * @returns {string} Client identifier
 */
export function getClientKey(request) {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = request.headers?.['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();

    const real = request.headers?.['x-real-ip'];
    if (real) return String(real).trim();
  }

  return request.socket?.remoteAddress || 'unknown';
}

/**
 * Consume one unit of a client's allowance.
 *
 * @param {object} request - Incoming request
 * @param {number} [maxRequests] - Override the per-window cap
 * @returns {{ allowed: boolean, remaining: number, resetAt: number, retryAfter: number }}
 */
export function consume(request, maxRequests = getMaxRequests()) {
  const now = Date.now();
  const key = getClientKey(request);

  // Opportunistic sweep; the map only ever holds active clients.
  if (buckets.size > 5000) {
    for (const [k, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(k);
    }
  }

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }

  bucket.count += 1;

  const allowed = bucket.count <= maxRequests;
  return {
    allowed,
    remaining: Math.max(0, maxRequests - bucket.count),
    resetAt: bucket.resetAt,
    retryAfter: Math.ceil((bucket.resetAt - now) / 1000)
  };
}

/**
 * Read the configured cap. Set RATE_LIMIT_MAX to 0 to disable limiting, which
 * is the sensible default for a local instance.
 *
 * @returns {number} Requests permitted per window
 */
function getMaxRequests() {
  const configured = Number(process.env.RATE_LIMIT_MAX);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MAX_REQUESTS;
}

/**
 * Apply rate limiting to a request, writing the 429 response when exceeded.
 *
 * @param {object} request - Incoming request
 * @param {object} response - Response to write to when blocked
 * @param {number} [maxRequests] - Override the per-window cap for this route
 * @returns {boolean} True when the caller should stop handling the request
 */
export function enforceRateLimit(request, response, maxRequests) {
  const configured = getMaxRequests();
  if (configured === 0) return false; // Limiting disabled.

  // A route-specific cap still honours the global disable switch above.
  const max = maxRequests ?? configured;

  const result = consume(request, max);

  response.setHeader?.('X-RateLimit-Limit', String(max));
  response.setHeader?.('X-RateLimit-Remaining', String(result.remaining));

  if (!result.allowed) {
    response.setHeader?.('Retry-After', String(result.retryAfter));
    response.status(429).json({
      error: 'Too many requests',
      message: `Rate limit of ${max} requests per minute exceeded. Retry in ${result.retryAfter}s.`,
      retryAfter: result.retryAfter
    });
    return true;
  }

  return false;
}

/**
 * Reset all counters. Test-only.
 */
export function resetRateLimits() {
  buckets.clear();
}
