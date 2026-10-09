/**
 * The payments page, as laid out after the design review (decision 23).
 *
 * It was a tab with one tab in it and the same word as a heading under it, four stat cards 130px tall
 * for four numbers, a provider and a method each in a box of its own, a header that said Refresh on
 * one side and Clear on the other, and labels in capitals. Now it is one title and a line, a strip of
 * four counts, a filter row that ends with Refresh, and a table whose only colour is the status.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const html = read('dashboard.html');
const script = read('js/dashboard.js');
const css = read('css/style.css');

const ruleFor = (selector) => {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `a rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
};

describe('the title', () => {
  test('is one h1, "Payments", with a line under it, before the tabs and outside any card', () => {
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    const h1 = html.indexOf('<h1 class="page-title">Payments</h1>');
    assert.notEqual(h1, -1);
    assert.ok(h1 < html.indexOf('class="tab-nav"'));
    assert.ok(h1 < html.indexOf('<div class="card">'));
    assert.match(html, /<p class="page-lede">[^<]+<\/p>/);
  });

  test('has no tabs for a visitor, who has one section; the owner has two', () => {
    assert.match(html, /<div data-admin-only class="tab-nav" role="tablist"/);
    const tabs = /<div data-admin-only class="tab-nav"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    assert.equal((tabs.match(/role="tab"/g) || []).length, 2);
  });
});

describe('the heading of each section', () => {
  const titles = /const SECTION_TITLES = (\{[\s\S]*?\n\});/.exec(script)?.[1] ?? '{}';
  const sections = Function(`return ${titles}`)();
  const body = /function switchTab\(tab\) \{([\s\S]*?)\n\}/.exec(script)?.[1] ?? '';

  test('starts as what the page says for payments, word for word', () => {
    assert.match(html, new RegExp(`<h1 class="page-title">${sections.payments.title}</h1>`));
    assert.ok(html.includes(`<p class="page-lede">${sections.payments.lede}</p>`));
  });

  test('changes with the tab, so the owner reading the logs is not under a heading that says Payments', () => {
    assert.equal(sections.logs.title, 'Request logs');
    assert.match(body, /title\.textContent = section\.title/);
    assert.match(body, /lede\.textContent = section\.lede/);
    assert.match(body, /document\.title = `\$\{section\.title\} · Paygate Sandbox`/);
  });
});

describe('switching sections, run against the page’s own script', () => {
  function loadPage() {
    const nodes = { '.page-title': { textContent: 'Payments' }, '.page-lede': { textContent: '' } };
    const document = {
      hidden: false,
      title: 'Payments · Paygate Sandbox',
      addEventListener() {},
      querySelector: (selector) => nodes[selector] ?? null,
      querySelectorAll: () => [],
      // Switching to the logs loads them; what loading reads is a field with nothing in it.
      getElementById: () => ({ value: '', textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }),
    };
    const context = vm.createContext({
      window: {},
      document,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: () => new Promise(() => {}),
      URLSearchParams,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      console: { ...console, debug() {}, log() {} },
    });
    vm.runInContext(script, context);
    return { context, document, nodes };
  }

  test('puts the logs’ name in the heading, its line under it, and the window’s title, and puts them back', () => {
    const { context, document, nodes } = loadPage();
    context.switchTab('logs');
    assert.equal(nodes['.page-title'].textContent, 'Request logs');
    assert.equal(nodes['.page-lede'].textContent, 'The requests the sandbox received and what it answered.');
    assert.equal(document.title, 'Request logs · Paygate Sandbox');
    context.switchTab('payments');
    assert.equal(nodes['.page-title'].textContent, 'Payments');
    assert.equal(document.title, 'Payments · Paygate Sandbox');
  });
});

describe('the header', () => {
  test('says "Sign out" in words, not an icon with a title', () => {
    assert.match(html, /<button class="btn btn-secondary btn-sm" onclick="logout\(\)">Sign out<\/button>/);
    assert.doesNotMatch(html, /title="Logout"/);
  });
});

describe('the stats', () => {
  test('are one strip of four counts with a rule between them, not four cards', () => {
    assert.match(ruleFor('.stats-grid'), /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
    assert.match(ruleFor('.stats-grid'), /border:\s*1px solid/);
    const card = ruleFor('.stat-card');
    assert.match(card, /border-left:\s*1px solid/);
    assert.doesNotMatch(card, /background:|border-radius:|padding:\s*1\.5rem/);
    assert.equal((html.match(/class="stat-card"/g) || []).length, 4);
  });

  test('are two by two from 768px, where they wrap, with the rules where the cards meet', () => {
    const phone = /@media \(max-width: 768px\) \{\s*\.stats-grid \{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[\s\S]*?\n\}\n/.exec(css)?.[0] ?? '';
    assert.match(phone, /\.stat-card:nth-child\(odd\)\s*\{\s*border-left:\s*0/);
    assert.match(phone, /\.stat-card:nth-child\(n \+ 3\)\s*\{\s*border-top:\s*1px solid/);
  });
});

describe('the filters', () => {
  const filters = /<div class="filters">([\s\S]*?)\n        <\/div>\n      <\/div>\n\n      <!-- Table -->/.exec(html)?.[1] ?? '';

  test('end with Refresh, whose ids the script still uses', () => {
    assert.match(filters, /id="refresh-payments-btn"/);
    for (const id of ['refresh-payments-btn', 'refresh-payments-icon', 'refresh-payments-text']) {
      assert.match(filters, new RegExp(`id="${id}"`));
      assert.match(script, new RegExp(`getElementById\\('${id}'\\)`));
    }
    assert.ok(filters.indexOf('refresh-payments-btn') > filters.indexOf('id="status-filter"'));
  });

  test('leave the owner’s Clear payments in a header of its own that a visitor does not see', () => {
    assert.match(html, /<div data-admin-only class="card-header card-header-end">\s*<button class="btn btn-danger btn-sm" onclick="openClearPaymentsModal\(\)">Clear payments<\/button>/);
  });

  test('are two columns between a phone and a laptop, with the search across both', () => {
    const block = /@media \(min-width: 481px\) and \(max-width: 768px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    assert.match(block, /\.filters \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(block, /\.filter-group-grow \{\s*grid-column: 1 \/ -1;/);
  });

  test('and the labels over the fields and the column heads are words, not capitals', () => {
    assert.doesNotMatch(ruleFor('.filter-group label'), /text-transform/);
    assert.doesNotMatch(ruleFor('.table th'), /text-transform/);
  });
});

describe('the rows', () => {
  const row = /tbody\.innerHTML = payments\.map\(payment => \{[\s\S]*?\}\)\.join\(''\);/.exec(script)?.[0] ?? '';

  test('write the provider and the method as words; the status is the only coloured cell', () => {
    assert.ok(row.length > 500, 'found the row template');
    assert.match(row, /<td class="pc-provider">\$\{providerName\}<\/td>/);
    assert.match(row, /<td class="pc-method">\$\{methodName\}<\/td>/);
    assert.doesNotMatch(row, /provider-badge|method-badge/);
  });

  test('line the method up down a phone list: the first column is as wide for every status', () => {
    assert.match(css, /grid-template-columns:\s*7rem auto 1fr auto;\s*grid-template-areas:\s*"invoice invoice invoice invoice"/);
  });
});
