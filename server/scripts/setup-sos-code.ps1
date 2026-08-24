# ============================================
# SaveHatke — One-shot SOS setup
# ============================================
# This script:
#   1) registers the SH-BK-... code in MongoDB
#   2) runs the diagnostic to confirm
#   3) tells you what to do next
#
# Run from any PowerShell terminal at the repo root:
#   .\server\scripts\setup-sos-code.ps1

$ErrorActionPreference = 'Stop'
Set-Location "$PSScriptRoot\..\.."

$CODE    = 'SH-BK-5E7E-5636-0529-CDAD'
$LABEL   = 'Primary SOS code'
$CREATOR = 'Rupayan'

Write-Host ''
Write-Host '== SaveHatke — registering SOS backup code ==' -ForegroundColor Yellow
Write-Host ''
Write-Host "Code: $CODE" -ForegroundColor Cyan
Write-Host ''

# 1) Register (hash + insert)
node server\scripts\register-backup-code.js `
    --code $CODE `
    --label $LABEL `
    --created-by $CREATOR

if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'Registration failed. Common causes:' -ForegroundColor Red
    Write-Host '  - your IP is not whitelisted in MongoDB Atlas' -ForegroundColor Red
    Write-Host '  - MONGODB_URI is missing or wrong in .env' -ForegroundColor Red
    Write-Host '  - the model has not been loaded by the running server' -ForegroundColor Red
    exit 1
}

# 2) Confirm with the diagnostic
Write-Host ''
Write-Host '== Diagnostic ==' -ForegroundColor Yellow
node server\scripts\backup-code-status.js
Write-Host ''

# 3) Next steps
Write-Host '== Next steps ==' -ForegroundColor Yellow
Write-Host ''
Write-Host '  1) Restart the server so it picks up the new route:' -ForegroundColor White
Write-Host '       cd server; node server.js' -ForegroundColor Gray
Write-Host ''
Write-Host '  2) In your browser, hard-refresh the login page (Ctrl+Shift+R)' -ForegroundColor White
Write-Host '     to bust any cached HTML.' -ForegroundColor Gray
Write-Host ''
Write-Host '  3) Paste the code into the email field and click Continue.' -ForegroundColor White
Write-Host ''
Write-Host '  4) Open the browser console (F12) before step 3 — if it still' -ForegroundColor White
Write-Host '     does not work, any JS error will show up there.' -ForegroundColor Gray
Write-Host ''
