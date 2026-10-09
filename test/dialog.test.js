/**
 * What a dialog does with the focus: in when it opens, held in while it is open, back to what
 * opened it when it closes.
 *
 * Found in a browser, not by a test: after the status dialog opened, `document.activeElement` was
 * still the row's button behind it, Tab walked on into the page, and closing left the focus
 * nowhere. Then the first fix (focus the first field as the class is added) did nothing either,
 * because the overlay fades in and a hidden control cannot take the focus; the third check in
 * this file is that one.
 *
 * dialog.js runs in a VM against a small stand-in for the parts of the DOM it touches, as
 * dashboard-submit.test.js does for the dashboard's own script.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../public/js/dialog.js', import.meta.url), 'utf8');

/** An element that can hold the focus, unless it is told to refuse for its first `refuse` tries. */
function control(doc, name, { refuse = 0, tag = 'BUTTON' } = {}) {
  let refused = 0;
  const el = {
    name,
    tagName: tag,
    offsetParent: {},
    isConnected: true,
    attrs: {},
    classList: { has: new Set(), add(c) { this.has.add(c); }, remove(c) { this.has.delete(c); }, contains(c) { return this.has.has(c); } },
    hasAttribute(a) { return a in this.attrs; },
    setAttribute(a, v) { this.attrs[a] = v; },
    getClientRects: () => [{}],
    tries: 0,
    focus() {
      el.tries++;
      if (refused < refuse) { refused++; return; }
      doc.activeElement = el;
    },
    querySelector: () => null,
    querySelectorAll: () => []
  };
  return el;
}

/**
 * A page with one overlay that holds a dialog with a close button and two fields, and a button
 * behind it that opens it.
 */
function page({ refuse = 0 } = {}) {
  const listeners = {};
  const timers = [];
  const doc = {
    activeElement: null,
    addEventListener: (type, fn) => (listeners[type] = fn),
    querySelectorAll: (selector) => (selector === '.modal-overlay.active' ? overlays.filter((o) => o.classList.contains('active')) : [])
  };
  const behind = control(doc, 'behind');
  const close = control(doc, 'close');
  const first = control(doc, 'first', { tag: 'INPUT', refuse });
  const last = control(doc, 'last');
  const body = control(doc, 'body', { tag: 'DIV' });
  body.querySelectorAll = () => [first, last];
  const dialog = control(doc, 'dialog', { tag: 'DIV' });
  dialog.querySelector = (s) => (s === '.modal-body' ? body : null);
  dialog.querySelectorAll = () => [close, first, last];
  const overlay = control(doc, 'overlay', { tag: 'DIV' });
  overlay.querySelector = (s) => (s === '[role="dialog"]' ? dialog : null);
  const overlays = [overlay];
  const root = { document: doc, setTimeout: (fn) => timers.push(fn) };
  root.window = root;
  vm.runInContext(SOURCE, vm.createContext({ window: root, globalThis: root }));
  const press = (key, extra = {}) => {
    const event = { key, shiftKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    listeners.keydown(event);
    return event;
  };
  const runTimers = () => { while (timers.length) timers.shift()(); };
  return { doc, root, behind, close, first, last, overlay, overlays, dialog, press, runTimers, listeners, Dialog: root.Dialog };
}

describe('where Tab goes', () => {
  const { Dialog } = page();
  const [a, b, c] = ['a', 'b', 'c'];

  test('on from the last to the first, and back from the first to the last', () => {
    assert.equal(Dialog.nextFocus([a, b, c], c, false), a);
    assert.equal(Dialog.nextFocus([a, b, c], a, true), c);
  });

  test('is left to the browser in the middle', () => {
    assert.equal(Dialog.nextFocus([a, b, c], b, false), null);
    assert.equal(Dialog.nextFocus([a, b, c], b, true), null);
  });

  test('comes in at the first (or the last, going back) from a place outside the list, and nowhere with nothing to go to', () => {
    assert.equal(Dialog.nextFocus([a, b, c], 'elsewhere', false), a);
    assert.equal(Dialog.nextFocus([a, b, c], 'elsewhere', true), c);
    assert.equal(Dialog.nextFocus([], a, false), null);
  });
});

describe('opening and closing', () => {
  test('puts the focus on the first field of the body, not on the close button before it', () => {
    const p = page();
    p.behind.focus();
    p.Dialog.open(p.overlay);
    assert.ok(p.overlay.classList.contains('active'));
    assert.equal(p.doc.activeElement, p.first);
  });

  test('asks again while the overlay is still fading in, until the control takes the focus', () => {
    const p = page({ refuse: 3 });
    p.behind.focus();
    p.Dialog.open(p.overlay);
    assert.equal(p.doc.activeElement, p.behind, 'refused at first');
    p.runTimers();
    assert.equal(p.doc.activeElement, p.first, 'taken once it can be');
  });

  test('gives up after a few tries (the first and eight more) rather than asking for ever', () => {
    const p = page({ refuse: 1000 });
    p.Dialog.open(p.overlay);
    p.runTimers();
    assert.equal(p.first.tries, 9);
  });

  test('gives the focus back to what opened it', () => {
    const p = page();
    p.behind.focus();
    p.Dialog.open(p.overlay);
    p.Dialog.close(p.overlay);
    assert.ok(!p.overlay.classList.contains('active'));
    assert.equal(p.doc.activeElement, p.behind);
  });

  test('does not fail if what opened it has gone from the page', () => {
    const p = page();
    p.behind.focus();
    p.Dialog.open(p.overlay);
    p.behind.isConnected = false;
    p.doc.activeElement = p.first;
    p.Dialog.close(p.overlay);
    assert.ok(!p.overlay.classList.contains('active'));
  });
});

describe('with the keyboard', () => {
  const opened = () => { const p = page(); p.behind.focus(); p.Dialog.open(p.overlay); return p; };

  test('Tab from the last control goes to the first, and Shift+Tab from the first (the close button) to the last', () => {
    const p = opened();
    p.doc.activeElement = p.last;
    assert.ok(p.press('Tab').prevented);
    assert.equal(p.doc.activeElement, p.close);
    assert.ok(p.press('Tab', { shiftKey: true }).prevented);
    assert.equal(p.doc.activeElement, p.last);
  });

  test('Tab between two controls is left alone', () => {
    const p = opened();
    p.doc.activeElement = p.first;
    assert.ok(!p.press('Tab').prevented);
  });

  test('Escape closes the dialog and returns the focus', () => {
    const p = opened();
    p.press('Escape');
    assert.ok(!p.overlay.classList.contains('active'));
    assert.equal(p.doc.activeElement, p.behind);
  });

  test('does nothing when no dialog is open', () => {
    const p = page();
    p.behind.focus();
    assert.ok(!p.press('Tab').prevented);
    p.press('Escape');
    assert.equal(p.doc.activeElement, p.behind);
  });

  test('a press on something inside the dialog that happens to be marked active does not close it', () => {
    // The callback dialog holds a tab that is `active`; pressing it is not a press outside.
    const p = opened();
    const tab = control(p.doc, 'tab');
    tab.classList.add('active');
    p.listeners.click({ target: tab });
    assert.ok(p.overlay.classList.contains('active'), 'the dialog stays open');
    assert.ok(tab.classList.contains('active'), 'and the tab is still the active one');
  });

  test('a press on the dimmed area closes it, and a press inside does not', () => {
    const p = opened();
    p.listeners.click({ target: p.close });
    assert.ok(p.overlay.classList.contains('active'));
    p.overlay.classList.has.add('modal-overlay');
    p.listeners.click({ target: p.overlay });
    assert.ok(!p.overlay.classList.contains('active'));
  });
});

describe('with two dialogs open and a control that is not shown', () => {
  test('Escape closes the one on top and leaves the other', () => {
    const p = page();
    const second = control(p.doc, 'second', { tag: 'DIV' });
    second.querySelector = (s) => (s === '[role="dialog"]' ? p.dialog : null);
    p.overlays.push(second);
    p.Dialog.open(p.overlay);
    p.Dialog.open(second);
    p.press('Escape');
    assert.ok(!second.classList.contains('active'), 'the top one closed');
    assert.ok(p.overlay.classList.contains('active'), 'the one under it stayed');
  });

  test('Tab does not stop on a control that cannot be seen', () => {
    const p = page();
    p.behind.focus();
    p.Dialog.open(p.overlay);
    p.last.offsetParent = null;
    p.last.getClientRects = () => [];
    p.doc.activeElement = p.first;
    const event = p.press('Tab');
    assert.ok(event.prevented, 'first is now the last that can be seen, so Tab wraps');
    assert.equal(p.doc.activeElement, p.close);
  });
});
