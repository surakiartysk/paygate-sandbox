/*
 * The arrow keys in a row of tabs.
 *
 * The tabs were tabs to a screen reader (role, aria-selected, aria-controls) but not to a keyboard:
 * each was its own Tab stop and Left and Right did nothing, which decision 22 named and left. Now
 * Left and Right move to the tab beside, round from the end to the start, Home and End to the
 * first and the last, and the tab moved to is chosen, as the WAI-ARIA tabs pattern does with
 * automatic activation. Choosing is the tab's own click, so whatever it switches is what switches.
 *
 * And a row of tabs is one Tab stop, as the pattern asks: the chosen tab has tabindex 0 and the
 * others -1, so Tab goes from the chosen tab to what follows the row rather than through every tab.
 * The pages' own scripts choose a tab by setting aria-selected; this file watches that attribute and
 * sets tabindex to match, so those scripts did not have to learn about it.
 */
(function (root) {
  const shown = (el) => !el.disabled && (el.offsetParent !== null || el.getClientRects().length > 0);

  /** The tab a key moves to from `current` among `tabs`, or null for a key that does not move. */
  function target(tabs, current, key) {
    const at = tabs.indexOf(current);
    if (at === -1 || tabs.length === 0) return null;
    if (key === 'ArrowRight') return tabs[(at + 1) % tabs.length];
    if (key === 'ArrowLeft') return tabs[(at - 1 + tabs.length) % tabs.length];
    if (key === 'Home') return tabs[0];
    if (key === 'End') return tabs[tabs.length - 1];
    return null;
  }

  /** Make the chosen tab of `list` its one Tab stop; the first tab, if none is chosen. */
  function rove(list) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const chosen = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0];
    for (const tab of tabs) tab.setAttribute('tabindex', tab === chosen ? '0' : '-1');
  }

  function roveAll() {
    if (root.document.querySelectorAll) root.document.querySelectorAll('[role="tablist"]').forEach(rove);
  }

  roveAll();
  if (typeof root.MutationObserver === 'function' && root.document.documentElement) {
    new root.MutationObserver((changes) => {
      const lists = new Set(changes.map((change) => change.target.closest && change.target.closest('[role="tablist"]')));
      lists.forEach((list) => list && rove(list));
    }).observe(root.document.documentElement, { attributes: true, attributeFilter: ['aria-selected'], subtree: true });
  }

  root.document.addEventListener('keydown', (event) => {
    const tab = event.target && event.target.closest ? event.target.closest('[role="tab"]') : null;
    if (!tab) return;
    const list = tab.closest('[role="tablist"]');
    if (!list) return;
    const tabs = [...list.querySelectorAll('[role="tab"]')].filter(shown);
    const next = target(tabs, tab, event.key);
    if (!next || next === tab) return;
    event.preventDefault();
    next.focus();
    next.click();
  });

  root.Tabs = { target, rove };
})(typeof window !== 'undefined' ? window : globalThis);
