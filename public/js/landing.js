/**
 * Landing page
 *
 * Runs the guided scenario and narrates it, so a first-time visitor sees the
 * full request → callback loop without reading any documentation first.
 */

/**
 * Fill in the quick-start snippet with this deployment's own origin, so it is
 * copy-pasteable as-is rather than needing a placeholder swapped out.
 */
function renderQuickstart() {
  const origin = location.origin;
  document.getElementById('quickstart-code').textContent =
`# 1. Create a payment, pointing callbacks at the built-in inspector
SESSION=$(curl -s -X POST ${origin}/api/inspect | sed 's/.*"sessionId":"\\([^"]*\\)".*/\\1/')

curl -X POST ${origin}/api/2c2p/token \\
  -H 'Content-Type: application/json' \\
  -d "{
    \\"invoiceNo\\": \\"INV-0001\\",
    \\"amount\\": 1500,
    \\"currencyCode\\": \\"THB\\",
    \\"backendReturnUrl\\": \\"${origin}/api/inspect/\${SESSION}\\"
  }"

# 2. Settle it and fire the callback
curl -X POST ${origin}/api/admin/payments/INV-0001/callback \\
  -H 'Content-Type: application/json' \\
  -H 'X-Admin-Password: mockpay' \\
  -d '{"sequence":[{"status":"success","respCode":"0000","delayAfter":0}]}'

# 3. Read back what your webhook would have received
curl ${origin}/api/inspect/\${SESSION}`;
}

/**
 * Run the guided scenario and render each step as it comes back.
 */
async function runScenario() {
  const button = document.getElementById('run-demo');
  const output = document.getElementById('demo-output');
  const steps = document.getElementById('demo-steps');

  button.disabled = true;
  button.textContent = 'Running…';
  output.hidden = false;
  steps.innerHTML = '<li class="demo-step demo-step-running">Creating the payment…</li>';
  output.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const response = await fetch('/api/demo/scenario', { method: 'POST' });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `The demo failed with status ${response.status}`);
    }

    const data = await response.json();
    renderSteps(data);
  } catch (error) {
    steps.innerHTML = `<li class="demo-step demo-step-error">${escapeHtml(error.message)}</li>`;
  } finally {
    button.disabled = false;
    button.textContent = 'Run it again';
  }
}

/**
 * Render the narrated steps and the payload that was delivered.
 * @param {object} data - Scenario result
 */
function renderSteps(data) {
  document.getElementById('demo-invoice').textContent = data.invoiceNo;

  document.getElementById('demo-steps').innerHTML = data.steps.map(step => `
    <li class="demo-step">
      <div class="demo-step-title">${escapeHtml(step.title)}</div>
      <div class="demo-step-detail">${escapeHtml(step.detail)}</div>
      <div class="demo-step-result">${escapeHtml(step.result)}</div>
    </li>
  `).join('');

  const received = data.received?.[0];
  const wrap = document.getElementById('demo-payload-wrap');

  if (received) {
    document.getElementById('demo-payload').textContent = JSON.stringify(received.body, null, 2);
    document.getElementById('demo-inspector-link').href = `/inspector?session=${encodeURIComponent(data.sessionId)}`;
    wrap.hidden = false;
  } else {
    wrap.hidden = true;
  }
}

/**
 * Copy the quick-start snippet.
 */
async function copyQuickstart() {
  const text = document.getElementById('quickstart-code').textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be denied; select the block so it can be copied by hand.
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('quickstart-code'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
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

renderQuickstart();
