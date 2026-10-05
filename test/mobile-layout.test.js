/**
 * What a phone gets: the layout of the pages it opens, and the touch rules.
 *
 * These read the stylesheet and the markup, because a unit test cannot lay a
 * page out. What they hold is the rules the mobile review found missing, each
 * measured in Chromium at 375px: before and after are in the commit message,
 * and the browser probes behind them are named there. A test that matches
 * CSS text says the rule is present, not that it works — which is why the
 * numbers were taken in a browser too.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
const payment = readFileSync(new URL('../public/payment.html', import.meta.url), 'utf8');

/** The declarations of the last rule for `selector`, or '' — whitespace-tolerant. */
function ruleFor(selector, source = css) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...source.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  return matches.at(-1)?.[1] ?? '';
}

/** The body of the `@media (pointer: coarse)` block. */
const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}\n/.exec(css)?.[1] ?? '';

describe('a touch screen', () => {
  /*
   * iOS Safari zooms the page in when a field under 16px is focused. Fifteen
   * were 13–14px. `!important` is the point: the fields' own classes set their
   * size and a media query adds no specificity.
   */
  test('gives every field 16px, over the size its own class sets', () => {
    assert.match(coarse, /input,\s*select,\s*textarea\s*\{[^}]*font-size:\s*16px\s*!important/);
  });

  /*
   * 197 of the dashboard's 203 buttons missed a tap 21px from their centre. The
   * area is invisible, so nothing is drawn bigger.
   */
  test('gives every control a tap area of at least 44px, drawn no bigger', () => {
    assert.match(coarse, /::before\s*\{[^}]*width:\s*max\(100%,\s*44px\)[^}]*height:\s*max\(100%,\s*44px\)/);
  });

  test('anchors that area to the control without overriding one that positions itself', () => {
    assert.match(coarse, /:where\(button[^)]*\)\s*\{\s*position:\s*relative/);
  });
});

describe('a payment page on a narrow screen', () => {
  /*
   * Three action buttons in one row that could not wrap made the page 395px wide
   * at 375, on every payment, and cut off Delete.
   */
  test('lets its action buttons wrap', () => {
    assert.match(ruleFor('.detail-actions'), /flex-wrap:\s*wrap/);
    assert.match(payment, /class="detail-actions"/);
  });

  /*
   * An inline `grid-column: span 2` on six tiles kept a second column alive when
   * the grid was set to one, and squeezed the first tile to a sliver.
   */
  test('does not span grid columns from inline styles', () => {
    assert.doesNotMatch(payment, /grid-column:\s*span 2/);
    assert.equal((payment.match(/info-item-wide/g) || []).length, 6);
  });

  test('puts its information in one column on a phone, and the wide tiles in it', () => {
    const phone = /@media \(max-width: 640px\) \{\s*\.detail-header[\s\S]*?\n\}\n/.exec(css)?.[0] ?? '';

    assert.match(phone, /\.info-grid\s*\{\s*grid-template-columns:\s*1fr/);
    assert.match(phone, /\.info-item-wide\s*\{\s*grid-column:\s*auto/);
  });

  test('breaks an invoice number that cannot break, instead of widening the page', () => {
    assert.match(ruleFor('.detail-title'), /overflow-wrap:\s*anywhere/);
  });
});

describe('the mock payment page on a narrow screen', () => {
  /*
   * 12,500,000.50 at 2.5rem is 313px; the card's content box at 375 was 229. An
   * invoice number of 56 characters made the page 548 wide.
   */
  test('shrinks the amount with the screen, and lets it break', () => {
    assert.match(css, /\.mock-pay-amount\s*\{\s*font-size:\s*clamp\(1\.5rem,\s*8vw,\s*2\.5rem\)/);
    assert.match(ruleFor('.mock-pay-amount'), /overflow-wrap:\s*anywhere/);
  });

  test('lets a long value break, and keeps a gap between a label and its value', () => {
    assert.match(ruleFor('.mock-pay-info-value'), /overflow-wrap:\s*anywhere/);
    assert.match(ruleFor('.mock-pay-info-row'), /gap:\s*0\.75rem/);
  });

  test('uses less of the screen for padding on a phone', () => {
    assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*?\.mock-pay-card\s*\{\s*padding:\s*1\.25rem/);
  });
});
