<#
.SYNOPSIS
    Asks for the GitHub access token with hidden input (shown as *) and
    prints it to stdout, where ops-setup.bat captures it with "for /f".
.DESCRIPTION
    The prompt and the * echo are written to stderr / the console, so only
    the token itself ends up in stdout. Keeps asking until a token with a
    valid format (letters, digits, underscore - e.g. ghp_... or github_pat_...)
    is entered and GitHub confirms it can read the repository. If GitHub
    can't be reached (no internet), the token is accepted with a warning and
    the later git pull verifies it. The token is never written to disk.
.PARAMETER Repo
    "owner/name" of the private repository the token must be able to read
#>
param(
    [string]$Repo = "unknown0492/estv-ops"
)

# Forces TLS 1.2, required by api.github.com from older PowerShell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

<#
.DESCRIPTION
    Asks the GitHub API whether the token can read the repository.
.PARAMETER Token
    The access token to check
.RETURNS
    [string] "ok", "invalid" (401), "noaccess" (403/404) or "offline" (GitHub unreachable / other error)
#>
function Test-GitHubToken {
    param([string]$Token)

    try {
        $headers = @{ Authorization = "Bearer $Token"; 'User-Agent' = 'esTV-Gen3-Setup' }
        Invoke-WebRequest -Uri "https://api.github.com/repos/$Repo" -Headers $headers -UseBasicParsing -TimeoutSec 20 | Out-Null
        return "ok"
    } catch {
        $response = $_.Exception.Response
        if (-not $response) { return "offline" }
        $code = [int]$response.StatusCode
        if ($code -eq 401) { return "invalid" }
        if ($code -eq 403 -or $code -eq 404) { return "noaccess" }
        return "offline"
    }
}

<#
.DESCRIPTION
    Reads one line from the keyboard without showing it, printing * per
    character. Backspace removes the last character, Enter finishes.
.PARAMETER Prompt
    Text shown before the input
.RETURNS
    [string] the typed text
#>
function Read-HiddenLine {
    param([string]$Prompt)

    [Console]::Error.Write($Prompt)
    # Characters typed so far
    $chars = New-Object System.Text.StringBuilder

    while ($true) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq 'Enter') { break }
        if ($key.Key -eq 'Backspace') {
            if ($chars.Length -gt 0) {
                [void]$chars.Remove($chars.Length - 1, 1)
                [Console]::Error.Write("`b `b")
            }
            continue
        }
        if (-not [char]::IsControl($key.KeyChar)) {
            [void]$chars.Append($key.KeyChar)
            [Console]::Error.Write('*')
        }
    }
    [Console]::Error.WriteLine()
    return $chars.ToString().Trim()
}

while ($true) {
    $token = Read-HiddenLine -Prompt "Enter GitHub access token for estv-ops (input hidden): "

    if ([string]::IsNullOrEmpty($token)) {
        [Console]::Error.WriteLine("Token cannot be empty. Please try again.")
        continue
    }
    # Format check also guarantees the token can't break the git command line
    if ($token -notmatch '^[A-Za-z0-9_]+$') {
        [Console]::Error.WriteLine("Invalid token format (only letters, digits and _ allowed). Please try again.")
        continue
    }

    [Console]::Error.WriteLine("Checking the token with GitHub...")
    # Result of the GitHub check (if/elseif instead of switch: "continue" inside a switch would not restart this loop)
    $check = Test-GitHubToken -Token $token
    if ($check -eq "invalid") {
        [Console]::Error.WriteLine("GitHub rejected this token (wrong or expired). Please try again.")
        continue
    } elseif ($check -eq "noaccess") {
        [Console]::Error.WriteLine("This token is valid but has no access to $Repo. Please use the correct token.")
        continue
    } elseif ($check -eq "offline") {
        [Console]::Error.WriteLine("WARNING: Could not reach GitHub to check the token. It will be verified when estv-ops is downloaded.")
    } else {
        [Console]::Error.WriteLine("Token accepted - it has access to $Repo.")
    }

    Write-Output $token
    exit 0
}
