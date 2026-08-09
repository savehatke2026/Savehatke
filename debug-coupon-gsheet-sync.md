# Debug Session: coupon-gsheet-sync
- **Status**: [OPEN]
- **Issue**: The admin UI reports "Coupon published successfully to Google Sheets!", but the submitted coupon details do not appear in the Google Sheets `Coupons` tab.
- **Debug Server**: http://127.0.0.1:7778/event
- **Log File**: `.dbg/trae-debug-log-coupon-gsheet-sync.ndjson`

## Reproduction Steps
1. Open the deployed admin page at `https://savehatke.vercel.app/admin.html`.
2. Log in as admin and submit a coupon from the Add Coupon form.
3. Observe the success toast in the UI.
4. Open the Google Sheet and check whether a new row appears in the `Coupons` tab.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | The deployed app is not using a working Google Sheets connection and is returning success from another code path | High | Low | Pending |
| B | The app is writing to a different spreadsheet ID than the one opened in the browser | High | Low | Pending |
| C | The admin request reaches the backend, but the row append fails or targets the wrong tab/range | High | Medium | Pending |
| D | The service account lacks permission on the target spreadsheet, so metadata or write calls fail | Medium | Low | Pending |
| E | The deployed frontend is hitting an older backend build that still reports success while using fallback behavior | Medium | Medium | Pending |

## Log Evidence
- Deployed `GET https://savehatke.vercel.app/api/health` returned `{"status":"ok","timestamp":"2026-08-09T07:38:30.528Z","name":"SaveHatke API"}`.
- Current workspace code in `server/server.js` returns an additional `storage` object in `/api/health`.
- This mismatch shows the live Vercel backend is not serving the current local code yet.

## Verification Conclusion
- Hypothesis E is currently the strongest match: the deployed frontend is hitting an older backend build that can still report success without the newer storage diagnostics/guards.
- Hypotheses A-D remain unverified until the current build is deployed and `/api/health` exposes storage state from the live environment.
