@echo off
setlocal
cd /d "%~dp0"

if not defined GEMLOGIN_BASE set "GEMLOGIN_BASE=http://127.0.0.1:1010"
if not defined GEMLOGIN_CDP_BASE set "GEMLOGIN_CDP_BASE=http://127.0.0.1:9222"

npm start
exit /b %ERRORLEVEL%
