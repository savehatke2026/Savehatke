# SaveHatke Admin Biometric Authentication — Implementation Plan

## Scope
Add exactly two selectable admin authentication methods:
1. WebAuthn passkeys (device user verification may be Face ID, Windows Hello, fingerprint, or device PIN depending on authenticator).
2. Camera face recognition using AWS Rekognition Face Liveness plus server-side face comparison.

Do not add OTP, SMS, authenticator apps, or another login method.

## Repository facts discovered
- Repository: savehatke2026/Savehatke
- Branch: feature/admin-biometric-auth
- Backend: Node.js / Express, deployed on Vercel.
- Admin roster: Supabase admin_allowlist via server/config/security.js.
- Revocable sessions: Supabase session table; raw 256-bit token only in sh_session HttpOnly cookie; SHA-256 hash stored server-side.
- Admin session hard lifetime: 2 hours.
- Admin login currently enters through Google OAuth in server/routes/auth.js and finishGoogleLogin().
- Admin session creation is in createLoginSession(), which currently requires a verified Google subject.
- Admin UI: public/vault.html; JavaScript: public/js/admin.js and other modular scripts.
- Camera is currently denied globally by Permissions-Policy in server/server.js and vercel.json.
- MongoDB is not the current source of truth for admin credentials. Use Supabase for new biometric records and do not reintroduce MongoDB.

## Critical migration rule
Do not simply bypass the existing Google OAuth path. Build a deliberate setup / enrollment transition:
- During rollout, keep Google admin login available until at least one passkey and one face enrollment have been verified and tested for each admin.
- After successful setup and explicit deployment cutover, admins may choose Passkey or Face Recognition at the admin login screen.
- Do not leave Google as a hidden fallback after cutover if the product decision is that the only two login methods are passkeys and face recognition.
- Provide a documented owner-controlled emergency recovery process outside the ordinary login UI. Never strand the only admin.
- New biometric-only session issuance must still check ensureAdminRosterReady(), getAdminAccount(email), active allowlist status, and isAdminRosterStale() (fail closed if the roster is stale).
- Refactor session creation safely so a verified passkey / face assertion can create the same Supabase admin session with login_method metadata, without fabricating or bypassing a Google subject. Add an explicit provider_verified value / session method with narrowly scoped tests. Do not weaken createLoginSession() for existing Google users.

## Passkeys
- Use @simplewebauthn/server and @simplewebauthn/browser.
- Add challenge generation, verification, replay prevention, expiration and origin/RP ID validation.
- Persist credential ID, public key, counter, transports, label, createdAt, lastUsedAt, and admin email/user ID in a dedicated Supabase table.
- Set userVerification = required.
- Challenge store must be shared across Vercel instances (Supabase table or another durable store), not process memory.
- Do not store private keys.
- Support credential revocation from the admin security interface.

Suggested endpoints:
- POST /api/admin-biometric/passkey/register-options
- POST /api/admin-biometric/passkey/register-verify
- POST /api/admin-biometric/passkey/login-options
- POST /api/admin-biometric/passkey/login-verify
- DELETE /api/admin-biometric/passkey/:credentialId

## Camera Face Recognition
Use AWS Rekognition Face Liveness in ap-south-1.
- Browser component: @aws-amplify/ui-react-liveness FaceLivenessDetector, integrated as a small isolated component (the main site uses vanilla HTML/JS; do not convert the dashboard).
- Backend creates liveness sessions using AWS SDK v3, and validates the result server-side.
- Browser receives only short-lived least-privilege credentials to submit the liveness video stream; never expose long-lived AWS keys.
- Liveness result must be successful and above a calibrated threshold.
- Fetch the AWS reference image from the server-side liveness result.
- Compare it server-side to the admin's enrolled face reference using CompareFaces.
- Require both live-person and face-identity checks before session issue.
- Store enrollment reference images in private S3 with SSE-KMS, strict bucket policy, block public access and no public URLs. Persist only object key and metadata in Supabase.
- Do not store login videos or retain per-login reference images.
- Add retention, consent, re-enrollment and deletion procedures; avoid logging biometric data or images.

Suggested endpoints:
- POST /api/admin-biometric/face/enroll-session
- POST /api/admin-biometric/face/enroll-verify
- POST /api/admin-biometric/face/login-session
- POST /api/admin-biometric/face/login-verify
- DELETE /api/admin-biometric/face/enrollment

## Camera permissions and CSP
- Change Permissions-Policy from camera=() to camera=(self) only for the dedicated admin authentication page/route. Do not grant camera to every public page.
- vercel.json currently sets a global camera=() header for static files. Use route-specific header handling or serve the biometric entry page through Express so the permission is narrowly scoped.
- Update CSP connect-src / frame-src only for required AWS endpoints; use documented AWS hosts, not wildcards.
- Use HTTPS; camera access is unavailable on insecure origins except localhost.

## Supabase migrations
Create migration tables for:
- admin_passkey_credentials
- admin_biometric_enrollments
- admin_auth_challenges
- admin_biometric_audit

Requirements:
- unique credential ID
- foreign association by normalized allowlisted email
- challenge hashes, purpose, expiry, used_at; one-time atomic consumption
- no anonymous access; deny all public roles via RLS
- server-side service role only
- encrypted S3 object references, no raw biometric payloads in table
- add indexes on email, expiry, credential ID
- add cleanup for expired challenges

## Admin UI
Add a focused security section inside public/vault.html, integrated into existing Security navigation:
- Register Passkey
- Register Face
- List registered passkeys (label, created date, last used, revoke)
- Face enrollment status and last enrollment date
- Clear status messages and camera permission errors
- Re-enrollment / removal guarded by existing authenticated admin APIs and explicit confirmation
- Login screen provides exactly two choices after migration cutover: "Continue with Passkey" and "Login with Face Recognition".
- Responsive accessible UI; no biometric data displayed.

## Session integration
- Reuse generateSessionToken(), hashSessionToken(), setSessionCookie(), Supabase createSession(), and existing 2-hour ADMIN_SESSION_TTL_MS.
- Add a separate helper for biometric admin sessions. It must accept only an already verified assertion result from the biometric routes.
- Session login_method values should identify "Admin Passkey" or "Admin Face Recognition".
- Do not use localStorage bearer tokens.
- Invalidate browser session state only via existing server-side revocation paths.

## Testing
Add automated tests for:
- passkey registration / successful assertion / wrong origin / wrong RP ID / wrong challenge / expired challenge / replay / counter handling / revoked credential.
- face liveness success / liveness fail / low confidence / face mismatch / S3 reference missing / AWS timeout / malformed session / replay.
- admin allowlist inactive / roster stale / unauthorized non-admin / Supabase unavailable.
- session row created, 2-hour expiry, HttpOnly Secure SameSite cookie and server-side revocation.
- camera permission available only on admin auth route.
- existing Google login tests and user login tests remain unchanged.

Do not claim real biometric success from mocks. Before production cutover, test physical Windows Hello and Android/iOS passkeys and real camera liveness in deployed HTTPS Preview. Keep Google login until the owner confirms both methods have been enrolled and verified for every admin.


## Implementation status — 5 November 2026

### Delivered on this feature branch
- Supabase migration: 20261105_admin_biometric_auth.sql creates server-only passkey credentials, one-time challenges, biometric enrollment metadata and audit tables. RLS is enabled and browser roles have no table access.
- server/routes/adminBiometric.js implements passkey enrollment options/verification, login options/verification, device listing and revocation. Challenges are short-lived and atomically consumed; login checks the active Supabase admin allowlist and creates the existing revocable 2-hour admin session only after WebAuthn verification.
- server/routes/auth.js exposes a narrow internal helper for a previously verified biometric assertion. Existing Google login still requires its verified Google subject; the new path does not fabricate one.
- server/services/supabase.js routes Admin Passkey sessions into the existing admin_sessions table.
- Added public/admin-biometric-login.html and public/js/admin-passkey-login.js for admin passkey sign-in, plus passkey management in the Security section of public/vault.html.
- Camera permission is narrowed to /admin-biometric-login; the rest of the website remains camera=().
- The existing Google sign-in path is preserved during rollout. It must not be removed until every admin has verified an alternative login in production.

### Not yet delivered
- Camera face recognition is deliberately NOT enabled. The UI identifies it as not configured. The AWS Face Liveness account setup, least-privilege Cognito Identity Pool, private S3/KMS bucket, server-side CompareFaces flow, consent/enrollment flow and real-device spoof-resistance tests are still required. No placeholder endpoint pretends that face recognition works.
- Real browser/hardware passkey tests and production Supabase migration have not been performed from this environment.

### Deployment notes before enabling passkeys
1. Apply supabase/migrations/20261105_admin_biometric_auth.sql to the production Supabase project.
2. Configure WEBAUTHN_ORIGIN=https://savehatke.vercel.app and WEBAUTHN_RP_ID=savehatke.vercel.app in the intended Vercel environment. Keep them aligned with the final production domain.
3. Regenerate and commit the root package-lock.json with npm install after adding @simplewebauthn/server@^13.3.3; this workspace could not reach the npm registry, so the lockfile has not been regenerated here. Do not use npm ci until the lockfile is synchronized.
4. Test registration and login on supported Android, iOS, Windows and macOS devices over HTTPS. Verify revoked credential, stale allowlist, replayed/expired challenge, wrong origin/RP ID, Supabase outage and 2-hour session expiry.
5. Only after tests pass, enable the passkey login route for the production admin roster. Keep the existing Google path until all admins are enrolled and owner-controlled recovery is confirmed.

The package is pinned to the SimpleWebAuthn 13.x API (@simplewebauthn/server 13.3.3 and browser UMD 13.3.0). The backend is CommonJS; use the package's Node/CommonJS entry point.


## Camera face recognition implementation — 5 November 2026

### Server and UI now present on the feature branch
- `server/services/adminFaceLiveness.js` uses AWS SDK v3 clients for Rekognition, Cognito Identity and S3.
- `server/routes/adminBiometric.js` creates Face Liveness sessions for enrollment and login, gets temporary Cognito unauthenticated-role credentials, retrieves the liveness result, checks the configured liveness confidence, compares the live reference image to the enrolled reference image with Rekognition CompareFaces, and issues the existing 2-hour admin session only after both checks pass.
- The browser uses Amplify UI's `FaceLivenessDetectorCore` with a custom credential provider. The browser receives short-lived Cognito credentials only; long-lived AWS access keys remain server-side.
- Face enrollment requires explicit consent with a versioned notice. Reference images are stored in a private S3 bucket and encrypted by the KMS key specified in the CreateFaceLivenessSession request. Login reference images are deleted after comparison; failed-liveness references are also deleted where AWS returned one.
- Face status, enrollment, removal and camera login controls are wired into the existing Security page and dedicated admin login page.
- Camera permission is granted only on the dedicated admin biometric login page and the authenticated `/vault` admin page. All other site routes continue to deny camera access.

### Required Vercel environment variables
Set these only in the intended environment (Preview first, then Production):

```env
WEBAUTHN_ORIGIN=https://savehatke.vercel.app
WEBAUTHN_RP_ID=savehatke.vercel.app

AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
# Optional only when using temporary IAM credentials
AWS_SESSION_TOKEN=

FACE_LIVENESS_REGION=ap-south-1
FACE_LIVENESS_BUCKET=
FACE_LIVENESS_KMS_KEY_ID=
FACE_LIVENESS_IDENTITY_POOL_ID=
FACE_LIVENESS_MIN_CONFIDENCE=
FACE_MATCH_MIN_SIMILARITY=
ADMIN_FACE_CONSENT_VERSION=2026-11-05-v1
```

Face Recognition reports `enabled: false` until every required setting is present and both confidence thresholds are numeric values from 1 to 100. The browser config endpoint exposes only enabled/region/consent version; it never returns server AWS credentials.

### AWS resource and IAM setup
1. Create a private S3 bucket in the same AWS region as Rekognition (Mumbai `ap-south-1` recommended for this app). Enable Block Public Access, enforce TLS-only access, and configure default encryption with a customer-managed KMS key. Do not add public bucket policies or public object ACLs.
2. Configure a lifecycle rule that deletes objects under `admin-biometric/temporary/` after one day. The application deletes normal temporary login references immediately, while the lifecycle rule is a cleanup backstop for abandoned or timed-out liveness sessions.
3. Create a customer-managed KMS key in the same region. Set `FACE_LIVENESS_KMS_KEY_ID` to its key ARN or ID. The backend IAM principal and Rekognition Face Liveness service must be allowed to use the key for the reference/audit image flow.
4. Create a Cognito Identity Pool in the same region and enable unauthenticated identities. Set its ID as `FACE_LIVENESS_IDENTITY_POOL_ID`. Attach an unauthenticated-role policy that allows only `rekognition:StartFaceLivenessSession` (the Amplify Face Liveness streaming call) and no S3 read, KMS or admin API permissions. This is the only AWS permission exposed through temporary browser credentials.
5. The server IAM principal needs: `rekognition:CreateFaceLivenessSession`, `rekognition:GetFaceLivenessSessionResults`, `rekognition:CompareFaces`, `cognito-identity:GetId`, `cognito-identity:GetCredentialsForIdentity`, and narrowly scoped S3 `GetObject` / `DeleteObject` permissions for the `admin-biometric/*` objects. It also needs the required KMS permissions for the configured key. Rekognition must be allowed to write Face Liveness output objects to the configured prefix.
6. Store `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` only in Vercel server-side environment variables (never in public/client variables or GitHub). Restrict the IAM user's permissions to these operations and the single bucket/prefix/key.

### Threshold calibration and privacy
- `FACE_LIVENESS_MIN_CONFIDENCE` is the minimum AWS Face Liveness confidence (0–100); `FACE_MATCH_MIN_SIMILARITY` is the minimum CompareFaces similarity (0–100). They must be calibrated with real devices, lighting, false accept/false reject testing and the intended admin population; do not use sample thresholds blindly.
- AWS Face Liveness is probabilistic and does not guarantee perfect spoof detection. Require both liveness and identity match; continue monitoring false accept/reject rates.
- Do not log face images, video, temporary AWS credentials, access keys, KMS keys, or raw liveness payloads. Only coarse confidence bands and non-biometric audit outcomes are recorded.
- Face profile removal revokes the DB record and attempts to delete its S3 reference object. A passkey must remain before the face profile can be removed.
- Review consent, retention, data subject rights and vendor processing arrangements under applicable privacy law before Production enrollment.

### What still requires AWS owner action and real-world verification
- Provision the AWS S3/KMS/Cognito resources and least-privilege policies.
- Apply the Supabase migration before the routes can write/read biometric records.
- Set the environment variables above and deploy to a protected Preview.
- Test Android Chrome, iOS Safari, desktop Chrome/Edge and Firefox where supported; verify camera permissions, liveness challenges, poor lighting, replay/photo spoof attempts, face mismatch, timeout, expired AWS session and AWS/Supabase outages.
- Confirm that all admins have both passkey and face login working before any future decision to remove the current Google fallback.
