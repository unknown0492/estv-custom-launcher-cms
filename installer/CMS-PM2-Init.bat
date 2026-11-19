@echo off
:: ===========================================================================
:: CMS-PM2-Init.bat - started by install-cms.bat through a temporary de-elevated scheduled task, so that PM2's
:: daemon and its start at Windows startup belong to the normal user, not to Administrator (an Admin PM2 talks to
:: a different daemon and later normal pm2 commands fail with "connect EPERM \\.\pipe\rpc.sock").
::
:: Usage: CMS-PM2-Init.bat "<CMS folder>" "<done file>"
::   Registers PM2 to start with Windows, starts the CMS from its ecosystem.config.js or restarts it when it is
::   already running (so an update takes effect), saves the PM2 list, then writes the done file.
:: ===========================================================================
setlocal

:: Folder of the CMS
set "CMS_DIR=%~1"
:: File written at the end
set "DONE_FILE=%~2"

echo Registering PM2 to start with Windows...
call pm2-startup install

if exist "%CMS_DIR%\ecosystem.config.js" (
    echo Starting the Custom Launcher CMS...
    pushd "%CMS_DIR%"
    call pm2 describe estv-custom-launcher-cms >nul 2>&1
    if errorlevel 1 (
        call pm2 start ecosystem.config.js
    ) else (
        call pm2 restart estv-custom-launcher-cms --update-env
    )
    popd
)

echo Saving the PM2 list...
call pm2 save

if not "%DONE_FILE%"=="" echo done> "%DONE_FILE%"
endlocal
