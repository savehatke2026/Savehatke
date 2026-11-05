// Browser-only bridge for AWS Amplify's FaceLivenessDetectorCore.
// The component streams video directly to Rekognition using short-lived
// Cognito unauthenticated-role credentials returned by the SaveHatke backend.
// No AWS long-lived secret is ever shipped to this file.

let modulesPromise;

async function loadModules() {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import('https://esm.sh/react@19.3.1'),
      import('https://esm.sh/react-dom@19.3.1/client?external=react'),
      import('https://esm.sh/@aws-amplify/ui-react@6.15.7?external=react,react-dom'),
      import('https://esm.sh/@aws-amplify/ui-react-liveness@3.7.0?external=react,react-dom'),
    ]).then(([ReactModule, ReactDomModule, UiModule, LivenessModule]) => ({
      React: ReactModule.default || ReactModule,
      createRoot: ReactDomModule.createRoot,
      ThemeProvider: UiModule.ThemeProvider,
      FaceLivenessDetectorCore: LivenessModule.FaceLivenessDetectorCore,
    }));
  }
  return modulesPromise;
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Face verification could not be completed.');
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function startFaceLiveness({
  flow,
  email,
  mount,
  consentVersion,
  onStatus,
  onComplete,
  onError,
}) {
  if (!mount || !['login', 'enroll'].includes(flow)) {
    throw new Error('Face verification could not start.');
  }

  const status = typeof onStatus === 'function' ? onStatus : () => {};
  const fail = typeof onError === 'function' ? onError : () => {};
  status('Preparing a secure camera session…');

  const sessionPath = flow === 'enroll'
    ? '/api/admin/biometric/face/enroll-session'
    : '/api/admin/biometric/face/login-session';
  const sessionBody = flow === 'enroll'
    ? { consent: true, consentVersion }
    : { email: String(email || '').trim().toLowerCase() };
  const session = await postJson(sessionPath, sessionBody);
  if (!session.sessionId || !session.challengeId || !session.credentials ||
      !session.credentials.accessKeyId || !session.credentials.secretAccessKey ||
      !session.credentials.sessionToken) {
    throw new Error('The camera session response was incomplete.');
  }

  const { React, createRoot, ThemeProvider, FaceLivenessDetectorCore } = await loadModules();
  if (typeof FaceLivenessDetectorCore !== 'function') {
    throw new Error('The camera verification component could not load.');
  }

  mount.replaceChildren();
  mount.classList.add('sh-face-liveness-active');
  const root = createRoot(mount);
  let completing = false;
  let destroyed = false;

  async function finishVerification() {
    if (completing || destroyed) return;
    completing = true;
    status('Verifying liveness and matching the registered face…');
    try {
      const verifyPath = flow === 'enroll'
        ? '/api/admin/biometric/face/enroll-verify'
        : '/api/admin/biometric/face/login-verify';
      const body = {
        challengeId: session.challengeId,
        ...(flow === 'login' ? { email: String(email || '').trim().toLowerCase() } : {}),
      };
      const result = await postJson(verifyPath, body);
      status(flow === 'enroll' ? 'Face profile registered successfully.' : 'Face verified. Opening the admin panel…');
      if (typeof onComplete === 'function') await onComplete(result);
    } catch (error) {
      status(error.message || 'Face verification failed.');
      fail(error);
    } finally {
      completing = false;
    }
  }

  function handleError(error) {
    const name = String(error && error.name || '');
    const message = name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access and start again.'
      : 'The camera verification could not be completed. Start a new check and try again.';
    status(message);
    fail(new Error(message));
  }

  const credentials = {
    accessKeyId: session.credentials.accessKeyId,
    secretAccessKey: session.credentials.secretAccessKey,
    sessionToken: session.credentials.sessionToken,
    expiration: new Date(session.credentials.expiration),
  };
  const credentialProvider = async () => credentials;

  root.render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(FaceLivenessDetectorCore, {
        sessionId: session.sessionId,
        region: session.region,
        onAnalysisComplete: finishVerification,
        onError: handleError,
        config: { credentialProvider },
      }),
    ),
  );

  return {
    stop() {
      destroyed = true;
      try { root.unmount(); } catch (_) {}
      mount.replaceChildren();
      mount.classList.remove('sh-face-liveness-active');
    },
  };
}
