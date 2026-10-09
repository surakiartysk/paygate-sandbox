/*
 * What a dialog owes the person using it with a keyboard or a screen reader.
 *
 * The overlays opened and closed by adding and removing a class, and nothing else moved:
 * a dialog could open with the focus still on the button behind it, Tab walked on into
 * the page underneath, and closing it left the focus nowhere. Measured in Chromium on the
 * dashboard: after the status dialog opened, document.activeElement was still the row's
 * button, outside the dialog.
 *
 * Opening puts the focus inside, Tab and Shift+Tab stay inside while it is open, and
 * closing gives the focus back to whatever opened it. The dialogs themselves are named in
 * the markup (role="dialog", aria-modal, aria-labelledby), so this file only moves focus.
 */
(function (root) {
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** What opened each dialog, to go back to. */
  const openers = new Map();

  const shown = (element) => element.offsetParent !== null || element.getClientRects().length > 0;
  const focusablesIn = (container) => [...container.querySelectorAll(FOCUSABLE)].filter(shown);

  /**
   * Where Tab goes from `active`, within `list`: on from the last to the first, and back from
   * the first to the last. `null` where the browser's own step stays inside the list.
   */
  function nextFocus(list, active, backwards) {
    if (list.length === 0) return null;
    const at = list.indexOf(active);
    if (at === -1) return backwards ? list[list.length - 1] : list[0];
    if (backwards && at === 0) return list[list.length - 1];
    if (!backwards && at === list.length - 1) return list[0];
    return null;
  }

  /** The control to start on: the first field of the body, else the first thing there is. */
  function startingPoint(overlay) {
    const dialog = overlay.querySelector('[role="dialog"]') || overlay;
    const body = dialog.querySelector('.modal-body');
    return (body && focusablesIn(body)[0]) || focusablesIn(dialog)[0] || dialog;
  }

  /**
   * The overlay fades in and its `visibility` changes over 0.2 s, and a control cannot take the
   * focus while it is hidden: asking at once left the focus on the button behind (measured in
   * Chromium). So it is asked again, a few times, until it takes it.
   */
  function focusWhenShown(element, tries) {
    element.focus();
    if (root.document.activeElement === element || tries <= 0) return;
    root.setTimeout(() => focusWhenShown(element, tries - 1), 30);
  }

  function open(overlay) {
    openers.set(overlay, root.document.activeElement);
    overlay.classList.add('active');
    const start = startingPoint(overlay);
    if (!start.hasAttribute('tabindex') && start.tagName === 'DIV') start.setAttribute('tabindex', '-1');
    focusWhenShown(start, 8);
  }

  function close(overlay) {
    overlay.classList.remove('active');
    const back = openers.get(overlay);
    openers.delete(overlay);
    if (back && back.isConnected !== false && typeof back.focus === 'function') back.focus();
  }

  function topmost() {
    const open = [...root.document.querySelectorAll('.modal-overlay.active')];
    return open[open.length - 1] || null;
  }

  root.document.addEventListener('keydown', (event) => {
    const overlay = topmost();
    if (!overlay) return;
    if (event.key === 'Escape') {
      close(overlay);
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = overlay.querySelector('[role="dialog"]') || overlay;
    const next = nextFocus(focusablesIn(dialog), root.document.activeElement, event.shiftKey);
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });

  // A press on the dimmed area outside the dialog closes it, as it did.
  root.document.addEventListener('click', (event) => {
    const target = event.target;
    if (target && target.classList && target.classList.contains('modal-overlay') && target.classList.contains('active')) {
      close(target);
    }
  });

  root.Dialog = { open, close, nextFocus, focusWhenShown };
})(typeof window !== 'undefined' ? window : globalThis);
