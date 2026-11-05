(function () {
  'use strict';
  const emailInput = document.getElementById('adminEmail');
  const passkeyButton = document.getElementById('passkeyLoginBtn');
  const faceButton = document.getElementById('faceLoginBtn');
  const faceStatus = document.getElementById('faceStatus');
  const faceMount = document.getElementById('faceLivenessMount');
  const status = document.getElementById('loginStatus');

  function setStatus(message, kind) {
    status.textContent = message || '';
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function saveAdminAndRedirect(user, method) {
    if (!user || user.role !== 'admin') throw new Error('Administrator authentication was not completed.');
    try {
      localStorage.setItem('sh_authenticated', '1');
      localStorage.setItem('sh_user', JSON.stringify(user));
      localStorage.setItem('sh_admin_user', JSON.stringify(user));
      localStorage.removeItem('sh_token');
      localStorage.removeItem('sh_admin_token');
    } catch (_) {}
    setStatus(method + ' verified. Opening the admin panel…', 'success');
    window.location.replace('/vault');
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

  function adminEmail() {
    const email = String(emailInput.value || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emailInput.focus();
      setStatus('Enter your authorised administrator email address.', 'error');
      return '';
    }
    return email;
  }

  async function loginWithPasskey() {
    const email = adminEmail();
    if (!email) return;
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
      if (!result.success) throw new Error('Administrator authentication was not completed.');
      saveAdminAndRedirect(result.user, 'Passkey');
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

  async function loginWithFace() {
    const email = adminEmail();
    if (!email) return;
    faceButton.disabled = true;
    faceButton.textContent = 'Preparing camera…';
    faceMount.style.display = 'block';
    faceMount.replaceChildren();
    setStatus('Starting face recognition…');
    try {
      const faceModule = await import('/js/admin-face-liveness.js');
      await faceModule.startFaceLiveness({
        flow: 'login',
        email,
        mount: faceMount,
        onStatus: (message) => setStatus(message),
        onComplete: (result) => {
          if (!result || !result.success) throw new Error('Face authentication was not completed.');
          saveAdminAndRedirect(result.user, 'Face recognition');
        },
        onError: (error) => setStatus(error.message || 'Face verification failed.', 'error'),
      });
    } catch (error) {
      setStatus(error.message || 'Face recognition could not start.', 'error');
      faceMount.style.display = 'none';
    } finally {
      faceButton.disabled = false;
      faceButton.textContent = 'Login with Face Recognition';
    }
  }

  async function loadFaceConfig() {
    try {
      const response = await fetch('/api/admin/biometric/face/config', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const config = await response.json().catch(() => ({}));
      if (response.ok && config.enabled === true) {
        faceButton.disabled = false;
        faceButton.textContent = 'Login with Face Recognition';
        faceStatus.textContent = 'Use your registered face with a live camera check. Your camera stream is processed by AWS Face Liveness; SaveHatke receives the verification result, not a saved video.';
      } else {
        faceButton.disabled = true;
        faceButton.textContent = 'Login with Face Recognition — Not configured';
        faceStatus.textContent = 'Camera face recognition is not configured yet. AWS credentials, Cognito temporary identity, a private KMS-encrypted S3 bucket and liveness thresholds must be configured before it can be used.';
      }
    } catch (_) {
      faceButton.disabled = true;
      faceButton.textContent = 'Login with Face Recognition — Unavailable';
      faceStatus.textContent = 'Camera face recognition is temporarily unavailable.';
    }
  }

  passkeyButton.addEventListener('click', loginWithPasskey);
  faceButton.addEventListener('click', loginWithFace);
  emailInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      loginWithPasskey();
    }
  });
  loadFaceConfig();
})();
