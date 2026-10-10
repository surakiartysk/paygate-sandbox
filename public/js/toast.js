/*
 * A toast: a line that says what just happened, in the corner, without taking the focus.
 *
 * Every toast left after three seconds, a failure included, so someone who reads slowly, or who
 * looked away, lost the one sentence that said what went wrong (decision 22 named it and left it).
 * Now a failure stays until it is dismissed; a confirmation stays five seconds, and not while the
 * pointer or the focus is on it; each has a button to dismiss it; and no more than three are on
 * the screen at once, so failures that stay cannot pile up the side of the page.
 *
 * The message is text, never markup: what a server answered can be shown without being escaped.
 */
(function (root) {
  const SHOWN_FOR_MS = 5000;
  const MOST_AT_ONCE = 3;

  function show(message, type = 'success') {
    const doc = root.document;
    const container = doc.getElementById('toast-container');
    if (!container) return null;

    const toast = doc.createElement('div');
    toast.className = `toast ${type}`;
    if (type !== 'success') toast.setAttribute('role', 'alert');

    const icon = doc.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = type === 'success' ? '✓' : '✕';

    const text = doc.createElement('span');
    text.className = 'toast-text';
    text.textContent = String(message);

    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';

    toast.append(icon, text, close);
    container.appendChild(toast);
    while (container.children.length > MOST_AT_ONCE) container.removeChild(container.children[0]);

    let timer = null;
    const stop = () => {
      if (timer !== null) root.clearTimeout(timer);
      timer = null;
    };
    const dismiss = () => {
      stop();
      toast.classList.add('leaving');
      root.setTimeout(() => toast.remove(), 300);
    };
    const start = () => {
      if (type !== 'success') return;
      stop();
      timer = root.setTimeout(dismiss, SHOWN_FOR_MS);
    };

    close.addEventListener('click', dismiss);
    toast.addEventListener('mouseenter', stop);
    toast.addEventListener('focusin', stop);
    toast.addEventListener('mouseleave', start);
    toast.addEventListener('focusout', start);
    start();
    return { toast, dismiss };
  }

  root.Toast = { show, SHOWN_FOR_MS, MOST_AT_ONCE };
})(typeof window !== 'undefined' ? window : globalThis);
