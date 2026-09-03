/**
 * Callback Inspector UI
 *
 * Reads back the callbacks captured by /api/inspect/{sessionId} and renders
 * each one with its headers and payload. The session id is kept in the URL so
 * a link to a particular session can be shared or reloaded.
 */

/** @type {string|null} */
let sessionId = null;

/** @type {number|null} */
let refreshTimer = null;

/** Poll interval while auto-refresh is on. */
const REFRESH_MS = 2000;

/**
 * Resolve the session to show: the one named in the URL, the last one used, or
 * a freshly minted one.
 */
async function init() {
  const fromUrl = new URLSearchParams(location.search).get('session');
  const remembered = safeGetStorage('inspector_session');

  if (fromUrl) {
    setSession(fromUrl);
  } else if (remembered) {
    setSession(remembered);
  } else {
    await newSession();
    return;
  }

  await loadSession();
  startAutoRefresh();

  document.getElementById('auto-refresh').addEventListener('change', event => {
    if (event.target.checked) startAutoRefresh();
    else stopAutoRefresh();
  });

  document.getElementById('session-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') loadSession();
  });
}

/**
 * Point the page at a session id.
 * @param {string} id - Session id
 */
function setSession(id) {
  sessionId = id;
  document.getElementById('session-input').value = id;
  document.getElementById('callback-url').value = `${location.origin}/api/inspect/${id}`;

  safeSetStorage('inspector_session', id);

  const url = new URL(location.href);
  url.searchParams.set('session', id);
  history.replaceState(null, '', url);
}

/**
 * Ask the server for a new session id.
 */
async function newSession() {
  try {
    const response = await fetch('/api/inspect', { method: 'POST' });
    const data = await response.json();
    setSession(data.sessionId);
    await loadSession();
    startAutoRefresh();
  } catch (error) {
    renderError(`Could not create a session: ${error.message}`);
  }
}

/**
 * Fetch and render the current session's captures.
 */
async function loadSession() {
  const typed = document.getElementById('session-input').value.trim();
  if (typed && typed !== sessionId) setSession(typed);
  if (!sessionId) return;

  try {
    const response = await fetch(`/api/inspect/${encodeURIComponent(sessionId)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      renderError(body.message || `Request failed with status ${response.status}`);
      return;
    }

    const data = await response.json();
    renderCaptures(data.captures || []);
  } catch (error) {
    renderError(`Could not load the session: ${error.message}`);
  }
}

/**
 * Discard everything captured in the current session.
 */
async function clearSession() {
  if (!sessionId) return;
  await fetch(`/api/inspect/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  await loadSession();
}

/**
 * Copy the callback URL to the clipboard.
 */
async function copyCallbackUrl() {
  const input = document.getElementById('callback-url');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    // Clipboard access can be denied; fall back to selecting the text so the
    // user can copy it themselves.
    input.select();
  }
}

/**
 * Render the captured callbacks, newest first.
 * @param {Array<object>} captures - Captured requests
 */
function renderCaptures(captures) {
  const container = document.getElementById('captures');
  const count = document.getElementById('capture-count');

  count.textContent = captures.length === 0
    ? 'No callbacks yet'
    : `${captures.length} callback${captures.length === 1 ? '' : 's'} captured`;

  if (captures.length === 0) {
    container.innerHTML = `
      <div class="inspector-empty">
        <p class="inspector-empty-title">Waiting for callbacks</p>
        <p>Send one from the dashboard, or run the guided scenario from the home page.</p>
      </div>`;
    return;
  }

  container.innerHTML = [...captures].reverse().map((capture, index) => {
    const number = captures.length - index;
    const payload = capture.body?.payload || capture.body;
    const summary = summarize(payload);

    return `
      <article class="inspector-capture">
        <header class="inspector-capture-header">
          <span class="inspector-capture-number">#${number}</span>
          <span class="inspector-capture-time">${formatTime(capture.receivedAt)}</span>
          ${summary.map(item => `<span class="badge ${item.className}">${escapeHtml(item.text)}</span>`).join('')}
        </header>
        <pre class="inspector-payload"><code>${escapeHtml(JSON.stringify(capture.body, null, 2))}</code></pre>
      </article>`;
  }).join('');
}

/**
 * Pull the few fields worth showing before the reader opens the payload.
 * @param {object} payload - Callback payload
 * @returns {Array<{ text: string, className: string }>} Badges
 */
function summarize(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const badges = [];

  // 2C2P
  if (payload.invoiceNo) badges.push({ text: payload.invoiceNo, className: 'badge-neutral' });
  if (payload.respCode) {
    badges.push({
      text: `respCode ${payload.respCode}`,
      className: payload.respCode === '0000' ? 'badge-success' : 'badge-error'
    });
  }
  if (payload.amount) badges.push({ text: `${payload.amount}`, className: 'badge-neutral' });

  // Omise webhooks carry the interesting parts under data/key.
  if (payload.key) badges.push({ text: payload.key, className: 'badge-neutral' });
  if (payload.data?.status) {
    badges.push({
      text: payload.data.status,
      className: payload.data.status === 'successful' ? 'badge-success' : 'badge-neutral'
    });
  }

  return badges;
}

/**
 * Show an error in place of the capture list.
 * @param {string} message - Message to display
 */
function renderError(message) {
  document.getElementById('captures').innerHTML = `
    <div class="inspector-empty">
      <p class="inspector-empty-title">Something went wrong</p>
      <p>${escapeHtml(message)}</p>
    </div>`;
}

/** Begin polling. */
function startAutoRefresh() {
  stopAutoRefresh();
  if (!document.getElementById('auto-refresh').checked) return;
  refreshTimer = setInterval(loadSession, REFRESH_MS);
}

/** Stop polling. */
function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * Format an ISO timestamp for display.
 * @param {string} iso - ISO timestamp
 * @returns {string} Local time
 */
function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString();
}

/**
 * Escape text for interpolation into HTML.
 * @param {string} text - Raw text
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Read from localStorage without throwing where it is unavailable.
 * @param {string} key - Storage key
 * @returns {string|null} Stored value
 */
function safeGetStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Write to localStorage without throwing where it is unavailable.
 * @param {string} key - Storage key
 * @param {string} value - Value to store
 */
function safeSetStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing or blocked site data — the session id stays in the URL.
  }
}

init();
