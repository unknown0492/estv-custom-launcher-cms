# install.ps1 - esTV Custom Launcher CMS one-line installer (2026-11-19)
#
# Run on a hotel PC, in a normal cmd window:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm https://files.estv.cloud/estv-custom-launcher-cms/installer/install.ps1 | iex"
#
# What it does:
#   1. Downloads install-cms.bat and the files it uses (CMS-PM2-Init.bat and the .ps1 helpers) from
#      https://files.estv.cloud/estv-custom-launcher-cms/installer/ into %TEMP%\cms-setup (a fresh, empty folder).
#   2. Starts install-cms.bat as Administrator (Windows asks "Do you want to allow..." - press Yes).
#      The setup itself guides the user step by step in that window.
#   3. Waits until that window is closed, then deletes the downloaded files.
# Nothing secret is in these files: the GitHub token is typed during the setup and only kept in memory.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'                                    # Faster downloads (no progress bar)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$CmsBaseUrl = 'https://files.estv.cloud/estv-custom-launcher-cms/installer/'                     # Where the setup files are published
$CmsWorkDir = Join-Path $env:TEMP 'cms-setup'                               # Temporary folder for this run
$CmsFiles   = @(                                                            # install-cms.bat first, then everything it calls
    'install-cms.bat',
    'CMS-PM2-Init.bat',
    'Ensure-Tool.ps1',
    'Read-GitHubToken.ps1'
)

<#
.DESCRIPTION Prints one line in the given colour
.PARAMETER Text  The text
.PARAMETER Color Console colour name
#>
function Write-CmsLine( [string]$Text, [string]$Color = 'Gray' ){
    Write-Host $Text -ForegroundColor $Color
}

<#
.DESCRIPTION Downloads every setup file into a fresh temporary folder and checks it is not empty
.OUTPUTS [bool] $true when all files were downloaded
#>
function Get-CmsSetupFiles(){
    if( Test-Path -LiteralPath $CmsWorkDir ){
        Remove-Item -LiteralPath $CmsWorkDir -Recurse -Force                 # Leftovers of an earlier run
    }
    New-Item -ItemType Directory -Path $CmsWorkDir -Force | Out-Null
    $stamp = [DateTime]::UtcNow.Ticks                                       # Avoids an old cached copy
    foreach( $name in $CmsFiles ){
        $out = Join-Path $CmsWorkDir $name                                  # Local file
        try{
            Invoke-WebRequest -Uri ( $CmsBaseUrl + $name + '?t=' + $stamp ) -OutFile $out -UseBasicParsing
        } catch {
            Write-CmsLine ( '  FAILED  ' + $name + ' - ' + $_.Exception.Message ) 'Red'
            return $false
        }
        if( ( Get-Item -LiteralPath $out ).Length -lt 20 ){
            Write-CmsLine ( '  FAILED  ' + $name + ' - the downloaded file is empty' ) 'Red'
            return $false
        }
        Write-CmsLine ( '  OK      ' + $name ) 'Green'
    }
    return $true
}

<#
.DESCRIPTION Main flow: download, start install-cms.bat as Administrator, wait, clean up
#>
function Start-CmsInstaller(){
    Write-Host ''
    Write-CmsLine '==============================================================' 'Cyan'
    Write-CmsLine '   esTV Custom Launcher CMS installer' 'Cyan'
    Write-CmsLine '==============================================================' 'Cyan'
    Write-CmsLine ' This installs or updates the esTV Custom Launcher CMS on this PC.'
    Write-CmsLine ' Keep ready: the GitHub access token and an eslink account with access to the hotel.'
    Write-Host ''
    Write-CmsLine ( ' Step 1 of 2: downloading the setup files into ' + $CmsWorkDir + ' ...' ) 'Yellow'

    if( -not ( Get-CmsSetupFiles ) ){
        Write-Host ''
        Write-CmsLine ' The setup files could not be downloaded. Check the internet connection and run the command again.' 'Red'
        return
    }

    Write-Host ''
    Write-CmsLine ' Step 2 of 2: starting the setup as Administrator.' 'Yellow'
    Write-CmsLine '   - Windows now asks "Do you want to allow this app to make changes?" - press YES.'
    Write-CmsLine '   - A new window "esTV Custom Launcher CMS Setup" opens: follow the questions there.'
    Write-CmsLine '   - Keep THIS window open; it tidies up when the setup window is closed.'
    Write-Host ''

    $bat = Join-Path $CmsWorkDir 'install-cms.bat'                            # The setup started as Administrator
    try{
        $proc = Start-Process -FilePath $bat -WorkingDirectory $CmsWorkDir -Verb RunAs -PassThru
    } catch {
        Write-CmsLine ' The setup was not started: Administrator permission was refused (UAC: No).' 'Red'
        Write-CmsLine ' Run the same command again and press YES.' 'Red'
        return
    }

    Write-CmsLine ' Setup is running in the Administrator window - waiting for it to finish...' 'Cyan'
    $proc.WaitForExit()

    Remove-Item -LiteralPath $CmsWorkDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-CmsLine ' The setup window was closed and the downloaded setup files were removed.' 'Green'
    Write-CmsLine ' Check the summary shown in the setup window for anything marked WARN or FAIL.' 'Green'
    Write-CmsLine ' Sign in on the CMS web page (Desktop shortcut "Custom Launcher CMS") to choose the hotel.' 'Green'
    Write-Host ''
}

Start-CmsInstaller
