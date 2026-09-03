/**
 * Callback URL Guard (SSRF protection)
 *
 * This sandbox sends HTTP POSTs to a URL supplied by whoever created the
 * payment. On a public deployment that is a textbook server-side request
 * forgery primitive: an attacker could point `backendReturnUrl` at a cloud
 * metadata endpoint, an internal admin panel, or a third party's server and
 * have our infrastructure make the request for them.
 *
 * Every outbound callback therefore passes through `assertCallbackUrlAllowed`
 * before it is sent. The policy is deny-by-default on anything that is not a
 * public HTTP(S) endpoint.
 *
 * Local development needs the opposite behaviour — callbacks to
 * http://localhost:3001 are the entire point — so loopback is permitted unless
 * the deployment opts into strict mode by setting ALLOW_PRIVATE_CALLBACKS=false
 * (which the public demo does).
 *
 * Note on scope: this validates the URL, not the DNS resolution behind it. A
 * hostname that resolves to a private address (DNS rebinding) is out of scope
 * for a sandbox whose worst case is an unwanted POST; blocking it properly
 * requires resolving and pinning the address at connect time.
 */

/** Error thrown when a callback target is rejected. */
export class BlockedCallbackUrlError extends Error {
  /**
   * @param {string} message - Human-readable reason
   * @param {string} url - The rejected URL
   */
  constructor(message, url) {
    super(message);
    this.name = 'BlockedCallbackUrlError';
    this.url = url;
    this.code = 'BLOCKED_CALLBACK_URL';
  }
}

/**
 * Hostnames that must never be reached, regardless of mode.
 * These are cloud metadata services that hand out credentials to anything
 * able to make an HTTP request from inside the network.
 */
const ALWAYS_BLOCKED_HOSTS = new Set([
  '169.254.169.254',           // AWS / GCP / Azure / DigitalOcean IMDS
  'metadata.google.internal',
  'metadata.goog',
  'metadata'
]);

/**
 * Is the deployment allowed to call private/loopback addresses?
 * Defaults to true so local development works out of the box; the public
 * demo sets ALLOW_PRIVATE_CALLBACKS=false.
 *
 * @returns {boolean} True when private targets are permitted
 */
function allowPrivateTargets() {
  return process.env.ALLOW_PRIVATE_CALLBACKS !== 'false';
}

/**
 * Parse an IPv4 address into its four octets.
 * @param {string} host - Hostname to test
 * @returns {number[]|null} Octets, or null when not an IPv4 literal
 */
function parseIPv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;

  const octets = match.slice(1).map(Number);
  return octets.every(o => o >= 0 && o <= 255) ? octets : null;
}

/**
 * Does this IPv4 address belong to a private, loopback or otherwise
 * non-routable range?
 *
 * @param {number[]} octets - Four octets
 * @returns {boolean} True when the address is not publicly routable
 */
function isPrivateIPv4([a, b]) {
  if (a === 10) return true;                        // 10.0.0.0/8
  if (a === 127) return true;                       // loopback
  if (a === 0) return true;                         // "this network"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 169 && b === 254) return true;          // link-local (incl. IMDS)
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true;                        // multicast + reserved
  return false;
}

/**
 * Does this IPv6 literal refer to a local or non-routable address?
 * @param {string} host - Hostname with brackets already stripped
 * @returns {boolean} True when the address is not publicly routable
 */
function isPrivateIPv6(host) {
  const addr = host.toLowerCase();
  if (addr === '::1' || addr === '::') return true;  // loopback / unspecified
  if (addr.startsWith('fe80')) return true;          // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local
  // IPv4-mapped addresses are judged by the IPv4 address they embed. The URL
  // parser normalises the dotted form (::ffff:127.0.0.1) into hex
  // (::ffff:7f00:1), so both spellings must be handled.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (mappedDotted) {
    const octets = parseIPv4(mappedDotted[1]);
    return octets ? isPrivateIPv4(octets) : true;
  }

  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isPrivateIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }

  return false;
}

/**
 * Hostnames that resolve to the local machine by convention.
 * @param {string} host - Lowercase hostname
 * @returns {boolean} True for loopback names
 */
function isLoopbackName(host) {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
}

/**
 * Validate a callback target, throwing when it must not be called.
 *
 * @param {string} url - Candidate callback URL
 * @throws {BlockedCallbackUrlError} When the URL is missing, malformed, or points somewhere unsafe
 * @returns {URL} The parsed, allowed URL
 */
export function assertCallbackUrlAllowed(url) {
  if (!url || typeof url !== 'string') {
    throw new BlockedCallbackUrlError('Callback URL is required', String(url));
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedCallbackUrlError('Callback URL is not a valid absolute URL', url);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedCallbackUrlError(
      `Callback URL must use http or https, got "${parsed.protocol}"`,
      url
    );
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (ALWAYS_BLOCKED_HOSTS.has(host)) {
    throw new BlockedCallbackUrlError(
      'Callback URL targets a cloud metadata endpoint, which is never allowed',
      url
    );
  }

  const ipv4 = parseIPv4(host);
  const isPrivate = ipv4
    ? isPrivateIPv4(ipv4)
    : host.includes(':')
      ? isPrivateIPv6(host)
      : isLoopbackName(host);

  if (isPrivate && !allowPrivateTargets()) {
    throw new BlockedCallbackUrlError(
      `Callback URL "${parsed.hostname}" points at a private or loopback address. ` +
      'This deployment only sends callbacks to public endpoints — use the built-in ' +
      'callback inspector instead, or run the sandbox locally.',
      url
    );
  }

  return parsed;
}

/**
 * Non-throwing variant, for validating input before acting on it.
 *
 * @param {string} url - Candidate callback URL
 * @returns {{ allowed: boolean, reason?: string }} Result
 */
export function checkCallbackUrl(url) {
  try {
    assertCallbackUrlAllowed(url);
    return { allowed: true };
  } catch (error) {
    return { allowed: false, reason: error.message };
  }
}
