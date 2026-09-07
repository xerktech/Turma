#!/usr/bin/env pwsh
# Behavioural tests for the native WINDOWS installer (agent/native/windows/install.ps1,
# XERK-672). The port of the coverage test_install_dsh.sh gives install.sh's lay-down.
#
# Like the launcher/controller PS suites, it runs the REAL installer on the POSIX CI
# runner: the winget/npm provisioning, the icacls ACL and the WinSW service registration
# are $IsWindows-gated, so with -NoInstallDeps every file-facing decision (lay-down,
# -Verify presence list, config preserve, -Uninstall preservation) executes exactly as it
# does on a Windows host, while the host-specific halves stay host-verified. That is why
# the installer keeps those actions behind $IsWindows — the same reason the controller
# suite drives its pidfile fallback and leaves WinSW to a real host.
#
# Pinned here, none of which PSScriptAnalyzer can see (it checks correctness, not behaviour):
#   1. a clean install lays down EVERY runtime sibling + hook + the qwen tree + the pty
#      terminal layer + the launcher/controller + a rendered service descriptor + VERSION —
#      a missing sibling is the XERK-528 "runs dark" class the installer copy exists to prevent;
#   2. the config env file is written with DEVICE_NAME seeded and TURMA_TOKEN blank, under
#      the %APPDATA% known-folder path (ADR D4);
#   3. the WinSW descriptor is rendered — %BASE% -> the real prefix, TURMA_AGENT_ENV -> the
#      real config path (not the launcher-would-mis-resolve %BASE%\bin\ path);
#   4. it is IDEMPOTENT and HEALS — a re-run restores a deleted sibling AND preserves an
#      edited config (never overwrites a token the operator set);
#   5. -Verify reports each laid file "ok" and a removed one "MISSING";
#   6. -Uninstall removes the prefix but PRESERVES config, ~/.turma and ~/.claude.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Here    = Split-Path -Parent $PSCommandPath
$WinDir  = Join-Path (Split-Path -Parent $Here) 'native/windows'
$Install = Join-Path $WinDir 'install.ps1'
$Work    = Join-Path ([System.IO.Path]::GetTempPath()) ("turma-install-" + [guid]::NewGuid().ToString('N'))
$Script:Failed = 0

function Ok([string]$m)   { [Console]::Out.WriteLine("  ok: $m") }
function Fail([string]$m) { [Console]::Out.WriteLine("  FAIL: $m"); $Script:Failed = 1 }
function Note([string]$m) { [Console]::Out.WriteLine($m) }

$PwshExe = (Get-Process -Id $PID).Path

# --- fixture: a throwaway HOME/APPDATA + prefix -----------------------------------------
$HomeDir = Join-Path $Work 'home'
$AppData = Join-Path $HomeDir 'AppData/Roaming'
$Prefix  = Join-Path $Work 'prefix'
$Cfg     = Join-Path $AppData 'turma-agent/turma-agent.env'
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null

# Run the installer as a child pwsh with a scoped env, output captured via an OS-level
# redirect (the launcher suite's lesson: Start-Process -RedirectStandard* async readers
# crash pwsh when a child exits). Returns the Process.
function Invoke-Install([string]$InstallArgs, [string]$OutFile) {
  $env:USERPROFILE  = $HomeDir
  $env:APPDATA      = $AppData
  $env:LOCALAPPDATA = Join-Path $HomeDir 'AppData/Local'
  $env:DEVICE_NAME  = 'testbox'
  $cmd = "exec `"$PwshExe`" -NoProfile -File `"$Install`" -Prefix `"$Prefix`" $InstallArgs > `"$OutFile`" 2>&1"
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = '/bin/sh'
  $psi.ArgumentList.Add('-c'); $psi.ArgumentList.Add($cmd)
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['USERPROFILE']  = $HomeDir
  $psi.EnvironmentVariables['APPDATA']      = $AppData
  $psi.EnvironmentVariables['LOCALAPPDATA'] = Join-Path $HomeDir 'AppData/Local'
  $psi.EnvironmentVariables['DEVICE_NAME']  = 'testbox'
  $p = [System.Diagnostics.Process]::Start($psi)
  $null = $p.WaitForExit(60000)
  return $p
}

try {
  # --- Case 1: a clean install lays down the full runtime + tooling ---------------------
  Note "case: a clean install lays the full runtime down"
  $c1 = Invoke-Install '-NoInstallDeps' (Join-Path $Work 'install1.log')
  if ($c1.ExitCode -eq 0) { Ok "install exited 0" }
  else { Fail "install exited $($c1.ExitCode): $(Get-Content (Join-Path $Work 'install1.log') -Raw)" }

  # Every file whose absence runs the agent (or a runtime) dark — the XERK-528 lockstep set,
  # matching install.ps1's own -Verify list and install.sh's do_verify.
  $mustExist = @(
    'hub-agent.py', 'tunnel-agent.js',
    'hooks/guard.py', 'hooks/fileguard.py', 'hooks/ask.py', 'hooks/statusline.py',
    'runtime_projection.py', 'runtime_tail.py',
    'qwen_session.py', 'qwen_transcript.py',
    'qwen/ask_mcp.py', 'qwen/peer_mcp.py', 'qwen/peer_inbox.py', 'qwen/guard/shim.py',
    'win/pty-host.mjs', 'win/tty-protocol.mjs', 'win/package.json',
    'win/vendor/ttyd-1.7.7/index.html',
    'bin/turma-agent.ps1', 'bin/turma-agentctl.ps1', 'bin/turma-agent.xml',
    'VERSION'
  )
  $missing = @($mustExist | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Prefix $_)) })
  if ($missing.Count -eq 0) { Ok "all $($mustExist.Count) runtime/tooling files laid down" }
  else { Fail "not laid down: $($missing -join ', ')" }

  $ver = (Get-Content -LiteralPath (Join-Path $Prefix 'VERSION') -Raw)
  if ($ver -match '^\d') { Ok "VERSION stamped ($ver)" } else { Fail "VERSION not a version: '$ver'" }

  # --- Case 2: config written, DEVICE_NAME seeded, TURMA_TOKEN blank, under %APPDATA% ----
  Note "case: config env file written under %APPDATA% with DEVICE_NAME seeded"
  if (Test-Path -LiteralPath $Cfg) { Ok "config at the %APPDATA% known-folder path" }
  else { Fail "config not written at $Cfg" }
  $cfgText = Get-Content -LiteralPath $Cfg
  if ($cfgText | Where-Object { $_ -eq 'DEVICE_NAME=testbox' }) { Ok "DEVICE_NAME seeded from the environment" }
  else { Fail "DEVICE_NAME not seeded: $(($cfgText | Where-Object { $_ -match '^DEVICE_NAME' }))" }
  if ($cfgText | Where-Object { $_ -match '^TURMA_TOKEN=\s*$' }) { Ok "TURMA_TOKEN left blank for the operator" }
  else { Fail "TURMA_TOKEN not blank in a fresh config" }

  # --- Case 3: the WinSW descriptor is rendered (%BASE% + env substituted) ---------------
  Note "case: the service descriptor is rendered with real paths"
  $xml = Get-Content -LiteralPath (Join-Path $Prefix 'bin/turma-agent.xml') -Raw
  if ($xml.Contains($Prefix) -and -not $xml.Contains('%BASE%')) { Ok "%BASE% substituted to the real prefix" }
  else { Fail "%BASE% not substituted in the descriptor" }
  if ($xml.Contains("value=`"$Cfg`"")) { Ok "TURMA_AGENT_ENV points at the real config path" }
  else { Fail "TURMA_AGENT_ENV not pointed at $Cfg" }

  # --- Case 4: idempotent + heals a deleted sibling, preserves an edited config ----------
  Note "case: a re-run heals a deleted sibling and preserves the operator's token"
  (Get-Content -LiteralPath $Cfg) -replace '^TURMA_TOKEN=.*', 'TURMA_TOKEN=SECRET123' | Set-Content -LiteralPath $Cfg
  Remove-Item -LiteralPath (Join-Path $Prefix 'qwen_session.py')
  Remove-Item -LiteralPath (Join-Path $Prefix 'hooks/guard.py')
  $c4 = Invoke-Install '-NoInstallDeps' (Join-Path $Work 'install2.log')
  if ($c4.ExitCode -eq 0) { Ok "re-run exited 0" } else { Fail "re-run exited $($c4.ExitCode)" }
  if (Test-Path -LiteralPath (Join-Path $Prefix 'qwen_session.py')) { Ok "healed the deleted sibling (qwen_session.py)" }
  else { Fail "re-run did not restore qwen_session.py" }
  if (Test-Path -LiteralPath (Join-Path $Prefix 'hooks/guard.py')) { Ok "healed the deleted hook (guard.py)" }
  else { Fail "re-run did not restore hooks/guard.py" }
  if (Get-Content -LiteralPath $Cfg | Where-Object { $_ -eq 'TURMA_TOKEN=SECRET123' }) { Ok "the edited config was preserved, not overwritten" }
  else { Fail "re-run overwrote the operator's config" }

  # --- Case 5: -Verify reports laid files ok and a removed one MISSING -------------------
  Note "case: -Verify reports presence per file"
  $vlog = Join-Path $Work 'verify1.log'
  Invoke-Install '-Verify' $vlog | Out-Null
  $vtext = Get-Content -LiteralPath $vlog -Raw
  if ($vtext -match 'file hub-agent\.py: ok' -and $vtext -match 'file qwen\\guard\\shim\.py: ok') { Ok "-Verify marks laid files ok" }
  else { Fail "-Verify did not mark laid files ok" }
  Remove-Item -LiteralPath (Join-Path $Prefix 'runtime_tail.py')
  $vlog2 = Join-Path $Work 'verify2.log'
  Invoke-Install '-Verify' $vlog2 | Out-Null
  if ((Get-Content -LiteralPath $vlog2 -Raw) -match 'file runtime_tail\.py: MISSING') { Ok "-Verify flags a removed sibling MISSING" }
  else { Fail "-Verify did not flag the removed runtime_tail.py" }

  # --- Case 6: -Uninstall removes the prefix, preserves config / ~/.turma / ~/.claude ----
  Note "case: -Uninstall preserves config, ~/.turma and ~/.claude"
  New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir '.turma'), (Join-Path $HomeDir '.claude') | Out-Null
  Set-Content -LiteralPath (Join-Path $HomeDir '.turma/sessions.json') -Value 'keepme'
  Set-Content -LiteralPath (Join-Path $HomeDir '.claude/.credentials.json') -Value 'creds'
  $c6 = Invoke-Install '-Uninstall' (Join-Path $Work 'uninstall.log')
  if ($c6.ExitCode -eq 0) { Ok "uninstall exited 0" } else { Fail "uninstall exited $($c6.ExitCode)" }
  if (-not (Test-Path -LiteralPath $Prefix)) { Ok "the prefix was removed" } else { Fail "the prefix survived uninstall" }
  if (Test-Path -LiteralPath $Cfg) { Ok "config preserved" } else { Fail "uninstall removed the config" }
  if (Get-Content -LiteralPath $Cfg | Where-Object { $_ -eq 'TURMA_TOKEN=SECRET123' }) { Ok "the token survived uninstall" }
  else { Fail "uninstall lost the token" }
  if (Test-Path -LiteralPath (Join-Path $HomeDir '.turma/sessions.json')) { Ok "~/.turma preserved" } else { Fail "uninstall removed ~/.turma" }
  if (Test-Path -LiteralPath (Join-Path $HomeDir '.claude/.credentials.json')) { Ok "~/.claude preserved" } else { Fail "uninstall removed ~/.claude" }
}
finally {
  if (Test-Path $Work) { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }
}

if ($Script:Failed -eq 0) { Note "all install.ps1 (windows) installer tests passed" }
else { Note "FAILURES" }
exit $Script:Failed
