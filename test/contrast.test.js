/**
 * Text that carries content is readable: 4.5:1, in both themes.
 *
 * The design review measured it from the stylesheet's own colours: the "muted"
 * text — field labels, timestamps, hints — was 2.67:1 on a dark card and 3.04:1
 * on white, and the status and provider badges at 12px bold were as low as 2.3:1
 * in dark. This does the same arithmetic from the stylesheet itself, so a colour
 * changed later is checked without anyone remembering to.
 *
 * Alpha is composited over the card the badge sits on. WCAG 2 contrast, the
 * 4.5:1 threshold for text under 18px (or 14px bold).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');

const block = (selector) => {
  const start = css.indexOf(`${selector} {`);
  return start === -1 ? '' : css.slice(start, css.indexOf('\n}', start));
};
const tokensOf = (source) => Object.fromEntries([...source.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

const DARK = tokensOf(block(':root,\n[data-theme="dark"]'));
const LIGHT = { ...DARK, ...tokensOf(block('[data-theme="light"]')) };

function parse(value, tokens) {
  const v = value.trim();
  const ref = /^var\(--([\w-]+)\)$/.exec(v);
  if (ref) return parse(tokens[ref[1]], tokens);
  if (v.startsWith('#')) {
    const h = v.length === 4 ? [...v.slice(1)].map((c) => c + c).join('') : v.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(v);
  assert.ok(m, `a colour this test can read: ${v}`);
  const p = m[1].split(',').map(Number);
  return [p[0], p[1], p[2], p[3] ?? 1];
}

const over = ([r, g, b, a], [r2, g2, b2]) => [r * a + r2 * (1 - a), g * a + g2 * (1 - a), b * a + b2 * (1 - a), 1];
const luminance = ([r, g, b]) => {
  const f = (x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Every `.badge-*` rule's colour and background, per theme: light overrides what dark sets. */
function badgeRules() {
  const rules = {};
  for (const m of css.matchAll(/(?:^|\n)([^{}\n@/][^{}]*)\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const light = raw.startsWith('[data-theme="light"]');
      const sel = raw.replace(/^\[data-theme="light"\]\s*/, '');
      if (!/^\.(badge-|provider-badge)|\.direction\.(incoming|outgoing)$/.test(sel)) continue;
      const color = /(?:^|[;\s])color:\s*([^;]+);/.exec(m[2])?.[1];
      const background = /background:\s*([^;]+);/.exec(m[2])?.[1];
      const entry = (rules[sel] ??= { dark: {}, light: {} });
      for (const theme of light ? ['light'] : ['dark', 'light']) {
        if (color) entry[theme].color = color;
        if (background) entry[theme].background = background;
      }
    }
  }
  return rules;
}

describe('muted and secondary text', () => {
  for (const [theme, tokens] of [['dark', DARK], ['light', LIGHT]]) {
    for (const text of ['text-secondary', 'text-muted']) {
      for (const surface of ['bg-primary', 'bg-secondary', 'bg-card', 'bg-hover']) {
        test(`${text} on ${surface}, ${theme}`, () => {
          const r = ratio(parse(tokens[text], tokens), parse(tokens[surface], tokens));
          assert.ok(r >= 4.5, `${r.toFixed(2)}:1`);
        });
      }
    }
  }
});

describe('badges', () => {
  const rules = badgeRules();

  test('reads the badge rules it is meant to check', () => {
    assert.ok(Object.keys(rules).length >= 15, `found ${Object.keys(rules).join(', ')}`);
  });

  for (const [theme, tokens] of [['dark', DARK], ['light', LIGHT]]) {
    for (const [selector, themes] of Object.entries(rules)) {
      const { color, background } = themes[theme];
      if (!color || !background) continue;
      test(`${selector}, ${theme}`, () => {
        const card = parse(tokens['bg-card'], tokens);
        const r = ratio(over(parse(color, tokens), over(parse(background, tokens), card)), over(parse(background, tokens), card));
        assert.ok(r >= 4.5, `${color} on ${background}: ${r.toFixed(2)}:1`);
      });
    }
  }
});
