/**
 * The headers vercel.json adds to a path, for anything that is not Vercel.
 *
 * Deployed, Vercel applies the `headers` rules itself. Locally, the dev server
 * used to write its own copy of the CORS headers into every preflight, and the
 * two drifted: the copy granted every origin `X-Admin-Password` on every path.
 * Reading the rules from the file Vercel reads keeps the dev server, and the
 * tests that run against it, answering exactly as a deployment does.
 *
 * A `source` is read as a regular expression anchored at both ends. That is
 * all the patterns in vercel.json need — `(.*)`, an alternation and a
 * negative lookahead — and a pattern using path-to-regexp's `:name` syntax
 * would not match here, so add one only with a test that shows it does.
 */

import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

/**
 * @param {string} pathname - The request path, without the query string
 * @param {Array<{ source: string, headers: Array<{ key: string, value: string }> }>} [rules]
 * @returns {Record<string, string>}
 */
export function headersFor(pathname, rules = config.headers) {
  const result = {};
  for (const rule of rules) {
    if (!new RegExp(`^${rule.source}$`).test(pathname)) continue;
    for (const { key, value } of rule.headers) result[key] = value;
  }
  return result;
}
