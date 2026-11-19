@echo off

:: ===========================================================================
:: install-cms.bat - installs or updates the esTV Custom Launcher CMS on the hotel's CMS PC:
::   estv-custom-launcher-cms -> <drive>:\estv-custom-launcher-cms   (PM2 "estv-custom-launcher-cms", port 4053)
:: Installs Git, Node.js and ADB when missing, PM2 with start at Windows startup, the Windows Firewall rule for
:: port 4053 (boxes and the web page), the Desktop shortcuts, then opens the web page. The first person to
:: sign in there with eslink chooses the hotel's property.
:: Runs again safely: an installed CMS is brought to the newest version; data\ (boxes, wallpaper, APKs,
:: property) is kept.
:: The GitHub access token is typed hidden, used for the download only and never saved.
:: ===========================================================================

:: ===================================
:: Self-elevation (the tools and the firewall rule need Administrator). Done BEFORE
:: "setlocal enabledelayedexpansion" so a "!" in the folder path can't be mangled.
:: ===================================
fltmc >nul 2>&1
if %errorlevel% equ 0 goto IS_ADMIN

echo Requesting Administrator privileges...
:: Full path of this .bat, passed via environment variable so spaces, quotes or parentheses can't break PowerShell
set "ELEVATE_SCRIPT=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath $env:ELEVATE_SCRIPT -Verb RunAs -ErrorAction Stop; exit 0 } catch { exit 1 }"
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Administrator privileges are required. The UAC prompt was cancelled or failed.
    echo Right-click install-cms.bat and choose "Run as administrator".
    pause
)
exit /b

:IS_ADMIN
:: An elevated cmd starts in C:\Windows\System32 - switch back to this script's folder
cd /d "%~dp0"

setlocal enabledelayedexpansion
title esTV Custom Launcher CMS Setup

:: ANSI colours
for /F %%a in ('echo prompt $E^|cmd') do set "ESC=%%a"
set "C_HEADER=%ESC%[96m"
set "C_STEP=%ESC%[95m"
set "C_OK=%ESC%[92m"
set "C_WARN=%ESC%[93m"
set "C_ERR=%ESC%[91m"
set "C_PROMPT=%ESC%[97m"
set "C_DIM=%ESC%[90m"
set "C_RESET=%ESC%[0m"

:: Results of every step, one "STATUS#text" line each (OK/WARN/FAIL/SKIP); Ensure-Tool.ps1 appends to it too
set "ESTV_SUMMARY_FILE=%TEMP%\cms-setup-summary.txt"
if exist "%ESTV_SUMMARY_FILE%" del /q "%ESTV_SUMMARY_FILE%"

:: GitHub repository (fixed), PM2 name and port of the CMS
set "CMS_REPO=unknown0492/estv-custom-launcher-cms"
set "CMS_PM2=estv-custom-launcher-cms"
set "CMS_PORT=4053"

:: ===================================
:: Welcome
:: ===================================
cls
echo %C_HEADER%==============================================================%C_RESET%
echo %C_HEADER%            esTV Custom Launcher CMS Setup%C_RESET%
echo %C_HEADER%==============================================================%C_RESET%
echo.
echo  %C_STEP%Purpose%C_RESET%
echo    Installs or updates the Custom Launcher CMS on this PC. The launcher
echo    boxes report to it every 5 minutes and take their wallpaper, home
echo    buttons and APK updates from it. It runs in PM2 and starts with Windows.
echo.
echo  %C_STEP%Keep these ready%C_RESET%
echo    - A working internet connection for the whole setup
echo    - The drive letter to install on ^(for example C or D^)
echo    - The GitHub access token ^(must read the CMS repository^)
echo    - An eslink account with access to the hotel's property
echo.
echo  %C_WARN%The boxes look for the CMS at 172.19.0.3 unless set otherwise in%C_RESET%
echo  %C_WARN%their Secret Menu. Give this PC that address, or set the right one on%C_RESET%
echo  %C_WARN%eslink: Other Products ^> Custom Launcher ^> CMS IP.%C_RESET%
echo.
echo %C_PROMPT%Press any key to begin...%C_RESET%
pause >nul

:: ===================================
:: Question 1: drive
:: ===================================
echo.
echo %C_HEADER%--------------------------------------------------------------%C_RESET%
echo %C_STEP% Installation drive%C_RESET%
echo %C_HEADER%--------------------------------------------------------------%C_RESET%

:ASK_DRIVE
:: Raw text typed by the user
set "DRIVE_IN="
set /p DRIVE_IN="%C_PROMPT%Enter the drive letter to install on [default: C]: %C_RESET%"
if not defined DRIVE_IN set "DRIVE_IN=C"
set "DRIVE_IN=!DRIVE_IN::=!"
set "DRIVE_IN=!DRIVE_IN:\=!"
:: Validated drive in "X:" form
set "INSTALL_DRIVE="
for %%L in (A B C D E F G H I J K L M N O P Q R S T U V W X Y Z) do if /i "!DRIVE_IN!"=="%%L" set "INSTALL_DRIVE=%%L:"
if not defined INSTALL_DRIVE (
    echo %C_WARN%Invalid input. Please enter a single drive letter, for example C or D.%C_RESET%
    goto ASK_DRIVE
)
if not exist "%INSTALL_DRIVE%\" (
    echo %C_WARN%Drive %INSTALL_DRIVE% was not found on this PC.%C_RESET%
    goto ASK_DRIVE
)
type nul > "%INSTALL_DRIVE%\cms-write-test.tmp" 2>nul
if not exist "%INSTALL_DRIVE%\cms-write-test.tmp" (
    echo %C_WARN%Cannot write to drive %INSTALL_DRIVE%.%C_RESET%
    goto ASK_DRIVE
)
del /q "%INSTALL_DRIVE%\cms-write-test.tmp" >nul 2>nul

:: App folder
set "CMS_DIR=%INSTALL_DRIVE%\estv-custom-launcher-cms"
call :SUMMARY OK "Installation folder: %CMS_DIR%"

:: ===================================
:: Question 2: GitHub token (checked against the repository)
:: ===================================
echo.
echo %C_HEADER%--------------------------------------------------------------%C_RESET%
echo %C_STEP% GitHub access token%C_RESET%
echo %C_HEADER%--------------------------------------------------------------%C_RESET%
echo  The CMS is downloaded from a private GitHub repository, so an access
echo  token is needed ^(ghp_... or github_pat_...^). What you type is hidden,
echo  checked with GitHub and NOT saved on this PC.
echo.
set "ESTV_TOKEN_SCRIPT=%~dp0Read-GitHubToken.ps1"
set "ESTV_TOKEN_REPO=%CMS_REPO%"
call :READ_GITHUB_TOKEN
echo.

:: ===================================
:: 1. Chocolatey
:: ===================================
echo %C_STEP%[1/7] Checking Chocolatey...%C_RESET%
where choco >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%ProgramData%\chocolatey\bin\choco.exe" (
        set "PATH=%PATH%;%ProgramData%\chocolatey\bin"
    ) else (
        echo Installing Chocolatey...
        powershell -ExecutionPolicy Bypass -Command "Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))"
        set "PATH=%PATH%;%ProgramData%\chocolatey\bin"
        if not exist "%ProgramData%\chocolatey\bin\choco.exe" (
            echo %C_ERR%ERROR: Chocolatey could not be installed.%C_RESET%
            call :SUMMARY FAIL "Chocolatey could not be installed - setup stopped"
            goto FINISH
        )
    )
)
call :SUMMARY OK "Chocolatey available"

:: ===================================
:: 2. Git, Node.js LTS and ADB (installed when missing - asked first, Enter = yes - or updated; see
::    Ensure-Tool.ps1). ADB (Android platform-tools) is used by "Install via ADB" on the APK updates page.
:: ===================================
echo.
echo %C_STEP%[2/7] Checking Git, Node.js and ADB...%C_RESET%
for %%T in (git nodejs-lts adb) do (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Ensure-Tool.ps1" -Package %%T
    echo.
)
call refreshenv >nul 2>nul
:: Makes freshly installed tools usable in this window
set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\nodejs;%APPDATA%\npm;%ProgramData%\chocolatey\bin"
where git >nul 2>nul
if %errorlevel% neq 0 (
    call :SUMMARY FAIL "Git is not available - setup stopped"
    goto FINISH
)
where node >nul 2>nul
if %errorlevel% neq 0 (
    call :SUMMARY FAIL "Node.js is not available - setup stopped"
    goto FINISH
)
:: ADB is optional: the CMS works without it, only "Install via ADB" needs it
where adb >nul 2>nul
if %errorlevel% neq 0 (
    call :SUMMARY WARN "ADB is not available - Install via ADB on the APK updates page will not work"
)

:: ===================================
:: 3. The CMS (first install or update to main; data\ is not in git, so it is kept)
:: ===================================
echo.
echo %C_STEP%[3/7] Downloading the CMS...%C_RESET%
:: Stops git from opening a login window when the token is rejected
set "GIT_TERMINAL_PROMPT=0"
if not exist "%CMS_DIR%" mkdir "%CMS_DIR%"
pushd "%CMS_DIR%"
if not exist ".git\HEAD" (
    if exist ".git" rmdir /s /q ".git"
    git init -q
)
:: Clean address without token (the token is only on the fetch command line)
git remote remove origin >nul 2>nul
git remote add origin https://github.com/%CMS_REPO%.git

:CMS_FETCH
git -c credential.helper= fetch -q https://x-access-token:!ESTV_GIT_TOKEN!@github.com/%CMS_REPO%.git main
if !errorlevel! neq 0 (
    echo %C_ERR%Download failed - the token may be wrong, expired, or lack access to %CMS_REPO%.%C_RESET%
    set "RETRY_IN="
    set /p RETRY_IN="%C_PROMPT%Try again with another token? (Y/N) [default: Y]: %C_RESET%"
    if "!RETRY_IN!"=="" set "RETRY_IN=Y"
    if /i "!RETRY_IN!"=="Y" (
        call :READ_GITHUB_TOKEN
        goto CMS_FETCH
    )
    call :SUMMARY FAIL "CMS: download failed - setup stopped"
    popd
    goto FINISH
)
:: The token is no longer needed
set "ESTV_GIT_TOKEN="
git checkout -q -f -B main FETCH_HEAD
if !errorlevel! neq 0 (
    call :SUMMARY FAIL "CMS: the code could not be checked out - setup stopped"
    popd
    goto FINISH
)
echo Installing packages...
call npm install --omit=dev --no-audit --no-fund
if !errorlevel! neq 0 (
    call :SUMMARY FAIL "CMS: npm install failed - setup stopped"
    popd
    goto FINISH
)
:: Version now installed, for the summary
set "APP_VERSION=?"
for /f "usebackq delims=" %%V in (`node -p "require('./package.json').version"`) do set "APP_VERSION=%%V"
call :SUMMARY OK "Custom Launcher CMS !APP_VERSION! installed in %CMS_DIR%"
popd

:: ===================================
:: 4. PM2 and start with Windows (as the normal user - see CMS-PM2-Init.bat)
:: ===================================
echo.
echo %C_STEP%[4/7] Setting up PM2 and the start with Windows...%C_RESET%
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
    echo Installing pm2...
    call npm install pm2 -g --no-audit --no-fund
)
where pm2-startup >nul 2>nul
if %errorlevel% neq 0 (
    echo Installing pm2-windows-startup...
    call npm install pm2-windows-startup -g --no-audit --no-fund
)
:: Written by CMS-PM2-Init.bat when it has finished
set "PM2_DONE_FILE=%TEMP%\cms-pm2-init.done"
if exist "%PM2_DONE_FILE%" del /q "%PM2_DONE_FILE%"
schtasks /create /tn "CMS_PM2_Init" /tr "\"%~dp0CMS-PM2-Init.bat\" \"%CMS_DIR%\" \"%PM2_DONE_FILE%\"" /sc once /st 00:00 /rl LIMITED /f >nul
if %errorlevel% neq 0 (
    call :SUMMARY FAIL "PM2 NOT set up - the setup task could not be created"
) else (
    schtasks /run /tn "CMS_PM2_Init" >nul
    echo Waiting for PM2 to start the CMS...
    for /l %%W in (1,1,60) do if not exist "%PM2_DONE_FILE%" timeout /t 2 >nul
    schtasks /delete /tn "CMS_PM2_Init" /f >nul
    if exist "%PM2_DONE_FILE%" (
        del /q "%PM2_DONE_FILE%"
        call :SUMMARY OK "PM2: CMS started, saved and set to start with Windows"
    ) else (
        call :SUMMARY WARN "PM2 did not confirm in 2 minutes - use the Start shortcut on the Desktop"
    )
)

:: ===================================
:: 5. Windows Firewall: the boxes and the web page use port 4053
:: ===================================
echo.
echo %C_STEP%[5/7] Windows Firewall rule for port %CMS_PORT%...%C_RESET%
netsh advfirewall firewall show rule name=estv-custom-launcher-cms >nul 2>&1
if %errorlevel% equ 0 (
    call :SUMMARY OK "Firewall rule estv-custom-launcher-cms (TCP %CMS_PORT%) already present"
) else (
    netsh advfirewall firewall add rule name=estv-custom-launcher-cms dir=in action=allow protocol=TCP localport=%CMS_PORT% profile=any >nul
    if !errorlevel! equ 0 (
        call :SUMMARY OK "Firewall rule estv-custom-launcher-cms (TCP %CMS_PORT%) added"
    ) else (
        call :SUMMARY WARN "Firewall rule estv-custom-launcher-cms (TCP %CMS_PORT%) could not be added - boxes cannot reach the CMS"
    )
)

:: ===================================
:: 6. Desktop shortcuts
:: ===================================
echo.
echo %C_STEP%[6/7] Desktop shortcuts...%C_RESET%
call :SHORTCUT "Custom Launcher CMS" "%CMS_DIR%\windows\Custom Launcher CMS.bat" "%CMS_DIR%" 13
call :SHORTCUT "Start Custom Launcher CMS" "%CMS_DIR%\windows\Start Custom Launcher CMS.bat" "%CMS_DIR%" 137
call :SUMMARY OK "Desktop shortcuts: web page and Start"

:: ===================================
:: 7. Web page
:: ===================================
echo.
echo %C_STEP%[7/7] Opening the web page...%C_RESET%
echo  Sign in with your eslink account. On a new CMS you then choose the
echo  hotel's property; its boxes get that property ID at their next check-in.
call :OPEN_URL "http://127.0.0.1:%CMS_PORT%/"
call :SUMMARY OK "Web page opened - http://127.0.0.1:%CMS_PORT%/"

:FINISH
set "ESTV_GIT_TOKEN="
call :SHOW_SUMMARY
exit /b 0

:: ===========================================================================
:: :SHORTCUT <name> <target .bat> <working folder> <shell32.dll icon index>
:: Desktop .lnk (replaced if present)
:: ===========================================================================
:SHORTCUT
set "SC_NAME=%~1"
set "SC_TARGET=%~2"
set "SC_DIR=%~3"
set "SC_ICON=%SystemRoot%\System32\shell32.dll,%~4"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) ($env:SC_NAME + '.lnk'))); $s.TargetPath = $env:SC_TARGET; $s.WorkingDirectory = $env:SC_DIR; $s.IconLocation = $env:SC_ICON; $s.WindowStyle = 7; $s.Save()"
exit /b 0

:: ===========================================================================
:: :OPEN_URL <url> - opens the browser (CMS_SETUP_TEST set = only prints it)
:: ===========================================================================
:OPEN_URL
if defined CMS_SETUP_TEST (
    echo OPEN %~1
) else (
    start "" "%~1"
)
exit /b 0

:: ===========================================================================
:: :SUMMARY <OK|WARN|FAIL|SKIP> "<text>" (avoid & < > | ! in the text)
:: ===========================================================================
:SUMMARY
>>"%ESTV_SUMMARY_FILE%" echo %~1#%~2
exit /b 0

:: ===========================================================================
:: :READ_GITHUB_TOKEN - hidden input, checked with GitHub against ESTV_TOKEN_REPO; kept in memory only
:: (not named GITHUB_TOKEN, which other tools read)
:: ===========================================================================
:READ_GITHUB_TOKEN
set "ESTV_GIT_TOKEN="
for /f "usebackq delims=" %%K in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "& $env:ESTV_TOKEN_SCRIPT -Repo $env:ESTV_TOKEN_REPO"`) do set "ESTV_GIT_TOKEN=%%K"
if not defined ESTV_GIT_TOKEN (
    echo %C_ERR%ERROR: No GitHub token was entered.%C_RESET%
    goto READ_GITHUB_TOKEN
)
exit /b 0

:: ===========================================================================
:: :SHOW_SUMMARY - every recorded result with a coloured tag, the totals, then waits for a key
:: ===========================================================================
:SHOW_SUMMARY
set /a "SUM_OK=0, SUM_WARN=0, SUM_FAIL=0, SUM_SKIP=0"
echo.
echo %C_HEADER%========================================%C_RESET%
echo %C_HEADER%   Setup Summary%C_RESET%
echo %C_HEADER%========================================%C_RESET%
echo.
if not exist "%ESTV_SUMMARY_FILE%" (
    echo   Nothing was recorded.
    goto SHOW_SUMMARY_END
)
for /f "usebackq tokens=1* delims=#" %%A in ("%ESTV_SUMMARY_FILE%") do (
    if "%%A"=="OK" (
        echo   %C_OK%[  OK  ]%C_RESET% %%B
        set /a SUM_OK+=1
    )
    if "%%A"=="WARN" (
        echo   %C_WARN%[ WARN ]%C_RESET% %%B
        set /a SUM_WARN+=1
    )
    if "%%A"=="FAIL" (
        echo   %C_ERR%[ FAIL ]%C_RESET% %%B
        set /a SUM_FAIL+=1
    )
    if "%%A"=="SKIP" (
        echo   %C_DIM%[ SKIP ]%C_RESET% %%B
        set /a SUM_SKIP+=1
    )
)
echo.
echo   %C_OK%!SUM_OK! done%C_RESET%, %C_WARN%!SUM_WARN! warning^(s^)%C_RESET%, %C_ERR%!SUM_FAIL! failed%C_RESET%, %C_DIM%!SUM_SKIP! skipped%C_RESET%
if !SUM_FAIL! gtr 0 echo   %C_ERR%Scroll up to see the error details of the failed items.%C_RESET%

:SHOW_SUMMARY_END
echo.
echo %C_HEADER%========================================%C_RESET%
echo.
if defined CMS_SETUP_TEST exit /b 0
echo %C_PROMPT%Press any key to exit...%C_RESET%
pause >nul
exit /b 0
