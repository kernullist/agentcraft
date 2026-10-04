<#
.SYNOPSIS
  One-shot: prepare this PC and run AgentCraft with the codex backend (ChatGPT plan, device-code sign-in).

.DESCRIPTION
  Windows helper (macOS: node tools/mac.mjs launch --backend codex). Steps:
    1. check node (22+) and git
    2. JDK 25 for Minecraft 26.3: JAVA_HOME, else %USERPROFILE%\.jdks\jdk-25*, else download
       Temurin 25 (portable zip, SHA-256 checked); the system default java is not changed
    3. environment: JAVA_HOME, GRADLE_USER_HOME=<repo>\.gradle-home, TEMP/TMP outside
       %LOCALAPPDATA%\Temp (AF_UNIX sockets fail there on some PCs, which breaks every JVM NIO
       selector; see docs/research/windows-build-setup.md)
    4. target repo: -Repo, default sandbox\codex-demo (created from the demo template if missing)
    5. start the Foreman only (tools\launch.ps1 -NoGame); npm deps incl. the bundled Codex CLI
       are installed by launch.ps1 when needed
    6. wait for the ChatGPT sign-in: show the device code, copy it to the clipboard, open the
       verification page; continue once the Foreman logs "codex auth ok"
    7. start the game (tools\launch.ps1 reuses the running Foreman)

.EXAMPLE
  .\run-codex.ps1
  .\run-codex.ps1 -Repo C:\code\my-repo
  .\run-codex.ps1 -NoGame                      # Foreman + sign-in only
  .\run-codex.ps1 -ForemanArgs '--workers','kit,wren','--effort','low'
  tools\stop.ps1 -Profile codex                # stop what this started
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Repo,
    [switch]$NoGame,
    [switch]$Dev,
    [switch]$Reset,
    [switch]$NoBrowser,
    [int]$LoginTimeoutSec = 900,
    [string[]]$ForemanArgs = @()
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Launch = Join-Path $Root 'tools\launch.ps1'
$PsExe = (Get-Process -Id $PID).Path
$script:Failed = $false

function Write-Step([string]$Text)
{
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Stop-WithError([string]$Text)
{
    Write-Host "ERROR: $Text" -ForegroundColor Red
    exit 1
}

# Run tools\launch.ps1 in a child PowerShell (it calls exit on failure). -Command with each
# argument single-quoted keeps arrays intact: with -File, -ForemanArgs would arrive as one
# comma-joined string, which the Foreman refuses.
function Invoke-Launch([string[]]$LaunchArgs, [string[]]$ForemanList)
{
    $q = { param($v) "'" + ($v -replace "'", "''") + "'" }
    $parts = @('&', (& $q $Launch))
    foreach ($a in $LaunchArgs)
    {
        if ($a.StartsWith('-'))
        {
            $parts += $a
        }
        else
        {
            $parts += (& $q $a)
        }
    }
    if ($ForemanList -and $ForemanList.Count -gt 0)
    {
        $parts += '-ForemanArgs'
        $parts += (($ForemanList | ForEach-Object { & $q $_ }) -join ',')
    }
    & $PsExe -NoProfile -ExecutionPolicy Bypass -Command ($parts -join ' ') | Out-Host
    return $LASTEXITCODE
}

function Get-JavaMajor([string]$JavaExe)
{
    $major = 0
    do
    {
        if (-not (Test-Path $JavaExe))
        {
            break
        }
        # java -version prints to stderr; cmd merges it so PowerShell does not treat it as an error
        $line = & $env:ComSpec /d /c "`"$JavaExe`" -version 2>&1" | Select-Object -First 1
        if ($line -match 'version "(\d+)')
        {
            $major = [int]$Matches[1]
        }
    }
    while ($false)
    return $major
}

function Find-Jdk25
{
    $found = $null
    do
    {
        if ($env:JAVA_HOME -and ((Get-JavaMajor (Join-Path $env:JAVA_HOME 'bin\java.exe')) -ge 25))
        {
            $found = $env:JAVA_HOME
            break
        }
        $jdks = Join-Path $env:USERPROFILE '.jdks'
        if (Test-Path $jdks)
        {
            $cand = Get-ChildItem $jdks -Directory -Filter 'jdk-25*' | Sort-Object Name -Descending | Select-Object -First 1
            if ($cand -and ((Get-JavaMajor (Join-Path $cand.FullName 'bin\java.exe')) -ge 25))
            {
                $found = $cand.FullName
            }
        }
    }
    while ($false)
    return $found
}

function Install-Jdk25
{
    $dst = Join-Path $env:USERPROFILE '.jdks'
    New-Item -ItemType Directory -Force $dst | Out-Null
    $api = 'https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
    $pkg = (Invoke-RestMethod $api)[0].binary.package
    Write-Host ("downloading {0} ({1:N0} MB) from Adoptium" -f $pkg.name, ($pkg.size / 1MB))
    $zip = Join-Path $dst $pkg.name
    Invoke-WebRequest $pkg.link -OutFile $zip
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $pkg.checksum)
    {
        Remove-Item $zip -Force
        Stop-WithError "JDK checksum mismatch (got $hash, expected $($pkg.checksum))"
    }
    Expand-Archive $zip -DestinationPath $dst -Force
    Remove-Item $zip -Force
}

# ---- 1. tools -------------------------------------------------------------------------------
Write-Step '1/7 checking node and git'
if (-not (Get-Command node -ErrorAction SilentlyContinue))
{
    Stop-WithError 'node is not installed (Node 22+ required: https://nodejs.org)'
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22)
{
    Stop-WithError "Node 22+ required (found $(node -v))"
}
if (-not (Get-Command git -ErrorAction SilentlyContinue))
{
    Stop-WithError 'git is not installed'
}
Write-Host "node $(node -v), $(git --version)"

# ---- 2. JDK 25 ------------------------------------------------------------------------------
Write-Step '2/7 JDK 25'
if ($NoGame)
{
    Write-Host 'skipped (-NoGame)'
}
else
{
    $jdk = Find-Jdk25
    if (-not $jdk)
    {
        Install-Jdk25
        $jdk = Find-Jdk25
        if (-not $jdk)
        {
            Stop-WithError 'JDK 25 install failed'
        }
    }
    $env:JAVA_HOME = $jdk
    $env:PATH = (Join-Path $jdk 'bin') + ';' + $env:PATH
    Write-Host "JAVA_HOME=$jdk"
}

# ---- 3. environment -------------------------------------------------------------------------
Write-Step '3/7 environment'
$env:GRADLE_USER_HOME = Join-Path $Root '.gradle-home'
$tmp = Join-Path $env:USERPROFILE '.agentcraft-tmp'
New-Item -ItemType Directory -Force $tmp | Out-Null
$env:TEMP = $tmp
$env:TMP = $tmp
Write-Host "GRADLE_USER_HOME=$env:GRADLE_USER_HOME"
Write-Host "TEMP=$tmp"

# ---- 4. target repo -------------------------------------------------------------------------
Write-Step '4/7 target repo'
if (-not $Repo)
{
    $Repo = Join-Path $Root 'sandbox\codex-demo'
    if (-not (Test-Path (Join-Path $Repo '.git')))
    {
        Write-Host "creating the demo repo at $Repo"
        node (Join-Path $Root 'sandbox\create-demo.mjs') --dir $Repo --quiet
        if ($LASTEXITCODE -ne 0)
        {
            Stop-WithError 'could not create the demo repo'
        }
    }
}
$Repo = [System.IO.Path]::GetFullPath($Repo)
if (-not (Test-Path (Join-Path $Repo '.git')))
{
    Stop-WithError "$Repo is not a git repository root"
}
Write-Host "repo $Repo"

# ---- 5. Foreman -----------------------------------------------------------------------------
Write-Step '5/7 starting the Foreman (codex backend)'
$summaryFile = Join-Path $tmp 'run-codex-foreman.json'
Remove-Item $summaryFile -ErrorAction SilentlyContinue
$fmArgs = @('-Backend', 'codex', '-Repo', $Repo, '-NoGame', '-SummaryJson', $summaryFile)
if ($Reset)
{
    $fmArgs += '-Reset'
}
if ($Dev)
{
    $fmArgs += '-Dev'
}
$rc = Invoke-Launch $fmArgs $ForemanArgs
if ($rc -ne 0)
{
    Stop-WithError 'the Foreman did not start (see the output above)'
}
$fmLog = $null
if (Test-Path $summaryFile)
{
    $sum = Get-Content $summaryFile -Raw | ConvertFrom-Json
    if ($sum.foreman -and $sum.foreman.log)
    {
        $fmLog = $sum.foreman.log
    }
}
if (-not $fmLog)
{
    $fmLog = Join-Path $Root 'artifacts\logs\foreman-codex.log'
}
Write-Host "Foreman log: $fmLog"

# ---- 6. ChatGPT sign-in ---------------------------------------------------------------------
Write-Step '6/7 ChatGPT sign-in'
$reCode = 'Sign in to ChatGPT for Codex: open (\S+) and enter the code (\S+)'
$reOk = 'codex auth ok \((.*)\)'
$reFail = '(Codex sign-in did not complete.*|Codex sign-in failed.*|Could not start the Codex CLI.*)'
$shownCode = ''
$state = 'waiting'
$deadline = (Get-Date).AddSeconds($LoginTimeoutSec)
do
{
    if ((Get-Date) -gt $deadline)
    {
        $state = 'timeout'
        break
    }
    $lines = @()
    if (Test-Path $fmLog)
    {
        $lines = Get-Content $fmLog -Encoding UTF8 -Tail 400
    }
    # the newest relevant line decides (a reused Foreman may have older ones above it)
    $last = $lines | Where-Object { $_ -match $reCode -or $_ -match $reOk -or $_ -match $reFail } | Select-Object -Last 1
    if ($last -and ($last -match $reOk))
    {
        $state = 'ok'
        Write-Host "signed in: $($Matches[1])" -ForegroundColor Green
        break
    }
    if ($last -and ($last -match $reFail))
    {
        $state = 'failed'
        Write-Host $Matches[1] -ForegroundColor Red
        break
    }
    if ($last -and ($last -match $reCode) -and ($Matches[2] -ne $shownCode))
    {
        $url = $Matches[1]
        $shownCode = $Matches[2]
        Write-Host ''
        Write-Host '  +------------------------------------------------------+' -ForegroundColor Yellow
        Write-Host "    open : $url" -ForegroundColor Yellow
        Write-Host "    code : $shownCode" -ForegroundColor Yellow
        Write-Host '  +------------------------------------------------------+' -ForegroundColor Yellow
        try
        {
            Set-Clipboard -Value $shownCode
            Write-Host '  (code copied to the clipboard)'
        }
        catch
        {
            Write-Host '  (could not copy the code to the clipboard)'
        }
        if (-not $NoBrowser)
        {
            Start-Process $url
        }
        Write-Host '  waiting for the sign-in to complete...'
    }
    Start-Sleep -Seconds 1
}
while ($true)

if ($state -eq 'timeout')
{
    Stop-WithError "no sign-in within $LoginTimeoutSec s. The Foreman keeps running: check $fmLog, or tools\stop.ps1 -Profile codex and run this again."
}
if ($state -eq 'failed')
{
    Stop-WithError "sign-in failed. Stop the Foreman (tools\stop.ps1 -Profile codex) and run this again for a new code."
}

# ---- 7. game --------------------------------------------------------------------------------
Write-Step '7/7 game'
if ($NoGame)
{
    Write-Host 'skipped (-NoGame). The Foreman is running: connect with "cd foreman; npm run tui" or start the game later.'
}
else
{
    $gameArgs = @('-Backend', 'codex', '-Repo', $Repo)
    if ($Dev)
    {
        $gameArgs += '-Dev'
    }
    $rc = Invoke-Launch $gameArgs @()
    if ($rc -ne 0)
    {
        Stop-WithError 'the game did not start (see the output above)'
    }
}

Write-Host ''
Write-Host 'Done. Press ` in game to type a goal. Stop everything with: tools\stop.ps1 -Profile codex' -ForegroundColor Green
