/**
 * The decisions document's index must index the decisions.
 *
 * `docs/decisions.md` carries a hand-maintained Contents list, and a list like
 * that has no way to notice a section was added below it. The companion
 * dashboard's copy went stale exactly that way — it advertised seventeen
 * decisions while holding twenty-five, including the two its own working notes
 * send a reader to by number.
 *
 * Nothing about that looks broken: every heading is present and every anchor
 * resolves. It is only wrong in the one place a reader looks first. So the
 * list is compared against the headings it claims to index — same numbers,
 * same titles, and an anchor GitHub will actually resolve.
 *
 * Asserted here rather than in a script because this repository already runs
 * `node --test test/*.test.js` and a second runner is a second thing to
 * remember.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOC = fileURLToPath(new URL('../docs/decisions.md', import.meta.url));

/**
 * GitHub's heading slug: lowercased, everything but letters, digits, spaces
 * and hyphens dropped, then spaces to hyphens. Applied to the whole heading
 * including its number, which is why the anchors start with a digit.
 *
 * An em dash is dropped rather than replaced, so the spaces around it collapse
 * to two hyphens — the detail a hand-written anchor gets wrong.
 */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');

const text = readFileSync(DOC, 'utf8');

const headings = [...text.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => ({
  number: Number(m[1]),
  title: m[2].trim(),
}));

const listed = [...text.matchAll(/^(\d+)\. \[(.+)\]\(#([^)]+)\)$/gm)].map((m) => ({
  number: Number(m[1]),
  title: m[2].trim(),
  anchor: m[3],
}));

describe('docs/decisions.md', () => {
  /*
   * A check that cannot find what it reads must fail saying so, rather than
   * passing because both sides came back empty. Reformatting the headings is
   * the realistic way to turn this whole file into a test that asserts
   * nothing.
   */
  test('this test can still find the headings and the Contents', () => {
    assert.ok(headings.length > 0, 'no "## N. Title" headings found — has the format changed?');
    assert.ok(listed.length > 0, 'no Contents entries found — has the format changed?');
  });

  test('every decision is in the Contents, under the title it actually has', () => {
    const byNumber = new Map(listed.map((entry) => [entry.number, entry]));

    for (const heading of headings) {
      const entry = byNumber.get(heading.number);
      assert.ok(entry, `decision ${heading.number} ("${heading.title}") is not in the Contents`);
      assert.equal(
        entry.title,
        heading.title,
        `Contents calls decision ${heading.number} "${entry.title}", the heading says "${heading.title}"`,
      );
    }
  });

  test('every link in the Contents resolves to the heading it names', () => {
    const byNumber = new Map(listed.map((entry) => [entry.number, entry]));

    for (const heading of headings) {
      const entry = byNumber.get(heading.number);
      if (!entry) continue; // Reported by the test above; not repeated here.
      assert.equal(
        entry.anchor,
        slug(`${heading.number}. ${heading.title}`),
        `the link to decision ${heading.number} points at #${entry.anchor}, which resolves to nothing`,
      );
    }
  });

  test('the Contents lists nothing that is not a decision', () => {
    const numbered = new Set(headings.map((heading) => heading.number));

    for (const entry of listed) {
      assert.ok(
        numbered.has(entry.number),
        `the Contents lists decision ${entry.number} ("${entry.title}"), which has no heading`,
      );
    }
  });
});
