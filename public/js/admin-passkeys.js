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


  const faceStatus = document.getElementById('shFaceStatus');
  const faceRegister = document.getElementById('shRegisterFace');
  const faceRemove = document.getElementById('shRemoveFace');
  const faceConsent = document.getElementById('shFaceConsent');
  const faceMount = document.getElementById('shFaceLivenessMount');
  let faceConfig = { enabled: false, consentVersion: '' };
  let faceEnrollment = { enrolled: false };

  function setFaceStatus(message, kind) {
    if (!faceStatus) return;
    faceStatus.textContent = message || '';
    faceStatus.style.color = kind === 'error' ? '#ff9999' : kind === 'success' ? '#69e5b5' : '#9eb8d0';
  }

  async function loadFaceSettings() {
    if (!faceRegister || !faceStatus || !faceMount) return;
    try {
      faceConfig = await request('/api/admin/biometric/face/config', { method: 'GET', headers: {} });
      faceEnrollment = await request('/api/admin/biometric/face/status', { method: 'GET', headers: {} });
      faceRegister.disabled = !(faceConfig.enabled && faceConsent && faceConsent.checked);
      faceRemove.disabled = !faceEnrollment.enrolled;
      if (!faceConfig.enabled) {
        setFaceStatus('Not configured. AWS Rekognition, a Cognito identity pool, a private KMS-encrypted S3 bucket and calibrated thresholds are required.', 'error');
      } else if (faceEnrollment.enrolled) {
        setFaceStatus('Face profile registered · ' + fmtDate(faceEnrollment.enrolledAt), 'success');
      } else {
        setFaceStatus('Ready to register. Review and accept the biometric notice above to continue.');
      }
    } catch (error) {
      faceRegister.disabled = true;
      faceRemove.disabled = true;
      setFaceStatus(error.message || 'Could not load face recognition settings.', 'error');
    }
  }

  async function registerFace() {
    if (!faceConfig.enabled || !faceConsent || !faceConsent.checked) {
      setFaceStatus('Accept the biometric enrollment notice before continuing.', 'error');
      return;
    }
    faceRegister.disabled = true;
    faceRegister.textContent = 'Preparing camera…';
    faceMount.style.display = 'block';
    faceMount.replaceChildren();
    setFaceStatus('Starting secure face enrollment…');
    try {
      const faceModule = await import('/js/admin-face-liveness.mjs');
      await faceModule.startFaceLiveness({
        flow: 'enroll',
        consentVersion: faceConfig.consentVersion,
        mount: faceMount,
        onStatus: (message) => setFaceStatus(message),
        onComplete: async () => {
          setFaceStatus('Face profile registered successfully.', 'success');
          await loadFaceSettings();
        },
        onError: (error) => setFaceStatus(error.message || 'Face enrollment failed.', 'error'),
      });
    } catch (error) {
      setFaceStatus(error.message || 'Face enrollment could not start.', 'error');
      faceMount.style.display = 'none';
    } finally {
      faceRegister.disabled = !(faceConfig.enabled && faceConsent && faceConsent.checked);
      faceRegister.textContent = '＋ Register face';
    }
  }

  async function removeFace() {
    if (!window.confirm('Remove the registered face profile? Camera face login will stop working until you enroll again.')) return;
    faceRemove.disabled = true;
    try {
      await request('/api/admin/biometric/face/enrollment', { method: 'DELETE' });
      faceMount.replaceChildren();
      faceMount.style.display = 'none';
      setFaceStatus('Face profile removed.', 'success');
      await loadFaceSettings();
    } catch (error) {
      setFaceStatus(error.message || 'Could not remove the face profile.', 'error');
      faceRemove.disabled = false;
    }
  }

  if (registerButton) registerButton.addEventListener('click', registerPasskey);
  if (faceRegister) faceRegister.addEventListener('click', registerFace);
  if (faceRemove) faceRemove.addEventListener('click', removeFace);
  if (faceConsent) faceConsent.addEventListener('change', () => {
    faceRegister.disabled = !(faceConfig.enabled && faceConsent.checked);
  });
  loadFaceSettings();
  loadPasskeys();
})();
