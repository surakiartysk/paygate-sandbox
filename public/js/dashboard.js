/**
 * Dashboard JavaScript
 * Handles payment list, config, and interactions
 */

// State
let payments = [];
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
let currentPollInterval = 60000; // Start with 60 seconds (60 requests/hour - safe for Hobby plan: 100/hour limit)
let consecutiveNoChanges = 0;
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

// Get admin password from localStorage
function getAdminPassword() {
  return localStorage.getItem('admin_password') || '';
}

// Check if logged in
function isLoggedIn() {
  return !!getAdminPassword();
}

// Logout
function logout() {
  stopAutoRefresh();
  localStorage.removeItem('admin_password');
  document.cookie = 'admin_password=; path=/; max-age=0';
  window.location.href = '/login';
}

// Add auth header to fetch options
function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Admin-Password': getAdminPassword()
  };
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

function switchTab(tab) {
  currentTab = tab;
  
  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
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
    if (text) text.textContent = 'Refreshing...';
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

async function loadPayments(page = null) {
  const tbody = document.getElementById('payments-tbody');
  const status = document.getElementById('status-filter').value;
  const provider = document.getElementById('provider-filter')?.value || paymentsPagination.provider || 'all';
  const method = document.getElementById('method-filter')?.value || 'all';
  const search = document.getElementById('search-input').value;

  try {
    // Use provided page or current page, reset to 1 if filters change
    if (page !== null) {
      paymentsPagination.page = page;
    }
    
    // Update provider filter state
    paymentsPagination.provider = provider;
    
    const params = new URLSearchParams();
    if (provider && provider !== 'all') params.set('provider', provider);
    if (method && method !== 'all') params.set('method', method);
    if (status && status !== 'all') params.set('status', status);
    if (search) params.set('search', search);
    params.set('page', paymentsPagination.page);
    params.set('limit', paymentsPagination.limit);

    const response = await fetch(`/api/admin/payments?${params}`, {
      headers: authHeaders()
    });
    
    if (handleAuthError(response)) return;
    const data = await safeParseJson(response);

    if (!data.success) {
      throw new Error(data.error || 'Failed to load payments');
    }

    payments = data.payments;
    if (data.pagination) {
      paymentsPagination = {
        ...paymentsPagination,
        ...data.pagination
      };
      // Update lastPaymentCount for auto-refresh
      lastPaymentCount = data.pagination.total || 0;
    }
    renderPayments();
    renderPaymentsPagination();
    updateStats();

  } catch (error) {
    console.error('Error loading payments:', error);
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state">
            <div class="empty-state-icon">❌</div>
            <div class="empty-state-title">Error loading payments</div>
            <p>${error.message}</p>
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
  
  // Use adaptive polling to stay within Vercel rate limits:
  // - Hobby plan: 100 requests/hour
  // - Pro plan: 1,000 requests/hour
  // Start with 30 seconds = 120 requests/hour (exceeds Hobby, but we'll back off)
  // After no changes, increase to 60 seconds = 60 requests/hour (safe for Hobby)
  
  const poll = async () => {
    // Only refresh if we're on payments tab and page is visible
    if (currentTab !== 'payments' || document.hidden) {
      return;
    }
    
    try {
      const response = await fetch(`/api/admin/payments?page=1&limit=1`, {
        headers: authHeaders()
      });
      
      if (handleAuthError(response)) return;
      
      const data = await safeParseJson(response);
      
      if (data.success && data.pagination) {
        const currentCount = data.pagination.total || 0;
        // Only refresh if count changed (new payment added)
        if (currentCount !== lastPaymentCount && lastPaymentCount > 0) {
          lastPaymentCount = currentCount;
          loadPayments();
          // Reset to faster polling when change detected (but still safe)
          consecutiveNoChanges = 0;
          if (currentPollInterval > 30000) {
            currentPollInterval = 30000; // 30 seconds (120/hour - OK for Pro, but will back off if no more changes)
            stopAutoRefresh();
            startAutoRefresh();
          }
        } else if (lastPaymentCount === 0) {
          // Initialize count on first check
          lastPaymentCount = currentCount;
        } else {
          // No changes detected - increase interval gradually
          consecutiveNoChanges++;
          if (consecutiveNoChanges >= 2 && currentPollInterval < 60000) {
            // After 2 checks with no changes, increase to 60 seconds
            currentPollInterval = 60000; // 60 seconds = 60 requests/hour (safe for Hobby)
            stopAutoRefresh();
            startAutoRefresh();
          }
        }
      }
    } catch (error) {
      // Silently fail - don't spam errors for polling
      console.debug('Auto-refresh check failed:', error);
      // On error, back off to slower polling
      if (currentPollInterval < 60000) {
        currentPollInterval = 60000;
        stopAutoRefresh();
        startAutoRefresh();
      }
    }
  };
  
  // Initial poll
  poll();
  
  // Set up interval with current poll interval
  autoRefreshInterval = setInterval(poll, currentPollInterval);
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
  // Reset polling state when stopped
  currentPollInterval = 60000; // Reset to safe default (60 requests/hour)
  consecutiveNoChanges = 0;
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
      showToast('Configuration saved', 'success');
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast('Failed to save config: ' + error.message, 'error');
  }
}

async function updateStatus(invoiceNo, status) {
  try {
    const response = await fetch(`/api/admin/payments/${invoiceNo}/status`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ status })
    });

    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      showToast(`Status updated to ${status}`, 'success');
      loadPayments();
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast('Failed to update status: ' + error.message, 'error');
  }
}

async function sendCallbackForPayment(invoiceNo) {
  try {
    const response = await fetch(`/api/admin/payments/${invoiceNo}/callback`, {
      method: 'POST',
      headers: authHeaders()
    });

    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      showToast(`Callback sent (${data.result.responseTime}ms)`, 'success');
    } else {
      showToast('Callback failed: ' + (data.error || data.result?.error), 'error');
    }
    
    // Always refresh - callback is recorded in history even if it failed
    loadPayments();
  } catch (error) {
    showToast('Failed to send callback: ' + error.message, 'error');
  }
}

async function deletePayment(invoiceNo) {
  if (!confirm(`Are you sure you want to delete payment "${invoiceNo}"? This cannot be undone.`)) {
    return;
  }

  try {
    const response = await fetch(`/api/admin/payments/${invoiceNo}`, {
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
    showToast('Failed to delete payment: ' + error.message, 'error');
  }
}

function openClearPaymentsModal() {
  document.getElementById('clear-payments-modal').classList.add('active');
}

function closeClearPaymentsModal() {
  document.getElementById('clear-payments-modal').classList.remove('active');
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
    showToast('Failed to clear payments: ' + error.message, 'error');
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
    if (text) text.textContent = 'Refreshing...';
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
            <div class="empty-state-icon">❌</div>
            <div class="empty-state-title">Error loading logs</div>
            <p>${error.message}</p>
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
  document.getElementById('clear-logs-modal').classList.add('active');
}

function closeClearLogsModal() {
  document.getElementById('clear-logs-modal').classList.remove('active');
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
    showToast('Failed to clear logs: ' + error.message, 'error');
  }
}

// ============ Rendering ============

function renderPayments() {
  const tbody = document.getElementById('payments-tbody');

  if (payments.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <div class="empty-state-title">No payments yet</div>
            <p>Payments will appear here when your system creates them</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = payments.map(payment => {
    const provider = payment.provider || '2c2p';
    const providerBadge = provider === 'omise' 
      ? '<span class="provider-badge badge-omise">Omise</span>'
      : '<span class="provider-badge badge-2c2p">2C2P</span>';
    
    // Payment method badge
    const paymentMethod = payment.paymentMethod || payment.channelCode || payment.paymentChannel?.[0] || '-';
    const methodLabels = {
      'CC': 'Card',
      '3DS': '3DS',
      'QR': 'QR',
      'DPAY': 'Wallet',
      'PC': 'Counter',
      'SSM': 'Machine',
      'IB': 'Banking',
      'WAP': 'Web',
      'APP': 'App'
    };
    const methodBadge = methodLabels[paymentMethod] 
      ? `<span class="method-badge" style="font-size: 0.75rem; padding: 4px 8px; background: var(--bg-secondary); border-radius: 4px; font-weight: 500;">${methodLabels[paymentMethod]}</span>`
      : `<span style="font-size: 0.75rem; color: var(--text-secondary);">${escapeHtml(paymentMethod)}</span>`;
    
    const isTruncated = payment.invoiceNo && payment.invoiceNo.length > 25;
    const invoiceDisplay = truncateInvoiceNo(payment.invoiceNo);
    return `
    <tr>
      <td>
        <div style="display: flex; align-items: center; gap: 0.5rem; max-width: 100%;">
          <a href="/payment/${encodeURIComponent(payment.invoiceNo)}" style="font-family: var(--font-mono); font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeAttr(payment.invoiceNo)}">
            ${invoiceDisplay}
          </a>
          ${isTruncated ? `
            <button onclick="copyInvoiceNo(${jsArg(payment.invoiceNo)}, event)" style="flex-shrink: 0; background: none; border: none; cursor: pointer; padding: 4px; display: inline-flex; align-items: center; color: var(--text-muted); opacity: 0.7; transition: opacity 0.2s;" title="Copy full invoice ID" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          ` : ''}
        </div>
      </td>
      <td>${providerBadge}</td>
      <td>${methodBadge}</td>
      <td>
        <span class="cell-amount">${formatAmount(payment.amount)}<span class="cell-currency">${payment.currencyCode}</span></span>
      </td>
      <td>
        <span class="badge badge-${payment.status}">
          ${payment.status.toUpperCase()}
        </span>
      </td>
      <td>
        <span class="cell-count">${payment.callbackCount || 0}</span>
      </td>
      <td>
        <span class="cell-date">${formatDate(payment.createdAt)}</span>
      </td>
      <td>
        <div class="action-buttons">
          <button class="row-action row-action-status"
                  onclick="openStatusModal(${jsArg(payment.invoiceNo)})"
                  title="Change payment status">
            <span class="row-action-dot status-dot-${payment.status}"></span>
            <span>Status</span>
          </button>
          <button class="row-action row-action-primary"
                  onclick="openCallbackModal(${jsArg(payment.invoiceNo)})"
                  title="${payment.backendReturnUrl ? 'Send a callback to the merchant' : 'No callback URL configured for this payment'}"
                  ${!payment.backendReturnUrl ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
            <span>Callback</span>
          </button>
          <div class="row-menu">
            <button class="row-action row-action-icon" onclick="toggleRowMenu(event, ${jsArg(payment.invoiceNo)})"
                    title="More actions" aria-haspopup="true" aria-expanded="false">
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
            <p>Request/response logs will appear here when your system makes API calls</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = logs.map((log, index) => `
    <tr>
      <td style="white-space: nowrap;">
        <span style="color: var(--text-secondary); font-size: 0.75rem; font-family: var(--font-mono);">
          ${formatLogTime(log.timestamp)}
        </span>
      </td>
      <td>
        <span class="badge badge-${log.type}" style="font-size: 0.7rem; padding: 0.2rem 0.5rem;">
          ${formatLogType(log.type)}
        </span>
      </td>
      <td style="max-width: 200px;">
        ${log.invoiceNo ? (() => {
          const isTruncated = log.invoiceNo.length > 25;
          const invoiceDisplay = truncateInvoiceNo(log.invoiceNo);
          return `
            <div style="display: flex; align-items: center; gap: 0.5rem; max-width: 100%;">
              <a href="/payment/${encodeURIComponent(log.invoiceNo)}" style="font-family: var(--font-mono); font-size: 0.8rem; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeAttr(log.invoiceNo)}">
                ${invoiceDisplay}
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
        <span style="font-family: var(--font-mono); font-size: 0.75rem;">
          ${log.request?.method || '-'}
        </span>
      </td>
      <td style="max-width: 250px; min-width: 150px;">
        <span style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-secondary); display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" 
              title="${escapeAttr(log.request?.path || '')}">
          ${truncatePath(log.request?.path || '-')}
        </span>
      </td>
      <td style="white-space: nowrap;">
        <span class="badge ${getStatusBadgeClass(log.response?.status)}" style="font-size: 0.7rem; padding: 0.2rem 0.5rem;">
          ${log.response?.status || '-'}
        </span>
      </td>
      <td style="white-space: nowrap;">
        <span style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--accent);">
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
  const pending = payments.filter(p => p.status === 'pending').length;
  const success = payments.filter(p => p.status === 'success').length;
  const failed = payments.filter(p => p.status === 'failed' || p.status === 'cancelled').length;
  
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
    container.innerHTML = `<div class="pagination-info">Showing ${total} payment(s)</div>`;
    return;
  }
  
  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  
  container.innerHTML = `
    <div class="pagination-info">
      Showing ${start}-${end} of ${total} payment(s)
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
    container.innerHTML = `<div class="pagination-info">Showing ${total} log(s)</div>`;
    return;
  }
  
  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  
  container.innerHTML = `
    <div class="pagination-info">
      Showing ${start}-${end} of ${total} log(s)
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

// A click anywhere else, or Escape, dismisses an open menu.
document.addEventListener('click', closeAllRowMenus);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeAllRowMenus();
});

function handleStatusChange(invoiceNo, status) {
  if (status) {
    updateStatus(invoiceNo, status);
  }
}

// ============ Modals ============

async function openConfigModal() {
  await updateConfigForm();
  document.getElementById('config-modal').classList.add('active');
}

function closeConfigModal() {
  document.getElementById('config-modal').classList.remove('active');
}

async function openStatusModal(invoiceNo, preSelectStatus = null) {
  currentInvoiceNo = invoiceNo;
  
  // Load payment data to get provider info
  try {
    const response = await fetch(`/api/admin/payments/${invoiceNo}`, {
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
      document.getElementById('status-modal').classList.add('active');
    } else {
      throw new Error(data.error || 'Payment not found');
    }
  } catch (error) {
    showToast('Failed to load payment: ' + error.message, 'error');
  }
}

function closeStatusModal() {
  document.getElementById('status-modal').classList.remove('active');
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
  
  try {
    const body = { status };
    if (respCode) {
      body.respCode = respCode;
    }
    
    const response = await fetch(`/api/admin/payments/${invoiceNo}/status`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });

    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      showToast(`Status updated to ${status}`, 'success');
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
    showToast('Failed to update status: ' + error.message, 'error');
  }
}

// ============ Callback Modal ============

async function openCallbackModal(invoiceNo) {
  currentInvoiceNo = invoiceNo;
  
  // Load payment data
  try {
    const response = await fetch(`/api/admin/payments/${invoiceNo}`, {
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
      
      document.getElementById('callback-modal').classList.add('active');
    } else {
      throw new Error(data.error || 'Payment not found');
    }
  } catch (error) {
    showToast('Failed to load payment: ' + error.message, 'error');
  }
}

function closeCallbackModal() {
  document.getElementById('callback-modal').classList.remove('active');
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
  
  document.getElementById('callback-sequence-mode').style.display = mode === 'sequence' ? 'block' : 'none';
  document.getElementById('callback-custom-mode').style.display = mode === 'custom' ? 'block' : 'none';
  
  const sendBtn = document.getElementById('callback-send-btn');
  sendBtn.textContent = mode === 'sequence' ? 'Send Sequence' : 'Send Custom Payload';
  
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
    expired: '2003'      // Treat as failed
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
        { code: '4010', desc: 'Insufficient funds' },
        { code: '4011', desc: 'Invalid card' },
        { code: '4051', desc: 'Expired card' },
        { code: '9999', desc: 'System error' },
        { code: '5002', desc: 'Timeout' }
      ],
      cancelled: [{ code: '0003', desc: 'Cancelled' }, { code: '0004', desc: 'User cancelled' }],
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
      <select onchange="updateSequenceItem(${index}, 'status', this.value)">
        <option value="success" ${item.status === 'success' ? 'selected' : ''}>Success</option>
        <option value="failed" ${item.status === 'failed' ? 'selected' : ''}>Failed</option>
        <option value="pending" ${item.status === 'pending' ? 'selected' : ''}>Pending</option>
        <option value="cancelled" ${item.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
      </select>
      <select onchange="updateSequenceItem(${index}, 'respCode', this.value)">
        ${getResponseCodeOptions(item.status, item.respCode)}
      </select>
      <input type="number" value="${item.delayAfter}" min="0" step="500" placeholder="Delay (ms)"
             onchange="updateSequenceItem(${index}, 'delayAfter', parseInt(this.value) || 0)"
             title="Delay after this callback before next (ms). Note: Delay on last callback won't be applied.">
      <button class="sequence-item-remove" onclick="removeCallbackFromSequence(${index})" title="Remove">
        ✕
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
    editor.value = 'Loading preview...';
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
    showToast('Failed to load preview: ' + error.message, 'error');
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
    showToast('Please add at least one callback to the sequence', 'error');
    return;
  }
  
  if (!currentInvoiceNo) return;
  
  // Save invoiceNo, custom fields and sequence before closing modal (which clears them)
  const invoiceNo = currentInvoiceNo;
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
  
  const btn = document.getElementById('callback-send-btn');
  if (btn) {
    const originalText = btn.textContent;
    btn.textContent = '⏳ Sending...';
    btn.disabled = true;
    
    try {
      const requestBody = { sequence: sequence };
      if (customFields) {
        requestBody.customFields = customFields;
      }
      
      const response = await fetch(`/api/admin/payments/${invoiceNo}/callback`, {
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
        showToast(`Callback sequence sent: ${totalCallbacks} callback(s) in ${totalResponseTime}ms`, 'success');
      } else {
        showToast('Callback failed: ' + (data.error || 'Unknown error'), 'error');
      }
      
      loadPayments();
      
    } catch (error) {
      showToast('Failed to send callback: ' + error.message, 'error');
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
}

async function sendCustomCallback() {
  if (!currentInvoiceNo) return;
  
  // Save invoiceNo before closing modal (which clears currentInvoiceNo)
  const invoiceNo = currentInvoiceNo;
  
  const payload = validateCallbackPayload();
  
  if (!payload) {
    showToast('Please fix JSON errors before sending', 'error');
    return;
  }
  
  closeCallbackModal();
  
  const btn = document.getElementById('callback-send-btn');
  if (btn) {
    const originalText = btn.textContent;
    btn.textContent = '⏳ Sending...';
    btn.disabled = true;
    
    try {
      const response = await fetch(`/api/admin/payments/${invoiceNo}/callback`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ customPayload: payload })
      });
      
      if (handleAuthError(response)) return;
      
      const data = await safeParseJson(response);
      
      if (data.success) {
        const result = data.result;
        const responseTime = result?.responseTime || result?.historyEntry?.responseTime || 0;
        showToast(`Custom callback sent successfully (${responseTime}ms)`, 'success');
      } else {
        showToast('Callback failed: ' + (data.error || 'Unknown error'), 'error');
      }
      
      loadPayments();
      
    } catch (error) {
      showToast('Failed to send callback: ' + error.message, 'error');
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
}

function handleCallbackSend() {
  if (callbackMode === 'sequence') {
    sendCallbackSequence();
  } else {
    sendCustomCallback();
  }
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
      <div style="margin-bottom: 0.5rem; font-size: 0.85rem; color: var(--text-secondary);">
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
  
  document.getElementById('log-modal').classList.add('active');
}

function closeLogModal() {
  document.getElementById('log-modal').classList.remove('active');
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
    showToast('Invoice ID copied to clipboard', 'success');
  }).catch(err => {
    console.error('Failed to copy:', err);
    showToast('Failed to copy invoice ID', 'error');
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

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span>
    <span>${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('active');
    }
  });
});

// Close modals on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(modal => {
      modal.classList.remove('active');
    });
  }
});
