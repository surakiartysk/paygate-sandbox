/**
 * The README's Configuration table lists the environment variables the code
 * reads — all of them, and only those.
 *
 * It named nine and the code read fourteen: `TRUST_PROXY`, `MOCK_MAX_DELAY_MS`,
 * `DATA_DIR` and `PORT` were findable only in the deployment guide, an API
 * footnote, an architecture comment, or the source. The first of those is the
 * one that matters: without it a deployment behind a proxy puts every client in
 * one rate-limit bucket, and nothing in the quick-start reading says so.
 *
 * Read from the source rather than from a list kept here, so a variable added
 * later fails this until it is documented.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Set by the platform, not by whoever deploys; not something to configure. */
const PLATFORM_PROVIDED = new Set(['VERCEL']);

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.js') ? [path] : [];
  });
}

const read = new Set(
  [...sourceFiles(join(root, 'api')), ...sourceFiles(join(root, 'lib')), join(root, 'dev-server.js')].flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1])
  )
);
for (const name of PLATFORM_PROVIDED) read.delete(name);

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const section = readme.slice(readme.indexOf('## Configuration'), readme.indexOf('## Tests'));
const documented = new Set([...section.matchAll(/^\|\s*`([A-Z][A-Z0-9_]+)`(?:\s*\/\s*`([A-Z][A-Z0-9_]+)`)?/gm)].flatMap((m) => [m[1], m[2]].filter(Boolean)));

describe('the README configuration table', () => {
  test('reads some variables from the source, so the comparison is not vacuous', () => {
    assert.ok(read.size >= 10, `found ${[...read].join(', ')}`);
    assert.ok(documented.size >= 10, `found ${[...documented].join(', ')}`);
  });

  test('names every variable the code reads', () => {
    const missing = [...read].filter((name) => !documented.has(name));
    assert.deepEqual(missing, [], `read by the code, absent from the table: ${missing.join(', ')}`);
  });

  test('names no variable the code does not read', () => {
    const stale = [...documented].filter((name) => !read.has(name));
    assert.deepEqual(stale, [], `in the table, read by nothing: ${stale.join(', ')}`);
  });
});

describe('the README links into the docs', () => {
  /** GitHub's heading slug, as test/decisions-doc.test.js applies it. */
  const slug = (heading) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');

  const links = [...readme.matchAll(/\]\((docs\/[\w.-]+\.md)#([\w-]+)\)/g)].map((m) => ({ file: m[1], anchor: m[2] }));

  test('has some to check', () => {
    assert.ok(links.length >= 1);
  });

  for (const { file, anchor } of links) {
    test(`${file}#${anchor} is a heading that exists`, () => {
      const headings = readFileSync(join(root, file), 'utf8')
        .split('\n')
        .filter((line) => /^#{1,6} /.test(line))
        .map((line) => slug(line.replace(/^#+ /, '')));
      assert.ok(headings.includes(anchor), `no heading slugs to ${anchor} in ${file}`);
    });
  }
});
