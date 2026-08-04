@echo off
setlocal
cd /d "%~dp0"
title QSS Pro DWG Mode
set QSS_PRO_WINDOWS_LAUNCHER=1
set PORT=4175
set OUT_LOG=server-4175.out.log
set ERR_LOG=server-4175.err.log
echo Starting QSS Pro DWG Mode...
echo.
echo Use this link after the server starts:
echo http://127.0.0.1:4175/
echo.
echo Keep this window open while extracting quantities from DWG/BAK drawings.
echo DXF/PDF uploads do not need DWG Mode.
echo Logs: %OUT_LOG% and %ERR_LOG%
echo.
set EXISTING_PID=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do set EXISTING_PID=%%P
if defined EXISTING_PID (
  echo QSS Pro is already running on http://127.0.0.1:%PORT%/ using process %EXISTING_PID%.
  echo Use the existing browser tab or open http://127.0.0.1:%PORT%/.
  echo This monitor window will stay open. Close this window only when you want to stop using this launcher.
  goto monitor_existing
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js before using QSS Pro DWG Mode.
  echo.
  goto hold_window
)
if not exist "server.js" (
  echo server.js was not found. Run this file from the QSS Pro app folder.
  echo.
  goto hold_window
)

echo Running leakproof validation gate...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\..\validate-qss-product.ps1"
if errorlevel 1 (
  echo.
  echo QSS Pro validation failed. DWG Mode was not opened because rules or tests need correction.
  echo.
  goto hold_window
)
echo Validation passed.
echo.

echo [%date% %time%] QSS Pro DWG Mode launcher started.>> "%OUT_LOG%"
echo [%date% %time%] QSS Pro DWG Mode launcher started.>> "%ERR_LOG%"
start "" /min cmd /c "timeout /t 3 >nul & explorer http://127.0.0.1:4175/"

:restart
set EXISTING_PID=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do set EXISTING_PID=%%P
if defined EXISTING_PID (
  echo.
  echo QSS Pro is already running on http://127.0.0.1:%PORT%/ using process %EXISTING_PID%.
  echo Use the existing browser tab or open http://127.0.0.1:%PORT%/. Close the other QSS Pro server window before starting a fresh DWG Mode server.
  echo This monitor window will stay open. Close this window only when you want to stop using this launcher.
  goto monitor_existing
)
echo.
echo [%date% %time%] Starting QSS Pro DWG Mode on http://127.0.0.1:%PORT%/
echo [%date% %time%] Starting QSS Pro DWG Mode on http://127.0.0.1:%PORT%/>> "%OUT_LOG%"
node server.js >> "%OUT_LOG%" 2>> "%ERR_LOG%"
set EXIT_CODE=%ERRORLEVEL%
echo.
echo [%date% %time%] QSS Pro DWG Mode stopped with exit code %EXIT_CODE%.
echo [%date% %time%] QSS Pro DWG Mode stopped with exit code %EXIT_CODE%.>> "%ERR_LOG%"
echo QSS Pro stopped. Read the message above, then close this window manually.
goto hold_window

:monitor_existing
timeout /t 60 >nul
goto monitor_existing

:hold_window
echo.
echo Keep this window open for diagnostics. Close it manually when finished.
timeout /t 60 >nul
goto hold_window
