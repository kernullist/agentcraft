# Windows build environment for a dev shell. Dot-source it before building or launching:
#   . .\dev-env.ps1
# (run-codex.ps1 does the same setup itself, and installs JDK 25 if it is missing.)
#
# - JAVA_HOME: a JDK 25 from JAVA_HOME or %USERPROFILE%\.jdks\jdk-25* (the system default java
#   is not changed).
# - GRADLE_USER_HOME: repo-local, as mod/DEV.md and tools/launch.ps1 expect.
# - TEMP/TMP: on some PCs AF_UNIX connect() fails anywhere under %LOCALAPPDATA%\Temp
#   ("Unable to establish loopback connection" from every JVM NIO Selector, so the Gradle
#   daemon, Netty and the DevBridge all break). The 8.3 short TEMP path also breaks one
#   foreman test (realpath mismatch). A long, non-Temp, non-repo dir fixes both.
#   See docs/research/windows-build-setup.md.

$jdk = $null
if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe')))
{
    $line = & $env:ComSpec /d /c "`"$(Join-Path $env:JAVA_HOME 'bin\java.exe')`" -version 2>&1" | Select-Object -First 1
    if ($line -match 'version "(\d+)' -and [int]$Matches[1] -ge 25)
    {
        $jdk = $env:JAVA_HOME
    }
}
if (-not $jdk)
{
    $cand = Get-ChildItem (Join-Path $env:USERPROFILE '.jdks') -Directory -Filter 'jdk-25*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($cand -and (Test-Path (Join-Path $cand.FullName 'bin\java.exe')))
    {
        $jdk = $cand.FullName
    }
}
if (-not $jdk)
{
    Write-Warning 'JDK 25 not found (JAVA_HOME or %USERPROFILE%\.jdks\jdk-25*). Run .\run-codex.ps1 once or install Temurin 25.'
}
else
{
    $env:JAVA_HOME = $jdk
    $env:PATH = (Join-Path $jdk 'bin') + ';' + $env:PATH
}

$env:GRADLE_USER_HOME = Join-Path $PSScriptRoot '.gradle-home'

$tmp = Join-Path $env:USERPROFILE '.agentcraft-tmp'
New-Item -ItemType Directory -Force $tmp | Out-Null
$env:TEMP = $tmp
$env:TMP = $tmp

Write-Host "JAVA_HOME=$env:JAVA_HOME"
Write-Host "GRADLE_USER_HOME=$env:GRADLE_USER_HOME"
Write-Host "TEMP=$env:TEMP"
