#!/usr/bin/env pwsh
# Behavioural tests for the native WINDOWS bootstrap (agent/native/windows/bootstrap.ps1,
# XERK-673) — the PowerShell port of test_bootstrap.sh.
#
# bootstrap.ps1 is the README's `irm | iex` front door: fetched and run straight off main
# on a host with no checkout, so a bug here misfires on every new Windows install and there
# is no deployed copy to fix — the next operator just pipes the broken script again.
# PSScriptAnalyzer covers correctness; this covers the decisions.
#
# The load-bearing assertion is the SAME as the bash suite's: CARRIED-ASSET RESOLUTION.
# A release umbrella carries an unchanged windows build forward under its ORIGINAL older
# name, so the newest release tag (v0.9.0) can hold turma-agent-windows-v0.3.0.zip.
# Deriving the asset name from the tag would ask for a v0.9.0 zip that was never built;
# only the URL the release actually publishes is real.
#
# Unlike the bash suite there is no PATH-stubbable `curl`. Instead each case runs the REAL
# script in a child pwsh that, with $env:TURMA_BOOTSTRAP_NORUN set (so the script defines
# its functions but does NOT auto-run), dot-sources bootstrap.ps1, then dot-sources a SHIM
# that overrides its three seams — Get-ReleaseJson / Get-ReleaseFile (a fake release stream
# + an asset store keyed by URL path, so a URL bootstrap invented rather than read out of
# the stream 404s exactly as it would against GitHub) and Resolve-Pwsh (the test runner's
# own pwsh, so the handoff drives a stub install.ps1 that records the version + args it got).
# It runs on the POSIX CI runner like the other PS suites; winget/ConPTY stay host proof.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Here      = Split-Path -Parent $PSCommandPath
$WinDir    = Join-Path (Split-Path -Parent $Here) 'native/windows'
$Bootstrap = Join-Path $WinDir 'bootstrap.ps1'
$Work      = Join-Path ([System.IO.Path]::GetTempPath()) ("turma-bootstrap-test-" + [guid]::NewGuid().ToString('N'))
$PwshExe   = (Get-Process -Id $PID).Path
$Script:Failed = 0

function Ok([string]$m)   { [Console]::Out.WriteLine("  ok: $m") }
function Fail([string]$m) { [Console]::Out.WriteLine("  FAIL: $m"); $Script:Failed = 1 }
function Note([string]$m) { [Console]::Out.WriteLine($m) }
function Assert-Eq($expected, $actual, $okMsg, $failMsg) {
  if ("$expected" -eq "$actual") { Ok $okMsg } else { Fail "$failMsg (expected '$expected', got '$actual')" }
}

New-Item -ItemType Directory -Force -Path $Work | Out-Null

# --- the SHIM: overrides bootstrap's three seams inside the child --------------------------
# Written once; each child dot-sources it after bootstrap.ps1. Reads $env:FAKE_DIR (the
# release stream + asset store) and $env:INSTALL_RECORD (where the stub install.ps1 writes).
$Shim = Join-Path $Work 'shim.ps1'
Set-Content -LiteralPath $Shim -Value @'
function Get-ReleaseJson([string]$Url) {
  $f = Join-Path $env:FAKE_DIR 'releases.json'
  if (-not (Test-Path -LiteralPath $f)) { throw "unreachable" }   # bootstrap maps this to its API error
  return (Get-Content -LiteralPath $f -Raw | ConvertFrom-Json)
}
function Get-ReleaseFile([string]$Url, [string]$OutFile) {
  # .../releases/download/<tag>/<name> -> $FAKE_DIR/assets/<tag>/<name>; anything else 404s.
  $m = [regex]::Match($Url, '/releases/download/(.+)$')
  if (-not $m.Success) { throw "404 $Url" }
  $src = Join-Path (Join-Path $env:FAKE_DIR 'assets') $m.Groups[1].Value
  if (-not (Test-Path -LiteralPath $src)) { throw "404 $Url" }   # a URL bootstrap invented
  Copy-Item -LiteralPath $src -Destination $OutFile -Force
}
function Resolve-Pwsh { return (Get-Process -Id $PID).Path }
'@

# --- fixture builders ---------------------------------------------------------------------
# A windows asset whose stub install.ps1 records how it was called: the version it shipped
# and the args bootstrap forwarded. Mirrors the real asset's flat layout (install.ps1 at the
# root beside hub-agent.py), which is what bootstrap hands off to.
function New-Asset([string]$Version, [string]$OutDir) {   # writes <OutDir>/turma-agent-windows-v<ver>.zip[.sha256]
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $staged = Join-Path $Work ("stage-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $staged | Out-Null
  Set-Content -LiteralPath (Join-Path $staged 'VERSION') -Value $Version -NoNewline
  Set-Content -LiteralPath (Join-Path $staged 'hub-agent.py') -Value "# hub-agent $Version"
  Set-Content -LiteralPath (Join-Path $staged 'install.ps1') -Value @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @())
$root = Split-Path -Parent $PSCommandPath
Set-Content -LiteralPath "$env:INSTALL_RECORD.version" -Value (Get-Content -LiteralPath (Join-Path $root 'VERSION') -Raw) -NoNewline
Set-Content -LiteralPath "$env:INSTALL_RECORD.args" -Value ($Rest -join ' ') -NoNewline
exit 0
'@
  $zip = Join-Path $OutDir "turma-agent-windows-v$Version.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -Path (Join-Path $staged '*') -DestinationPath $zip
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$zip.sha256" -Value "$hash  turma-agent-windows-v$Version.zip" -NoNewline
  Remove-Item -Recurse -Force -LiteralPath $staged
}

# Publish a build under a release tag: the zip is BUILT at <asset-version> and served from
# <tag>'s download path. A tag whose version differs from the asset's stages a carried release.
function Publish([string]$Fake, [string]$Tag, [string]$AssetVersion) {
  New-Asset $AssetVersion (Join-Path (Join-Path $Fake 'assets') $Tag)
}

# releases.json listing "<tag>:<asset-version>" pairs, newest-first (the API's order).
function Write-Releases([string]$File, [string[]]$Pairs) {
  $rels = foreach ($p in $Pairs) {
    $tag = $p.Split(':')[0]; $ver = $p.Split(':')[1]
    [pscustomobject]@{
      tag_name = $tag
      assets   = @(
        [pscustomobject]@{ name = 'manifest.json'; browser_download_url = "https://github.com/o/r/releases/download/$tag/manifest.json" }
        [pscustomobject]@{ name = "turma-agent-windows-v$ver.zip"; browser_download_url = "https://github.com/o/r/releases/download/$tag/turma-agent-windows-v$ver.zip" }
        [pscustomobject]@{ name = "turma-agent-windows-v$ver.zip.sha256"; browser_download_url = "https://github.com/o/r/releases/download/$tag/turma-agent-windows-v$ver.zip.sha256" }
      )
    }
  }
  Set-Content -LiteralPath $File -Value (ConvertTo-Json @($rels) -Depth 8)
}

function New-Fake { $f = Join-Path $Work ("fake-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Force -Path (Join-Path $f 'assets') | Out-Null; return $f }

# Run the real bootstrap in a child pwsh with the shim installed. Returns @{ Code; Out }.
function Invoke-Bootstrap-Child([string]$Fake, [string]$Record, [string]$ForwardLiteral) {
  $outFile = Join-Path $Work ("out-" + [guid]::NewGuid().ToString('N') + '.log')
  # A private TMPDIR per call so the assertion below can prove bootstrap's temp dir
  # ([Path]::GetTempPath() honours TMPDIR on Unix) is swept even on the refusal paths.
  $tmp = Join-Path $Work ("tmp-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $inner = ". '$Bootstrap'; . '$Shim'; exit (Invoke-Bootstrap $ForwardLiteral)"
  $sh = "exec `"$PwshExe`" -NoProfile -Command `"$($inner.Replace('"','\"'))`" > `"$outFile`" 2>&1"
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = '/bin/sh'
  $psi.ArgumentList.Add('-c'); $psi.ArgumentList.Add($sh)
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['TURMA_BOOTSTRAP_NORUN'] = '1'
  $psi.EnvironmentVariables['FAKE_DIR']       = $Fake
  $psi.EnvironmentVariables['INSTALL_RECORD'] = $Record
  $psi.EnvironmentVariables['TMPDIR']         = $tmp
  $p = [System.Diagnostics.Process]::Start($psi)
  $null = $p.WaitForExit(60000)
  $out = if (Test-Path -LiteralPath $outFile) { Get-Content -LiteralPath $outFile -Raw } else { '' }
  $leaked = @(Get-ChildItem -LiteralPath $tmp -Directory -Filter 'turma-bootstrap-*' -ErrorAction SilentlyContinue)
  return @{ Code = $p.ExitCode; Out = $out; Leaked = $leaked.Count }
}

Note "test_bootstrap_ps1.ps1"

try {
  # --- Case 1: picks the newest windows build, and passes args through --------------------
  Note "case: newest windows version wins + args passthrough"
  $fake = New-Fake
  Publish $fake 'v0.3.0' '0.3.0'
  Publish $fake 'v0.4.1' '0.4.1'
  Write-Releases (Join-Path $fake 'releases.json') @('v0.4.1:0.4.1', 'v0.3.0:0.3.0')
  $rec = Join-Path $Work ("rec1-" + [guid]::NewGuid().ToString('N'))
  $r = Invoke-Bootstrap-Child $fake $rec "@('-Verify','-Prefix','D:\turma')"
  if ($r.Code -eq 0) {
    Assert-Eq '0.4.1' (Get-Content -LiteralPath "$rec.version" -Raw) "installed the newest windows build" "installed the wrong version"
    Assert-Eq '-Verify -Prefix D:\turma' (Get-Content -LiteralPath "$rec.args" -Raw) "forwarded its args to install.ps1" "dropped or mangled install.ps1 args"
    if ($r.Leaked -eq 0) { Ok "cleaned its temp dir on the happy path" } else { Fail "leaked $($r.Leaked) temp dir(s) on the happy path" }
  } else { Fail "bootstrap exited $($r.Code) on a good release stream: $($r.Out)" }

  # --- Case 2: carried asset under an older name on a newer tag (the load-bearing one) ----
  Note "case: carried asset under an older name on a newer tag"
  $fake = New-Fake
  Publish $fake 'v0.3.0' '0.3.0'      # where it was built
  Publish $fake 'v0.9.0' '0.3.0'      # carried onto the newer umbrella, same name
  Write-Releases (Join-Path $fake 'releases.json') @('v0.9.0:0.3.0', 'v0.3.0:0.3.0')
  $rec = Join-Path $Work ("rec2-" + [guid]::NewGuid().ToString('N'))
  $r = Invoke-Bootstrap-Child $fake $rec "@()"
  if ($r.Code -eq 0) {
    Assert-Eq '0.3.0' (Get-Content -LiteralPath "$rec.version" -Raw) "resolved the carried asset by its own filename version" "failed to resolve a carried asset"
  } else { Fail "bootstrap failed on a carried release: $($r.Out)" }

  # --- Case 3: a bad checksum must refuse to install --------------------------------------
  Note "case: checksum mismatch refuses"
  $fake = New-Fake
  Publish $fake 'v0.4.1' '0.4.1'
  Write-Releases (Join-Path $fake 'releases.json') @('v0.4.1:0.4.1')
  Add-Content -LiteralPath (Join-Path $fake 'assets/v0.4.1/turma-agent-windows-v0.4.1.zip') -Value 'tampered'
  $rec = Join-Path $Work ("rec3-" + [guid]::NewGuid().ToString('N'))
  $r = Invoke-Bootstrap-Child $fake $rec "@()"
  if ($r.Code -eq 0) { Fail "installed a zip whose checksum did not match" }
  elseif ($r.Out -match 'checksum mismatch') { Ok "refused a tampered zip" }
  else { Fail "refused, but not for the checksum: $($r.Out)" }
  if (Test-Path -LiteralPath "$rec.version") { Fail "ran install.ps1 despite the bad checksum" } else { Ok "never reached install.ps1" }
  # The refusal exits through Die, BEFORE Invoke-Bootstrap's finally — Die must still sweep
  # the temp dir (the downloaded, tampered zip), the parity gap vs bootstrap.sh's EXIT trap.
  if ($r.Leaked -eq 0) { Ok "swept its temp dir on the refusal path" } else { Fail "leaked $($r.Leaked) temp dir(s) after a refusal (Die did not clean up)" }

  # --- Case 4: a missing checksum sidecar must refuse too --------------------------------
  Note "case: missing checksum refuses"
  $fake = New-Fake
  Publish $fake 'v0.4.1' '0.4.1'
  Write-Releases (Join-Path $fake 'releases.json') @('v0.4.1:0.4.1')
  Remove-Item -LiteralPath (Join-Path $fake 'assets/v0.4.1/turma-agent-windows-v0.4.1.zip.sha256') -Force
  $rec = Join-Path $Work ("rec4-" + [guid]::NewGuid().ToString('N'))
  $r = Invoke-Bootstrap-Child $fake $rec "@()"
  if ($r.Code -eq 0) { Fail "installed unverified bits when no checksum was published" }
  elseif ($r.Out -match 'no checksum published') { Ok "refused unverified bits" }
  else { Fail "refused, but not for the missing checksum: $($r.Out)" }

  # --- Case 5: a stream with no windows asset fails clearly ------------------------------
  Note "case: no windows release found"
  $fake = New-Fake
  Set-Content -LiteralPath (Join-Path $fake 'releases.json') -Value (ConvertTo-Json @(
    [pscustomobject]@{ tag_name = 'glasses-v0.2.22'; assets = @([pscustomobject]@{ name = 'turma-hud-v0.2.22.ehpk'; browser_download_url = 'https://github.com/o/r/releases/download/glasses-v0.2.22/turma-hud-v0.2.22.ehpk' }) }
  ) -Depth 8)
  $r = Invoke-Bootstrap-Child $fake (Join-Path $Work 'rec5') "@()"
  if ($r.Code -eq 0) { Fail "claimed success with no windows asset in the stream" }
  elseif ($r.Out -match 'no windows agent release found') { Ok "reported an empty windows stream clearly" }
  else { Fail "failed, but without a usable message: $($r.Out)" }

  # --- Case 6: an unreachable API fails clearly -----------------------------------------
  Note "case: unreachable release API"
  $fake = New-Fake   # no releases.json written
  $r = Invoke-Bootstrap-Child $fake (Join-Path $Work 'rec6') "@()"
  if ($r.Code -eq 0) { Fail "claimed success when the release API was unreachable" }
  elseif ($r.Out -match 'cannot reach the GitHub release API') { Ok "reported the unreachable API clearly" }
  else { Fail "failed, but without a usable message: $($r.Out)" }

  # --- Case 7: the scriptblock entry accepts arbitrary install flags into $args ----------
  # The passthrough contract: `& ([scriptblock]::Create((irm .../bootstrap.ps1))) -Verify …`
  # must NOT reject -Verify/-Prefix as a binding error — which is exactly what an advanced
  # function with a declared param would do to an unknown flag. So this proves the script
  # stays param-less ($args capture). NORUN skips main, so no network/handoff runs.
  Note "case: scriptblock entry accepts arbitrary install flags (no param-binding error)"
  $env:TURMA_BOOTSTRAP_NORUN = '1'
  try {
    $sb = [scriptblock]::Create((Get-Content -LiteralPath $Bootstrap -Raw))
    try { & $sb -Verify -Prefix 'D:\turma' -NoInstallDeps; Ok "accepted -Verify/-Prefix/-NoInstallDeps verbatim" }
    catch { Fail "rejected passthrough flags at the entry (a param()/CmdletBinding regression?): $_" }
  } finally { Remove-Item Env:\TURMA_BOOTSTRAP_NORUN -ErrorAction SilentlyContinue }
}
finally {
  Remove-Item -Recurse -Force -LiteralPath $Work -ErrorAction SilentlyContinue
}

Note ""
if ($Script:Failed -eq 0) { Note "all windows bootstrap tests passed" } else { Note "FAILURES" }
exit $Script:Failed
