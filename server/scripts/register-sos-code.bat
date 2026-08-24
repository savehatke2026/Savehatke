@echo off
REM ============================================
REM SaveHatke - Register a backup code in MongoDB
REM ============================================
REM This script registers a cleartext backup code by hashing it and
REM inserting the bcrypt hash + metadata into MongoDB.
REM
REM Usage:
REM   register-sos-code.bat <SH-BK-XXXX-XXXX-XXXX-XXXX> [label] [createdBy]
REM
REM Example:
REM   register-sos-code.bat SH-BK-AB12-CD34-EF56-7890 "Primary SOS" Rupayan
REM
REM SECURITY:
REM   - The cleartext is only ever passed on the command line and is NOT
REM     persisted to disk by this script.
REM   - After this script runs successfully, only the bcrypt hash lives
REM     in MongoDB. The cleartext cannot be recovered from the database.

if "%~1"=="" (
  echo.
  echo Usage: %~nx0 ^<SH-BK-XXXX-XXXX-XXXX-XXXX^> [label] [createdBy]
  echo.
  echo Example:
  echo   %~nx0 SH-BK-AB12-CD34-EF56-7890 "Primary SOS" Rupayan
  echo.
  pause
  exit /b 1
)

set CODE=%~1
set LABEL=%~2
if "%LABEL%"=="" set LABEL=Registered SOS code
set CREATED_BY=%~3
if "%CREATED_BY%"=="" set CREATED_BY=cli

cd /d "%~dp0..\.."
echo.
echo Connecting to MongoDB and registering the code...
echo.
node server\scripts\register-backup-code.js --code "%CODE%" --label "%LABEL%" --created-by "%CREATED_BY%"
echo.
echo Done.
pause
