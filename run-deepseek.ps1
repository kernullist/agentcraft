<#
.SYNOPSIS
  One-shot: prepare this PC and run AgentCraft with the team on DeepSeek (API key).

.DESCRIPTION
  Windows helper, the DeepSeek sibling of run-codex.ps1. Steps:
    1. check node (22+) and git
    2. JDK 25 for Minecraft 26.3: JAVA_HOME, else %USERPROFILE%\.jdks\jdk-25*, else download
       Temurin 25 (portable zip, SHA-256 checked); the system default java is not changed
    3. environment: JAVA_HOME, GRADLE_USER_HOME=<repo>\.gradle-home, TEMP/TMP outside
       %LOCALAPPDATA%\Temp (AF_UNIX sockets fail there on some PCs; see
       docs/research/windows-build-setup.md)
    4. target repo: -Repo, default sandbox\deepseek-demo (created from the demo template if missing)
    5. start the Foreman only (claude runtime, profile "deepseek"; tools\launch.ps1 -NoGame)
    6. DeepSeek connection: reuse the saved one when its key still works; otherwise (first run,
       -Rekey, or a rejected key) ask for the key with hidden input and hand it to the Foreman on
       stdin (never on a command line). The Foreman keeps it in the OS credential store and tests
       it; then the connection is assigned to -Role (default: the whole team)
    7. start the game (tools\launch.ps1 reuses the running Foreman)

  The repository's code and diffs are sent to DeepSeek (api.deepseek.com). The first setup asks
  you to confirm that (-Yes skips the question).

.EXAMPLE
  .\run-deepseek.ps1
  .\run-deepseek.ps1 -Repo C:\code\my-repo
  .\run-deepseek.ps1 -Role workers                  # Marlow stays on the command-line Claude connection
  .\run-deepseek.ps1 -ApiKeyEnv DEEPSEEK_API_KEY    # key from an environment variable instead
  .\run-deepseek.ps1 -Rekey                         # replace the saved key
  .\run-deepseek.ps1 -LeadModel deepseek-v4-pro -WorkerModel deepseek-flash
  tools\stop.ps1 -Profile deepseek                  # stop what this started
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Repo,
    [ValidateSet('all', 'workers', 'lead')][string]$Role = 'all',
    [string]$ApiKeyEnv,
    [switch]$Rekey,
    [string]$LeadModel,
    [string]$WorkerModel,
    [switch]$Yes,
    [switch]$NoGame,
    [switch]$Dev,
    [switch]$Reset,
    [Alias('Home')][string]$AgentHome,
    [int]$Port = 0,
    [int]$DevPort = 0,
    [string[]]$ForemanArgs = @()
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Launch = Join-Path $Root 'tools\launch.ps1'
$Cli = Join-Path $Root 'tools\foremancli.mjs'
$PsExe = (Get-Process -Id $PID).Path
$ProfileName = 'deepseek'
if ($Port -le 0)
{
    $Port = 7878
    if ($env:AGENTCRAFT_PORT)
    {
        $Port = [int]$env:AGENTCRAFT_PORT
    }
}

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

# The launch.ps1 arguments every step shares (profile, home, ports).
function Get-CommonLaunchArgs
{
    $a = @('-Backend', 'claude', '-Profile', $ProfileName, '-Port', [string]$Port)
    if ($AgentHome)
    {
        $a += @('-Home', $AgentHome)
    }
    if ($DevPort -gt 0)
    {
        $a += @('-DevPort', [string]$DevPort)
    }
    if ($Dev)
    {
        $a += '-Dev'
    }
    return $a
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

# foremancli connection-setup. $Key (plain text) goes to the child's stdin only, never to its
# command line. Returns @{ code = exit code; result = parsed JSON (or $null) }.
function Invoke-ConnectionSetup([string]$Key, [switch]$WithRekey)
{
    $cliArgs = @($Cli, 'connection-setup', '--provider', 'deepseek', '--role', $Role, '--port', [string]$Port, '--timeout', '60')
    if ($LeadModel)
    {
        $cliArgs += @('--lead-model', $LeadModel)
    }
    if ($WorkerModel)
    {
        $cliArgs += @('--worker-model', $WorkerModel)
    }
    if ($ApiKeyEnv)
    {
        $cliArgs += @('--key-env', $ApiKeyEnv)
    }
    if ($WithRekey)
    {
        $cliArgs += '--rekey'
    }
    $text = $null
    if ($Key)
    {
        $cliArgs += '--key-stdin'
        $text = $Key | & node @cliArgs
    }
    else
    {
        $text = & node @cliArgs
    }
    $code = $LASTEXITCODE
    $json = $null
    try
    {
        $json = ($text | Where-Object { $_ -is [string] } | Out-String) | ConvertFrom-Json
    }
    catch
    {
        $json = $null
    }
    return @{ code = $code; result = $json; raw = ($text | Out-String) }
}

# Hidden input; the plain text exists only for the pipe into foremancli.
function Read-ApiKey
{
    $sec = Read-Host -AsSecureString 'DeepSeek API key (hidden)'
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try
    {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally
    {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
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
    $Repo = Join-Path $Root 'sandbox\deepseek-demo'
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
Write-Step "5/7 starting the Foreman (claude runtime, profile $ProfileName, port $Port)"
$fmArgs = (Get-CommonLaunchArgs) + @('-Repo', $Repo, '-NoGame')
if ($Reset)
{
    $fmArgs += '-Reset'
}
$rc = Invoke-Launch $fmArgs $ForemanArgs
if ($rc -ne 0)
{
    Stop-WithError 'the Foreman did not start (see the output above)'
}

# ---- 6. DeepSeek connection -----------------------------------------------------------------
Write-Step "6/7 DeepSeek connection (role: $Role)"
$attempt = 0
$done = $false
$confirmed = [bool]$Yes
$needKey = [bool]$Rekey
do
{
    $attempt++
    if ($attempt -gt 3)
    {
        break
    }
    $key = $null
    if ($needKey -and -not $ApiKeyEnv)
    {
        if (-not $confirmed)
        {
            Write-Host ''
            Write-Host '  Your repository''s code and diffs will be sent to DeepSeek (api.deepseek.com).' -ForegroundColor Yellow
            $ans = Read-Host '  Continue? [y/N]'
            if ($ans -notmatch '^(y|yes)$')
            {
                Stop-WithError 'cancelled. The Foreman keeps running (tools\stop.ps1 -Profile deepseek to stop it).'
            }
            $confirmed = $true
        }
        if ([Console]::IsInputRedirected)
        {
            Stop-WithError 'no console to type the key into: use -ApiKeyEnv NAME (an environment variable holding the key)'
        }
        $key = Read-ApiKey
        if (-not $key)
        {
            Stop-WithError 'no key entered'
        }
    }
    $r = Invoke-ConnectionSetup -Key $key -WithRekey:($needKey -and -not $key -and -not $ApiKeyEnv)
    $key = $null
    if ($r.code -eq 0 -and $r.result -and $r.result.ok)
    {
        $c = $r.result.connection
        Write-Host ("DeepSeek connection '{0}' works (key {1}); assigned: lead {2}, workers {3}" -f $c.id, $c.secret, $r.result.assignment.lead, $r.result.assignment.workers) -ForegroundColor Green
        $done = $true
        break
    }
    if ($r.code -eq 3)
    {
        $why = if ($r.result -and $r.result.error) { $r.result.error } else { 'a key is needed' }
        if ($ApiKeyEnv)
        {
            Stop-WithError "the key from env:$ApiKeyEnv does not work: $why"
        }
        if ($needKey)
        {
            Write-Host "  $why" -ForegroundColor Red
        }
        $needKey = $true
        continue
    }
    $msg = if ($r.result -and $r.result.error) { $r.result.error } else { $r.raw }
    Stop-WithError "could not set up the connection: $msg"
}
while (-not $done)

if (-not $done)
{
    Stop-WithError 'no working DeepSeek key after 3 tries. The Foreman keeps running: in game, console /connect fixes it too.'
}
if ($Role -ne 'all')
{
    Write-Host "Note: the other role stays on the command-line Claude connection; it needs Claude access (ANTHROPIC_API_KEY or --use-claude-login)." -ForegroundColor Yellow
}

# ---- 7. game --------------------------------------------------------------------------------
Write-Step '7/7 game'
if ($NoGame)
{
    Write-Host "skipped (-NoGame). The Foreman is running: connect with ""cd foreman; npm run tui -- --port $Port"" or start the game later."
}
else
{
    $gameArgs = (Get-CommonLaunchArgs) + @('-Repo', $Repo)
    $rc = Invoke-Launch $gameArgs @()
    if ($rc -ne 0)
    {
        Stop-WithError 'the game did not start (see the output above)'
    }
}

Write-Host ''
Write-Host 'Done. Press ` in game to type a goal; /connect shows the connections. Stop everything with: tools\stop.ps1 -Profile deepseek' -ForegroundColor Green
