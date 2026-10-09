/**
 * What a screen reader and a keyboard are told by the pages.
 *
 * An axe run over every page, and a probe in Chromium of the dashboard, found: a `select` with no
 * name (critical), nine more fields on the dashboard with none, six close buttons that were a
 * multiplication sign, six dialogs that were not dialogs, tabs that were buttons, nothing that
 * announced a toast, a scrollable code block the keyboard could not reach, and links 23 px tall.
 * Each is held here by what the markup says. The behaviour (focus going in and coming back) is in
 * dialog.test.js, and all of it was checked in a browser as well, because a test that reads markup
 * says a rule is present and not that it works.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const pages = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.html'));
const css = read('css/style.css');

/** Every field in a page and whether anything names it: a label for it, a label around it, or aria. */
function fieldsWithoutAName(html) {
  const labelled = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
  const wrapped = [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].map((m) => [m.index, m.index + m[0].length]);
  const bad = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    if (/type="hidden"/.test(attrs)) continue;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const named =
      /\baria-label="[^"]+"/.test(attrs) ||
      /\baria-labelledby="[^"]+"/.test(attrs) ||
      (id && labelled.has(id)) ||
      wrapped.some(([from, to]) => m.index > from && m.index < to);
    if (!named) bad.push(`${m[1]}${id ? '#' + id : ''}`);
  }
  return bad;
}

describe('fields', () => {
  test('every field on every page has a name', () => {
    for (const page of pages) assert.deepEqual(fieldsWithoutAName(read(page)), [], page);
  });

  test('this test can see a field with no name', () => {
    assert.deepEqual(fieldsWithoutAName('<input id="a"><label for="b">B</label><select id="b"></select>'), ['input#a']);
    assert.deepEqual(fieldsWithoutAName('<label>Name <input></label><input aria-label="x">'), []);
  });
});

describe('dialogs', () => {
  const withDialogs = ['dashboard.html', 'payment.html'];

  test('each overlay holds a modal dialog named by its own title', () => {
    for (const page of withDialogs) {
      const html = read(page);
      const overlays = [...html.matchAll(/<div class="modal-overlay" id="([^"]+)">\s*<div class="modal[^"]*"[^>]*>/g)];
      assert.ok(overlays.length >= 2, `${page} has dialogs`);
      for (const m of overlays) {
        const tag = m[0];
        const titleId = /aria-labelledby="([^"]+)"/.exec(tag)?.[1];
        assert.match(tag, /role="dialog"/, `${page} ${m[1]}`);
        assert.match(tag, /aria-modal="true"/, `${page} ${m[1]}`);
        assert.ok(titleId && html.includes(`id="${titleId}"`), `${page} ${m[1]} is named by an element that exists`);
      }
      assert.equal((html.match(/class="modal-overlay"/g) ?? []).length, overlays.length, `${page}: every overlay was read`);
    }
  });

  test('every close button says what it does, and a pictograph in a title is not read out', () => {
    for (const page of withDialogs) {
      const html = read(page);
      for (const m of html.matchAll(/<button\b[^>]*class="modal-close"[^>]*>/g)) {
        assert.match(m[0], /aria-label="Close"/, page);
        assert.match(m[0], /type="button"/, page);
      }
      for (const m of html.matchAll(/<h3\b[^>]*class="modal-title"[^>]*>([^<]*(?:<span[^>]*>[^<]*<\/span>)?[^<]*)</g)) {
        assert.doesNotMatch(m[1], /^[^<]*[\u{1F300}-\u{1FAFF}⚠]/u, `${page}: ${m[1]}`);
      }
    }
  });

  test('the pages load dialog.js before the script that opens them', () => {
    for (const [page, script] of [['dashboard.html', 'dashboard.js'], ['payment.html', 'payment-detail.js']]) {
      const html = read(page);
      assert.ok(html.indexOf('/js/dialog.js') !== -1 && html.indexOf('/js/dialog.js') < html.indexOf(`/js/${script}`), page);
    }
  });

  test('the scripts open and close a dialog through it, and never by the class alone', () => {
    for (const script of ['dashboard.js', 'payment-detail.js']) {
      const src = read(`js/${script}`);
      assert.doesNotMatch(src, /-modal'\)\.classList\.(add|remove)\('active'\)/, script);
      assert.match(src, /Dialog\.open\(/, script);
      assert.match(src, /Dialog\.close\(/, script);
    }
  });
});

describe('tabs', () => {
  test('each tab says it is a tab and which panel it controls, and the panel says which tab names it', () => {
    for (const page of ['dashboard.html', 'payment.html']) {
      const html = read(page);
      const tabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
      assert.ok(tabs.length >= 2, page);
      for (const tab of tabs) {
        const id = /\bid="([^"]+)"/.exec(tab)?.[1];
        const controls = /aria-controls="([^"]+)"/.exec(tab)?.[1];
        assert.match(tab, /aria-selected="(true|false)"/, tab);
        assert.ok(id && controls, `${page}: ${tab}`);
        const panel = new RegExp(`<div[^>]*id="${controls}"[^>]*>`).exec(html)?.[0] ?? '';
        assert.match(panel, /role="tabpanel"/, `${page} ${controls}`);
        assert.match(panel, new RegExp(`aria-labelledby="${id}"`), `${page} ${controls}`);
      }
    }
  });

  /** The body of a top-level function: from its first line to the closing brace at the start of a line. */
  const bodyOf = (src, name) => new RegExp(`function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}\\n`).exec(src)?.[1] ?? '';

  test('the scripts keep aria-selected true to what is shown', () => {
    assert.match(bodyOf(read('js/dashboard.js'), 'switchTab'), /setAttribute\('aria-selected', String\(btn\.dataset\.tab === tab\)\)/);
    for (const script of ['dashboard.js', 'payment-detail.js']) {
      const body = bodyOf(read(`js/${script}`), 'switchCallbackMode');
      assert.match(body, /callback-mode-sequence'\)\.setAttribute\('aria-selected', String\(mode === 'sequence'\)\)/, script);
      assert.match(body, /callback-mode-custom'\)\.setAttribute\('aria-selected', String\(mode === 'custom'\)\)/, script);
    }
  });

  test('this test reads the function it names, not the rest of the file', () => {
    assert.equal(bodyOf('function a(x) {\n  one\n}\nfunction b() {\n  two\n}\n', 'a').trim(), 'one');
    assert.equal(bodyOf('function a(x) {\n  one\n}\n', 'missing'), '');
  });
});

describe('announcements', () => {
  test('the toasts are in a live region, and a failure is announced at once', () => {
    for (const page of ['dashboard.html', 'payment.html']) {
      assert.match(read(page), /id="toast-container" role="status" aria-live="polite"/, page);
    }
    for (const script of ['dashboard.js', 'payment-detail.js']) {
      assert.match(read(`js/${script}`), /if \(type !== 'success'\) toast\.setAttribute\('role', 'alert'\)/, script);
    }
  });
});

describe('the rows', () => {
  const src = read('js/dashboard.js');

  test('say whose they are, so a list of fifty "Status" buttons is not fifty of the same name', () => {
    for (const label of ['Change status of', 'Send a callback for', 'More actions for', 'Copy invoice number']) {
      assert.match(src, new RegExp(`aria-label="${label} \\$\\{escapeAttr\\(payment\\.invoiceNo\\)\\}"`), label);
    }
  });
});

describe('the landing page', () => {
  test('lets a keyboard reach the code that scrolls, and says what it is', () => {
    assert.match(read('index.html'), /<pre class="landing-code" tabindex="0" role="region" aria-label="[^"]+">/);
  });
});

describe('links', () => {
  test('are at least 32 px tall, and 44 px for a finger', () => {
    const rule = /\.pc-invoice a,\s*\.landing-footer-links a \{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(rule, /min-height:\s*32px/);
    const touch = /@media \(pointer: coarse\) \{\s*\.pc-invoice a,\s*\.landing-footer-links a \{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(touch, /min-height:\s*44px/);
  });
});
