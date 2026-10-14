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
 * Names are resolved before the request is sent, and every address a name
 * resolves to is judged by the same rules as an address written in the URL.
 * Judging the name alone let `169.254.169.254.nip.io` and `localtest.me`
 * through: nothing about either name is private, everything about where they
 * point is. Callers that need the resolved check use
 * `assertCallbackTargetAllowed`; `assertCallbackUrlAllowed` is the
 * synchronous half, for the URL alone.
 *
 * What remains: the address is not pinned. `fetch` resolves the name again
 * when it connects, so a name that answers a public address to this check and
 * a private one a moment later (DNS rebinding) still gets through. Closing
 * that means connecting to the checked address, which the built-in `fetch`
 * cannot be told to do without another dependency. For a sandbox whose worst
 * case is an unwanted POST whose answer is never shown, that is where the
 * line is drawn — and it is drawn here, in writing, rather than implied away.
 */

import { lookup } from 'node:dns/promises';
import { announceDeploymentProblems, isPublicDeployment } from './deployment.js';

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
 * Is this deployment allowed to call private/loopback addresses?
 *
 * An explicit value always wins, in either direction. What changed is what an
 * *unset* variable means: it used to mean "allowed" everywhere, so a public
 * instance that never set it ran permissively — while docs/deployment.md
 * marked `ALLOW_PRIVATE_CALLBACKS=false` "Required for a public instance".
 * A requirement nothing enforces is a requirement that gets forgotten, and
 * forgetting it turns an SSRF guard off.
 *
 * So unset now means "local yes, deployed no". Local development still works
 * out of the box — posting to your own service is the normal case there — and
 * a deployment that genuinely wants private targets sets "true" and says so,
 * rather than getting them by omission.
 *
 * @returns {boolean} True when private targets are permitted
 */
function allowPrivateTargets() {
  if (process.env.ALLOW_PRIVATE_CALLBACKS === 'false') return false;
  if (process.env.ALLOW_PRIVATE_CALLBACKS === 'true') return true;

  if (isPublicDeployment()) {
    announceDeploymentProblems();
    return false;
  }

  return true;
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
function isPrivateIPv4([a, b, c]) {
  if (a === 10) return true;                        // 10.0.0.0/8
  if (a === 127) return true;                       // loopback
  if (a === 0) return true;                         // "this network"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 169 && b === 254) return true;          // link-local (incl. IMDS)
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                        // multicast + reserved
  return false;
}

/**
 * Parse an IPv6 literal into its eight 16-bit groups.
 *
 * Parsed rather than matched by prefix, because a prefix check on the text
 * only knows the spellings it was written for. `startsWith('fe80')` caught
 * the first sixty-fourth of link-local: fe80::/10 runs to febf, and
 * `fe90::1` went through.
 *
 * @param {string} host - Lowercase hostname, brackets stripped
 * @returns {number[]|null} Eight groups, or null when not an IPv6 literal
 */
function parseIPv6(host) {
  if (!host.includes(':')) return null;
  let text = host;

  // A trailing dotted quad is two groups written another way.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = parseIPv4(dotted[2]);
    if (!octets) return null;
    text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groupsOf = part => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map(g => parseInt(g, 16));
}

/**
 * The IPv4 address an IPv6 address carries, when it carries one a packet
 * could end up at: IPv4-mapped (`::ffff:a.b.c.d`), the deprecated
 * IPv4-compatible form (`::a.b.c.d`), NAT64 (`64:ff9b::/96`) and 6to4
 * (`2002::/16`). Each was a way to write 169.254.169.254 that a check on the
 * IPv6 text did not recognise.
 *
 * @param {number[]} g - Eight groups
 * @returns {number[]|null} Octets, or null when none is embedded
 */
function embeddedIPv4(g) {
  const octetsOf = (high, low) => [high >> 8, high & 0xff, low >> 8, low & 0xff];
  const zeros = n => g.slice(0, n).every(x => x === 0);

  if (zeros(5) && g[5] === 0xffff) return octetsOf(g[6], g[7]);
  if (zeros(6) && (g[6] !== 0 || g[7] > 1)) return octetsOf(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return octetsOf(g[6], g[7]);
  if (g[0] === 0x2002) return octetsOf(g[1], g[2]);
  return null;
}

/**
 * Does this IPv6 address refer to a local or non-routable address?
 * @param {number[]} g - Eight groups
 * @returns {boolean} True when the address is not publicly routable
 */
function isPrivateIPv6(g) {
  if (g.slice(0, 7).every(x => x === 0) && g[7] <= 1) return true; // :: and ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local, fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated), fec0::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local, fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo: its IPv4 is hidden
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && g.slice(1, 4).every(x => x === 0)) return true; // discard

  // Addresses that embed an IPv4 one are judged by the address they embed.
  const ipv4 = embeddedIPv4(g);
  return ipv4 !== null && isPrivateIPv4(ipv4);
}

/**
 * Hostnames that resolve to the local machine by convention.
 * @param {string} host - Lowercase hostname, trailing dots removed
 * @returns {boolean} True for loopback names
 */
function isLoopbackName(host) {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
}

/**
 * Is this address the cloud metadata service, in any spelling?
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
 * @param {number[]|null} ipv4 - Octets when the address is IPv4
 * @param {number[]|null} ipv6 - Groups when the address is IPv6
 * @returns {boolean} True when the target is the metadata service
 */
function isMetadataAddress(ipv4, ipv6) {
  const octets = ipv4 ?? (ipv6 ? embeddedIPv4(ipv6) : null);
  return octets !== null && octets.every((o, i) => o === METADATA_IPV4[i]);
}

/**
 * What a host is, as far as the guard cares.
 *
 * Trailing dots are removed first. `localhost.` and
 * `metadata.google.internal.` are the fully qualified spellings of the names
 * the checks below know, they resolve to the same places, and a check on the
 * text alone passed both.
 *
 * @param {string} rawHost - Hostname or address as written
 * @returns {{ host: string, metadata: boolean, private: boolean, literal: boolean }}
 */
function classifyHost(rawHost) {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const ipv4 = parseIPv4(host);
  const ipv6 = ipv4 ? null : parseIPv6(host);

  return {
    host,
    literal: Boolean(ipv4 || ipv6),
    metadata: ALWAYS_BLOCKED_HOSTS.has(host) || isMetadataAddress(ipv4, ipv6),
    private: ipv4 ? isPrivateIPv4(ipv4) : ipv6 ? isPrivateIPv6(ipv6) : isLoopbackName(host)
  };
}

/**
 * Throw for a host the guard refuses.
 * @param {ReturnType<typeof classifyHost>} verdict - What the host is
 * @param {string} url - The URL, for the error
 * @param {string} shown - The host as the message names it, quoted
 */
function refuse(verdict, url, shown) {
  if (verdict.metadata) {
    throw new BlockedCallbackUrlError(
      'Callback URL targets a cloud metadata endpoint, which is never allowed',
      url
    );
  }

  if (verdict.private && !allowPrivateTargets()) {
    throw new BlockedCallbackUrlError(
      `Callback URL ${shown} points at a private or loopback address. ` +
      'This deployment only sends callbacks to public endpoints — use the built-in ' +
      'callback inspector instead, or run the sandbox locally.',
      url
    );
  }
}

/** How a name is resolved. Replaceable so a test can answer for DNS. */
let resolveHost = host => lookup(host, { all: true, verbatim: true });

/**
 * Answer name lookups from a function instead of DNS, or restore DNS with null.
 * For tests only.
 * @param {((host: string) => Promise<Array<{ address: string }>>)|null} fn - Resolver
 */
export function setHostResolverForTests(fn) {
  resolveHost = fn ?? (host => lookup(host, { all: true, verbatim: true }));
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

  refuse(classifyHost(parsed.hostname), url, `"${parsed.hostname}"`);

  return parsed;
}

/**
 * Validate a callback target including where its name resolves, throwing when
 * it must not be called. Every address the name has is checked, not the first:
 * a name with one public and one private address could be connected to either.
 *
 * A name that does not resolve is not refused — the request would fail on its
 * own — but is reported as a failure, not as a block.
 *
 * @param {string} url - Candidate callback URL
 * @throws {BlockedCallbackUrlError} When the URL, or any address its name resolves to, is unsafe
 * @returns {Promise<URL>} The parsed, allowed URL
 */
export async function assertCallbackTargetAllowed(url) {
  const parsed = assertCallbackUrlAllowed(url);
  const verdict = classifyHost(parsed.hostname);
  if (verdict.literal) return parsed;

  let addresses;
  try {
    addresses = await resolveHost(verdict.host);
  } catch (error) {
    throw new Error(`Callback host "${parsed.hostname}" could not be resolved (${error.code || error.message})`);
  }

  for (const { address } of addresses) {
    refuse(classifyHost(address), url, `"${parsed.hostname}" (resolves to ${address})`);
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
