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

  test('are two by two on a phone, with the rules where the cards meet', () => {
    const phone = /@media \(max-width: 640px\) \{\s*\.stats-grid \{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[\s\S]*?\n\}\n/.exec(css)?.[0] ?? '';
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
