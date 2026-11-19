@echo off
:: ===========================================================================
:: Start Custom Launcher CMS - Desktop shortcut "Start Custom Launcher CMS"
::
:: For when the CMS has stopped: starts it in PM2 again (or adds it to PM2 if it is missing), saves the PM2
:: list so it also starts with Windows, then opens the web page. Safe to run while the CMS is running -
:: nothing is restarted then. Run it as the normal Windows user, not as Administrator.
:: ===========================================================================
setlocal
title Start Custom Launcher CMS

:: The app folder is the parent of this windows\ folder
set "APP_DIR=%~dp0.."
set "CMS_PORT=4053"

cd /d "%APP_DIR%"

where pm2 >nul 2>&1
if errorlevel 1 (
    echo PM2 is not installed on this PC. Run install-cms.bat first.
    pause
    exit /b 1
)

echo Starting the Custom Launcher CMS...
:: Starts only what is not running; a running CMS is left as it is
call pm2 start ecosystem.config.js
call pm2 save >nul

echo.
echo The Custom Launcher CMS is running. Opening its web page: http://127.0.0.1:%CMS_PORT%/
timeout /t 3 >nul
start "" "http://127.0.0.1:%CMS_PORT%/"
endlocal
