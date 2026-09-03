/**
 * URL Utilities
 *
 * Config-driven rewriting of callback / return URLs.
 *
 * Merchants commonly copy a payment request payload straight out of their
 * production system when reproducing a bug. That payload points at production
 * hosts, and firing a callback at production while testing is exactly the kind
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
