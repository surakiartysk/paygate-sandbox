/**
 * URL Utilities
 *
 * Config-driven rewriting of callback / return URLs.
 *
 * A payload copied out of a live system to reproduce a bug still points at
 * live hosts, and firing a callback at one while testing is exactly the kind
 * of accident this sandbox exists to prevent. The rewrite rules below map those
 * hosts onto their staging equivalents automatically.
 *
 * Rules come from the URL_REWRITE_RULES environment variable, so no real
 * hostname is ever committed to this repository. Format is a comma-separated
 * list of `from=>to` host pairs:
 *
 *   URL_REWRITE_RULES=api.example.com=>staging-api.example.com,example.com=>staging.example.com
 *
 * Matching is host-only and exact (case-insensitive). Path, query string and
 * port are preserved. When the variable is unset — as it is on the public demo
 * — every URL passes through untouched.
 */

/** @typedef {{ from: string, to: string }} RewriteRule */

/** @type {RewriteRule[] | null} */
let cachedRules = null;
/** @type {string | undefined} */
let cachedSource;

/**
 * Parse the URL_REWRITE_RULES environment variable into rules.
 * Malformed entries are skipped with a warning rather than throwing, so a typo
 * in configuration can never take the sandbox down.
 *
 * @param {string | undefined} raw - Raw environment variable value
 * @returns {RewriteRule[]} Parsed rules
 */
export function parseRewriteRules(raw) {
  if (!raw) return [];

  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [from, to] = entry.split('=>').map(part => part?.trim().toLowerCase());
      if (!from || !to) {
        console.warn(`[urlUtils] Ignoring malformed rewrite rule: "${entry}" (expected "from=>to")`);
        return null;
      }
      return { from, to };
    })
    .filter(Boolean);
}

/**
 * Get the active rewrite rules, re-parsing when the environment changes.
 * @returns {RewriteRule[]} Active rules
 */
function getRules() {
  const source = process.env.URL_REWRITE_RULES;
  if (cachedRules === null || source !== cachedSource) {
    cachedSource = source;
    cachedRules = parseRewriteRules(source);
  }
  return cachedRules;
}

/**
 * Apply configured host rewrites to a URL.
 *
 * @param {string} url - URL to process
 * @returns {string} Rewritten URL, or the original when no rule matches
 */
export function rewriteUrl(url) {
  if (!url) return url;

  const rules = getRules();
  if (rules.length === 0) return url;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL (relative path, template placeholder, …) — leave it alone.
    return url;
  }

  const rule = rules.find(r => r.from === parsed.hostname.toLowerCase());
  if (!rule) return url;

  parsed.hostname = rule.to;
  return parsed.toString();
}

/**
 * The origin a caller should use to reach this sandbox: MOCK_SERVER_URL when it
 * is set, otherwise inferred from the request.
 *
 * @param {object} [request] - Incoming request, used to infer the origin
 * @returns {string} Origin with no trailing slash
 */
export function publicOrigin(request) {
  const configured = process.env.MOCK_SERVER_URL;
  if (configured) return configured.replace(/\/$/, '');

  const host = request?.headers?.host || 'localhost:3000';
  const forwardedProto = request?.headers?.['x-forwarded-proto'];
  // Local hosts are served over plain HTTP; anything else (a real deployment
  // behind a proxy that did not set x-forwarded-proto) is assumed to be HTTPS.
  const hostname = host.split(':')[0];
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    || hostname.endsWith('.localhost');
  const proto = forwardedProto || (isLocal ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * Where a pending Omise charge sends the payer: this sandbox's own payment
 * page, for a card charge (3-D Secure) and a redirect source alike. Null once
 * the charge is no longer pending, as in the Omise API.
 *
 * The origin recorded when the charge was created wins over the request's:
 * a webhook is built with no request at all, and without the record it would
 * fall back to localhost on a deployment that leaves MOCK_SERVER_URL unset.
 *
 * @param {object} payment - Stored payment
 * @param {object} [request] - Incoming request, used to infer the origin
 * @returns {string|null}
 */
export function omiseAuthorizeUri(payment, request) {
  const redirects = payment.omiseCard || payment.omiseSource;
  if (payment.status !== 'pending' || !redirects || !payment.paymentToken) return null;
  const origin = payment.origin || publicOrigin(request);
  return `${origin}/mock-pay/${encodeURIComponent(payment.paymentToken)}`;
}
