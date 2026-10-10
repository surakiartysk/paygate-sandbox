/**
 * The four things decision 22 named and left, done (decision 25): a toast that stays long enough to
 * read, the arrow keys in a row of tabs, the page behind a dialog made inert, and the row's "⋯" as
 * a disclosure that takes and gives back the focus.
 *
 * toast.js, tabs.js and dialog.js run in a VM against a small stand-in for the DOM they touch, as
 * dialog.test.js does.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

/** An element with the few things these scripts use. */
function element(tag = 'DIV') {
  const listeners = {};
  const el = {
    tagName: tag,
    children: [],
    attrs: {},
    textContent: '',
    className: '',
    removed: false,
    parent: null,
    classes: new Set(),
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c) || el.className.split(' ').includes(c)
    },
    setAttribute(a, v) { el.attrs[a] = String(v); },
    getAttribute(a) { return a in el.attrs ? el.attrs[a] : null; },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((fn) => fn({ type })); },
    append(...kids) { kids.forEach((k) => el.appendChild(k)); },
    appendChild(k) { k.parent = el; el.children.push(k); return k; },
    removeChild(k) { el.children.splice(el.children.indexOf(k), 1); k.removed = true; },
    remove() { el.removed = true; if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); }
  };
  return el;
}

function toastPage() {
  const container = element();
  const timers = [];
  const doc = { getElementById: (id) => (id === 'toast-container' ? container : null), createElement: (tag) => element(tag.toUpperCase()) };
  const root = {
    document: doc,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; }
  };
  vm.runInContext(read('js/toast.js'), vm.createContext({ window: root, globalThis: root }));
  const due = () => timers.filter((t) => !t.cleared);
  return { container, timers, due, Toast: root.Toast };
}

describe('a toast', () => {
  test('that confirms stays five seconds, and not while the pointer or the focus is on it', () => {
    const { Toast, due } = toastPage();
    const { toast } = Toast.show('Status changed to failed', 'success');
    assert.deepEqual(due().map((t) => t.ms), [5000]);
    toast.fire('mouseenter');
    assert.equal(due().length, 0, 'paused under the pointer');
    toast.fire('mouseleave');
    assert.deepEqual(due().map((t) => t.ms), [5000]);
    toast.fire('focusin');
    assert.equal(due().length, 0, 'paused while focused');
  });

  test('that reports a failure stays until it is dismissed, and is announced at once', () => {
    const { Toast, due } = toastPage();
    const { toast } = Toast.show("Couldn't change the status: network down", 'error');
    assert.equal(due().length, 0);
    assert.equal(toast.getAttribute('role'), 'alert');
    toast.fire('mouseleave');
    assert.equal(due().length, 0, 'leaving it does not start a clock it never had');
  });

  test('has a button that dismisses it', () => {
    const { Toast, timers } = toastPage();
    const { toast } = Toast.show('x', 'error');
    const close = toast.children.find((c) => c.className === 'toast-close');
    assert.equal(close.getAttribute('aria-label'), 'Dismiss');
    close.fire('click');
    assert.ok(toast.classes.has('leaving'));
    timers.at(-1).fn();
    assert.ok(toast.removed);
  });

  test('says its message as text, so an answer from a server is never markup', () => {
    const { Toast } = toastPage();
    const { toast } = Toast.show('<img src=x onerror=alert(1)>', 'error');
    const text = toast.children.find((c) => c.className === 'toast-text');
    assert.equal(text.textContent, '<img src=x onerror=alert(1)>');
    assert.doesNotMatch(read('js/toast.js'), /innerHTML/);
  });

  test('is one of three at most, the oldest leaving first', () => {
    const { Toast, container } = toastPage();
    const first = Toast.show('1', 'error').toast;
    for (const n of ['2', '3', '4']) Toast.show(n, 'error');
    assert.equal(container.children.length, 3);
    assert.ok(first.removed);
  });
});

describe('the arrow keys in a row of tabs', () => {
  const root = { document: { addEventListener() {} } };
  vm.runInContext(read('js/tabs.js'), vm.createContext({ window: root, globalThis: root }));
  const { target } = root.Tabs;
  const [a, b, c] = ['a', 'b', 'c'];

  test('move to the tab beside, round from the end to the start and back', () => {
    assert.equal(target([a, b, c], a, 'ArrowRight'), b);
    assert.equal(target([a, b, c], c, 'ArrowRight'), a);
    assert.equal(target([a, b, c], a, 'ArrowLeft'), c);
  });

  test('go to the first and the last with Home and End, and leave every other key alone', () => {
    assert.equal(target([a, b, c], b, 'Home'), a);
    assert.equal(target([a, b, c], b, 'End'), c);
    assert.equal(target([a, b, c], b, 'ArrowDown'), null);
    assert.equal(target([a, b, c], b, 'Tab'), null);
  });

  test('choose the tab they move to, with its own click, and stop the page scrolling', () => {
    let handler;
    const doc = { addEventListener: (type, fn) => { if (type === 'keydown') handler = fn; } };
    const r = { document: doc };
    vm.runInContext(read('js/tabs.js'), vm.createContext({ window: r, globalThis: r }));
    const tabs = ['one', 'two'].map((name) => ({ name, disabled: false, offsetParent: {}, getClientRects: () => [{}], clicked: 0, focused: 0, click() { this.clicked++; }, focus() { this.focused++; }, closest: null }));
    const list = { querySelectorAll: () => tabs };
    tabs.forEach((t) => { t.closest = (s) => (s === '[role="tab"]' ? t : s === '[role="tablist"]' ? list : null); });
    const event = { key: 'ArrowRight', target: tabs[0], prevented: false, preventDefault() { this.prevented = true; } };
    handler(event);
    assert.equal(tabs[1].clicked, 1);
    assert.equal(tabs[1].focused, 1);
    assert.ok(event.prevented);
  });

  test('are loaded by both pages that have tabs, after dialog.js and before the page script', () => {
    for (const page of ['dashboard.html', 'payment.html']) {
      const html = read(page);
      assert.match(html, /<script src="\/js\/dialog\.js"><\/script>\s*<script src="\/js\/toast\.js"><\/script>\s*<script src="\/js\/tabs\.js"><\/script>/, page);
    }
  });
});

describe('the page behind a dialog', () => {
  function page() {
    const listeners = {};
    const header = { tagName: 'HEADER', inert: false, classList: { contains: () => false } };
    const main = { tagName: 'MAIN', inert: false, classList: { contains: () => false } };
    const already = { tagName: 'DIV', inert: true, classList: { contains: () => false } };
    const toasts = { tagName: 'DIV', id: 'toast-container', inert: false, classList: { contains: () => false } };
    const overlays = [];
    const mk = () => {
      const o = { tagName: 'DIV', inert: false, active: false, classList: { add(c) { if (c === 'active') o.active = true; }, remove(c) { if (c === 'active') o.active = false; }, contains: (c) => c === 'modal-overlay' || (c === 'active' && o.active) }, querySelector: () => null, querySelectorAll: () => [], focus() {}, hasAttribute: () => true, getClientRects: () => [{}], offsetParent: {} };
      overlays.push(o);
      return o;
    };
    const one = mk();
    const two = mk();
    const doc = {
      activeElement: null,
      body: { children: [header, main, already, toasts, one, two] },
      addEventListener: (t, fn) => (listeners[t] = fn),
      querySelectorAll: (s) => (s === '.modal-overlay.active' ? overlays.filter((o) => o.active) : [])
    };
    const root = { document: doc, setTimeout: () => 0 };
    vm.runInContext(read('js/dialog.js'), vm.createContext({ window: root, globalThis: root }));
    return { root, header, main, already, toasts, one, two };
  }

  test('is inert while a dialog is open, the toasts and the dialogs excepted', () => {
    const { root, header, main, toasts, one } = page();
    root.Dialog.open(one);
    assert.equal(header.inert, true);
    assert.equal(main.inert, true);
    assert.equal(toasts.inert, false, 'a toast is announced over a dialog');
    assert.equal(one.inert, false);
  });

  test('comes back when the last dialog closes, and not before', () => {
    const { root, header, one, two } = page();
    root.Dialog.open(one);
    root.Dialog.open(two);
    root.Dialog.close(two);
    assert.equal(header.inert, true, 'one dialog is still open');
    root.Dialog.close(one);
    assert.equal(header.inert, false);
  });

  test('gives back only what it made inert', () => {
    const { root, already, one } = page();
    root.Dialog.open(one);
    root.Dialog.close(one);
    assert.equal(already.inert, true);
  });
});

describe("the row's ⋯", () => {
  const src = read('js/dashboard.js');

  test('is a disclosure, not a menu it does not behave as', () => {
    assert.doesNotMatch(src, /aria-haspopup/);
    assert.match(src, /aria-label="More actions for \$\{escapeAttr\(payment\.invoiceNo\)\}" aria-expanded="false" aria-controls="menu-\$\{escapeAttr\(payment\.invoiceNo\)\}"/);
  });

  test('puts the focus on its first item when it opens', () => {
    const body = /function toggleRowMenu\(event, invoiceNo\) \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    assert.match(body, /panel\.hidden = false;[\s\S]*panel\.querySelector\('a, button'\)\?\.focus\(\);/);
  });

  test('gives the focus back to its button on Escape', () => {
    assert.match(src, /const open = document\.querySelector\('\.row-menu-panel:not\(\[hidden\]\)'\);\s*closeAllRowMenus\(\);\s*if \(open\) open\.previousElementSibling\?\.focus\(\);/);
  });
});
