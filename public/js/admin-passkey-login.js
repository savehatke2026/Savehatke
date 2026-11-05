(function () {
  'use strict';
  const emailInput = document.getElementById('adminEmail');
  const passkeyButton = document.getElementById('passkeyLoginBtn');
  const status = document.getElementById('loginStatus');

  function setStatus(message, kind) {
    status.textContent = message || '';
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function postJson(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'The request could not be completed.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function loginWithPasskey() {
    const email = String(emailInput.value || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emailInput.focus();
      setStatus('Enter your authorised administrator email address.', 'error');
      return;
    }
    if (!window.SimpleWebAuthnBrowser ||
        typeof window.SimpleWebAuthnBrowser.startAuthentication !== 'function') {
      setStatus('Passkey support could not load. Check your connection and try again.', 'error');
      return;
    }
    passkeyButton.disabled = true;
    passkeyButton.textContent = 'Waiting for your device…';
    setStatus('Preparing secure passkey challenge…');
    try {
      const challenge = await postJson('/api/admin/biometric/passkey/login-options', { email });
      const assertion = await window.SimpleWebAuthnBrowser.startAuthentication({
        optionsJSON: challenge.options,
      });
      setStatus('Verifying your passkey…');
      const result = await postJson('/api/admin/biometric/passkey/login-verify', {
        email,
        challengeId: challenge.challengeId,
        response: assertion,
      });
      if (!result.success || !result.user || result.user.role !== 'admin') {
        throw new Error('Administrator authentication was not completed.');
      }
      try {
        localStorage.setItem('sh_authenticated', '1');
        localStorage.setItem('sh_user', JSON.stringify(result.user));
        localStorage.setItem('sh_admin_user', JSON.stringify(result.user));
        localStorage.removeItem('sh_token');
        localStorage.removeItem('sh_admin_token');
      } catch (_) {}
      setStatus('Passkey verified. Opening the admin panel…', 'success');
      window.location.replace('/vault');
    } catch (error) {
      if (error && error.name === 'NotAllowedError') {
        setStatus('Passkey request was cancelled or timed out. Try again.', 'error');
      } else {
        setStatus(error.message || 'Passkey sign-in failed. Try again.', 'error');
      }
    } finally {
      passkeyButton.disabled = false;
      passkeyButton.textContent = 'Continue with Passkey';
    }
  }

  passkeyButton.addEventListener('click', loginWithPasskey);
  emailInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      loginWithPasskey();
    }
  });
})();
