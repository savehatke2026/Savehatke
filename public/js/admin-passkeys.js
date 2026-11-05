(function () {
  'use strict';

  const status = document.getElementById('shPasskeyStatus');
  const list = document.getElementById('shPasskeyList');
  const registerButton = document.getElementById('shRegisterPasskey');

  function setStatus(message, kind) {
    if (!status) return;
    status.textContent = message || '';
    status.style.color = kind === 'error' ? '#ff9999' : kind === 'success' ? '#69e5b5' : '#9eb8d0';
  }

  async function request(path, options) {
    const response = await fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    }, options || {}));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function fmtDate(value) {
    if (!value) return 'Never used';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function renderRows(rows) {
    if (!list) return;
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No passkeys registered for this administrator yet.';
      empty.style.color = '#9eb8d0';
      empty.style.fontSize = '.82rem';
      list.appendChild(empty);
      return;
    }
    rows.forEach(function (row) {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 0;border-top:1px solid rgba(79,195,247,.1)';
      const meta = document.createElement('div');
      meta.style.minWidth = '0';
      const name = document.createElement('div');
      name.textContent = row.label || 'This device';
      name.style.cssText = 'font-weight:700;color:#e2ecff;font-size:.86rem';
      const date = document.createElement('div');
      date.textContent = 'Added ' + fmtDate(row.createdAt) + ' · Last used ' + fmtDate(row.lastUsedAt);
      date.style.cssText = 'font-size:.72rem;color:#8ea8c2;margin-top:4px;line-height:1.5';
      meta.append(name, date);
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = 'Revoke';
      revoke.disabled = rows.length < 2;
      revoke.title = rows.length < 2 ? 'Register another passkey before revoking the last one.' : 'Revoke this passkey';
      revoke.style.cssText = 'flex-shrink:0;border:1px solid rgba(255,107,107,.4);border-radius:8px;background:rgba(255,107,107,.08);color:#ff9a9a;padding:7px 10px;cursor:pointer;font:600 .75rem inherit';
      revoke.addEventListener('click', async function () {
        if (!window.confirm('Revoke this passkey? It will no longer be able to sign in.')) return;
        revoke.disabled = true;
        try {
          const data = await request('/api/admin/biometric/passkey/' + encodeURIComponent(row.id), { method: 'DELETE' });
          renderRows(data.passkeys || []);
          setStatus('Passkey revoked.', 'success');
        } catch (error) {
          setStatus(error.message, 'error');
          revoke.disabled = false;
        }
      });
      item.append(meta, revoke);
      list.appendChild(item);
    });
  }

  async function loadPasskeys() {
    try {
      const data = await request('/api/admin/biometric/passkeys', { method: 'GET', headers: {} });
      renderRows(data.passkeys || []);
    } catch (error) {
      renderRows([]);
      setStatus(error.message || 'Could not load passkeys.', 'error');
    }
  }

  async function registerPasskey() {
    if (!window.SimpleWebAuthnBrowser ||
        typeof window.SimpleWebAuthnBrowser.startRegistration !== 'function') {
      setStatus('Passkey component could not load. Refresh the page and try again.', 'error');
      return;
    }
    registerButton.disabled = true;
    registerButton.textContent = 'Waiting for your device…';
    setStatus('Preparing a secure registration challenge…');
    try {
      const label = (window.prompt('Name this passkey (for example, Work laptop):', 'This device') || 'This device').trim().slice(0, 60) || 'This device';
      const challenge = await request('/api/admin/biometric/passkey/register-options', { method: 'POST', body: '{}' });
      const response = await window.SimpleWebAuthnBrowser.startRegistration({
        optionsJSON: challenge.options,
      });
      setStatus('Verifying and saving your passkey…');
      const result = await request('/api/admin/biometric/passkey/register-verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId: challenge.challengeId, response, label }),
      });
      renderRows(result.passkeys || []);
      setStatus('Passkey registered successfully.', 'success');
    } catch (error) {
      if (error && error.name === 'NotAllowedError') {
        setStatus('Passkey registration was cancelled or timed out.', 'error');
      } else {
        setStatus(error.message || 'Passkey registration failed.', 'error');
      }
    } finally {
      registerButton.disabled = false;
      registerButton.textContent = '＋ Register passkey';
    }
  }

  if (registerButton) registerButton.addEventListener('click', registerPasskey);
  loadPasskeys();
})();
