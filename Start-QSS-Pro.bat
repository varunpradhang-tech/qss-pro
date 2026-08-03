@echo off
setlocal
cd /d "%~dp0"
title QSS Pro Local Server
set QSS_PRO_WINDOWS_LAUNCHER=1
set PORT=4175
set OUT_LOG=server-4175.out.log
set ERR_LOG=server-4175.err.log
echo Starting QSS Pro local server...
echo.
echo App link: http://127.0.0.1:4175/
echo Keep this window open while using QSS Pro.
echo If the server stops, this window will restart it automatically.
echo Logs: %OUT_LOG% and %ERR_LOG%
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js or start QSS Pro from Codex for non-DWG testing.
  echo.
  pause
  exit /b 1
)
if not exist "server.js" (
  echo server.js was not found. This file must be run from the QSS Pro app folder.
  echo.
  pause
  exit /b 1
)

echo Running leakproof validation gate...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\..\validate-qss-product.ps1"
if errorlevel 1 (
  echo.
  echo QSS Pro validation failed. The app link was not opened because rules or tests need correction.
  echo.
  pause
  exit /b 1
)
echo Validation passed.
echo.

echo [%date% %time%] QSS Pro launcher started.>> "%OUT_LOG%"
echo [%date% %time%] QSS Pro launcher started.>> "%ERR_LOG%"
start "" /min cmd /c "timeout /t 3 >nul & explorer http://127.0.0.1:4175/"

:restart
set EXISTING_PID=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do set EXISTING_PID=%%P
if defined EXISTING_PID (
  echo.
  echo QSS Pro is already running on http://127.0.0.1:%PORT%/ using process %EXISTING_PID%.
  echo Opening the existing app link. Close the other QSS Pro server window before starting a fresh server.
  start "" "http://127.0.0.1:%PORT%/"
  echo.
  pause
  exit /b 0
)
echo.
echo [%date% %time%] Starting QSS Pro server on http://127.0.0.1:%PORT%/
echo [%date% %time%] Starting QSS Pro server on http://127.0.0.1:%PORT%/>> "%OUT_LOG%"
node server.js >> "%OUT_LOG%" 2>> "%ERR_LOG%"
set EXIT_CODE=%ERRORLEVEL%
echo.
echo [%date% %time%] QSS Pro server stopped with exit code %EXIT_CODE%.
echo [%date% %time%] QSS Pro server stopped with exit code %EXIT_CODE%.>> "%ERR_LOG%"
echo Restarting in 5 seconds. Keep this window open, or close it to stop QSS Pro.
timeout /t 5 >nul
goto restart
