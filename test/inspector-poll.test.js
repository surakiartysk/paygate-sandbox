/**
 * What the inspector's two-second refresh does to the page it is refreshing.
 *
 * The inspector exists to be read and copied from. It rebuilt the capture list
 * every two seconds even when nothing had arrived, which discards a text
 * selection in a payload (so a callback could not be copied while it was open);
 * it replaced the whole list with "Something went wrong" when one poll dropped;
 * it polled in a hidden tab; and an answer for the session it had just left
 * could land under the one it had just opened.
 *
 * Run in a VM against the page's own script, with fetch held so a test chooses
 * when an answer arrives.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PAGE_SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'inspector.js'),
  'utf8'
);

const capture = (n) => ({ receivedAt: '2026-01-01T00:00:00.000Z', body: { invoiceNo: `INV-${n}`, respCode: '0000' } });

async function loadPage({ session = 's_one' } = {}) {
  const held = [];
  const intervals = [];
  const elements = {};
  const writes = { captures: 0 };
  const element = (id) => {
    if (elements[id]) return elements[id];
    const el = { value: '', checked: true, textContent: '', addEventListener() {}, select() {} };
    if (id === 'captures') {
      let html = '';
      Object.defineProperty(el, 'innerHTML', {
        get: () => html,
        set: (value) => { html = value; writes.captures++; }
      });
    } else {
      el.innerHTML = '';
    }
    return (elements[id] = el);
  };

  const document = { hidden: false, getElementById: element, addEventListener() {} };
  const context = vm.createContext({
    document,
    location: { search: `?session=${session}`, origin: 'http://x', href: `http://x/inspector?session=${session}` },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    URL,
    URLSearchParams,
    encodeURIComponent,
    fetch: (url) => new Promise((resolve, reject) => held.push({ url: String(url), resolve, reject })),
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    clearInterval() {},
    console
  });
  vm.runInContext(PAGE_SCRIPT, context); // starts init(), which asks once

  const page = {
    element,
    document,
    intervals,
    writes,
    asked: () => held.map((request) => request.url),
    run: (code) => vm.runInContext(code, context),
    answer: (index, captures) =>
      held.splice(index, 1)[0].resolve({ ok: true, status: 200, json: async () => ({ captures }) }),
    fail: (index, error) => held.splice(index, 1)[0].reject(error)
  };
  return page;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A page that has loaded its first answer and started polling. */
async function loaded(captures = [capture(1)]) {
  const page = await loadPage();
  page.answer(0, captures);
  await settle();
  assert.equal(page.intervals.length, 1, 'polling started');
  return page;
}

describe('the inspector refreshing', () => {
  test('leaves the list alone when nothing new arrived', async () => {
    const page = await loaded();
    const writes = page.writes.captures;

    page.intervals[0].fn();
    page.answer(0, [capture(1)]);
    await settle();

    assert.equal(page.writes.captures, writes, 'the list was rebuilt, which discards a text selection');
  });

  test('shows a capture that has arrived', async () => {
    const page = await loaded();

    page.intervals[0].fn();
    page.answer(0, [capture(1), capture(2)]);
    await settle();

    assert.match(page.element('captures').innerHTML, /INV-2/);
    assert.match(page.element('capture-count').textContent, /2 callbacks/);
  });

  test('keeps what it shows through a poll that dropped', async () => {
    const page = await loaded();

    page.intervals[0].fn();
    page.fail(0, new Error('network down'));
    await settle();

    assert.match(page.element('captures').innerHTML, /INV-1/);
    assert.doesNotMatch(page.element('captures').innerHTML, /Something went wrong/);
  });

  test('does not ask while the tab is hidden', async () => {
    const page = await loaded();

    page.document.hidden = true;
    page.intervals[0].fn();
    assert.deepEqual(page.asked(), []);

    page.document.hidden = false;
    page.intervals[0].fn();
    assert.equal(page.asked().length, 1);
  });

  test('says so when the first load fails, since there is nothing to keep', async () => {
    const page = await loadPage();
    page.fail(0, new Error('network down'));
    await settle();

    assert.match(page.element('captures').innerHTML, /Could not load the session: network down/);
  });

  test('does not leave the old session on screen when the new one cannot be reached', async () => {
    const page = await loaded();
    page.element('session-input').value = 's_two';

    page.intervals[0].fn();
    page.fail(0, new Error('network down'));
    await settle();

    assert.match(page.element('captures').innerHTML, /Could not load the session/);
    assert.doesNotMatch(page.element('captures').innerHTML, /INV-1/);
  });

  test('draws the list again once an error on screen has cleared', async () => {
    const page = await loaded();

    // A reader-initiated load that fails replaces the list with the error...
    const failing = page.run('loadSession()');
    page.fail(0, new Error('network down'));
    await failing;
    assert.match(page.element('captures').innerHTML, /Could not load the session/);

    // ...and the next poll, carrying the very captures that were there before, must undo it.
    page.intervals[0].fn();
    page.answer(0, [capture(1)]);
    await settle();

    assert.match(page.element('captures').innerHTML, /INV-1/);
    assert.doesNotMatch(page.element('captures').innerHTML, /Could not load/);
  });

  test('a superseded request failing late does not put an error over the list', async () => {
    const page = await loaded();

    const older = page.run('loadSession()');
    const newer = page.run('loadSession()');
    page.answer(1, [capture(1), capture(2)]);
    await newer;
    page.fail(0, new Error('network down'));
    await older;

    assert.match(page.element('captures').innerHTML, /INV-2/);
    assert.doesNotMatch(page.element('captures').innerHTML, /Could not load/);
  });

  test('a slow answer for the session just left does not land under the new one', async () => {
    const page = await loadPage({ session: 's_one' });
    // The first request (s_one) is still in flight when the reader opens s_two.
    page.element('session-input').value = 's_two';
    const second = page.run('loadSession()');

    page.answer(1, [capture(2)]);
    await second;
    page.answer(0, [capture(1)]);
    await settle();

    assert.match(page.element('captures').innerHTML, /INV-2/);
    assert.doesNotMatch(page.element('captures').innerHTML, /INV-1/);
  });
});
