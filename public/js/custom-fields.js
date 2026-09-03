/**
 * Custom Callback Fields
 *
 * Payment providers define a fixed callback schema, but most merchant
 * integrations carry extra correlation data through the transaction — a user
 * id, a tenant, an internal order reference. This module lets you attach
 * arbitrary key/value pairs to an outgoing callback so the sandbox can
 * reproduce those payloads without hard-coding any particular merchant's
 * fields into the codebase.
 *
 * Presets are stored server-side in the simulation config, so a team can share
 * the values they use most often.
 *
 * Shared by the dashboard and the payment detail page.
 */

/** @typedef {{ key: string, value: string }} CustomField */

/** @type {CustomField[]} */
let customFields = [];

/** @type {Array<{ name: string, fields: Record<string, string> }>} */
let customFieldPresets = [];

/**
 * Reset the editor to an empty state.
 */
function resetCustomFields() {
  customFields = [];
  renderCustomFields();
  const presetSelect = document.getElementById('custom-field-preset');
  if (presetSelect) presetSelect.value = '';
}

/**
 * Add an empty row to the editor.
 */
function addCustomField() {
  customFields.push({ key: '', value: '' });
  renderCustomFields();
}

/**
 * Remove one row.
 * @param {number} index - Row index
 */
function removeCustomField(index) {
  customFields.splice(index, 1);
  renderCustomFields();
  updateCustomFieldsPreview();
}

/**
 * Update one row from its input.
 * @param {number} index - Row index
 * @param {'key'|'value'} prop - Which half of the pair changed
 * @param {string} value - New value
 */
function updateCustomField(index, prop, value) {
  if (!customFields[index]) return;
  customFields[index][prop] = value;
  updateCustomFieldsPreview();
}

/**
 * Render the editor rows.
 */
function renderCustomFields() {
  const list = document.getElementById('custom-fields-list');
  if (!list) return;

  if (customFields.length === 0) {
    list.innerHTML = '<p class="custom-fields-empty">No custom fields. The callback uses the provider schema only.</p>';
    return;
  }

  list.innerHTML = customFields.map((field, i) => `
    <div class="custom-field-row">
      <input type="text" class="form-input" placeholder="key" value="${escapeAttr(field.key)}"
             oninput="updateCustomField(${i}, 'key', this.value)">
      <input type="text" class="form-input" placeholder="value" value="${escapeAttr(field.value)}"
             oninput="updateCustomField(${i}, 'value', this.value)">
      <button type="button" class="btn-icon" onclick="removeCustomField(${i})" title="Remove field">&times;</button>
    </div>
  `).join('');
}

/**
 * Collect the editor contents as a plain object, skipping incomplete rows.
 * @returns {Record<string, string>|null} Fields, or null when none are set
 */
function getCustomFields() {
  const result = {};
  for (const { key, value } of customFields) {
    const trimmed = key.trim();
    if (trimmed) result[trimmed] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Load the editor from an object.
 * @param {Record<string, string>} obj - Fields to load
 */
function setCustomFields(obj) {
  customFields = Object.entries(obj || {}).map(([key, value]) => ({ key, value: String(value) }));
  renderCustomFields();
}

/**
 * Fetch presets from the server and populate the dropdown.
 */
async function loadCustomFieldPresets() {
  const select = document.getElementById('custom-field-preset');
  if (!select) return;

  try {
    const response = await fetch('/api/admin/config', { headers: authHeaders() });
    if (!response.ok) return;

    const data = await safeParseJson(response);
    customFieldPresets = data.config?.customFieldPresets || [];

    select.innerHTML = '<option value="">Presets…</option>' +
      customFieldPresets.map((preset, i) => `<option value="${i}">${escapeHtml(preset.name)}</option>`).join('');
  } catch {
    // Presets are a convenience; the editor works without them.
  }
}

/**
 * Apply a preset by its index in the dropdown.
 * @param {string} index - Selected index as a string
 */
function applyCustomFieldPreset(index) {
  if (index === '') return;
  const preset = customFieldPresets[Number(index)];
  if (!preset) return;

  setCustomFields(preset.fields);
  updateCustomFieldsPreview();
}

/**
 * Mirror the current fields into the custom-payload editor, so what you see in
 * the preview matches what will actually be sent.
 */
function updateCustomFieldsPreview() {
  const editor = document.getElementById('callback-payload-editor');
  if (!editor || !editor.value || typeof callbackMode === 'undefined' || callbackMode !== 'custom') return;

  try {
    const payload = JSON.parse(editor.value);
    const target = payload.payload || payload;

    // Drop keys previously injected by this editor, then re-apply the current set.
    for (const key of Object.keys(target)) {
      if (target.__customFieldKeys?.includes(key)) delete target[key];
    }
    Object.assign(target, getCustomFields() || {});

    editor.value = JSON.stringify(payload, null, 2);
  } catch {
    // Invalid JSON in the editor — leave the user's text alone.
  }
}

/**
 * Escape a string for use in an HTML attribute.
 * @param {string} str - Raw value
 * @returns {string} Escaped value
 */
function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
