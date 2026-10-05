/**
 * What a link to the landing page shows when someone pastes it.
 *
 * The page had a `<title>` and a description and nothing else, so a link shared
 * on LinkedIn or in a chat arrived as a bare line with no picture — on a project
 * whose links are mostly shared there. These hold the tags to the file they
 * point at. Whether a given site then renders them is checked by hand, with its
 * own preview tool, after a deploy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(join(publicDir, 'index.html'), 'utf8');

function meta(attribute, key) {
  const tag = html.match(new RegExp(`<meta[^>]*${attribute}="${key}"[^>]*>`, 's'))?.[0];
  return tag?.match(/content="([^"]*)"/)?.[1];
}

/** A PNG's width and height, from its header. */
function pngSize(path) {
  const bytes = readFileSync(path);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

const imagePath = () => join(publicDir, new URL(meta('property', 'og:image') ?? 'https://x.invalid/missing').pathname);

describe('the landing page link preview', () => {
  test('has a title, a description and a large image card', () => {
    assert.ok(meta('property', 'og:title'));
    assert.ok(meta('property', 'og:description'));
    assert.ok(meta('name', 'description'));
    assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  });

  // Absolute, because the crawlers that fetch it do not resolve a relative URL
  // against the page — a relative one is a preview with no picture.
  test('names its image by an absolute URL', () => {
    assert.match(meta('property', 'og:image') ?? '', /^https:\/\//);
  });

  test('points at an image this build actually ships', () => {
    assert.ok(existsSync(imagePath()), `${imagePath()} does not exist`);
  });

  test('states the size the image really is', () => {
    const [width, height] = pngSize(imagePath());
    assert.deepEqual(
      [meta('property', 'og:image:width'), meta('property', 'og:image:height')],
      [String(width), String(height)]
    );
    // The ratio the large card is cropped to; anything else is cut off.
    assert.ok(Math.abs(width / height - 1200 / 630) < 0.01, `${width}x${height}`);
  });

  test('describes the image for those who cannot see it', () => {
    assert.ok(meta('property', 'og:image:alt'));
  });
});
