@echo off
setlocal
cd /d "%~dp0"

if not defined GEMLOGIN_BASE set "GEMLOGIN_BASE=http://127.0.0.1:1010"
if not defined GEMLOGIN_CDP_PORT set "GEMLOGIN_CDP_PORT=9222"
if not defined GEMLOGIN_CDP_BASE set "GEMLOGIN_CDP_BASE=http://127.0.0.1:%GEMLOGIN_CDP_PORT%"
if not defined GEMLOGIN_EXE set "GEMLOGIN_EXE=%LOCALAPPDATA%\Programs\gemlogin\gemlogin.exe"

node scripts/ensure-gemlogin-windows.mjs
if errorlevel 1 exit /b 1

npm start
exit /b %ERRORLEVEL%
