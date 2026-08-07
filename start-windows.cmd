@echo off
setlocal
cd /d "%~dp0"

if not defined GEMLOGIN_BASE set "GEMLOGIN_BASE=http://127.0.0.1:1010"
if not defined GEMLOGIN_CDP_PORT set "GEMLOGIN_CDP_PORT=9222"
if not defined GEMLOGIN_CDP_BASE set "GEMLOGIN_CDP_BASE=http://127.0.0.1:%GEMLOGIN_CDP_PORT%"
if not defined GEMLOGIN_EXE set "GEMLOGIN_EXE=%LOCALAPPDATA%\Programs\gemlogin\gemlogin.exe"

powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:%GEMLOGIN_CDP_PORT%/json/version'; if ($r.StatusCode -eq 200) { exit 0 } } catch {} exit 1" >nul 2>&1
if not errorlevel 1 goto cdp_ready

tasklist /FI "IMAGENAME eq gemlogin.exe" | find /I "gemlogin.exe" >nul
if not errorlevel 1 (
  echo GemLogin is already running without CDP on port %GEMLOGIN_CDP_PORT%.
  echo Close GemLogin and rerun this launcher, or start it with --remote-debugging-port=%GEMLOGIN_CDP_PORT%.
  exit /b 1
)

if not exist "%GEMLOGIN_EXE%" (
  echo GemLogin executable not found: %GEMLOGIN_EXE%
  echo Set GEMLOGIN_EXE to the installed GemLogin executable path and rerun this launcher.
  exit /b 1
)

start "" "%GEMLOGIN_EXE%" --remote-debugging-port=%GEMLOGIN_CDP_PORT%
for /L %%N in (1,1,30) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:%GEMLOGIN_CDP_PORT%/json/version'; if ($r.StatusCode -eq 200) { exit 0 } } catch {} exit 1" >nul 2>&1
  if not errorlevel 1 goto cdp_ready
  timeout /t 1 /nobreak >nul
)

echo GemLogin CDP did not become ready on port %GEMLOGIN_CDP_PORT%.
exit /b 1

:cdp_ready
npm start
exit /b %ERRORLEVEL%
