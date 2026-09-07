#!/usr/bin/env pwsh
# Behavioural tests for the native WINDOWS self-updater
# (agent/native/windows/turma-agent-update.ps1, XERK-674).
#
# The port of test_turma_agent_update.sh. The updater is the ONLY runtime consumer of the
# release scheme and runs on deployed hosts we can't push to — a bug here mis-updates the whole
# native Windows fleet, so this pins the DECISIONS PSScriptAnalyzer cannot see. Each case stages
# a fake $Prefix + a fake `gh` on PATH serving canned releases, runs the real script, and
# asserts what it installed and stamped.
#
# The load-bearing assertion is the carried-release NO-OP: a unified release whose tag moved
# ahead but whose Windows COMPONENT was carried must not reinstall — comparing the tag instead
# of the component version would reinstall the same bits every poll and mis-stamp VERSION.
#
# Pinned here:
#   1. a newer component installs and stamps the COMPONENT version;
#   2. a carried release (tag ahead, component unchanged) is a NO-OP;
#   3. a carried asset on an OLDER release_tag resolves from that release;
#   4. a checksum mismatch refuses, VERSION unchanged;
#   5. an up-to-date unified release is a no-op;
#   6. the legacy stream is the fallback when no unified release exists;
#   7. a successful install leaves the updating.json expected-restart hint (XERK-29);
#   8. a payload MISSING hooks/ is refused (the swap deletes installed hooks first, so this
#      would fail the guard OPEN — the completeness refusal);
#   9. the lock / holder / stamps are PREFIX-SCOPED (XERK-551);
#  10. a WEDGED lock holder is reclaimed once it ages past the threshold (XERK-549);
#  11. a HEALTHY (young) holder is NOT reclaimed — single-flight preserved;
#  12. a recent stamp makes -Boot skip (the every-start rate limit, XERK-254);
#  13. Claude Code: up-to-date no-op, a newer version installs, and an UNREADABLE claude is
#      repaired-then-remembered (claude-unparseable) so a futile repair is not retried forever.
#
# PowerShell-on-POSIX like the launcher/controller suites: the real updater runs; only what it
# shells out to (gh, npm, claude, the restart) is stubbed. Run on the same ubuntu-latest runner.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Here    = Split-Path -Parent $PSCommandPath
$WinDir  = Join-Path (Split-Path -Parent $Here) 'native/windows'
$Updater = Join-Path $WinDir 'turma-agent-update.ps1'
$Work    = Join-Path ([System.IO.Path]::GetTempPath()) ("turma-upd-" + [guid]::NewGuid().ToString('N'))
$Script:Failed = 0

function Ok([string]$m)   { [Console]::Out.WriteLine("  ok: $m") }
function Fail([string]$m) { [Console]::Out.WriteLine("  FAIL: $m"); $Script:Failed = 1 }
function Note([string]$m) { [Console]::Out.WriteLine($m) }

$PwshExe = (Get-Process -Id $PID).Path
New-Item -ItemType Directory -Force -Path $Work | Out-Null

# Mirror Get-PrefixTag: sha256 of the RESOLVED prefix path, first 12 hex chars.
function Get-PrefixTag([string]$Prefix) {
  $full = (Resolve-Path -LiteralPath $Prefix).Path
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($full)) } finally { $sha.Dispose() }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
}

function New-ShStub([string]$Path, [string]$Body) {
  $text = "#!/bin/sh`n" + ($Body -replace "`r`n", "`n")
  [System.IO.File]::WriteAllText($Path, $text)
  & chmod +x $Path
}

# --- fake gh (the same interface the bash suite serves) ---------------------------------------
# Data-driven from $FAKE_GH_DIR: tags, manifests/<tag>.json, assets/<tag>/<file>...
function Install-FakeGh([string]$BinDir) {
  New-ShStub (Join-Path $BinDir 'gh') @'
D="$FAKE_GH_DIR"
case "${1:-}" in
  auth) exit 0 ;;
  api) cat "$D/tags" 2>/dev/null || true; exit 0 ;;
  release)
    shift; shift  # 'release' 'download'
    tag=""; dir=""; patterns=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --pattern) shift; patterns="$patterns $1" ;;
        --dir) shift; dir="$1" ;;
        --repo) shift ;;
        --clobber) ;;
        -*) ;;
        *) [ -z "$tag" ] && tag="$1" ;;
      esac
      shift
    done
    mkdir -p "$dir"
    # Real `gh release download` downloads assets matching ANY --pattern; a pattern that
    # matches nothing is not an error. Succeed iff at least one asset was copied (so a
    # genuinely-absent asset still fails). The legacy path sends *.zip *.tar.gz *.sha256 and
    # a zip-only release legitimately has no tar.gz.
    got=0
    for p in $patterns; do
      for f in "$D/assets/$tag/"*; do
        [ -e "$f" ] || continue
        base=$(basename "$f")
        case "$base" in $p) cp "$f" "$dir/$base"; got=1 ;; esac
      done
    done
    [ "$got" = 1 ] || exit 1
    exit 0 ;;
  *) exit 0 ;;
esac
'@
}

# A session-preserving restart stub so a successful install doesn't touch a real service.
function Install-StubCtl([string]$BinDir) {
  Set-Content -LiteralPath (Join-Path $BinDir 'turma-agentctl.ps1') -Value @'
param([Parameter(Position=0)][string]$Command)
[Console]::Out.WriteLine("stub-ctl $Command")
exit 0
'@
}

# --- payload builder -------------------------------------------------------------------------
# A .zip that satisfies Install-Payload's completeness check (hub-agent.py + tunnel-agent.js +
# hooks/), plus a .zip.sha256 sidecar. -NoHooks omits hooks/ to exercise the refusal.
function New-Payload([string]$Version, [string]$DestDir, [switch]$NoHooks) {
  $staging = Join-Path $Work ("stage-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path (Join-Path $staging 'hooks'), (Join-Path $staging 'qwen') | Out-Null
  Set-Content -LiteralPath (Join-Path $staging 'hub-agent.py')       -Value "# hub-agent $Version"
  Set-Content -LiteralPath (Join-Path $staging 'tunnel-agent.js')    -Value "// tunnel $Version"
  Set-Content -LiteralPath (Join-Path $staging 'hooks\guard.py')     -Value "# guard $Version"
  Set-Content -LiteralPath (Join-Path $staging 'qwen_session.py')    -Value "# qwen $Version"
  Set-Content -LiteralPath (Join-Path $staging 'qwen_transcript.py') -Value "# qwen tx $Version"
  Set-Content -LiteralPath (Join-Path $staging 'qwen\ask_mcp.py')    -Value "# ask $Version"
  Set-Content -LiteralPath (Join-Path $staging 'VERSION')            -Value $Version -NoNewline
  if ($NoHooks) { Remove-Item -Recurse -Force -LiteralPath (Join-Path $staging 'hooks') }
  New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
  $name = "turma-agent-windows-v$Version.zip"
  $zip = Join-Path $DestDir $name
  Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
  Set-Content -LiteralPath "$zip.sha256" -Value "$hash  $name" -NoNewline
  Remove-Item -Recurse -Force -LiteralPath $staging
  return $zip
}

function New-GhDir {
  $d = Join-Path $Work ("gh-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path (Join-Path $d 'manifests'), (Join-Path $d 'assets') | Out-Null
  return $d
}

# Add a unified release: tag, Windows component version, and the asset on a (possibly older)
# release_tag — the carried-asset case.
function Add-UnifiedRelease([string]$GhDir, [string]$Tag, [string]$Nver, [string]$Atag) {
  Add-Content -LiteralPath (Join-Path $GhDir 'tags') -Value $Tag
  $asset = "turma-agent-windows-v$Nver.zip"
  $manifest = @"
{ "schema":1, "version":"$($Tag.TrimStart('v'))", "tag":"$Tag",
  "components": {
    "agent-windows": {
      "version":"$Nver", "kind":"asset",
      "asset":"$asset", "sha256_asset":"$asset.sha256",
      "release_tag":"$Atag", "built":true
    }
  }
}
"@
  Set-Content -LiteralPath (Join-Path $GhDir "manifests\$Tag.json") -Value $manifest
  New-Item -ItemType Directory -Force -Path (Join-Path $GhDir "assets\$Tag") | Out-Null
  Copy-Item -LiteralPath (Join-Path $GhDir "manifests\$Tag.json") -Destination (Join-Path $GhDir "assets\$Tag\manifest.json")
  New-Payload $Nver (Join-Path $GhDir "assets\$Atag") | Out-Null
}

# --- run the updater against a staged prefix -------------------------------------------------
$Script:Prefix = $null
function New-Prefix([string]$Installed) {
  $root = Join-Path $Work ("case-" + [guid]::NewGuid().ToString('N'))
  $prefix = Join-Path $root 'prefix'
  $bin = Join-Path $prefix 'bin'
  New-Item -ItemType Directory -Force -Path $bin, (Join-Path $prefix 'hooks'), (Join-Path $root 'home') | Out-Null
  Copy-Item -LiteralPath $Updater -Destination (Join-Path $bin 'turma-agent-update.ps1')
  Set-Content -LiteralPath (Join-Path $prefix 'hub-agent.py')   -Value "# old"
  Set-Content -LiteralPath (Join-Path $prefix 'tunnel-agent.js') -Value "// old"
  Set-Content -LiteralPath (Join-Path $prefix 'hooks\guard.py') -Value "# old"
  Set-Content -LiteralPath (Join-Path $prefix 'VERSION')        -Value $Installed -NoNewline
  Install-FakeGh $bin
  Install-StubCtl $bin
  return $root
}

# Run the updater (default mode = one agent self-update pass) with the case env. Returns the
# root so the caller can read VERSION / logs. TURMA_CLAUDE_AUTO_UPDATE off unless a case is
# about claude. Output captured via a /bin/sh exec redirect (the launcher-suite lesson: async
# Start-Process readers crash pwsh on a killed child; these exit cleanly, but keep one path).
function Invoke-Updater([string]$Root, [string]$GhDir, [string[]]$UpdaterArgs = @(), [hashtable]$Env = @{}, [int]$TimeoutMs = 90000) {
  $prefix = Join-Path $Root 'prefix'
  $bin = Join-Path $prefix 'bin'
  $updaterPath = Join-Path $bin 'turma-agent-update.ps1'
  $env:FAKE_GH_DIR = $GhDir
  $env:USERPROFILE = Join-Path $Root 'home'
  $env:TURMA_REPO = 'xerktech/turma'
  $env:PATH = $bin + [System.IO.Path]::PathSeparator + $env:PATH
  $env:TURMA_CLAUDE_AUTO_UPDATE = '0'
  foreach ($k in $Env.Keys) { Set-Item -Path "env:$k" -Value $Env[$k] }
  $argline = (@('-NoProfile', '-File', "`"$updaterPath`"") + $UpdaterArgs) -join ' '
  $log = Join-Path $Root 'run.log'
  $cmd = "exec `"$PwshExe`" $argline > `"$log`" 2>&1"
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = '/bin/sh'; $psi.ArgumentList.Add('-c'); $psi.ArgumentList.Add($cmd)
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $null = $p.WaitForExit($TimeoutMs)
  # Reset the case env so the next case starts clean.
  foreach ($k in $Env.Keys) { Remove-Item -Path "env:$k" -ErrorAction SilentlyContinue }
  Remove-Item env:TURMA_CLAUDE_AUTO_UPDATE -ErrorAction SilentlyContinue
  Remove-Item env:FAKE_GH_DIR -ErrorAction SilentlyContinue
  return $Root
}

function Get-Version([string]$Root) {
  return ((Get-Content -LiteralPath (Join-Path $Root 'prefix\VERSION') -Raw) -replace '\s', '')
}
function Get-UpdateLog([string]$Root) {
  $p = Join-Path $Root 'home\.turma\update.log'
  if (Test-Path -LiteralPath $p) { return (Get-Content -LiteralPath $p -Raw) } else { return '' }
}

try {
  Note "test_turma_agent_update_ps1.ps1"

  # 1. newer component installs & stamps the COMPONENT version.
  $gh = New-GhDir; Add-UnifiedRelease $gh 'v0.3.5' '0.3.5' 'v0.3.5'
  $r = New-Prefix '0.3.0'; Invoke-Updater $r $gh | Out-Null
  if ((Get-Version $r) -eq '0.3.5') { Ok "newer component installs (-> 0.3.5)" }
  else { Fail "expected 0.3.5, got $(Get-Version $r); log: $(Get-UpdateLog $r)" }

  # 2. carried release: tag moved to v0.3.9 but component stayed 0.3.0 == installed -> NO-OP.
  $gh = New-GhDir; Add-UnifiedRelease $gh 'v0.3.9' '0.3.0' 'v0.3.0'
  $r = New-Prefix '0.3.0'; Invoke-Updater $r $gh | Out-Null
  if ((Get-Version $r) -eq '0.3.0') { Ok "carried release is a no-op despite newer tag (stayed 0.3.0)" }
  else { Fail "carried release wrongly changed VERSION to $(Get-Version $r)" }

  # 3. carried-but-newer asset lives on an OLDER release_tag.
  $gh = New-GhDir; Add-UnifiedRelease $gh 'v0.3.9' '0.3.4' 'v0.3.4'
  $r = New-Prefix '0.3.0'; Invoke-Updater $r $gh | Out-Null
  if ((Get-Version $r) -eq '0.3.4') { Ok "resolves carried asset from its own release_tag (-> 0.3.4)" }
  else { Fail "expected 0.3.4 from v0.3.4, got $(Get-Version $r); log: $(Get-UpdateLog $r)" }

  # 4. checksum mismatch refuses, VERSION unchanged.
  $gh = New-GhDir; Add-UnifiedRelease $gh 'v0.3.5' '0.3.5' 'v0.3.5'
  Add-Content -LiteralPath (Join-Path $gh 'assets\v0.3.5\turma-agent-windows-v0.3.5.zip') -Value 'corruption'
  $r = New-Prefix '0.3.0'; Invoke-Updater $r $gh | Out-Null
  if ((Get-Version $r) -eq '0.3.0') { Ok "checksum mismatch refuses install (stayed 0.3.0)" }
  else { Fail "installed a corrupt payload (VERSION now $(Get-Version $r))" }

  # 5. up-to-date unified release is a no-op.
  $gh = New-GhDir; Add-UnifiedRelease $gh 'v0.3.5' '0.3.5' 'v0.3.5'
  $r = New-Prefix '0.3.5'; Invoke-Updater $r $gh | Out-Null
  if ((Get-Version $r) -eq '0.3.5') { Ok "up-to-date unified release is a no-op (stayed 0.3.5)" }
  else { Fail "reinstalled an up-to-date version, got $(Get-Version $r)" }

  # 6. legacy fallback installs when no unified release exists.
  $gh = New-GhDir
  Add-Content -LiteralPath (Join-Path $gh 'tags') -Value 'agent-windows-v0.2.9'
  New-Payload '0.2.9' (Join-Path $gh 'assets\agent-windows-v0.2.9') | Out-Null
  $r = New-Prefix '0.2.5'; Invoke-Updater $r $gh | Out-Null
  if ((Get-Version $r) -eq '0.2.9') { Ok "legacy fallback installs when no unified release exists (-> 0.2.9)" }
  else { Fail "legacy fallback failed, got $(Get-Version $r); log: $(Get-UpdateLog $r)" }

  # 7. a successful install leaves the updating.json expected-restart hint (XERK-29).
  $gh = New-GhDir; Add-UnifiedRelease $gh 'v0.3.5' '0.3.5' 'v0.3.5'
  $r = New-Prefix '0.3.0'; Invoke-Updater $r $gh | Out-Null
  $flag = Join-Path $r 'home\.turma\updating.json'
  if ((Test-Path -LiteralPath $flag) -and ((Get-Content -LiteralPath $flag -Raw) -match '0\.3\.5')) {
    Ok "install left updating.json carrying the target version"
  } else { Fail "no/blank updating.json after install: $(if (Test-Path $flag) { Get-Content $flag -Raw } else { 'absent' })" }

  # 8. a payload MISSING hooks/ is refused (the fail-open guard hazard).
  $gh = New-GhDir
  Add-Content -LiteralPath (Join-Path $gh 'tags') -Value 'v0.3.5'
  $asset = 'turma-agent-windows-v0.3.5.zip'
  Set-Content -LiteralPath (Join-Path $gh 'manifests\v0.3.5.json') -Value @"
{ "version":"0.3.5", "components": { "agent-windows": { "version":"0.3.5", "asset":"$asset", "sha256_asset":"$asset.sha256", "release_tag":"v0.3.5" } } }
"@
  New-Item -ItemType Directory -Force -Path (Join-Path $gh 'assets\v0.3.5') | Out-Null
  Copy-Item -LiteralPath (Join-Path $gh 'manifests\v0.3.5.json') -Destination (Join-Path $gh 'assets\v0.3.5\manifest.json')
  New-Payload '0.3.5' (Join-Path $gh 'assets\v0.3.5') -NoHooks | Out-Null
  $r = New-Prefix '0.3.0'; Invoke-Updater $r $gh | Out-Null
  if ((Get-Version $r) -eq '0.3.0') { Ok "payload missing hooks/ is refused (stayed 0.3.0)" }
  else { Fail "installed a hookless payload (VERSION now $(Get-Version $r))" }
  if ((Get-UpdateLog $r) -match 'incomplete') { Ok "the refusal is logged as an incomplete payload" }
  else { Fail "no 'incomplete' refusal in the log: $(Get-UpdateLog $r)" }

  # 9. the lock / holder / stamps are PREFIX-SCOPED (XERK-551).
  $gh = New-GhDir; Add-UnifiedRelease $gh 'v0.3.5' '0.3.5' 'v0.3.5'
  $r = New-Prefix '0.3.0'; Invoke-Updater $r $gh | Out-Null
  $tag = Get-PrefixTag (Join-Path $r 'prefix')
  $stamp = Join-Path $r "home\.turma\last-update-check.$tag"
  if (Test-Path -LiteralPath $stamp) { Ok "the check stamp is prefix-scoped ($tag)" }
  else { Fail "no prefix-scoped stamp at $stamp; files: $(Get-ChildItem (Join-Path $r 'home\.turma') -ErrorAction SilentlyContinue | ForEach-Object Name)" }
  $r2 = New-Prefix '0.3.0'; $tag2 = Get-PrefixTag (Join-Path $r2 'prefix')   # a different prefix differs
  if ($tag -ne $tag2) { Ok "a distinct prefix yields a distinct lock/stamp scope" }
  else { Fail "two distinct prefixes produced the same tag $tag — scoping is ineffective" }

  # 10. a WEDGED lock holder is reclaimed once it ages past the threshold (XERK-549).
  $gh = New-GhDir; Add-UnifiedRelease $gh 'v0.4.0' '0.4.0' 'v0.4.0'
  $r = New-Prefix '0.3.0'
  $turma = Join-Path $r 'home\.turma'
  New-Item -ItemType Directory -Force -Path $turma | Out-Null
  $tag = Get-PrefixTag (Join-Path $r 'prefix')
  $lock = Join-Path $turma "update.$tag.lock"
  $holderFile = Join-Path $turma "update.$tag.lock.holder"
  # A live process that HOLDS the lock exclusively and whose command line names our updater
  # (the PID-reuse guard). Its needle rides a harmless string literal.
  $helperCmd = "`$null='turma-agent-update wedged-helper'; `$fs=[System.IO.File]::Open('$lock',[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); Start-Sleep -Seconds 120"
  $helper = Start-Process -FilePath $PwshExe -ArgumentList @('-NoProfile', '-Command', $helperCmd) -PassThru
  Start-Sleep -Milliseconds 500
  $old = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 100
  Set-Content -LiteralPath $holderFile -Value "$($helper.Id) $old" -NoNewline
  Invoke-Updater $r $gh @() @{ TURMA_LOCK_RECLAIM_AFTER = '2' } | Out-Null
  if ((Get-UpdateLog $r) -match 'reclaim') { Ok "a wedged holder past the threshold is reclaimed" }
  else { Fail "the wedged holder was not reclaimed: $(Get-UpdateLog $r)" }
  if ((Get-Version $r) -eq '0.4.0') { Ok "the reclaiming run then completes the update (-> 0.4.0)" }
  else { Fail "reclaim happened but VERSION stayed $(Get-Version $r)" }
  try { $helper.Kill($true) } catch { }

  # 11. a HEALTHY (young) holder is NOT reclaimed — single-flight preserved.
  $gh = New-GhDir; Add-UnifiedRelease $gh 'v0.4.0' '0.4.0' 'v0.4.0'
  $r = New-Prefix '0.3.0'
  $turma = Join-Path $r 'home\.turma'; New-Item -ItemType Directory -Force -Path $turma | Out-Null
  $tag = Get-PrefixTag (Join-Path $r 'prefix')
  $lock = Join-Path $turma "update.$tag.lock"
  $holderFile = Join-Path $turma "update.$tag.lock.holder"
  $helperCmd = "`$null='turma-agent-update healthy-helper'; `$fs=[System.IO.File]::Open('$lock',[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); Start-Sleep -Seconds 120"
  $helper = Start-Process -FilePath $PwshExe -ArgumentList @('-NoProfile', '-Command', $helperCmd) -PassThru
  Start-Sleep -Milliseconds 500
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  Set-Content -LiteralPath $holderFile -Value "$($helper.Id) $now" -NoNewline
  Invoke-Updater $r $gh @() @{ }  | Out-Null   # default reclaim threshold (7200s) >> the holder's age
  if ((Get-UpdateLog $r) -match 'another update run holds the lock') { Ok "a young holder is not reclaimed — the run stands aside" }
  else { Fail "a young holder was not respected: $(Get-UpdateLog $r)" }
  if ((Get-Version $r) -eq '0.3.0' -and (Get-Process -Id $helper.Id -ErrorAction SilentlyContinue)) {
    Ok "the healthy holder survived and VERSION was not touched"
  } else { Fail "the healthy holder was reclaimed or VERSION changed (now $(Get-Version $r))" }
  try { $helper.Kill($true) } catch { }

  # 12. a recent stamp makes -Boot skip (the every-start rate limit, XERK-254).
  $gh = New-GhDir; Add-UnifiedRelease $gh 'v0.5.0' '0.5.0' 'v0.5.0'
  $r = New-Prefix '0.3.0'
  $turma = Join-Path $r 'home\.turma'; New-Item -ItemType Directory -Force -Path $turma | Out-Null
  $tag = Get-PrefixTag (Join-Path $r 'prefix')
  Set-Content -LiteralPath (Join-Path $turma "last-update-check.$tag") -Value ([string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -NoNewline
  Invoke-Updater $r $gh @('-Boot') @{ } | Out-Null
  if ((Get-Version $r) -eq '0.3.0') { Ok "-Boot with a fresh stamp skips the check (stayed 0.3.0)" }
  else { Fail "-Boot ran despite a fresh stamp (VERSION now $(Get-Version $r))" }

  # --- Claude Code (XERK-254) ---------------------------------------------------------------
  # 13a. claude up to date -> no-op (no install call).
  $r = New-Prefix '0.3.0'
  $bin = Join-Path $r 'prefix\bin'
  New-ShStub (Join-Path $bin 'claude') 'case "$1" in --version) echo "2.0.14 (Claude Code)";; update) echo did-update; echo update >> "$TURMA_TEST_NPM_LOG";; esac; exit 0'
  New-ShStub (Join-Path $bin 'npm') @'
case "$1 $2" in
  "view @anthropic-ai/claude-code") echo "2.0.14" ;;
  "ls -g") echo "installed"; exit 0 ;;
  "prefix -g") echo "/nowhere" ;;
  "install -g") echo "npm install $*" >> "$TURMA_TEST_NPM_LOG" ;;
esac
exit 0
'@
  $npmlog = Join-Path $r 'npm.log'
  Invoke-Updater $r (New-GhDir) @('-ClaudeOnly') @{ TURMA_CLAUDE_AUTO_UPDATE = '1'; TURMA_TEST_NPM_LOG = $npmlog } | Out-Null
  if (-not (Test-Path -LiteralPath $npmlog)) { Ok "claude up to date -> no install call" }
  else { Fail "claude reinstalled though up to date: $(Get-Content $npmlog -Raw)" }

  # 13b. a newer published claude -> installs.
  $r = New-Prefix '0.3.0'
  $bin = Join-Path $r 'prefix\bin'
  New-ShStub (Join-Path $bin 'claude') 'case "$1" in --version) echo "2.0.14 (Claude Code)";; esac; exit 0'
  New-ShStub (Join-Path $bin 'npm') @'
case "$1 $2" in
  "view @anthropic-ai/claude-code") echo "2.9.9" ;;
  "ls -g") echo "installed"; exit 0 ;;
  "prefix -g") p=$(command -v claude); echo "$(dirname "$(dirname "$p")")" ;;
  "install -g") echo "npm install $*" >> "$TURMA_TEST_NPM_LOG" ;;
esac
exit 0
'@
  $npmlog = Join-Path $r 'npm.log'
  Invoke-Updater $r (New-GhDir) @('-ClaudeOnly') @{ TURMA_CLAUDE_AUTO_UPDATE = '1'; TURMA_TEST_NPM_LOG = $npmlog } | Out-Null
  if ((Test-Path -LiteralPath $npmlog) -and ((Get-Content $npmlog -Raw) -match 'install -g')) { Ok "a newer published claude triggers an install" }
  else { Fail "a newer claude did not install: log=$(Get-UpdateLog $r)" }

  # 13c. an UNREADABLE claude is repaired-then-remembered, and a repair that does not help is
  #      not retried (claude-unparseable), while a repair that fixes it clears the marker.
  $r = New-Prefix '0.3.0'
  $bin = Join-Path $r 'prefix\bin'
  # claude prints a shape this cannot parse; the npm "install" does NOT change that.
  New-ShStub (Join-Path $bin 'claude') 'case "$1" in --version) echo "calver-2026.01 (Claude Code)";; esac; exit 0'
  New-ShStub (Join-Path $bin 'npm') @'
case "$1 $2" in
  "view @anthropic-ai/claude-code") echo "2.9.9" ;;
  "ls -g") echo "installed"; exit 0 ;;
  "prefix -g") p=$(command -v claude); echo "$(dirname "$(dirname "$p")")" ;;
  "install -g") echo "npm install $*" >> "$TURMA_TEST_NPM_LOG" ;;
esac
exit 0
'@
  $npmlog = Join-Path $r 'npm.log'
  Invoke-Updater $r (New-GhDir) @('-ClaudeOnly') @{ TURMA_CLAUDE_AUTO_UPDATE = '1'; TURMA_TEST_NPM_LOG = $npmlog } | Out-Null
  $marker = Join-Path $r 'home\.turma\claude-unparseable'
  if (Test-Path -LiteralPath $marker) { Ok "an unhelpful repair of an unreadable claude is remembered" }
  else { Fail "no claude-unparseable marker after an unhelpful repair; log=$(Get-UpdateLog $r)" }
  # A second run must NOT reinstall (the same unreadable output is remembered).
  Remove-Item -LiteralPath $npmlog -Force -ErrorAction SilentlyContinue
  Invoke-Updater $r (New-GhDir) @('-ClaudeOnly') @{ TURMA_CLAUDE_AUTO_UPDATE = '1'; TURMA_TEST_NPM_LOG = $npmlog; TURMA_BOOT_UPDATE_MIN_INTERVAL = '0' } | Out-Null
  if (-not (Test-Path -LiteralPath $npmlog)) { Ok "a remembered unhelpful repair is not retried" }
  else { Fail "the futile repair was retried: $(Get-Content $npmlog -Raw)" }
}
finally {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $cl = $null; try { $cl = $_.CommandLine } catch { }
    $cl -and $cl.Contains($Work)
  } | ForEach-Object { try { $_.Kill($true) } catch { } }
  if (Test-Path $Work) { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }
}

if ($Script:Failed -eq 0) { Note "all turma-agent-update (windows) tests passed" }
else { Note "FAILURES" }
exit $Script:Failed
