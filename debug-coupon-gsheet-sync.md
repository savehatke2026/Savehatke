# Debug Session: coupon-gsheet-sync
- **Status**: [OPEN]
- **Issue**: Coupon details submitted from `admin.html` are not appearing in the Google Sheets `Coupons` tab.
- **Debug Server**: pending
- **Log File**: `.dbg/trae-debug-log-coupon-gsheet-sync.ndjson`

## Reproduction Steps
1. Start the SaveHatke server.
2. Open `admin.html` and submit a coupon from the Add Coupon form.
3. Check whether a new row appears in the Google Sheets `Coupons` sheet.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | Google Sheets auth fails and the app falls back to in-memory storage | High | Low | Pending |
| B | The app is connected to a different spreadsheet/tab than the one opened by the user | High | Low | Pending |
| C | The admin coupon request reaches the backend, but `appendRow` fails during the write | High | Medium | Pending |
| D | The service account lacks edit access to the spreadsheet, so sheet setup and row append fail | Medium | Low | Pending |
| E | The coupon submit request never reaches the admin route due to auth/runtime mismatch | Medium | Medium | Pending |

## Log Evidence
Pending.

## Verification Conclusion
Pending.
