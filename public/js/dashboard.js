/**
 * Dashboard JavaScript
 * Handles payment list, config, and interactions
 */

// State
let payments = [];
let paymentCounts = {};
let config = {};
let logs = [];
let currentInvoiceNo = null;
let currentTab = 'payments';
let responseCodes = null;
let defaultCodes = null;
let currentPaymentForModal = null;
let callbackSequence = [];
let callbackMode = 'sequence';
let callbackPreviewPayload = null;
let autoRefreshInterval = null;
let lastPaymentCount = 0;
// How often auto-refresh asks: a minute, so 60 requests an hour for each open dashboard. Vercel's
// limits page names no hourly cap on requests for a Hobby plan; they count towards its monthly usage.
const POLL_INTERVAL_MS = 60000;
// Counts the list requests asked for; only the newest one's answer is used.
let paymentsRequestSeq = 0;
let autoRefreshEnabled = false; // Default disabled to prevent Vercel rate limit issues with teams

// Pagination state
let paymentsPagination = {
  page: 1,
  limit: 50, // Optimized for free tier KV
  total: 0,
  totalPages: 1,
  hasNext: false,
  hasPrev: false,
  provider: 'all'  // Provider filter: 'all', '2c2p', 'omise'
};

let logsPagination = {
  page: 1,
  limit: 50, // Optimized for free tier KV
  total: 0,
  totalPages: 1,
  hasNext: false,
  hasPrev: false
};

// Whether this browser signed in as the admin. A marker, not a credential: the
// credential is an HttpOnly session cookie the page cannot read, and the
// server decides — a stale marker only earns a 401 and a trip to /login.
function isAdmin() {
  return localStorage.getItem('admin_signed_in') === '1';
}

// Check if logged in
function isLoggedIn() {
  return isAdmin() || !!localStorage.getItem('demo_token');
}

// Older dashboards stored the admin password itself here. Nothing reads it
// now; this removes it from any browser that still holds it.
localStorage.removeItem('admin_password');

// Logout. The session cookie is HttpOnly, so ending it takes the server.
function logout() {
  stopAutoRefresh();
  localStorage.removeItem('admin_signed_in');
  localStorage.removeItem('demo_token');
  localStorage.removeItem('demo_inspector');
  fetch('/api/admin/logout', { method: 'POST' })
    .catch(() => {})
    .finally(() => { window.location.href = '/login'; });
}

// A demo visitor's token, when this browser signed in with the demo password.
// It replaces the password as the credential: see lib/demoAccess.js.
function getDemoToken() {
  return localStorage.getItem('demo_token') || '';
}

function isDemo() {
  return !isAdmin() && !!getDemoToken();
}

// Add auth header to fetch options
function authHeaders() {
  if (isDemo()) {
    return {
      'Content-Type': 'application/json',
      'X-Demo-Token': getDemoToken()
    };
  }
  // The admin's session cookie goes with every same-origin request by itself.
  return { 'Content-Type': 'application/json' };
}

/**
 * Mark the page as a demo visitor's and say so at the top.
 *
 * Hiding the admin-only controls is for the visitor's sake, not the server's:
 * the routes behind them refuse a demo token whatever the page shows.
 */
function applyDemoMode() {
  if (!isDemo()) return;
  document.body.classList.add('is-demo');

  const banner = document.createElement('div');
  banner.className = 'demo-banner';
  const inspector = localStorage.getItem('demo_inspector');
  banner.innerHTML = 'Demo: these ten payments are yours alone for a day. Change a status, send a callback, '
    + 'then see what arrived in <a class="demo-inspector-link">your inspector</a>. '
    + 'Settings and logs stay with the owner.';
  const link = banner.querySelector('.demo-inspector-link');
  if (inspector) link.href = `/inspector?session=${encodeURIComponent(inspector)}`;
  else link.replaceWith(document.createTextNode('your inspector'));
  document.body.prepend(banner);
}

// Handle 401 errors
function handleAuthError(response) {
  if (response.status === 401) {
    logout();
    return true;
  }
  return false;
}

// Safely parse JSON response with validation
async function safeParseJson(response) {
  // Check if response is OK (status 200-299)
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
  }
  
  // Check Content-Type header
  const contentType = response.headers.get('content-type');
  if (contentType && !contentType.includes('application/json')) {
    const text = await response.text().catch(() => 'Non-JSON response');
    throw new Error(`Expected JSON but got ${contentType}: ${text.substring(0, 200)}`);
  }
  
  // Parse JSON with error handling
  try {
    const text = await response.text();
    if (!text.trim()) {
      throw new Error('Empty response body');
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON response: ${error.message}`);
    }
    throw error;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Check if logged in
  if (!isLoggedIn()) {
    window.location.href = '/login';
    return;
  }
  
  // Show page after auth confirmed
  document.body.classList.add('authenticated');
  applyDemoMode();
  
  loadPayments();
  loadConfig();
  loadResponseCodes();
  // Auto-refresh will start after config is loaded if enabled
  
  // Stop auto-refresh when page is hidden or user navigates away
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopAutoRefresh();
    } else if (currentTab === 'payments') {
      startAutoRefresh();
    }
  });
  
  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    stopAutoRefresh();
  });
});

// ============ Tab Navigation ============

/** What the page's one heading and its line say for each section. Only the owner can switch. */
const SECTION_TITLES = {
  payments: {
    title: 'Payments',
    lede: "Change a payment's status or send its callback to see what your integration receives.",
  },
  logs: {
    title: 'Request logs',
    lede: 'The requests the sandbox received and what it answered.',
  },
};

function switchTab(tab) {
  currentTab = tab;

  // The heading says which section is showing, and so does the window's title.
  const section = SECTION_TITLES[tab] || SECTION_TITLES.payments;
  const title = document.querySelector('.page-title');
  const lede = document.querySelector('.page-lede');
  if (title) title.textContent = section.title;
  if (lede) lede.textContent = section.lede;
  document.title = `${section.title} · Paygate Sandbox`;
  
  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
    btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
  });
  
  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tab}`);
  });
  
  // Handle auto-refresh based on tab
  if (tab === 'payments') {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
  
  // Load data for the tab
  if (tab === 'logs' && logs.length === 0) {
    loadLogs();
  }
}

// ============ API Calls ============

async function refreshPayments() {
  const btn = document.getElementById('refresh-payments-btn');
  const icon = document.getElementById('refresh-payments-icon');
  const text = document.getElementById('refresh-payments-text');
  
  if (btn && icon) {
    btn.classList.add('refresh-disabled');
    icon.classList.add('refresh-spinning');
    if (text) text.textContent = 'Refreshing…';
  }
  
  await loadPayments();
  
  // Keep animation for a bit to show it completed
  setTimeout(() => {
    if (btn && icon) {
      btn.classList.remove('refresh-disabled');
      icon.classList.remove('refresh-spinning');
      if (text) text.textContent = 'Refresh';
    }
  }, 300);
}

/**
 * The query for the list the reader is looking at: the filters on screen and the
 * page they are on. Auto-refresh asks for exactly this, so what it compares is
 * what is displayed.
 */
function paymentsQuery() {
  const status = document.getElementById('status-filter').value;
  const provider = document.getElementById('provider-filter')?.value || paymentsPagination.provider || 'all';
  const method = document.getElementById('method-filter')?.value || 'all';
  const search = document.getElementById('search-input').value;

  const params = new URLSearchParams();
  if (provider && provider !== 'all') params.set('provider', provider);
  if (method && method !== 'all') params.set('method', method);
  if (status && status !== 'all') params.set('status', status);
  if (search) params.set('search', search);
  params.set('page', paymentsPagination.page);
  params.set('limit', paymentsPagination.limit);
  return params;
}

/**
 * Asks for the list, and returns it — or null if a newer request was asked for
 * while this one was in flight, or the session ended.
 *
 * Without the check, a slow answer to an older filter overwrote the answer to
 * the newer one: the dropdown said "success" and the rows were the pending ones.
 */
async function fetchPaymentsList() {
  const seq = ++paymentsRequestSeq;
  const response = await fetch(`/api/admin/payments?${paymentsQuery()}`, { headers: authHeaders() });

  if (handleAuthError(response)) return null;
  const data = await safeParseJson(response);
  if (seq !== paymentsRequestSeq) return null;

  if (!data.success) {
    throw new Error(data.error || 'Failed to load payments');
  }
  return data;
}

/** Which page to ask for instead, if the one asked for is past the last; otherwise null. */
function pageToLandOn(pagination) {
  if (!pagination || pagination.page <= 1) return null;
  const last = Math.max(1, pagination.totalPages || 1);
  return pagination.page > last ? last : null;
}

/** Puts a list the server answered on screen. */
function applyPaymentsList(data) {
  payments = data.payments;
  paymentCounts = data.counts || {};
  if (data.pagination) {
    paymentsPagination = {
      ...paymentsPagination,
      ...data.pagination
    };
    lastPaymentCount = data.pagination.total || 0;
  }
  renderPayments();
  renderPaymentsPagination();
  updateStats();
}

/**
 * What auto-refresh does each time it fires: ask for the list on screen, and put
 * the answer there only if it differs.
 *
 * It used to ask for the unfiltered total and compare it with the filtered count
 * the last load had stored. With a filter on they never matched, so every tick
 * reloaded the list and restarted its own timer — which polls at once — and went
 * round again: 511 requests in 185 seconds. And watching only the total, it never
 * saw a payment change status, or one deleted as another was created.
 *
 * @returns {Promise<boolean>} whether the list on screen changed
 */
async function refreshPaymentsIfChanged() {
  const data = await fetchPaymentsList();
  if (!data) return false;

  const landing = pageToLandOn(data.pagination);
  if (landing !== null) {
    paymentsPagination.page = landing;
    await loadPayments();
    return true;
  }

  const same =
    JSON.stringify(data.payments) === JSON.stringify(payments) &&
    (data.pagination?.total || 0) === paymentsPagination.total;
  if (same) return false;

  applyPaymentsList(data);
  return true;
}

async function loadPayments(page = null) {
  const tbody = document.getElementById('payments-tbody');

  try {
    // Use provided page or current page, reset to 1 if filters change
    if (page !== null) {
      paymentsPagination.page = page;
    }
    
    // Remember the provider filter, for the next load
    paymentsPagination.provider = document.getElementById('provider-filter')?.value || paymentsPagination.provider || 'all';
    
    const data = await fetchPaymentsList();
    if (!data) return;

    // The page the reader was on may be gone (its last row deleted): go to the
    // last one that exists instead of showing an empty table under a footer that
    // counts payments there is no way back to.
    const landing = pageToLandOn(data.pagination);
    if (landing !== null) {
      paymentsPagination.page = landing;
      return loadPayments();
    }

    applyPaymentsList(data);

  } catch (error) {
    console.error('Error loading payments:', error);
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty-state">
            <div class="empty-state-title">Couldn't load the payments</div>
            <p>${escapeHtml(error.message)}</p>
          </div>
        </td>
      </tr>
    `;
  } finally {
    // Reset refresh button state if it was triggered by refresh button
    const btn = document.getElementById('refresh-payments-btn');
    const icon = document.getElementById('refresh-payments-icon');
    const text = document.getElementById('refresh-payments-text');
    if (btn && btn.classList.contains('refresh-disabled')) {
      setTimeout(() => {
        if (btn && icon) {
          btn.classList.remove('refresh-disabled');
          icon.classList.remove('refresh-spinning');
          if (text) text.textContent = 'Refresh';
        }
      }, 300);
    }
  }
}

async function loadConfig() {
  try {
    const response = await fetch('/api/admin/config', {
      headers: authHeaders()
    });
    
    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      config = data.config;
      // Load auto-refresh setting (default to false if not set)
      autoRefreshEnabled = config.autoRefresh === true;
      // Start auto-refresh if enabled and on payments tab
      if (autoRefreshEnabled && currentTab === 'payments') {
        startAutoRefresh();
      }
      // updateConfigForm will be called when config modal is opened
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }
}

async function loadResponseCodes() {
  try {
    const response = await fetch('/api/admin/response-codes', {
      headers: authHeaders()
    });
    
    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);
    
    if (data.success) {
      responseCodes = data.responseCodes;
      defaultCodes = data.defaultCodes;
    }
  } catch (error) {
    console.error('Error loading response codes:', error);
  }
}

function startAutoRefresh() {
  // Clear existing interval if any
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
  }
  
  // Check if auto-refresh is enabled
  if (!autoRefreshEnabled) {
    return;
  }
  
  // Only auto-refresh on payments tab
  if (currentTab !== 'payments') {
    return;
  }
  
  const poll = async () => {
    // Only refresh if we're on payments tab and page is visible
    if (currentTab !== 'payments' || document.hidden) {
      return;
    }
    
    try {
      await refreshPaymentsIfChanged();
    } catch (error) {
      // Silently fail - don't spam errors for polling
      console.debug('Auto-refresh check failed:', error);
    }
  };
  
  // Initial poll
  poll();
  
  autoRefreshInterval = setInterval(poll, POLL_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

async function saveConfig() {
  try {
    const forceError2c2p = document.getElementById('config-error-2c2p').value || null;
    const forceErrorOmise = document.getElementById('config-error-omise').value || null;
    
    const newConfig = {
      globalDelay: parseInt(document.getElementById('config-delay').value) || 0,
      forceError2c2p: forceError2c2p === '' ? null : forceError2c2p,
      forceErrorOmise: forceErrorOmise === '' ? null : forceErrorOmise,
      failureRate: parseInt(document.getElementById('config-failure-rate').value) || 0,
      duplicateCallback: document.getElementById('config-duplicate').checked,
      autoRefresh: document.getElementById('config-auto-refresh').checked
    };
    
    // Update local state
    autoRefreshEnabled = newConfig.autoRefresh !== false;

    const response = await fetch('/api/admin/config', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(newConfig)
    });
    
    if (handleAuthError(response)) return;

    const data = await safeParseJson(response);

    if (data.success) {
      config = data.config;
      // Restart or stop auto-refresh based on setting
      if (autoRefreshEnabled && currentTab === 'payments') {
        startAutoRefresh();
      } else {
        stopAutoRefresh();
      }
      closeConfigModal();
      showToast('Settings saved', 'success');
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast("Couldn't save the settings: " + error.message, 'error');
  }
}

/**
 * Actions that are under way, by name. A button that sends a request stays
 * pressable until its answer arrives, and a second press is a second request:
 * `once` runs the work only if no other call with the same key is still going,
 * and lets go of the key whether the work succeeded or threw.
 * @returns {Promise<boolean>} false when it was skipped
 */
const actionsUnderWay = new Set();
async function once(key, work) {
  if (actionsUnderWay.has(key)) return false;
  actionsUnderWay.add(key);
  try {
    await work();
  } finally {
    actionsUnderWay.delete(key);
  }
  return true;
}

async function updateStatus(invoiceNo, status) {
  try {
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}/status`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ status })
    });

    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      showToast(`Status changed to ${status}`, 'success');
      loadPayments();
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast("Couldn't change the status: " + error.message, 'error');
  }
}

async function sendCallbackForPayment(invoiceNo) {
  try {
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}/callback`, {
      method: 'POST',
      headers: authHeaders()
    });

    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      showToast(`Callback sent (${data.result.responseTime} ms)`, 'success');
    } else {
      showToast('Callback failed: ' + (data.error || data.result?.error), 'error');
    }
    
    // Always refresh - callback is recorded in history even if it failed
    loadPayments();
  } catch (error) {
    showToast("Couldn't send the callback: " + error.message, 'error');
  }
}

async function deletePayment(invoiceNo) {
  if (!confirm(`Delete payment ${invoiceNo} and its callback history? This cannot be undone.`)) {
    return;
  }

  try {
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}`, {
      method: 'DELETE',
      headers: authHeaders()
    });

    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      showToast(`Payment ${invoiceNo} deleted`, 'success');
      loadPayments();
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast("Couldn't delete the payment: " + error.message, 'error');
  }
}

function openClearPaymentsModal() {
  Dialog.open(document.getElementById('clear-payments-modal'));
}

function closeClearPaymentsModal() {
  Dialog.close(document.getElementById('clear-payments-modal'));
}

async function confirmClearPayments() {
  closeClearPaymentsModal();

  try {
    const response = await fetch('/api/admin/payments/clear', {
      method: 'POST',
      headers: authHeaders()
    });

    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      showToast('All payments cleared', 'success');
      lastPaymentCount = 0; // Reset count for auto-refresh
      loadPayments();
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast("Couldn't clear the payments: " + error.message, 'error');
  }
}

// ============ Logs API ============

async function refreshLogs() {
  const btn = document.getElementById('refresh-logs-btn');
  const icon = document.getElementById('refresh-logs-icon');
  const text = document.getElementById('refresh-logs-text');
  
  if (btn && icon) {
    btn.classList.add('refresh-disabled');
    icon.classList.add('refresh-spinning');
    if (text) text.textContent = 'Refreshing…';
  }
  
  await loadLogs();
  
  // Keep animation for a bit to show it completed
  setTimeout(() => {
    if (btn && icon) {
      btn.classList.remove('refresh-disabled');
      icon.classList.remove('refresh-spinning');
      if (text) text.textContent = 'Refresh';
    }
  }, 300);
}

async function loadLogs(page = null) {
  const tbody = document.getElementById('logs-tbody');
  const type = document.getElementById('log-type-filter').value;
  const invoiceFilter = document.getElementById('log-invoice-filter').value;

  try {
    // Use provided page or current page
    if (page !== null) {
      logsPagination.page = page;
    }
    
    const params = new URLSearchParams();
    if (type && type !== 'all') params.set('type', type);
    if (invoiceFilter) params.set('invoiceNo', invoiceFilter);
    params.set('page', logsPagination.page);
    params.set('limit', logsPagination.limit);

    const response = await fetch(`/api/admin/logs?${params}`, {
      headers: authHeaders()
    });
    
    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (!data.success) {
      throw new Error(data.error || 'Failed to load logs');
    }

    logs = data.logs;
    
    if (data.pagination) {
      logsPagination = {
        ...logsPagination,
        ...data.pagination
      };
    }
    
    // Update TTL info
    document.getElementById('log-ttl-info').textContent = `TTL: ${data.logTTLDays} days`;
    
    renderLogs();
    renderLogsPagination();

  } catch (error) {
    console.error('Error loading logs:', error);
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty-state">
            <div class="empty-state-title">Couldn't load the logs</div>
            <p>${escapeHtml(error.message)}</p>
          </div>
        </td>
      </tr>
    `;
  } finally {
    // Reset refresh button state if it was triggered by refresh button
    const btn = document.getElementById('refresh-logs-btn');
    const icon = document.getElementById('refresh-logs-icon');
    const text = document.getElementById('refresh-logs-text');
    if (btn && btn.classList.contains('refresh-disabled')) {
      setTimeout(() => {
        if (btn && icon) {
          btn.classList.remove('refresh-disabled');
          icon.classList.remove('refresh-spinning');
          if (text) text.textContent = 'Refresh';
        }
      }, 300);
    }
  }
}

function openClearLogsModal() {
  Dialog.open(document.getElementById('clear-logs-modal'));
}

function closeClearLogsModal() {
  Dialog.close(document.getElementById('clear-logs-modal'));
}

async function confirmClearLogs() {
  closeClearLogsModal();

  try {
    const response = await fetch('/api/admin/logs', {
      method: 'DELETE',
      headers: authHeaders()
    });

    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      showToast('All logs cleared', 'success');
      loadLogs();
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast("Couldn't clear the logs: " + error.message, 'error');
  }
}

// ============ Rendering ============

function renderPayments() {
  const tbody = document.getElementById('payments-tbody');

  if (payments.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty-state">
            <div class="empty-state-title">No payments yet</div>
            <p>Payments your system creates appear here.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  /*
   * Every payment field interpolated below is supplied by whoever called the
   * provider API, which needs no authentication — so this table renders
   * attacker-controlled strings into the admin's own page.
   *
   * `invoiceNo` was the proven case: the `title` attribute one line down was
   * escaped with `escapeAttr` and the text node directly beneath it was not,
   * so `<img src=x onerror=…>` as an invoice number ran in the admin's
   * session — which then kept the admin password in localStorage. Confirmed by
   * POSTing it to /api/2c2p/token, which accepted it (respCode 0000) and
   * stored it verbatim.
   *
   * Escape anything from `payment` that reaches markup: `jsArg` for the
   * onclick attributes, `escapeAttr` for other attributes, `escapeHtml` for
   * text.
   */
  tbody.innerHTML = payments.map(payment => {
    const provider = payment.provider || '2c2p';
    // The provider and the method are words in the row: the status is the one thing that is coloured.
    const providerName = provider === 'omise' ? 'Omise' : '2C2P';
    
    // Payment method
    const paymentMethod = payment.paymentMethod || payment.channelCode || payment.paymentChannel?.[0] || '-';
    const methodLabels = {
      'CC': 'Card',
      '3DS': '3DS card',
      'QR': 'QR',
      'DPAY': 'Wallet',
      'PC': 'Counter',
      'SSM': 'Kiosk',
      'IB': 'Banking',
      'WAP': 'Web',
      'APP': 'App'
    };
    const methodName = methodLabels[paymentMethod] || escapeHtml(paymentMethod);
    
    const isTruncated = payment.invoiceNo && payment.invoiceNo.length > 25;
    const invoiceDisplay = truncateInvoiceNo(payment.invoiceNo);
    return `
    <tr class="payment-row">
      <td class="pc-invoice">
        <div style="display: flex; align-items: center; gap: 0.5rem; max-width: 100%;">
          <a href="/payment/${encodeURIComponent(payment.invoiceNo)}" style="font-family: var(--font-mono); font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeAttr(payment.invoiceNo)}">
            ${escapeHtml(invoiceDisplay)}
          </a>
          ${isTruncated ? `
            <button onclick="copyInvoiceNo(${jsArg(payment.invoiceNo)}, event)" aria-label="Copy invoice number ${escapeAttr(payment.invoiceNo)}" style="flex-shrink: 0; background: none; border: none; cursor: pointer; padding: 4px; display: inline-flex; align-items: center; color: var(--text-muted); opacity: 0.7; transition: opacity 0.2s;" title="Copy full invoice ID" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          ` : ''}
        </div>
      </td>
      <td class="pc-provider">${providerName}</td>
      <td class="pc-method">${methodName}</td>
      <td class="pc-amount">
        <span class="cell-amount">${formatAmount(payment.amount)}<span class="cell-currency">${escapeHtml(payment.currencyCode)}</span></span>
      </td>
      <td class="pc-status">
        <span class="badge badge-${payment.status}">
          ${payment.status.toUpperCase()}
        </span>
      </td>
      <td class="pc-callbacks">
        <span class="cell-count">${payment.callbackCount || 0}</span>
      </td>
      <td class="pc-created">
        <span class="cell-date">${formatDate(payment.createdAt)}</span>
      </td>
      <td class="pc-actions">
        <div class="action-buttons">
          <button class="row-action row-action-status"
                  onclick="openStatusModal(${jsArg(payment.invoiceNo)})"
                  title="Change payment status"
                  aria-label="Change status of ${escapeAttr(payment.invoiceNo)}">
            <span class="row-action-dot status-dot-${payment.status}"></span>
            <span>Status</span>
          </button>
          <button class="row-action row-action-primary"
                  onclick="openCallbackModal(${jsArg(payment.invoiceNo)})"
                  title="${payment.backendReturnUrl ? 'Send a callback to the merchant' : 'No callback URL configured for this payment'}"
                  aria-label="Send a callback for ${escapeAttr(payment.invoiceNo)}"
                  ${!payment.backendReturnUrl ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
            <span>Callback</span>
          </button>
          <div class="row-menu">
            <button class="row-action row-action-icon" onclick="toggleRowMenu(event, ${jsArg(payment.invoiceNo)})"
                    title="More actions" aria-label="More actions for ${escapeAttr(payment.invoiceNo)}" aria-expanded="false" aria-controls="menu-${escapeAttr(payment.invoiceNo)}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="1.6"></circle>
                <circle cx="12" cy="12" r="1.6"></circle>
                <circle cx="19" cy="12" r="1.6"></circle>
              </svg>
            </button>
            <div class="row-menu-panel" id="menu-${escapeAttr(payment.invoiceNo)}" hidden>
              <a href="/payment/${encodeURIComponent(payment.invoiceNo)}" class="row-menu-item">View details</a>
              <button class="row-menu-item row-menu-item-danger" onclick="deletePayment(${jsArg(payment.invoiceNo)})">
                Delete payment
              </button>
            </div>
          </div>
        </div>
      </td>
    </tr>
    `;
  }).join('');
}

// Format log type for display
function formatLogType(type) {
  const typeMap = {
    'token': 'Token',
    'inquiry': 'Inquiry',
    'payment': 'Payment (QR)',
    'info': 'Info',
    'callback': 'Callback',
    'optionDetails': 'Option Details',
    'omise-charge': 'Charge',
    'omise-charge-get': 'Charge GET',
    'omise-token': 'Token',
    'omise-source': 'Source'
  };
  
  return typeMap[type] || type.split('-').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join(' ');
}

function renderLogs() {
  const tbody = document.getElementById('logs-tbody');

  if (logs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty-state">
            <div class="empty-state-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity: 0.5;">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
            </div>
            <div class="empty-state-title">No logs yet</div>
            <p>Each API call your system makes appears here.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = logs.map((log, index) => `
    <tr>
      <td style="white-space: nowrap;">
        <span style="color: var(--text-secondary); font-size: 12px; font-family: var(--font-mono);">
          ${formatLogTime(log.timestamp)}
        </span>
      </td>
      <td>
        <span class="badge badge-${log.type}" style="font-size: 12px; padding: 0.2rem 0.5rem;">
          ${formatLogType(log.type)}
        </span>
      </td>
      <td style="max-width: 200px;">
        ${log.invoiceNo ? (() => {
          const isTruncated = log.invoiceNo.length > 25;
          const invoiceDisplay = truncateInvoiceNo(log.invoiceNo);
          return `
            <div style="display: flex; align-items: center; gap: 0.5rem; max-width: 100%;">
              <a href="/payment/${encodeURIComponent(log.invoiceNo)}" style="font-family: var(--font-mono); font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeAttr(log.invoiceNo)}">
                ${escapeHtml(invoiceDisplay)}
              </a>
              ${isTruncated ? `
                <button onclick="copyInvoiceNo(${jsArg(log.invoiceNo)}, event)" style="flex-shrink: 0; background: none; border: none; cursor: pointer; padding: 4px; display: inline-flex; align-items: center; color: var(--text-muted); opacity: 0.7; transition: opacity 0.2s;" title="Copy full invoice ID" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
              ` : ''}
            </div>
          `;
        })() : '<span style="color: var(--text-muted);">-</span>'}
      </td>
      <td style="white-space: nowrap;">
        <span style="font-family: var(--font-mono); font-size: 12px;">
          ${escapeHtml(log.request?.method || '-')}
        </span>
      </td>
      <td style="max-width: 250px; min-width: 150px;">
        <span style="font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" 
              title="${escapeAttr(log.request?.path || '')}">
          ${escapeHtml(truncatePath(log.request?.path || '-'))}
        </span>
      </td>
      <td style="white-space: nowrap;">
        <span class="badge ${getStatusBadgeClass(log.response?.status)}" style="font-size: 12px; padding: 0.2rem 0.5rem;">
          ${log.response?.status || '-'}
        </span>
      </td>
      <td style="white-space: nowrap;">
        <span style="font-family: var(--font-mono); font-size: 12px; color: var(--accent);">
          ${log.response?.duration ? `${log.response.duration}ms` : '-'}
        </span>
      </td>
      <td>
        <button class="action-btn" onclick="viewLogDetail(${index})" title="View Details">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>
      </td>
    </tr>
  `).join('');
}

function updateStats() {
  // Use pagination total for accurate count
  const total = paymentsPagination.total || payments.length;
  // From the server's counts over every page, not the loaded page, so the
  // tiles describe the same payments the total does. The third tile is every
  // way a payment can end without being paid — failed, cancelled and expired
  // — so the three add up to the total; it used to leave expired out and call
  // cancelled "failed".
  const count = (status) => paymentCounts[status] || 0;
  const pending = count('pending');
  const success = count('success');
  const failed = count('failed') + count('cancelled') + count('expired');
  
  // Provider breakdown
  const count2c2p = payments.filter(p => (p.provider || '2c2p') === '2c2p').length;
  const countOmise = payments.filter(p => p.provider === 'omise').length;

  const totalEl = document.getElementById('stat-total');
  if (totalEl) {
    totalEl.textContent = total;
    // Show provider breakdown in tooltip if we have multiple providers
    if (count2c2p > 0 && countOmise > 0) {
      totalEl.title = `Total: ${total} (2C2P: ${count2c2p} | Omise: ${countOmise})`;
    } else {
      totalEl.title = '';
    }
  }
  
  const pendingEl = document.getElementById('stat-pending');
  if (pendingEl) pendingEl.textContent = pending;
  
  const successEl = document.getElementById('stat-success');
  if (successEl) successEl.textContent = success;
  
  const failedEl = document.getElementById('stat-failed');
  if (failedEl) failedEl.textContent = failed;
}

// Pagination rendering
function renderPaymentsPagination() {
  const container = document.getElementById('payments-pagination');
  if (!container) return;
  
  const { page, totalPages, total, limit, hasNext, hasPrev } = paymentsPagination;
  
  if (totalPages <= 1) {
    container.innerHTML = `<div class="pagination-info">${total} ${total === 1 ? 'payment' : 'payments'}</div>`;
    return;
  }
  
  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  
  container.innerHTML = `
    <div class="pagination-info">
      ${start}–${end} of ${total} payments
    </div>
    <div class="pagination-controls">
      <button class="pagination-btn" onclick="goToPaymentsPage(1)" ${!hasPrev ? 'disabled' : ''} title="First page">
        ⏮
      </button>
      <button class="pagination-btn" onclick="goToPaymentsPage(${page - 1})" ${!hasPrev ? 'disabled' : ''} title="Previous page">
        ◀
      </button>
      <span class="pagination-page-info">
        Page ${page} of ${totalPages}
      </span>
      <button class="pagination-btn" onclick="goToPaymentsPage(${page + 1})" ${!hasNext ? 'disabled' : ''} title="Next page">
        ▶
      </button>
      <button class="pagination-btn" onclick="goToPaymentsPage(${totalPages})" ${!hasNext ? 'disabled' : ''} title="Last page">
        ⏭
      </button>
    </div>
  `;
}

function renderLogsPagination() {
  const container = document.getElementById('logs-pagination');
  if (!container) return;
  
  const { page, totalPages, total, limit, hasNext, hasPrev } = logsPagination;
  
  if (totalPages <= 1) {
    container.innerHTML = `<div class="pagination-info">${total} ${total === 1 ? 'log' : 'logs'}</div>`;
    return;
  }
  
  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  
  container.innerHTML = `
    <div class="pagination-info">
      ${start}–${end} of ${total} logs
    </div>
    <div class="pagination-controls">
      <button class="pagination-btn" onclick="goToLogsPage(1)" ${!hasPrev ? 'disabled' : ''} title="First page">
        ⏮
      </button>
      <button class="pagination-btn" onclick="goToLogsPage(${page - 1})" ${!hasPrev ? 'disabled' : ''} title="Previous page">
        ◀
      </button>
      <span class="pagination-page-info">
        Page ${page} of ${totalPages}
      </span>
      <button class="pagination-btn" onclick="goToLogsPage(${page + 1})" ${!hasNext ? 'disabled' : ''} title="Next page">
        ▶
      </button>
      <button class="pagination-btn" onclick="goToLogsPage(${totalPages})" ${!hasNext ? 'disabled' : ''} title="Last page">
        ⏭
      </button>
    </div>
  `;
}

// Pagination navigation
function goToPaymentsPage(page) {
  if (page < 1 || page > paymentsPagination.totalPages) return;
  loadPayments(page);
  // Scroll to top of table
  document.getElementById('payments-tbody')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function goToLogsPage(page) {
  if (page < 1 || page > logsPagination.totalPages) return;
  loadLogs(page);
  // Scroll to top of table
  document.getElementById('logs-tbody')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function updateConfigForm() {
  document.getElementById('config-delay').value = config.globalDelay || '';
  document.getElementById('config-failure-rate').value = config.failureRate || '';
  document.getElementById('config-duplicate').checked = config.duplicateCallback || false;
  document.getElementById('config-auto-refresh').checked = config.autoRefresh === true; // Default to false
  
  // Populate 2C2P error dropdown
  await populateErrorDropdown('config-error-2c2p', '2c2p', config.forceError2c2p || config.forceError || '');
  
  // Populate Omise error dropdown
  await populateErrorDropdown('config-error-omise', 'omise', config.forceErrorOmise || '');
}

async function populateErrorDropdown(selectId, provider, selectedValue) {
  const select = document.getElementById(selectId);
  if (!select) return;
  
  // Fetch response codes for the provider
  try {
    const response = await fetch(`/api/admin/response-codes?provider=${provider}`, {
      headers: authHeaders()
    });
    
    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);
    if (!data.success || !data.responseCodes) return;
    
    // Clear existing options except the first "No error" option
    select.innerHTML = '<option value="">No error (normal response)</option>';
    
    // Add failed error codes (grouped by category)
    const failedCodes = data.responseCodes.failed || [];
    const categories = {};
    
    failedCodes.forEach(code => {
      const category = code.category || 'General';
      if (!categories[category]) {
        categories[category] = [];
      }
      categories[category].push(code);
    });
    
    // Add options grouped by category
    Object.keys(categories).sort().forEach(category => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = category;
      
      categories[category].forEach(code => {
        const option = document.createElement('option');
        option.value = code.code;
        option.textContent = `${code.code} - ${code.desc}`;
        optgroup.appendChild(option);
      });
      
      select.appendChild(optgroup);
    });
    
    // Set selected value
    select.value = selectedValue || '';
  } catch (error) {
    console.error(`Failed to load ${provider} error codes:`, error);
  }
}

// ============ Event Handlers ============

function handleSearch(event) {
  if (event.key === 'Enter') {
    paymentsPagination.page = 1; // Reset to first page on search
    loadPayments(1);
  }
}

function handleLogSearch(event) {
  if (event.key === 'Enter') {
    logsPagination.page = 1; // Reset to first page on search
    loadLogs(1);
  }
}

// Reset pagination when filters change
function handleProviderFilterChange() {
  paymentsPagination.page = 1;
  loadPayments(1);
}

function handleMethodFilterChange() {
  paymentsPagination.page = 1;
  loadPayments(1);
}

function handleStatusFilterChange() {
  paymentsPagination.page = 1;
  loadPayments(1);
}

function handleLogTypeFilterChange() {
  logsPagination.page = 1;
  loadLogs(1);
}

// Expose pagination functions globally
window.goToPaymentsPage = goToPaymentsPage;
window.goToLogsPage = goToLogsPage;
window.handleProviderFilterChange = handleProviderFilterChange;
window.handleMethodFilterChange = handleMethodFilterChange;
window.handleStatusFilterChange = handleStatusFilterChange;
window.handleLogTypeFilterChange = handleLogTypeFilterChange;
window.openStatusModal = openStatusModal;
window.toggleRowMenu = toggleRowMenu;
window.deletePayment = deletePayment;
window.openCallbackModal = openCallbackModal;
window.onStatusModalChange = onStatusModalChange;
window.refreshPayments = refreshPayments;
window.refreshLogs = refreshLogs;

/**
 * Open one row's overflow menu, closing any other that is open.
 * The secondary actions live here so the destructive one is never a
 * neighbouring click target to the ones used routinely.
 *
 * @param {Event} event - Originating click
 * @param {string} invoiceNo - Row identifier
 */
function toggleRowMenu(event, invoiceNo) {
  event.stopPropagation();

  // getElementById takes the id literally, so no escaping is needed here — but
  // the id was written through escapeAttr, so match on the same decoded value.
  const panel = document.getElementById(`menu-${invoiceNo}`);
  if (!panel) return;

  const wasOpen = !panel.hidden;
  closeAllRowMenus();

  if (!wasOpen) {
    panel.hidden = false;
    panel.previousElementSibling?.setAttribute('aria-expanded', 'true');
    // A disclosure that opens with the keyboard puts the focus on its first item, so Tab does not
    // have to walk past the rest of the row to reach what it opened.
    panel.querySelector('a, button')?.focus();
  }
}

/**
 * Close every open row menu.
 */
function closeAllRowMenus() {
  document.querySelectorAll('.row-menu-panel').forEach(panel => {
    panel.hidden = true;
    panel.previousElementSibling?.setAttribute('aria-expanded', 'false');
  });
}

// A click anywhere else, or Escape, dismisses an open menu. Escape gives the focus back to the
// button that opened it: closing a panel the focus was in left the focus nowhere.
document.addEventListener('click', closeAllRowMenus);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const open = document.querySelector('.row-menu-panel:not([hidden])');
  closeAllRowMenus();
  if (open) open.previousElementSibling?.focus();
});

function handleStatusChange(invoiceNo, status) {
  if (status) {
    updateStatus(invoiceNo, status);
  }
}

// ============ Modals ============

async function openConfigModal() {
  await updateConfigForm();
  Dialog.open(document.getElementById('config-modal'));
}

function closeConfigModal() {
  Dialog.close(document.getElementById('config-modal'));
}

async function openStatusModal(invoiceNo, preSelectStatus = null) {
  currentInvoiceNo = invoiceNo;
  
  // Load payment data to get provider info
  try {
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}`, {
      headers: authHeaders()
    });
    
    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);
    
    if (data.success && data.payment) {
      currentPaymentForModal = data.payment;
      document.getElementById('status-modal-invoice').textContent = invoiceNo;
      // Use pre-selected status if provided, otherwise use current payment status
      document.getElementById('new-status').value = preSelectStatus || data.payment.status || 'pending';
      document.getElementById('send-callback-after').checked = false;
      onStatusModalChange();
      Dialog.open(document.getElementById('status-modal'));
    } else {
      throw new Error(data.error || 'Payment not found');
    }
  } catch (error) {
    showToast("Couldn't load the payment: " + error.message, 'error');
  }
}

function closeStatusModal() {
  Dialog.close(document.getElementById('status-modal'));
  currentInvoiceNo = null;
  currentPaymentForModal = null;
}

function onStatusModalChange() {
  const status = document.getElementById('new-status').value;
  const respCodeGroup = document.getElementById('resp-code-group');
  const respCodeSelect = document.getElementById('resp-code');
  
  if (!currentPaymentForModal || !responseCodes) {
    respCodeGroup.style.display = 'none';
    return;
  }
  
  const provider = currentPaymentForModal.provider || '2c2p';
  
  if (status !== 'success' && responseCodes[provider] && responseCodes[provider][status]) {
    respCodeGroup.style.display = 'block';
    
    const codes = responseCodes[provider][status];
    const providerDefaultCodes = defaultCodes?.[provider] || {};
    let optionsHtml = '';
    
    const categories = {};
    codes.forEach(code => {
      const category = code.category || 'General';
      if (!categories[category]) categories[category] = [];
      categories[category].push(code);
    });
    
    if (Object.keys(categories).length > 1) {
      for (const [category, categoryCodes] of Object.entries(categories)) {
        optionsHtml += `<optgroup label="${category}">`;
        categoryCodes.forEach(c => {
          const isDefault = c.code === providerDefaultCodes[status];
          optionsHtml += `<option value="${c.code}" ${isDefault ? 'selected' : ''}>${c.code} - ${c.desc}</option>`;
        });
        optionsHtml += `</optgroup>`;
      }
    } else {
      codes.forEach(c => {
        const isDefault = c.code === providerDefaultCodes[status];
        optionsHtml += `<option value="${c.code}" ${isDefault ? 'selected' : ''}>${c.code} - ${c.desc}</option>`;
      });
    }
    
    respCodeSelect.innerHTML = optionsHtml;
  } else {
    respCodeGroup.style.display = 'none';
  }
}

async function confirmUpdateStatus() {
  if (!currentInvoiceNo) return;
  
  // Save invoiceNo before closing modal (which clears it)
  const invoiceNo = currentInvoiceNo;
  
  const status = document.getElementById('new-status').value;
  const respCodeGroup = document.getElementById('resp-code-group');
  let respCode = null;
  
  if (respCodeGroup.style.display !== 'none') {
    respCode = document.getElementById('resp-code').value;
  }
  
  const sendCallback = document.getElementById('send-callback-after').checked;
  
  await once(`status:${invoiceNo}`, () => submitStatusUpdate(invoiceNo, status, respCode, sendCallback));
}

async function submitStatusUpdate(invoiceNo, status, respCode, sendCallback) {
  try {
    const body = { status };
    if (respCode) {
      body.respCode = respCode;
    }
    
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}/status`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });

    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      showToast(`Status changed to ${status}`, 'success');
      closeStatusModal();
      
      if (sendCallback) {
        // Open callback modal after status update
        setTimeout(() => {
          openCallbackModal(invoiceNo);
        }, 300);
      } else {
        loadPayments();
      }
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast("Couldn't change the status: " + error.message, 'error');
  }
}

// ============ Callback Modal ============

async function openCallbackModal(invoiceNo) {
  currentInvoiceNo = invoiceNo;
  
  // Load payment data
  try {
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}`, {
      headers: authHeaders()
    });
    
    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);
    
    if (data.success && data.payment) {
      currentPaymentForModal = data.payment;
      document.getElementById('callback-modal-invoice').textContent = invoiceNo;
      
      resetCustomFields();
      loadCustomFieldPresets();
      
      // Initialize callback sequence
      callbackSequence = [{
        status: data.payment.status,
        respCode: data.payment.respCode || getDefaultRespCode(data.payment.status),
        delayAfter: 0
      }];
      
      callbackMode = 'sequence';
      switchCallbackMode('sequence');
      renderCallbackSequence();
      
      Dialog.open(document.getElementById('callback-modal'));
    } else {
      throw new Error(data.error || 'Payment not found');
    }
  } catch (error) {
    showToast("Couldn't load the payment: " + error.message, 'error');
  }
}

function closeCallbackModal() {
  Dialog.close(document.getElementById('callback-modal'));
  currentInvoiceNo = null;
  currentPaymentForModal = null;
  callbackSequence = [];
  callbackPreviewPayload = null;
  resetCustomFields();
}

function switchCallbackMode(mode) {
  callbackMode = mode;
  
  document.getElementById('callback-mode-sequence').classList.toggle('active', mode === 'sequence');
  document.getElementById('callback-mode-custom').classList.toggle('active', mode === 'custom');
  document.getElementById('callback-mode-sequence').setAttribute('aria-selected', String(mode === 'sequence'));
  document.getElementById('callback-mode-custom').setAttribute('aria-selected', String(mode === 'custom'));
  
  document.getElementById('callback-sequence-mode').style.display = mode === 'sequence' ? 'block' : 'none';
  document.getElementById('callback-custom-mode').style.display = mode === 'custom' ? 'block' : 'none';
  
  const sendBtn = document.getElementById('callback-send-btn');
  sendBtn.textContent = mode === 'sequence' ? 'Send callbacks' : 'Send payload';
  
  if (mode === 'custom' && !callbackPreviewPayload) {
    loadCallbackPreview();
  }
}

/**
 * Get default response code for a payment status
 * These codes must match lib/constants.js on the backend
 * @see https://developer.2c2p.com/v4.0.2/docs/response-code-payment
 */
function getDefaultRespCode(status) {
  const RESP_CODES = {
    success: '0000',     // Success
    pending: '2001',     // Transaction in progress
    failed: '2003',      // Payment / Inquiry Failed
    cancelled: '0003',   // Transaction is cancelled
    expired: '5009'      // Payment Expired
  };
  return RESP_CODES[status] || '2001';
}

function getResponseCodeOptions(status, selectedCode) {
  if (!currentPaymentForModal) {
    return `<option value="${getDefaultRespCode(status)}">${getDefaultRespCode(status)}</option>`;
  }
  
  const provider = currentPaymentForModal.provider || '2c2p';
  
  let codes = [];
  if (responseCodes && responseCodes[provider] && responseCodes[provider][status]) {
    codes = responseCodes[provider][status];
  } else {
    // Fallback to common response codes
    const codesByStatus = {
      success: [{ code: '0000', desc: 'Successful' }],
      pending: [{ code: '0001', desc: 'Pending' }, { code: '2001', desc: 'In progress' }],
      failed: [
        { code: '9035', desc: 'Payment failed' },
        { code: '4051', desc: 'Insufficient funds' },
        { code: '4014', desc: 'Invalid card' },
        { code: '4054', desc: 'Expired card' },
        { code: '0999', desc: 'System error' },
        { code: '5002', desc: 'Timeout' }
      ],
      cancelled: [{ code: '0003', desc: 'Cancelled' }, { code: '4080', desc: 'User closed the browser' }],
      expired: [{ code: '5009', desc: 'Payment expired' }]
    };
    codes = codesByStatus[status] || codesByStatus.failed;
  }
  
  return codes.map(c => 
    `<option value="${c.code}" ${c.code === selectedCode ? 'selected' : ''}>${c.code} - ${c.desc}</option>`
  ).join('');
}

function addCallbackToSequence() {
  callbackSequence.push({
    status: 'success',
    respCode: '0000',
    delayAfter: 1000
  });
  renderCallbackSequence();
}

function removeCallbackFromSequence(index) {
  callbackSequence.splice(index, 1);
  renderCallbackSequence();
}

function updateSequenceItem(index, field, value) {
  callbackSequence[index][field] = value;
  
  // Log delay updates for debugging
  if (field === 'delayAfter') {
    console.log(`⏱️  Delay updated for callback ${index + 1}: ${value}ms`);
  }
  
  // Auto-update respCode when status changes
  if (field === 'status') {
    callbackSequence[index].respCode = getDefaultRespCode(value);
    renderCallbackSequence();
  }
}

function renderCallbackSequence() {
  const container = document.getElementById('callback-sequence-list');
  
  if (!container) return;
  
  if (callbackSequence.length === 0) {
    container.innerHTML = `
      <div class="sequence-empty">
        No callbacks configured. Click "+ Add" to add a callback.
      </div>
    `;
    return;
  }
  
  container.innerHTML = callbackSequence.map((item, index) => `
    <div class="sequence-item">
      <div class="sequence-item-num">#${index + 1}</div>
      <select aria-label="Status of callback ${index + 1}" onchange="updateSequenceItem(${index}, 'status', this.value)">
        <option value="success" ${item.status === 'success' ? 'selected' : ''}>Success</option>
        <option value="failed" ${item.status === 'failed' ? 'selected' : ''}>Failed</option>
        <option value="pending" ${item.status === 'pending' ? 'selected' : ''}>Pending</option>
        <option value="cancelled" ${item.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
      </select>
      <select aria-label="Response code of callback ${index + 1}" onchange="updateSequenceItem(${index}, 'respCode', this.value)">
        ${getResponseCodeOptions(item.status, item.respCode)}
      </select>
      <span class="sequence-item-wait">
        <input type="number" aria-label="Wait after callback ${index + 1}, in ms" value="${item.delayAfter}" min="0" step="500" placeholder="Delay (ms)"
             onchange="updateSequenceItem(${index}, 'delayAfter', parseInt(this.value) || 0)"
             title="Delay after this callback before next (ms). Note: Delay on last callback won't be applied.">
        <span aria-hidden="true">ms</span>
      </span>
      <button class="sequence-item-remove" onclick="removeCallbackFromSequence(${index})" title="Remove" aria-label="Remove callback ${index + 1}">
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  `).join('');
}

async function loadCallbackPreview() {
  if (!currentInvoiceNo) return;
  
  const editor = document.getElementById('callback-payload-editor');
  const errorDiv = document.getElementById('callback-json-error');
  
  if (!editor) {
    console.error('Callback payload editor not found');
    return;
  }
  
  try {
    editor.disabled = true;
    editor.value = 'Loading preview…';
    if (errorDiv) errorDiv.style.display = 'none';
    
    const response = await fetch(`/api/admin/payments/${currentInvoiceNo}?preview=callback`, {
      headers: authHeaders()
    });
    
    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);
    
    if (data.success && data.preview) {
      const customFields = getCustomFields();
      const preview = { ...data.preview };
      if (customFields) {
        Object.assign(preview.payload || preview, customFields);
      }
      
      callbackPreviewPayload = preview;
      editor.value = JSON.stringify(preview, null, 2);
      if (errorDiv) errorDiv.style.display = 'none';
    } else {
      throw new Error(data.error || 'Failed to load preview');
    }
  } catch (error) {
    editor.value = '';
    if (errorDiv) {
      errorDiv.textContent = 'Error loading preview: ' + error.message;
      errorDiv.style.display = 'block';
    }
    showToast("Couldn't load the preview: " + error.message, 'error');
  } finally {
    editor.disabled = false;
  }
}

function resetCallbackPayload() {
  if (callbackPreviewPayload) {
    const editor = document.getElementById('callback-payload-editor');
    if (editor) {
      editor.value = JSON.stringify(callbackPreviewPayload, null, 2);
      const errorDiv = document.getElementById('callback-json-error');
      if (errorDiv) errorDiv.style.display = 'none';
    }
  } else {
    loadCallbackPreview();
  }
}

function formatCallbackPayload() {
  const editor = document.getElementById('callback-payload-editor');
  const errorDiv = document.getElementById('callback-json-error');
  
  if (!editor) return;
  
  try {
    const parsed = JSON.parse(editor.value);
    editor.value = JSON.stringify(parsed, null, 2);
    if (errorDiv) errorDiv.style.display = 'none';
  } catch (error) {
    if (errorDiv) {
      errorDiv.textContent = 'Invalid JSON: ' + error.message;
      errorDiv.style.display = 'block';
    }
  }
}

function validateCallbackPayload() {
  const editor = document.getElementById('callback-payload-editor');
  const errorDiv = document.getElementById('callback-json-error');
  
  if (!editor) return null;
  
  try {
    const payload = JSON.parse(editor.value);
    if (errorDiv) errorDiv.style.display = 'none';
    return payload;
  } catch (error) {
    if (errorDiv) {
      errorDiv.textContent = 'Invalid JSON: ' + error.message;
      errorDiv.style.display = 'block';
    }
    return null;
  }
}

async function sendCallbackSequence() {
  if (callbackSequence.length === 0) {
    showToast('Add at least one callback first.', 'error');
    return;
  }
  
  if (!currentInvoiceNo) return;
  
  // Save invoiceNo, custom fields and sequence before closing modal (which clears them)
  const invoiceNo = currentInvoiceNo;
  if (actionsUnderWay.has(`callback:${invoiceNo}`)) {
    showToast(`A callback for ${invoiceNo} is already being sent`, 'error');
    return;
  }

  const customFields = getCustomFields();
  const sequence = [...callbackSequence]; // Create a copy before modal closes
  
  // Log sequence details for debugging
  console.log('📤 Sending callback sequence:', {
    invoiceNo: invoiceNo,
    customFields: customFields,
    sequenceLength: sequence.length,
    sequence: sequence.map((item, idx) => ({
      index: idx + 1,
      status: item.status,
      respCode: item.respCode,
      delayAfter: item.delayAfter
    }))
  });
  
  closeCallbackModal();

  // The modal is closed from here on, so there is no button to show progress
  // on; `once` is what keeps the same invoice from being sent twice at once.
  await once(`callback:${invoiceNo}`, async () => {
    try {
      const requestBody = { sequence: sequence };
      if (customFields) {
        requestBody.customFields = customFields;
      }
      
      const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}/callback`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(requestBody)
      });
      
      if (handleAuthError(response)) return;
      
      const data = await safeParseJson(response);
      
      if (data.success) {
        const results = data.results || (data.result ? [data.result] : []);
        const totalCallbacks = results.length;
        // Sum up actual response times from the server
        const totalResponseTime = results.reduce((sum, r) => {
          return sum + (r.responseTime || r.historyEntry?.responseTime || 0);
        }, 0);
        console.log('✅ Callback sequence completed:', {
          totalCallbacks,
          totalResponseTimeMs: totalResponseTime,
          results: results.map(r => ({
            sequenceIndex: r.sequenceIndex,
            status: r.status,
            responseTime: r.responseTime || r.historyEntry?.responseTime
          }))
        });
        showToast(`Sent ${totalCallbacks} ${totalCallbacks === 1 ? 'callback' : 'callbacks'} in ${totalResponseTime} ms`, 'success');
      } else {
        showToast('Callback failed: ' + (data.error || 'Unknown error'), 'error');
      }
      
      loadPayments();
      
    } catch (error) {
      showToast("Couldn't send the callback: " + error.message, 'error');
    }
  });
}

async function sendCustomCallback() {
  if (!currentInvoiceNo) return;
  
  // Save invoiceNo before closing modal (which clears currentInvoiceNo)
  const invoiceNo = currentInvoiceNo;
  
  if (actionsUnderWay.has(`callback:${invoiceNo}`)) {
    showToast(`A callback for ${invoiceNo} is already being sent`, 'error');
    return;
  }

  const payload = validateCallbackPayload();
  
  if (!payload) {
    showToast('The payload is not valid JSON. Fix it before sending.', 'error');
    return;
  }
  
  closeCallbackModal();
  
  await once(`callback:${invoiceNo}`, async () => {
    try {
      const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}/callback`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ customPayload: payload })
      });
      
      if (handleAuthError(response)) return;
      
      const data = await safeParseJson(response);
      
      if (data.success) {
        const result = data.result;
        const responseTime = result?.responseTime || result?.historyEntry?.responseTime || 0;
        showToast(`Callback sent (${responseTime} ms)`, 'success');
      } else {
        showToast('Callback failed: ' + (data.error || 'Unknown error'), 'error');
      }
      
      loadPayments();
      
    } catch (error) {
      showToast("Couldn't send the callback: " + error.message, 'error');
    }
  });
}

function handleCallbackSend() {
  return callbackMode === 'sequence' ? sendCallbackSequence() : sendCustomCallback();
}

// Expose callback functions globally
window.switchCallbackMode = switchCallbackMode;
window.addCallbackToSequence = addCallbackToSequence;
window.removeCallbackFromSequence = removeCallbackFromSequence;
window.updateSequenceItem = updateSequenceItem;
window.loadCallbackPreview = loadCallbackPreview;
window.resetCallbackPayload = resetCallbackPayload;
window.formatCallbackPayload = formatCallbackPayload;
window.handleCallbackSend = handleCallbackSend;
window.openClearPaymentsModal = openClearPaymentsModal;
window.closeClearPaymentsModal = closeClearPaymentsModal;
window.confirmClearPayments = confirmClearPayments;
window.openClearLogsModal = openClearLogsModal;
window.closeClearLogsModal = closeClearLogsModal;
window.confirmClearLogs = confirmClearLogs;
window.toggleAutoRefresh = toggleAutoRefresh;
window.copyInvoiceNo = copyInvoiceNo;

function toggleAutoRefresh() {
  const checkbox = document.getElementById('config-auto-refresh');
  autoRefreshEnabled = checkbox.checked;
  
  if (autoRefreshEnabled && currentTab === 'payments') {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

// Log Detail Modal
function viewLogDetail(index) {
  const log = logs[index];
  if (!log) return;
  
  const direction = log.request?.direction || 'incoming';
  const directionLabel = direction === 'outgoing' ? 'OUTGOING' : 'INCOMING';
  
  const modalBody = document.getElementById('log-modal-body');
  modalBody.innerHTML = `
    <div class="log-meta">
      <div class="log-meta-item">
        <span class="log-meta-label">Type:</span>
        <span class="badge badge-${log.type}">${formatLogType(log.type)}</span>
      </div>
      <div class="log-meta-item">
        <span class="log-meta-label">Time:</span>
        <span class="log-meta-value">${new Date(log.timestamp).toLocaleString()}</span>
      </div>
      <div class="log-meta-item">
        <span class="log-meta-label">Duration:</span>
        <span class="log-meta-value">${log.response?.duration || 0}ms</span>
      </div>
      <div class="log-meta-item">
        <span class="log-meta-label">Status:</span>
        <span class="log-meta-value ${log.response?.status >= 200 && log.response?.status < 300 ? 'success' : 'error'}">
          ${log.response?.status || 'N/A'}
        </span>
      </div>
    </div>
    
    <div class="log-detail-section">
      <div class="log-detail-title">
        Request
        <span class="direction ${direction}">${directionLabel}</span>
      </div>
      <div style="margin-bottom: 0.5rem; font-size: 13px; color: var(--text-secondary);">
        <strong>${escapeHtml(log.request?.method || 'UNKNOWN')}</strong> ${escapeHtml(log.request?.path || '')}
      </div>
      <div class="code-block">${formatJson(log.request?.body)}</div>
    </div>
    
    <div class="log-detail-section">
      <div class="log-detail-title">Response</div>
      <div class="code-block">${formatJson(log.response?.body)}</div>
    </div>
    
    ${log.request?.headers ? `
      <div class="log-detail-section">
        <div class="log-detail-title">Headers</div>
        <div class="code-block">${formatJson(log.request.headers)}</div>
      </div>
    ` : ''}
  `;
  
  Dialog.open(document.getElementById('log-modal'));
}

function closeLogModal() {
  Dialog.close(document.getElementById('log-modal'));
}

// ============ Utilities ============

function formatAmount(amount) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 *
 * `escapeHtml` goes through textContent, which does not escape quotes — safe
 * for text nodes, not for attributes. Payment fields are supplied by whoever
 * called the provider API, so anything interpolated into markup is untrusted.
 *
 * @param {string} value - Raw value
 * @returns {string} Attribute-safe value
 */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render a value as a quoted JavaScript string literal for an inline handler.
 *
 * Interpolating a raw value into `onclick="fn('...')"` lets a crafted invoice
 * number close the quote and append its own statements. JSON.stringify produces
 * a correctly quoted and escaped literal; the HTML escaping that follows keeps
 * it from breaking out of the attribute.
 *
 * @param {string} value - Raw value
 * @returns {string} Escaped JavaScript string literal
 */
function jsArg(value) {
  return escapeAttr(JSON.stringify(String(value)));
}

function formatLogTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function truncatePath(path) {
  if (!path) return '-';
  // Show full path if 40 chars or less, otherwise truncate
  if (path.length <= 40) return path;
  // Show first 25 chars + ... + last 12 chars for better readability
  return path.slice(0, 25) + '...' + path.slice(-12);
}

function truncateInvoiceNo(invoiceNo) {
  if (!invoiceNo) return '-';
  // Show full invoice if 25 chars or less, otherwise truncate
  if (invoiceNo.length <= 25) return invoiceNo;
  // Show first 20 chars + ...
  return invoiceNo.slice(0, 20) + '...';
}

function copyInvoiceNo(invoiceNo, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  
  navigator.clipboard.writeText(invoiceNo).then(() => {
    showToast('Invoice number copied', 'success');
  }).catch(err => {
    console.error('Failed to copy:', err);
    showToast("Couldn't copy the invoice number", 'error');
  });
}

function getStatusBadgeClass(status) {
  if (!status) return '';
  if (status >= 200 && status < 300) return 'badge-success';
  if (status >= 400 && status < 500) return 'badge-error';
  if (status >= 500) return 'badge-error';
  return 'badge-pending';
}

function formatJson(obj) {
  if (!obj) return '<span style="color: var(--text-muted);">null</span>';
  try {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    return escapeHtml(str);
  } catch {
    return escapeHtml(String(obj));
  }
}

/** How long a toast stays, and how it is dismissed, is in toast.js. */
function showToast(message, type = 'success') {
  window.Toast.show(message, type);
}

// Closing on a press outside a dialog, and on Escape, is in dialog.js.
