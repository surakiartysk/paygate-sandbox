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
 * Metadata service *names* that must never be reached, regardless of mode.
 *
 * Names only. The address is matched structurally in `isMetadataAddress`
 * below, because a Set of strings can only ever block the spellings someone
 * thought to list — and an IP address has several.
 */
const ALWAYS_BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata'
]);

/** The IMDS address every major cloud serves credentials from. */
const METADATA_IPV4 = [169, 254, 169, 254];

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
  // IPv4-mapped addresses are judged by the IPv4 address they embed.
  const mapped = mappedIPv4(addr);
  if (mapped) return isPrivateIPv4(mapped);

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
 * Is this host the cloud metadata address, in any spelling?
 *
 * Checked structurally rather than by string, and that distinction was a real
 * hole. `169.254.169.254` was listed in a Set, so the dotted form was refused
 * "regardless of mode" exactly as documented — while `[::ffff:a9fe:a9fe]`,
 * which is the same address, went through on the default mode. Strict mode
 * happened to catch it as private, so only a self-hosted deployment that never
 * set ALLOW_PRIVATE_CALLBACKS=false was exposed, which is also why nobody
 * noticed.
 *
 * The other classic spellings — decimal, hex, octal, the `127.1` short form —
 * never needed handling here: the WHATWG URL parser normalises them to dotted
 * quads before this code runs. That is worth stating because it looks like an
 * omission otherwise, and because it is a property of the parser rather than
 * of this function.
 *
 * @param {number[]|null} ipv4 - Octets when the host is an IPv4 literal
 * @param {string} host - Lowercase hostname, brackets stripped
 * @returns {boolean} True when the target is the metadata service
 */
function isMetadataAddress(ipv4, host) {
  const octets = ipv4 ?? mappedIPv4(host);
  return octets !== null && octets.every((o, i) => o === METADATA_IPV4[i]);
}

/**
 * The IPv4 address embedded in an IPv4-mapped IPv6 literal, or null.
 *
 * Both spellings occur: the URL parser normalises `::ffff:127.0.0.1` into
 * `::ffff:7f00:1`, so a caller may present either.
 *
 * @param {string} host - Lowercase hostname, brackets stripped
 * @returns {number[]|null} Octets, or null when not an IPv4-mapped address
 */
function mappedIPv4(host) {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (dotted) return parseIPv4(dotted[1]);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return null;

  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
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

  const ipv4 = parseIPv4(host);

  if (ALWAYS_BLOCKED_HOSTS.has(host) || isMetadataAddress(ipv4, host)) {
    throw new BlockedCallbackUrlError(
      'Callback URL targets a cloud metadata endpoint, which is never allowed',
      url
    );
  }

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
