/**
 * The dashboard's summary tiles add up to its total.
 *
 * They did not: three of the four counted the payments on the loaded page and
 * the fourth showed the server's total for every page, and the third tile
 * counted failed and cancelled but not expired — so with an expired payment on
 * screen, 2 + 5 + 3 sat under a total of 11.
 *
 * Runs the page's own script in a VM, then calls its `updateStats` with the
 * counts the list API returns. The loaded page is left empty on purpose: tiles
 * still counting from it would all read 0.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PAGE_SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'dashboard.js'),
  'utf8'
);

function tilesFor(counts, total) {
  const elements = {};
  const context = vm.createContext({
    window: {},
    localStorage: { getItem: () => null, removeItem() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      getElementById: (id) => (elements[id] ??= { textContent: '', title: '' })
    },
    console
  });
  vm.runInContext(PAGE_SCRIPT, context);
  // Script-scope `let`s are shared by later scripts in the same context.
  vm.runInContext(
    `payments = []; paymentCounts = ${JSON.stringify(counts)}; paymentsPagination.total = ${total}; updateStats();`,
    context
  );
  const read = (id) => Number(elements[id].textContent);
  return { total: read('stat-total'), pending: read('stat-pending'), success: read('stat-success'), notPaid: read('stat-failed') };
}

describe('dashboard summary tiles', () => {
  test('count every way a payment ends unpaid, so the three add up to the total', () => {
    const counts = { pending: 2, success: 5, failed: 2, cancelled: 1, expired: 1 };
    const tiles = tilesFor(counts, 11);

    assert.deepEqual(tiles, { total: 11, pending: 2, success: 5, notPaid: 4 });
    assert.equal(tiles.pending + tiles.success + tiles.notPaid, tiles.total);
  });
});
