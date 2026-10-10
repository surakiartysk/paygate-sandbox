/*
 * The arrow keys in a row of tabs.
 *
 * The tabs were tabs to a screen reader (role, aria-selected, aria-controls) but not to a keyboard:
 * each was its own Tab stop and Left and Right did nothing, which decision 22 named and left. Now
 * Left and Right move to the tab beside, round from the end to the start, Home and End to the
 * first and the last, and the tab moved to is chosen, as the WAI-ARIA tabs pattern does with
 * automatic activation. Choosing is the tab's own click, so whatever it switches is what switches.
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

  root.Tabs = { target };
})(typeof window !== 'undefined' ? window : globalThis);
