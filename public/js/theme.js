/**
 * The theme, set before the page paints. Loaded synchronously in every page's
 * <head>, ahead of anything that renders.
 *
 * One file because there used to be four copies of this, on four of the seven
 * pages. The other three — sign-in, the payer's page and the 404 — set nothing
 * and always drew dark, so choosing light on the dashboard lasted until the
 * next sign-out.
 *
 * A saved choice wins. Without one, the visitor's own system setting decides:
 * this used to default to dark for everyone, which is a choice made on their
 * behalf that the page had no reason to make.
 */
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch (e) {
    // Storage can be blocked; fall through to the system setting.
  }
  var theme = saved === 'light' || saved === 'dark'
    ? saved
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', theme);
})();
