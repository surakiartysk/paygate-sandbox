/**
 * The payment page, as laid out after the design review (decision 23).
 *
 * It was twelve tiles in two equal columns, a history stretched to the height of the tiles, Delete
 * beside the actions that can be undone, and an emoji in front of five headings and buttons. The page
 * is now a title with its status beside it, the facts as a list, a history as tall as its content, and
 * Delete set apart with what it does. Each is held here by what the page and its script say.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const html = read('payment.html');
const script = read('js/payment-detail.js');
const css = read('css/style.css');

const ruleFor = (selector) => {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `a rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
};

describe('the title', () => {
  test('is the invoice number with its status beside it, in the one h1', () => {
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '';
    assert.match(h1, /id="invoice-display"/);
    assert.match(h1, /id="status-badge"/);
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
  });

  test('does not draw the status badge until the script has a status for it', () => {
    assert.match(html, /<span class="badge" id="status-badge" hidden>/);
    assert.match(script, /statusBadge\.hidden = false;/);
    assert.match(css, /\.badge\[hidden\] \{\s*display: none;/);
  });

  test('has a breadcrumb back to the list, and the page no longer has a "Back to List" button', () => {
    assert.match(html, /<nav class="crumbs" aria-label="Breadcrumb">\s*<a href="\/dashboard">Payments<\/a>/);
    assert.doesNotMatch(html, /Back to List/);
  });

  test('is filled in by the script: the invoice, the breadcrumb and the one-line summary', () => {
    for (const id of ['invoice-display', 'crumb-invoice', 'detail-summary']) {
      assert.match(html, new RegExp(`id="${id}"`));
      assert.match(script, new RegExp(`getElementById\\('${id}'\\)`));
    }
  });
});

describe('the facts', () => {
  const facts = /<dl class="info-grid">([\s\S]*?)<\/dl>/.exec(html)?.[1] ?? '';

  test('are a description list: every label is a dt and every value a dd with an id the script fills', () => {
    const terms = facts.match(/<dt class="info-label"/g) || [];
    const values = [...facts.matchAll(/<dd class="info-value[^"]*" id="([\w-]+)"/g)];
    assert.ok(terms.length >= 12, `${terms.length} terms`);
    assert.equal(values.length, terms.length);
    for (const [, id] of values) assert.match(script, new RegExp(`getElementById\\('${id}'\\)`), id);
  });

  test('do not say twice what the title says: no invoice and no currency of their own', () => {
    assert.doesNotMatch(facts, /id="info-invoice"|id="info-currency"/);
    assert.match(script, /formatAmount\(payment\.amount\)\} \$\{payment\.currencyCode\}/);
  });

  test('are rows with a hairline, not tiles', () => {
    const item = ruleFor('.info-item');
    assert.match(item, /border-bottom:\s*1px solid/);
    assert.doesNotMatch(item, /background:/);
  });

  test('hide the rows that only some methods have with the hidden attribute, which the script sets', () => {
    for (const id of ['info-qr-item', 'info-ref-item', 'info-redirect-item']) {
      assert.match(html, new RegExp(`id="${id}" hidden`));
      assert.match(script, new RegExp(`${id.replace(/-item$/, '').replace('info-', '')}Item\\.hidden = (true|false)`));
    }
    assert.doesNotMatch(script, /(qr|ref|redirect)Item\.style\.display/);
  });
});

describe('the columns', () => {
  test('give the facts the wider column, and let the history be as tall as its content', () => {
    const grid = ruleFor('.detail-grid');
    assert.match(grid, /grid-template-columns:\s*minmax\(0, 2fr\) minmax\(280px, 1fr\)/);
    assert.match(grid, /align-items:\s*start/);
  });

  test('become one column at 900px, where the two would be too narrow', () => {
    assert.match(css, /@media \(max-width: 900px\) \{\s*\.detail-grid \{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});

describe('delete', () => {
  test('is not among the actions that can be undone, and says what it does', () => {
    const actions = /<div class="detail-actions">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    assert.doesNotMatch(actions, /deletePaymentAndRedirect/);
    const zone = /<section class="danger-zone"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    assert.match(zone, /deletePaymentAndRedirect\(\)/);
    assert.match(zone, /It cannot be undone/);
  });

  test('is the last thing on the page', () => {
    assert.ok(html.indexOf('class="danger-zone"') > html.indexOf('Inquiry simulation'));
  });
});

describe('the words and marks', () => {
  test('have no emoji in the page or in what its script writes into it', () => {
    for (const [name, source] of [['payment.html', html], ['payment-detail.js', script]]) {
      assert.deepEqual(source.match(/\p{Extended_Pictographic}/gu) || [], [], name);
    }
  });

  test('name the sections as h2, under the h1', () => {
    for (const title of ['Payment', 'Status history', 'Callback history', 'Inquiry simulation']) {
      assert.match(html, new RegExp(`<h2 class="card-title">\\s*${title}\\b`), title);
    }
    assert.doesNotMatch(html, /<h3 class="card-title">/);
  });
});
