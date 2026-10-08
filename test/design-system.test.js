/**
 * The look the pages share with the rest of the portfolio, held so it cannot drift back.
 *
 * The first redesign step moved paygate onto the type, the neutral primary and the
 * page names the other projects use. Each rule here is one thing that step changed and
 * that a later edit could quietly undo: a page loading a second font, a green accent
 * next to green "success", a size outside the scale, a page with no title of its own.
 * The status colours are not touched: green still means success and red still means failed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const css = read('css/style.css');
const pages = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.html'));
const scripts = readdirSync(new URL('../public/js/', import.meta.url)).filter((f) => f.endsWith('.js'));

const block = (selector) => {
  const start = css.indexOf(`${selector} {`);
  return start === -1 ? '' : css.slice(start, css.indexOf('\n}', start));
};
const tokensOf = (source) =>
  Object.fromEntries([...source.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const DARK = tokensOf(block(':root,\n[data-theme="dark"]'));
const LIGHT = { ...DARK, ...tokensOf(block('[data-theme="light"]')) };

const rgb = (hex) => {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const luminance = ([r, g, b]) => {
  const f = (x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the type', () => {
  test('is Manrope for text and JetBrains Mono for code, and no page asks for another family', () => {
    assert.match(DARK['font-sans'], /^'Manrope'/);
    assert.match(DARK['font-mono'], /^'JetBrains Mono'/);
    assert.doesNotMatch(css, /Inter\b/);
    for (const page of pages) {
      const html = read(page);
      if (!html.includes('fonts.googleapis.com')) continue;
      assert.match(html, /family=Manrope:/, `${page} loads Manrope`);
      assert.doesNotMatch(html, /family=Inter\b/, `${page} does not load Inter`);
    }
  });

  /*
   * Fourteen sizes had grown up across the stylesheet and the markup that styles itself
   * inline: 0.8rem, 0.85rem, 0.875rem, 0.9rem for text that differs by a pixel. The scale
   * is 12, 13, 15, 16 and 22 and 28 for headings; 32, 40 and 64 are the big numbers, and the
   * landing page and the 404 are the only places that use them.
   */
  test('uses the sizes of the scale and no others, in the stylesheet, the pages and the scripts', () => {
    const allowed = new Set(['12px', '13px', '15px', '16px', '22px', '28px', '2rem', '2.5rem', '4rem']);
    const off = [];
    const sources = [['style.css', css], ...pages.map((p) => [p, read(p)]), ...scripts.map((s) => [s, read(`js/${s}`)])];
    for (const [name, text] of sources) {
      for (const m of text.matchAll(/font-size:\s*([0-9.]+(?:rem|px))/g)) {
        if (!allowed.has(m[1])) off.push(`${name}: ${m[0]}`);
      }
    }
    assert.deepEqual(off, []);
  });
});

describe('the colour', () => {
  /*
   * The accent was green on dark and blue on light, and the primary button was the accent:
   * the same green as "success", so a button and an outcome could not be told apart. The
   * accent is now a neutral, and what is red, green, blue or amber keeps its meaning.
   */
  test('is neutral for the accent in both themes, so it is never mistaken for a status', () => {
    for (const [name, tokens] of [['dark', DARK], ['light', LIGHT]]) {
      const [r, g, b] = rgb(tokens.accent);
      // A slate counts (#1f2937 is 24 apart); the green and the blue it replaced were 177 and 212.
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 32, `${name} accent ${tokens.accent} is a grey`);
    }
  });

  test('keeps green for success, red for an error and blue for pending', () => {
    for (const [name, tokens] of [['dark', DARK], ['light', LIGHT]]) {
      const [sr, sg, sb] = rgb(tokens['success-text']);
      assert.ok(sg > sr && sg > sb, `${name} success is green`);
      const [er, eg, eb] = rgb(tokens['error-text']);
      assert.ok(er > eg && er > eb, `${name} error is red`);
      const [pr, pg, pb] = rgb(tokens.pending);
      assert.ok(pb > pr && pb > pg, `${name} pending is blue`);
    }
  });

  test('puts text on the primary button that can be read, in both themes', () => {
    const rule = /\.btn-primary \{([^}]*)\}/.exec(css)[1];
    assert.match(rule, /background:\s*var\(--accent\)/);
    assert.match(rule, /color:\s*var\(--bg-primary\)/);
    for (const [name, tokens] of [['dark', DARK], ['light', LIGHT]]) {
      const r = ratio(rgb(tokens.accent), rgb(tokens['bg-primary']));
      assert.ok(r >= 4.5, `${name}: ${r.toFixed(2)}:1`);
    }
  });

  test('draws a link in a sentence, and an invoice number that is a link, with an underline', () => {
    assert.match(/\.demo-banner a \{([^}]*)\}/.exec(css)[1], /text-decoration:\s*underline/);
    assert.match(/\.pc-invoice a \{([^}]*)\}/.exec(css)[1], /text-decoration:\s*underline/);
  });
});

describe('the pages', () => {
  const titles = {
    'dashboard.html': 'Payments · Paygate Sandbox',
    'login.html': 'Login · Paygate Sandbox',
    'inspector.html': 'Callback inspector · Paygate Sandbox',
    '404.html': 'Page not found · Paygate Sandbox',
    'mock-pay.html': 'Complete payment · Paygate Sandbox',
    'payment.html': 'Payment · Paygate Sandbox',
  };

  test('each has a title of its own, the page first and the site after it', () => {
    for (const [page, title] of Object.entries(titles)) {
      assert.match(read(page), new RegExp(`<title>${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</title>`), page);
    }
    assert.match(read('index.html'), /<title>Paygate Sandbox — /);
    const titlesSeen = pages.map((p) => /<title>([^<]*)<\/title>/.exec(read(p))[1]);
    assert.equal(new Set(titlesSeen).size, pages.length, 'no two pages share a title');
  });

  test('names a payment in the title once it is loaded, with its invoice, its provider and the site', () => {
    assert.match(read('js/payment-detail.js'), /document\.title = `\$\{payment\.invoiceNo\} \(\$\{provider\.toUpperCase\(\)\}\) · Paygate Sandbox`/);
  });

  test('each has exactly one h1', () => {
    for (const page of pages) {
      assert.equal((read(page).match(/<h1[\s>]/g) ?? []).length, 1, page);
    }
  });

  test('is called Paygate Sandbox on the admin pages, and Mock Payment Gateway only on the hosted payment page it imitates', () => {
    for (const page of ['dashboard.html', 'login.html', 'payment.html']) {
      assert.doesNotMatch(read(page), /Mock\s*<span>Payment<\/span>\s*Gateway/, page);
      assert.match(read(page), /class="logo-text"[^>]*>Paygate Sandbox</, page);
    }
    assert.match(read('mock-pay.html'), /Mock <span>Payment<\/span> Gateway/);
  });
});
