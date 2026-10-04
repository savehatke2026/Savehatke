/**
 * SaveHatke — Coupon Auto-Verify (Client)
 * =========================================
 * Sends the coupon + brand config to the verification server
 * and updates the UI with the result.
 */

const API_URL = 'http://localhost:3000/api/verify-coupon';

/* ── DOM refs (populated on DOMContentLoaded) ── */
let configData    = null;
let elInput       = null;
let elBtn         = null;
let elResult      = null;
let elResultIcon  = null;
let elResultText  = null;
let elSpinner     = null;

/* ── Bootstrap ── */
document.addEventListener('DOMContentLoaded', async () => {
  elInput      = document.getElementById('verify-coupon-input');
  elBtn        = document.getElementById('verify-coupon-btn');
  elResult     = document.getElementById('verify-result');
  elResultIcon = document.getElementById('verify-result-icon');
  elResultText = document.getElementById('verify-result-text');
  elSpinner    = document.getElementById('verify-spinner');

  if (!elInput || !elBtn) {
    console.warn('[auto-verify] Required DOM elements not found.');
    return;
  }

  /* Load brand config */
  try {
    const res  = await fetch('./config.json');
    if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
    configData = await res.json();
    console.log('[auto-verify] Config loaded for:', configData.brandSlug);
  } catch (err) {
    console.error('[auto-verify] Failed to load config.json:', err);
    showResult('error', 'Configuration error — config.json not found.');
    elBtn.disabled = true;
    return;
  }

  elBtn.addEventListener('click', handleVerify);
  elInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleVerify();
  });
});

/* ── Verify handler ── */
async function handleVerify() {
  const code = elInput.value.trim().toUpperCase();
  if (!code) {
    shakeInput();
    return;
  }
  if (!configData) {
    showResult('error', 'Brand config not loaded.');
    return;
  }

  setLoading(true);
  hideResult();

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        couponCode: code,
        cartUrl:    configData.cartUrl,
        selectors:  configData.selectors,
        timeout:    configData.timeout || 10000,
        waitForNav: configData.waitForNav || false
      })
    });

    if (!res.ok) throw new Error(`Server returned ${res.status}`);

    const data = await res.json();

    if (data.valid) {
      showResult('success', data.reason || 'Coupon is valid! Discount applied successfully.');
    } else {
      showResult('error', data.reason || 'Coupon is invalid or expired.');
    }
  } catch (err) {
    console.error('[auto-verify] Request failed:', err);
    showResult('error', `Verification failed: ${err.message}`);
  } finally {
    setLoading(false);
  }
}

/* ── UI helpers ── */
function setLoading(on) {
  elBtn.disabled = on;
  elInput.disabled = on;
  if (elSpinner) elSpinner.style.display = on ? 'flex' : 'none';
  elBtn.innerHTML = on
    ? '<span class="btn-spinner"></span> Verifying…'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg> Test Coupon';
}

function showResult(type, message) {
  if (!elResult) return;
  elResult.className = `verify-result verify-result--${type} verify-result--visible`;
  if (elResultIcon) {
    elResultIcon.innerHTML = type === 'success'
      ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>'
      : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  }
  if (elResultText) elResultText.textContent = message;
}

function hideResult() {
  if (elResult) elResult.className = 'verify-result';
}

function shakeInput() {
  elInput.classList.add('shake');
  elInput.focus();
  setTimeout(() => elInput.classList.remove('shake'), 500);
}
