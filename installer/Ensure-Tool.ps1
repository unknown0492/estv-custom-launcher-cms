<#
.SYNOPSIS
    Makes sure one tool is installed and up to date, using Chocolatey.
.DESCRIPTION
    - Already installed and older than the latest Chocolatey version -> upgraded automatically (no prompt)
    - Already installed and up to date                              -> nothing is done
    - Not installed                                                 -> user is asked (Y/N) before installing
    The installed version is read from the tool itself (so installs made
    outside Chocolatey are detected too) and compared to the latest version
    published on the Chocolatey community repository.
.PARAMETER Package
    Chocolatey package id: notepadplusplus, git, nodejs-lts or adb
.NOTES
    Exit codes: 0 = OK / skipped by user, 1 = install or upgrade failed
#>
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("notepadplusplus", "git", "nodejs-lts", "adb")]
    [string]$Package
)

# Friendly display name shown to the user for each package
$displayNames = @{
    "notepadplusplus" = "Notepad++"
    "git"             = "Git SCM"
    "nodejs-lts"      = "Node.js (LTS)"
    "adb"             = "ADB (Android Debug Bridge)"
}
$name = $displayNames[$Package]

<#
.DESCRIPTION
    Appends one result line to the end-of-setup summary file created by
    ops-setup.bat (path passed in the ESTV_SUMMARY_FILE environment variable).
    Does nothing when the script is run on its own.
.PARAMETER Status
    OK, WARN, FAIL or SKIP
.PARAMETER Text
    Result description shown in the summary
.RETURNS
    void
#>
function Add-Summary {
    param([string]$Status, [string]$Text)

    if ($env:ESTV_SUMMARY_FILE) {
        Add-Content -Path $env:ESTV_SUMMARY_FILE -Value "$Status#$Text" -Encoding Ascii
    }
}

<#
.DESCRIPTION
    Converts any version-looking text ("v22.11.0", "git version 2.55.0.windows.3",
    "8.9.7.0") into a [version] made of its first 3 numeric parts, so versions
    reported by the tools and by Chocolatey can be compared reliably.
.PARAMETER Text
    Raw text containing a version number
.RETURNS
    [version] or $null if no version number was found
#>
function ConvertTo-ShortVersion {
    param([string]$Text)

    if ($Text -notmatch '(\d+)(?:\.(\d+))?(?:\.(\d+))?') { return $null }
    # Missing minor/patch parts are treated as 0
    $parts = @($Matches[1], $Matches[2], $Matches[3]) | ForEach-Object { if ($_) { [int]$_ } else { 0 } }
    return [version]("{0}.{1}.{2}" -f $parts[0], $parts[1], $parts[2])
}

<#
.DESCRIPTION
    Runs a tool's executable (from PATH or a known install folder) and
    returns the text it prints, or $null if the executable can't be found.
.PARAMETER Command
    Executable name to look up on PATH (e.g. "git")
.PARAMETER FallbackPaths
    Full paths checked when the command isn't on PATH (e.g. PATH not yet refreshed)
.PARAMETER Arguments
    Arguments that make the tool print its version
.RETURNS
    [string] output text, or $null
#>
function Get-ToolOutput {
    param([string]$Command, [string[]]$FallbackPaths, [string[]]$Arguments)

    $exe = $null
    $cmd = Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) {
        $exe = $cmd.Source
    } else {
        $exe = $FallbackPaths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    }
    if (-not $exe) { return $null }

    try {
        return (& $exe @Arguments 2>$null | Out-String)
    } catch {
        return $null
    }
}

<#
.DESCRIPTION
    Detects the version of the tool currently installed on this PC,
    regardless of whether it was installed by Chocolatey or manually.
.RETURNS
    [version] or $null when the tool is not installed
#>
function Get-InstalledVersion {
    switch ($Package) {
        "notepadplusplus" {
            # Notepad++ has no --version switch, so read the exe's file version
            $exe = @("$env:ProgramFiles\Notepad++\notepad++.exe", "${env:ProgramFiles(x86)}\Notepad++\notepad++.exe") |
                Where-Object { Test-Path $_ } | Select-Object -First 1
            if (-not $exe) { return $null }
            $info = (Get-Item $exe).VersionInfo
            return ConvertTo-ShortVersion ("{0}.{1}.{2}" -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart)
        }
        "git" {
            $out = Get-ToolOutput -Command "git" -FallbackPaths @("$env:ProgramFiles\Git\cmd\git.exe") -Arguments @("--version")
            if ($out) { return ConvertTo-ShortVersion $out }
        }
        "nodejs-lts" {
            $out = Get-ToolOutput -Command "node" -FallbackPaths @("$env:ProgramFiles\nodejs\node.exe") -Arguments @("--version")
            if ($out) { return ConvertTo-ShortVersion $out }
        }
        "adb" {
            # "adb version" prints "Android Debug Bridge version 1.0.41" then "Version 36.0.0-..."; the 2nd line is the package version
            $out = Get-ToolOutput -Command "adb" -FallbackPaths @("$env:ProgramData\chocolatey\lib\adb\tools\platform-tools\adb.exe") -Arguments @("version")
            if ($out -and $out -match '(?m)^Version\s+(\S+)') { return ConvertTo-ShortVersion $Matches[1] }
        }
    }
    return $null
}

<#
.DESCRIPTION
    Reads a "package|version" line from Chocolatey's --limit-output listing.
.PARAMETER ChocoArgs
    Arguments passed to choco (e.g. "list" or "search")
.RETURNS
    [version] or $null when the package isn't listed
#>
function Get-ChocoVersion {
    param([string[]]$ChocoArgs)

    $lines = & choco @ChocoArgs $Package --exact --limit-output 2>$null
    $line = $lines | Where-Object { $_ -like "$Package|*" } | Select-Object -First 1
    if (-not $line) { return $null }
    return ConvertTo-ShortVersion ($line.Split('|')[1])
}

<#
.DESCRIPTION
    Runs "choco install" or "choco upgrade" for the package and reports the result.
.PARAMETER Action
    "install" or "upgrade"
.PARAMETER SummaryText
    Text recorded in the setup summary on success
.RETURNS
    [int] 0 on success, 1 on failure
#>
function Invoke-Choco {
    param([string]$Action, [string]$SummaryText)

    # Out-Host shows choco's output live without it becoming this function's return value
    & choco $Action $Package -y --no-progress | Out-Host
    # 3010 = success, but Windows needs a reboot to finish
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 3010) {
        # Past-tense wording for the success message
        $done = if ($Action -eq "install") { "installed" } else { "updated" }
        Write-Host "$name $done successfully." -ForegroundColor Green
        Add-Summary -Status "OK" -Text $SummaryText
        return 0
    }
    Write-Host "ERROR: $name $Action failed (choco exit code $LASTEXITCODE)." -ForegroundColor Red
    Add-Summary -Status "FAIL" -Text "$name $Action failed (choco exit code $LASTEXITCODE)"
    return 1
}

Write-Host "Checking $name..." -ForegroundColor Cyan

# Version installed on this PC (tool itself first, Chocolatey's local record as fallback)
$installed = Get-InstalledVersion
if (-not $installed) { $installed = Get-ChocoVersion -ChocoArgs @("list") }

# --- Not installed: ask before installing ---
if (-not $installed) {
    while ($true) {
        $answer = Read-Host "$name is not installed. Install it now? (Y/N) [default: Y]"
        if ([string]::IsNullOrWhiteSpace($answer)) { $answer = "Y" }
        if ($answer -match '^[Yy]$') { exit (Invoke-Choco -Action "install" -SummaryText "$name installed") }
        if ($answer -match '^[Nn]$') {
            Write-Host "Skipping $name installation." -ForegroundColor Yellow
            Add-Summary -Status "SKIP" -Text "$name not installed (skipped by user)"
            exit 0
        }
        Write-Host "Invalid input. Please enter Y or N." -ForegroundColor Yellow
    }
}

# --- Installed: compare with the latest version and upgrade silently if older ---
$latest = Get-ChocoVersion -ChocoArgs @("search")
if (-not $latest) {
    Write-Host "WARNING: Could not check the latest $name version online. Keeping installed v$installed." -ForegroundColor Yellow
    Add-Summary -Status "WARN" -Text "$name v$installed kept - could not check for updates"
    exit 0
}

if ($installed -lt $latest) {
    Write-Host "$name v$installed is installed, latest is v$latest. Updating..." -ForegroundColor Yellow
    exit (Invoke-Choco -Action "upgrade" -SummaryText "$name updated from v$installed to v$latest")
}

Write-Host "$name is up to date (v$installed)." -ForegroundColor Green
Add-Summary -Status "OK" -Text "$name already up to date (v$installed)"
exit 0
