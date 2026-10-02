/**
 * A placeholder QR image, served by the sandbox itself.
 *
 * Nothing scans it; it exists so that a QR link the sandbox hands out opens
 * something on this instance rather than on a provider's domain. Every value
 * drawn into it comes from a caller — an invoice number is whatever the
 * token request supplied — so each is escaped: this is an SVG served from the
 * sandbox's own origin, and markup in it would run there.
 */

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[c]);
}

/**
 * @param {object} lines
 * @param {string} lines.reference - Invoice number or source id, shown under the code
 * @param {string} lines.detail - Amount, or what the code is for
 * @returns {string} SVG document
 */
export function renderMockQr({ reference, detail }) {
  const shown = reference.length > 25 ? reference.substring(0, 22) + '...' : reference;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="250" height="300" viewBox="0 0 250 300">
  <rect width="100%" height="100%" fill="white"/>
  <rect x="25" y="25" width="200" height="200" fill="none" stroke="#333" stroke-width="2"/>
  <rect x="35" y="35" width="40" height="40" fill="#333"/>
  <rect x="40" y="40" width="30" height="30" fill="white"/>
  <rect x="45" y="45" width="20" height="20" fill="#333"/>
  <rect x="175" y="35" width="40" height="40" fill="#333"/>
  <rect x="180" y="40" width="30" height="30" fill="white"/>
  <rect x="185" y="45" width="20" height="20" fill="#333"/>
  <rect x="35" y="175" width="40" height="40" fill="#333"/>
  <rect x="40" y="180" width="30" height="30" fill="white"/>
  <rect x="45" y="185" width="20" height="20" fill="#333"/>
  <rect x="90" y="90" width="70" height="70" fill="none" stroke="#333" stroke-width="1"/>
  <text x="125" y="130" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#333">MOCK QR</text>
  <text x="125" y="245" text-anchor="middle" font-family="monospace" font-size="10" fill="#666">${escapeXml(shown)}</text>
  <text x="125" y="265" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="bold" fill="#333">${escapeXml(detail)}</text>
  <text x="125" y="285" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#999">Paygate Sandbox</text>
</svg>`;
}
