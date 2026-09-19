/**
 * Payment Detail Page JavaScript
 * Handles payment details, status updates, and callback history
 */

// State
let payment = null;
let invoiceNo = null;
let responseCodes = null;
let defaultCodes = null;
let callbackSequence = [];
let callbackMode = 'sequence'; // 'sequence' or 'custom'
let callbackPreviewPayload = null;

// Get invoice number from URL
const pathParts = window.location.pathname.split('/');
invoiceNo = pathParts[pathParts.length - 1];

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
  
  loadPayment();
  loadResponseCodes();
});

// ============ API Calls ============

async function loadPayment() {
  try {
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}`, {
      headers: authHeaders()
    });
    
    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (!data.success) {
      throw new Error(data.error || 'Payment not found');
    }

    payment = data.payment;
    renderPayment();

  } catch (error) {
    console.error('Error loading payment:', error);
    document.getElementById('invoice-display').textContent = 'Error: ' + error.message;
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

async function updatePaymentStatus(status, respCode = null) {
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
      showToast(data.message || `Status updated to ${status}`, 'success');
      
      // Check if should send callback
      if (document.getElementById('send-callback-after').checked) {
        await sendCallback();
      } else {
        loadPayment();
      }
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast('Failed to update status: ' + error.message, 'error');
  }
}

async function sendCallback() {
  const btn = document.getElementById('btn-send-callback');
  const originalText = btn.innerHTML;
  btn.innerHTML = '⏳ Sending...';
  btn.disabled = true;

  try {
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}/callback`, {
      method: 'POST',
      headers: authHeaders()
    });

    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);

    if (data.success) {
      showToast(`Callback sent successfully (${data.result.responseTime}ms)`, 'success');
    } else {
      showToast('Callback failed: ' + (data.error || data.result?.error || 'Unknown error'), 'error');
    }

    loadPayment();

  } catch (error) {
    showToast('Failed to send callback: ' + error.message, 'error');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function deletePaymentAndRedirect() {
  if (!confirm(`Are you sure you want to delete payment "${invoiceNo}"? This cannot be undone.`)) {
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
      // Redirect to dashboard after short delay
      setTimeout(() => {
        window.location.href = '/';
      }, 500);
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast('Failed to delete payment: ' + error.message, 'error');
  }
}

// ============ Rendering ============

function renderPayment() {
  // Detect provider (default to 2c2p for backward compatibility)
  const provider = payment.provider || '2c2p';
  const isOmise = provider === 'omise';
  
  // Header with provider badge
  document.getElementById('invoice-display').textContent = payment.invoiceNo;
  document.title = `${payment.invoiceNo} - Paygate Sandbox (${provider.toUpperCase()})`;
  
  // Add provider badge to header if element exists
  const providerBadgeEl = document.getElementById('provider-badge');
  if (providerBadgeEl) {
    const providerBadge = isOmise
      ? '<span class="provider-badge badge-omise">💳 Omise</span>'
      : '<span class="provider-badge badge-2c2p">🏦 2C2P</span>';
    providerBadgeEl.innerHTML = providerBadge;
  }

  // Status badge
  const statusBadge = document.getElementById('status-badge');
  statusBadge.textContent = payment.status.toUpperCase();
  statusBadge.className = `badge badge-${payment.status}`;

  // Info fields
  document.getElementById('info-invoice').textContent = payment.invoiceNo;
  document.getElementById('info-amount').textContent = formatAmount(payment.amount);
  document.getElementById('info-currency').textContent = payment.currencyCode;
  document.getElementById('info-merchant').textContent = payment.merchantID;
  document.getElementById('info-tranref').textContent = payment.tranRef || '-';
  document.getElementById('info-approval').textContent = payment.approvalCode || '-';
  
  // Payment method display
  const paymentMethod = payment.paymentMethod || payment.channelCode || payment.paymentChannel?.[0] || '-';
  const methodLabels = {
    'CC': '💳 Credit Card (Non-3DS)',
    '3DS': '🔒 3D Secure Card',
    'QR': '📱 QR Payment',
    'DPAY': '💸 Digital Wallet',
    'PC': '🏪 Pay At Counter',
    'SSM': '🤖 Self Service Machine',
    'IB': '🌐 Internet Banking',
    'WAP': '🌍 Web Payment',
    'APP': '📲 Mobile App Payment',
    'DC': '💳 Debit Card'
  };
  const methodDisplay = methodLabels[paymentMethod] || paymentMethod;
  document.getElementById('info-method').textContent = methodDisplay;
  
  // Show/hide Direct API specific fields
  const qrItem = document.getElementById('info-qr-item');
  const qrCodeEl = document.getElementById('info-qr-code');
  if (payment.qrCode && paymentMethod === 'QR') {
    qrItem.style.display = 'block';
    qrCodeEl.textContent = payment.qrCode;
    if (payment.qrPaymentUrl) {
      renderLink(qrCodeEl, payment.qrPaymentUrl, payment.qrCode);
    }
  } else {
    qrItem.style.display = 'none';
  }
  
  const refItem = document.getElementById('info-ref-item');
  const refEl = document.getElementById('info-payment-ref');
  if (payment.paymentReference && (paymentMethod === 'PC' || paymentMethod === 'SSM')) {
    refItem.style.display = 'block';
    refEl.textContent = payment.paymentReference;
  } else {
    refItem.style.display = 'none';
  }
  
  const redirectItem = document.getElementById('info-redirect-item');
  const redirectEl = document.getElementById('info-redirect-url');
  if (payment.redirectUrl && (paymentMethod === '3DS' || paymentMethod === 'DPAY' || paymentMethod === 'IB')) {
    redirectItem.style.display = 'block';
    renderLink(redirectEl, payment.redirectUrl, payment.redirectUrl);
  } else if (payment.webPaymentUrl && paymentMethod === '3DS') {
    redirectItem.style.display = 'block';
    renderLink(redirectEl, payment.webPaymentUrl, payment.webPaymentUrl);
  } else {
    redirectItem.style.display = 'none';
  }
  
  // Provider-specific labels and values
  const respCodeLabelEl = document.getElementById('resp-code-label');
  const respDescLabelEl = document.getElementById('resp-desc-label');
  
  if (isOmise) {
    // For Omise, show charge status instead of response code
    const omiseStatusMap = {
      pending: 'pending',
      success: 'successful',
      failed: 'failed',
      cancelled: 'reversed',
      expired: 'expired'
    };
    const chargeStatus = omiseStatusMap[payment.status] || 'pending';
    
    // Update labels for Omise format
    if (respCodeLabelEl) respCodeLabelEl.textContent = 'Charge Status';
    if (respDescLabelEl) respDescLabelEl.textContent = 'Failure Message';
    
    document.getElementById('info-respcode').textContent = chargeStatus;
    document.getElementById('info-respdesc').textContent = payment.respDesc || payment.description || '-';
  } else {
    // 2C2P format (default)
    if (respCodeLabelEl) respCodeLabelEl.textContent = 'Response Code';
    if (respDescLabelEl) respDescLabelEl.textContent = 'Response Desc';
    
    document.getElementById('info-respcode').textContent = payment.respCode || '-';
    document.getElementById('info-respdesc').textContent = payment.respDesc || '-';
  }
  
  document.getElementById('info-description').textContent = payment.description || '-';
  document.getElementById('info-token').textContent = payment.paymentToken;
  document.getElementById('info-backend-url').textContent = payment.backendReturnUrl || 'Not configured';
  document.getElementById('info-created').textContent = formatDateTime(payment.createdAt);
  document.getElementById('info-updated').textContent = formatDateTime(payment.updatedAt);

  // Disable callback button if no URL
  const callbackBtn = document.getElementById('btn-send-callback');
  if (!payment.backendReturnUrl) {
    callbackBtn.disabled = true;
    callbackBtn.title = 'No callback URL configured';
  }

  // Render status history
  renderStatusHistory();

  // Render callback history
  renderCallbackHistory();

  // Render inquiry simulation settings
  renderInquiryConfig();

  // Update modal
  const currentStatusBadge = document.getElementById('current-status-badge');
  if (currentStatusBadge) {
    currentStatusBadge.textContent = payment.status.toUpperCase();
    currentStatusBadge.className = `badge badge-${payment.status}`;
  }
}

function renderInquiryConfig() {
  // Update badge
  const badge = document.getElementById('inquiry-behavior-badge');
  const behavior = payment.inquiryBehavior || 'normal';
  badge.textContent = behavior.toUpperCase();
  badge.className = `badge badge-${behavior === 'normal' ? 'success' : behavior === 'timeout' ? 'failed' : 'pending'}`;
  
  // Update form values
  document.getElementById('inquiry-behavior').value = behavior;
  document.getElementById('inquiry-delay').value = payment.inquiryDelay || 5000;
  if (payment.inquiryErrorCode) {
    document.getElementById('inquiry-error-code').value = payment.inquiryErrorCode;
  }
  
  // Show/hide conditional fields
  onInquiryBehaviorChange();
}

function onInquiryBehaviorChange() {
  const behavior = document.getElementById('inquiry-behavior').value;
  const delayGroup = document.getElementById('inquiry-delay-group');
  const errorGroup = document.getElementById('inquiry-error-group');
  
  delayGroup.style.display = behavior === 'delay' ? 'block' : 'none';
  errorGroup.style.display = behavior === 'error' ? 'block' : 'none';
}

async function saveInquiryConfig() {
  const behavior = document.getElementById('inquiry-behavior').value;
  const delay = parseInt(document.getElementById('inquiry-delay').value, 10) || 0;
  const errorCode = document.getElementById('inquiry-error-code').value;
  
  try {
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}/inquiry-config`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        behavior,
        delay,
        errorCode
      })
    });
    
    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);
    
    if (data.success) {
      showToast(`Inquiry behavior set to: ${behavior}`, 'success');
      loadPayment();
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast('Failed to save inquiry config: ' + error.message, 'error');
  }
}

async function resetInquiryConfig() {
  try {
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}/inquiry-config`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        behavior: 'normal',
        delay: 0,
        errorCode: null
      })
    });
    
    if (handleAuthError(response)) return;
    
    const data = await safeParseJson(response);
    
    if (data.success) {
      showToast('Inquiry behavior reset to normal', 'success');
      loadPayment();
    } else {
      throw new Error(data.error);
    }
  } catch (error) {
    showToast('Failed to reset inquiry config: ' + error.message, 'error');
  }
}

function renderStatusHistory() {
  const timeline = document.getElementById('status-timeline');
  const history = payment.statusHistory || [];

  if (history.length === 0) {
    timeline.innerHTML = `
      <div class="empty-state" style="padding: 1rem;">
        <p style="color: var(--text-muted);">No status changes recorded</p>
      </div>
    `;
    return;
  }

  // Sort by date descending (newest first)
  const sorted = [...history].sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt));

  timeline.innerHTML = sorted.map(entry => `
    <div class="timeline-item">
      <div class="timeline-time">${formatDateTime(entry.changedAt)}</div>
      <div class="timeline-content">
        <span class="badge badge-${entry.status}" style="font-size: 0.7rem;">
          ${entry.status.toUpperCase()}
        </span>
        ${entry.respCode ? `
          <span style="color: var(--accent); font-family: var(--font-mono); font-size: 0.75rem; margin-left: 0.5rem;">
            [${entry.respCode}]
          </span>
        ` : ''}
        ${entry.previousStatus ? `
          <span style="color: var(--text-muted); margin: 0 0.5rem;">←</span>
          <span style="color: var(--text-muted); text-decoration: line-through;">
            ${entry.previousStatus}
          </span>
        ` : ''}
        <span style="color: var(--text-muted); margin-left: 0.5rem; font-size: 0.8rem;">
          by ${entry.changedBy || entry.source || 'unknown'}
        </span>
        ${entry.respDesc && entry.status !== 'success' ? `
          <div style="color: var(--text-muted); font-size: 0.75rem; margin-top: 0.25rem;">
            ${entry.respDesc}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

function renderCallbackHistory() {
  const container = document.getElementById('callback-history');
  const countBadge = document.getElementById('callback-count');
  const history = payment.callbackHistory || [];

  countBadge.textContent = history.length;

  if (history.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 2rem;">
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-title">No callbacks sent yet</div>
        <p>Click "Send Callback" to notify your system</p>
      </div>
    `;
    return;
  }

  // Sort by date descending (newest first)
  const sorted = [...history].sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));

  container.innerHTML = sorted.map((entry, index) => `
    <div class="callback-item">
      <div class="callback-status ${entry.success ? 'success' : 'failed'}"></div>
      <div class="callback-info">
        <div class="callback-time">${formatDateTime(entry.sentAt)}</div>
        <div class="callback-details">
          ${entry.success ? 
            `<span style="color: var(--success);">✓ Success</span> - HTTP ${entry.responseStatus}` :
            `<span style="color: var(--error);">✕ Failed</span> - ${entry.error || 'HTTP ' + entry.responseStatus}`
          }
        </div>
      </div>
      <div class="callback-response-time">
        ${entry.responseTime}ms
      </div>
    </div>
  `).join('');
}

// ============ Modals ============

function openStatusModal() {
  const modal = document.getElementById('status-modal');
  document.getElementById('new-status').value = payment.status;
  document.getElementById('send-callback-after').checked = false;
  onStatusChange(); // Update response code dropdown
  modal.classList.add('active');
}

function closeStatusModal() {
  document.getElementById('status-modal').classList.remove('active');
}

function onStatusChange() {
  const status = document.getElementById('new-status').value;
  const respCodeGroup = document.getElementById('resp-code-group');
  const respCodeSelect = document.getElementById('resp-code');
  
  // Get provider from payment (default to 2c2p for backward compatibility)
  const provider = payment?.provider || '2c2p';
  
  // Show response code dropdown for non-success statuses
  if (status !== 'success' && responseCodes && responseCodes[provider] && responseCodes[provider][status]) {
    respCodeGroup.style.display = 'block';
    
    // Populate dropdown
    const codes = responseCodes[provider][status];
    const providerDefaultCodes = defaultCodes?.[provider] || {};
    let optionsHtml = '';
    
    // Group by category if available
    const categories = {};
    codes.forEach(code => {
      const category = code.category || 'General';
      if (!categories[category]) categories[category] = [];
      categories[category].push(code);
    });
    
    if (Object.keys(categories).length > 1) {
      // Multiple categories - use optgroups
      for (const [category, categoryCodes] of Object.entries(categories)) {
        optionsHtml += `<optgroup label="${category}">`;
        categoryCodes.forEach(c => {
          const isDefault = c.code === providerDefaultCodes[status];
          optionsHtml += `<option value="${c.code}" ${isDefault ? 'selected' : ''}>${c.code} - ${c.desc}</option>`;
        });
        optionsHtml += `</optgroup>`;
      }
    } else {
      // Single category - flat list
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

function confirmUpdateStatus() {
  const status = document.getElementById('new-status').value;
  let respCode = null;
  
  // Get response code if visible
  const respCodeGroup = document.getElementById('resp-code-group');
  if (respCodeGroup.style.display !== 'none') {
    respCode = document.getElementById('resp-code').value;
  }
  
  updatePaymentStatus(status, respCode);
  closeStatusModal();
}

// ============ Callback Sequence Modal ============

function openCallbackModal() {
  resetCustomFields();
  loadCustomFieldPresets();
  
  // Initialize with one default callback using current payment status
  callbackSequence = [{
    status: payment.status,
    respCode: payment.respCode || getDefaultRespCode(payment.status),
    delayAfter: 0
  }];
  renderCallbackSequence();
  
  // Reset to sequence mode and load preview if needed
  callbackMode = 'sequence';
  switchCallbackMode('sequence');
  
  document.getElementById('callback-modal').classList.add('active');
}

function switchCallbackMode(mode) {
  callbackMode = mode;
  
  // Update button styles
  document.getElementById('callback-mode-sequence').classList.toggle('active', mode === 'sequence');
  document.getElementById('callback-mode-custom').classList.toggle('active', mode === 'custom');
  
  // Show/hide mode containers
  document.getElementById('callback-sequence-mode').style.display = mode === 'sequence' ? 'block' : 'none';
  document.getElementById('callback-custom-mode').style.display = mode === 'custom' ? 'block' : 'none';
  
  // Update send button text
  const sendBtn = document.getElementById('callback-send-btn');
  sendBtn.textContent = mode === 'sequence' ? 'Send Sequence' : 'Send Custom Payload';
  
  // Load preview when switching to custom mode
  if (mode === 'custom' && !callbackPreviewPayload) {
    loadCallbackPreview();
  }
}

async function loadCallbackPreview() {
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
    
    const response = await fetch(`/api/admin/payments/${encodeURIComponent(invoiceNo)}?preview=callback`, {
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
      errorDiv.style.display = 'none';
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
    editor.value = JSON.stringify(callbackPreviewPayload, null, 2);
    const errorDiv = document.getElementById('callback-json-error');
    errorDiv.style.display = 'none';
  } else {
    loadCallbackPreview();
  }
}

function formatCallbackPayload() {
  const editor = document.getElementById('callback-payload-editor');
  const errorDiv = document.getElementById('callback-json-error');
  
  try {
    const parsed = JSON.parse(editor.value);
    editor.value = JSON.stringify(parsed, null, 2);
    errorDiv.style.display = 'none';
  } catch (error) {
    errorDiv.textContent = 'Invalid JSON: ' + error.message;
    errorDiv.style.display = 'block';
  }
}

function validateCallbackPayload() {
  const editor = document.getElementById('callback-payload-editor');
  const errorDiv = document.getElementById('callback-json-error');
  
  try {
    const parsed = JSON.parse(editor.value);
    errorDiv.style.display = 'none';
    return parsed;
  } catch (error) {
    errorDiv.textContent = 'Invalid JSON: ' + error.message;
    errorDiv.style.display = 'block';
    return null;
  }
}

async function sendCustomCallback() {
  const editor = document.getElementById('callback-payload-editor');
  const payload = validateCallbackPayload();
  
  if (!payload) {
    showToast('Please fix JSON errors before sending', 'error');
    return;
  }
  
  closeCallbackModal();
  
  const btn = document.getElementById('btn-send-callback');
  const originalText = btn.innerHTML;
  btn.innerHTML = '⏳ Sending...';
  btn.disabled = true;
  
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
      showToast(`Custom callback sent successfully (${responseTime}ms)`, 'success');
    } else {
      showToast('Callback failed: ' + (data.error || 'Unknown error'), 'error');
    }
    
    loadPayment();
    
  } catch (error) {
    showToast('Failed to send callback: ' + error.message, 'error');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

function handleCallbackSend() {
  if (callbackMode === 'sequence') {
    sendCallbackSequence();
  } else {
    sendCustomCallback();
  }
}

function closeCallbackModal() {
  document.getElementById('callback-modal').classList.remove('active');
  resetCustomFields();
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
  
  // Auto-update respCode when status changes
  if (field === 'status') {
    callbackSequence[index].respCode = getDefaultRespCode(value);
    renderCallbackSequence();
  }
}

function renderCallbackSequence() {
  const container = document.getElementById('callback-sequence-list');
  
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
             title="Delay after this callback (ms)">
      <button class="sequence-item-remove" onclick="removeCallbackFromSequence(${index})" title="Remove">
        ✕
      </button>
    </div>
  `).join('');
}

function getResponseCodeOptions(status, selectedCode) {
  // Get provider from payment (default to 2c2p for backward compatibility)
  const provider = payment?.provider || '2c2p';
  
  // Use response codes from API if available, otherwise fallback to common codes
  let codes = [];
  if (responseCodes && responseCodes[provider] && responseCodes[provider][status]) {
    codes = responseCodes[provider][status];
  } else {
    // Fallback to common response codes
    const codesByStatus = {
      success: [
        { code: '0000', desc: 'Successful' }
      ],
      pending: [
        { code: '0001', desc: 'Pending' },
        { code: '2001', desc: 'In progress' }
      ],
      failed: [
        { code: '9035', desc: 'Payment failed' },
        { code: '4010', desc: 'Insufficient funds' },
        { code: '4011', desc: 'Invalid card' },
        { code: '4051', desc: 'Expired card' },
        { code: '9999', desc: 'System error' },
        { code: '5002', desc: 'Timeout' }
      ],
      cancelled: [
        { code: '0003', desc: 'Cancelled' },
        { code: '0004', desc: 'User cancelled' }
      ],
      expired: [
        { code: '5009', desc: 'Payment expired' }
      ]
    };
    codes = codesByStatus[status] || codesByStatus.failed;
  }
  
  return codes.map(c => 
    `<option value="${c.code}" ${c.code === selectedCode ? 'selected' : ''}>${c.code} - ${c.desc}</option>`
  ).join('');
}

async function sendCallbackSequence() {
  if (callbackSequence.length === 0) {
    showToast('Please add at least one callback to the sequence', 'error');
    return;
  }
  
  // Capture custom fields before closing modal (which clears them)
  const customFields = getCustomFields();
  
  closeCallbackModal();
  
  const btn = document.getElementById('btn-send-callback');
  const originalText = btn.innerHTML;
  btn.innerHTML = '⏳ Sending...';
  btn.disabled = true;
  
  try {
    const requestBody = { sequence: callbackSequence };
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
      const count = results.length;
      // Sum up actual response times from the server
      const totalResponseTime = results.reduce((sum, r) => {
        return sum + (r.responseTime || r.historyEntry?.responseTime || 0);
      }, 0);
      showToast(`Callback sequence sent: ${count} callback(s) in ${totalResponseTime}ms`, 'success');
    } else {
      showToast('Callback failed: ' + (data.error || 'Unknown error'), 'error');
    }
    
    loadPayment();
    
  } catch (error) {
    showToast('Failed to send callback: ' + error.message, 'error');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

// ============ Utilities ============

function formatAmount(amount) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function formatDateTime(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * Render a link into a container, safely.
 *
 * Payment fields come from whoever called the provider API, so a URL is
 * untrusted input. Building the element rather than interpolating into HTML
 * avoids the attribute-injection problem, and only http(s) targets become
 * links — anything else (notably `javascript:`) is shown as plain text.
 *
 * @param {HTMLElement} container - Element to render into
 * @param {string} url - Link target
 * @param {string} label - Visible text
 */
function renderLink(container, url, label) {
  container.textContent = '';

  let safe = false;
  try {
    const parsed = new URL(url, location.origin);
    safe = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    safe = false;
  }

  if (!safe) {
    container.textContent = label ?? url ?? '';
    return;
  }

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.color = 'var(--primary)';
  link.textContent = label ?? url;
  container.appendChild(link);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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

// Auto-refresh every 10 seconds
setInterval(loadPayment, 10000);
