#!/usr/bin/env pwsh
# Behavioural tests for the native WINDOWS process controller
# (agent/native/windows/turma-agentctl.ps1, XERK-671).
#
# The port of test_turma_agentctl.sh. It pins the pidfile-FALLBACK path — the Windows twin
# of the bash ctl's nohup fallback — because that is the half a POSIX CI runner can drive:
# Get-Service is undefined on Linux pwsh, so Test-ServiceMode is false and every command
# takes the fallback path, exactly as the bash suite runs with no systemd and the launcher
# suite leaves WinSW/ConPTY to a real Windows host. The service (WinSW) path is host-verified.
#
# Pinned here, none of which PSScriptAnalyzer can see (it checks PowerShell correctness, not
# behaviour):
#   1. a set-but-UNUSABLE TURMA_RUNTIME_DIR falls back to ~/.turma (the /run/user trap the
#      bash ctl guards against — a silently-failing pidfile write orphans-then-doubles the
#      manager), start succeeds, and the pidfile lands under ~/.turma, not the broken dir;
#   2. status/stop round-trip through the fallback pidfile (the property the bug destroyed:
#      an unreadable pid made stop a no-op that orphaned the manager);
#   3. a USABLE TURMA_RUNTIME_DIR is still honoured (the fix rescues the broken case only);
#   4. SESSION-PRESERVING stop — the control plane (launcher/manager/tunnel/supervisor) is
#      reaped while a detached pty-host is LEFT ALIVE (the KillMode=process guarantee);
#   5. SESSION-PRESERVING restart — same, and it leaves exactly ONE fresh launcher (no
#      doubled manager) with the pty-host still alive.
#
# Like the launcher suite, the REAL controller runs; only the launcher it starts is stubbed
# (by a stub turma-agent.ps1 that backgrounds faux control-plane + pty-host processes with
# the command lines the reap keys on, then sleeps). PowerShell-on-POSIX, run on the same
# ubuntu-latest runner.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Here     = Split-Path -Parent $PSCommandPath
$WinDir   = Join-Path (Split-Path -Parent $Here) 'native/windows'
$Ctl      = Join-Path $WinDir 'turma-agentctl.ps1'
$Work     = Join-Path ([System.IO.Path]::GetTempPath()) ("turma-ctl-" + [guid]::NewGuid().ToString('N'))
$Script:Failed = 0

function Ok([string]$m)   { [Console]::Out.WriteLine("  ok: $m") }
function Fail([string]$m) { [Console]::Out.WriteLine("  FAIL: $m"); $Script:Failed = 1 }
function Note([string]$m) { [Console]::Out.WriteLine($m) }

$PwshExe = (Get-Process -Id $PID).Path

# --- fixture: a PREFIX laid out the way the installer lays one out -----------------------
$Prefix = Join-Path $Work 'prefix'
$Bin    = Join-Path $Prefix 'bin'
$Home_  = Join-Path $Work 'home'
New-Item -ItemType Directory -Force -Path $Bin, $Home_ | Out-Null
Copy-Item $Ctl (Join-Path $Bin 'turma-agentctl.ps1')
$CtlPath = Join-Path $Bin 'turma-agentctl.ps1'

# The paths the ctl reaps on and the stub launcher spawns fauxes for (both derive them the
# same way from their own location, and the test computes them identically).
$Manager = Join-Path $Prefix 'hub-agent.py'
$Tunnel  = Join-Path $Prefix 'tunnel-agent.js'
$PtyHost = Join-Path $Prefix 'pty-host.mjs'          # deliberately NOT a reap needle
$StubLauncherPath = Join-Path $Bin 'turma-agent.ps1'

# Stub launcher: backgrounds four faux long-lived processes whose command lines carry the
# exact needles the ctl reaps on — a tunnel SUPERVISOR (launcher path + -TunnelSupervisor),
# the TUNNEL (tunnel-agent.js), the MANAGER (hub-agent.py) and a PTY-HOST (pty-host.mjs, no
# needle) — then sleeps so the ctl's recorded pid stays alive to be found and killed. The
# fauxes are independent processes, so killing this stub does not cascade to them: the
# pty-host survives a control-plane reap exactly as a detached pty-host survives on a real
# host.
$stubBody = @'
Set-StrictMode -Version Latest
$SelfDir = Split-Path -Parent $PSCommandPath
$Prefix  = Split-Path -Parent $SelfDir
$me      = (Get-Process -Id $PID).Path
function Faux([string]$needle) {
  Start-Process -FilePath $me -ArgumentList @('-NoProfile','-Command',"Start-Sleep -Seconds 300 # $needle") | Out-Null
}
Faux ((Join-Path $SelfDir 'turma-agent.ps1') + ' -TunnelSupervisor')
Faux (Join-Path $Prefix 'tunnel-agent.js')
Faux (Join-Path $Prefix 'hub-agent.py')
Faux (Join-Path $Prefix 'pty-host.mjs')
Start-Sleep -Seconds 300
'@
Set-Content -LiteralPath $StubLauncherPath -Value $stubBody

# --- helpers -----------------------------------------------------------------------------
function Wait-For([scriptblock]$Cond, [int]$Tries = 80) {
  for ($i = 0; $i -lt $Tries; $i++) { if (& $Cond) { return $true }; Start-Sleep -Milliseconds 100 }
  return $false
}

# Every process whose command line contains ALL the needles. Callers ALWAYS include a
# fixture-scoping needle ($Work) so a stale orphan leaked by another test run (its command
# line names a DIFFERENT temp dir) is never counted — the supervisor needle '-TunnelSupervisor'
# in particular is not fixture-unique on its own.
function Get-ByNeedle([string[]]$Needles) {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $cl = $null; try { $cl = $_.CommandLine } catch { }
      if (-not $cl) { return $false }
      foreach ($n in $Needles) { if (-not $cl.Contains($n)) { return $false } }
      return $true
    })
}
function Count-Faux([string[]]$Needles) { @(Get-ByNeedle $Needles).Count }

# Reap every fixture process (anything whose command line names $Work), between and after
# cases, so a leftover cannot bleed into the next assertion.
function Reset-Fixture {
  for ($i = 0; $i -lt 40; $i++) {
    $procs = @(Get-ByNeedle @($Work))
    if ($procs.Count -eq 0) { return }
    foreach ($p in $procs) { try { $p.Kill() } catch { } }
    Start-Sleep -Milliseconds 120
  }
}

# Run the ctl as a child pwsh, inheriting the case env, output captured to $OutFile via an
# OS-level redirect (not Start-Process -RedirectStandard*, whose async readers crash pwsh
# when a child is killed — the launcher suite's lesson). Returns the Process; the ctl exits
# quickly for start/stop/restart/status.
function Start-Ctl([string]$Command, [string]$OutFile) {
  $cmd = "exec `"$PwshExe`" -NoProfile -File `"$CtlPath`" $Command > `"$OutFile`" 2>&1"
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = '/bin/sh'
  $psi.ArgumentList.Add('-c'); $psi.ArgumentList.Add($cmd)
  $psi.UseShellExecute = $false
  return [System.Diagnostics.Process]::Start($psi)
}
function Invoke-Ctl([string]$Command, [string]$OutFile) {
  $p = Start-Ctl $Command $OutFile
  $null = $p.WaitForExit(15000)
  return $p
}

function Set-BaseEnv {
  $env:USERPROFILE = $Home_
  Remove-Item env:TURMA_RUNTIME_DIR   -ErrorAction SilentlyContinue
  Remove-Item env:TURMA_SERVICE_NAME  -ErrorAction SilentlyContinue
}

$TurmaDir  = Join-Path $Home_ '.turma'
$PidInTurma = Join-Path $TurmaDir 'turma-agent.pid'

try {
  # --- Case 1: a set-but-unusable TURMA_RUNTIME_DIR falls back to ~/.turma ---------------
  Note "case: broken TURMA_RUNTIME_DIR falls back to ~/.turma"
  Reset-Fixture
  # A regular file makes any path under it un-mkdir-able (ENOTDIR) — a stand-in for a
  # never-created runtime dir, the exact WSL /run/user trap.
  $notdir = Join-Path $Work 'notadir'
  Set-Content -LiteralPath $notdir -Value 'x'
  Set-BaseEnv
  $env:TURMA_RUNTIME_DIR = Join-Path $notdir 'run'
  $c1 = Invoke-Ctl 'start' (Join-Path $Work 'start1.log')
  if ($c1.ExitCode -eq 0) { Ok "start exited 0 with an unusable runtime dir" }
  else { Fail "start exited $($c1.ExitCode): $(Get-Content (Join-Path $Work 'start1.log') -Raw -ErrorAction SilentlyContinue)" }
  if (Wait-For { Test-Path -LiteralPath $PidInTurma }) { Ok "pidfile fell back to ~/.turma" }
  else { Fail "pidfile did not fall back to ~/.turma" }
  if (-not (Test-Path -LiteralPath (Join-Path $notdir 'run'))) { Ok "did not write under the broken runtime dir" }
  else { Fail "wrote under the broken runtime dir" }

  # --- Case 2: status/stop round-trip through the fallback pidfile -----------------------
  Note "case: status/stop round-trip through the fallback pidfile"
  # The launcher stub must have come up (its faux manager is the proof).
  if (Wait-For { (Count-Faux @($Manager)) -ge 1 }) { Ok "launcher stub came up (manager present)" }
  else { Fail "launcher stub never started its faux manager" }
  $mpid = 0
  if (Test-Path -LiteralPath $PidInTurma) { $mpid = [int]((Get-Content -LiteralPath $PidInTurma -Raw) -replace '\D', '') }
  Invoke-Ctl 'status' (Join-Path $Work 'status2.log') | Out-Null
  if (Select-String -Quiet 'running' (Join-Path $Work 'status2.log')) { Ok "status reports running" }
  else { Fail "status did not report running: $(Get-Content (Join-Path $Work 'status2.log') -Raw -ErrorAction SilentlyContinue)" }
  Invoke-Ctl 'stop' (Join-Path $Work 'stop2.log') | Out-Null
  if (Wait-For { -not (Get-Process -Id $mpid -ErrorAction SilentlyContinue) }) { Ok "stop killed the launcher (pid $mpid)" }
  else { Fail "stop left the launcher running" }

  # --- Case 3: a usable TURMA_RUNTIME_DIR is honoured -----------------------------------
  Note "case: usable TURMA_RUNTIME_DIR is honoured"
  Reset-Fixture
  $run = Join-Path $Work 'run-usable'
  Set-BaseEnv
  $env:TURMA_RUNTIME_DIR = $run
  Invoke-Ctl 'start' (Join-Path $Work 'start3.log') | Out-Null
  if (Wait-For { Test-Path -LiteralPath (Join-Path $run 'turma-agent.pid') }) { Ok "pidfile lands in a usable runtime dir" }
  else { Fail "pidfile did not land in the usable runtime dir: $(Get-Content (Join-Path $Work 'start3.log') -Raw -ErrorAction SilentlyContinue)" }
  Invoke-Ctl 'stop' (Join-Path $Work 'stop3.log') | Out-Null

  # --- Case 4: session-preserving stop — control plane reaped, pty-host left alive -------
  Note "case: stop reaps the control plane but leaves the pty-host (sessions) alive"
  Reset-Fixture
  Set-BaseEnv
  Invoke-Ctl 'start' (Join-Path $Work 'start4.log') | Out-Null
  # Wait for the whole faux control plane + pty-host to be up.
  if (Wait-For { (Count-Faux @($Manager)) -ge 1 -and (Count-Faux @($Tunnel)) -ge 1 -and (Count-Faux @($Work,'-TunnelSupervisor')) -ge 1 -and (Count-Faux @($PtyHost)) -ge 1 }) {
    Ok "control plane + pty-host all up before stop"
  }
  else { Fail "not all faux processes came up (mgr=$(Count-Faux @($Manager)) tun=$(Count-Faux @($Tunnel)) sup=$(Count-Faux @($Work,'-TunnelSupervisor')) pty=$(Count-Faux @($PtyHost)))" }
  Invoke-Ctl 'stop' (Join-Path $Work 'stop4.log') | Out-Null
  if (Wait-For { (Count-Faux @($Manager)) -eq 0 -and (Count-Faux @($Tunnel)) -eq 0 -and (Count-Faux @($Work,'-TunnelSupervisor')) -eq 0 }) {
    Ok "stop reaped the launcher, manager, tunnel and supervisor"
  }
  else { Fail "control plane survived stop (mgr=$(Count-Faux @($Manager)) tun=$(Count-Faux @($Tunnel)) sup=$(Count-Faux @($Work,'-TunnelSupervisor')))" }
  # Settle, then the pty-host must STILL be alive — the KillMode=process guarantee.
  Start-Sleep -Milliseconds 400
  if ((Count-Faux @($PtyHost)) -ge 1) { Ok "the pty-host survived stop (the session is preserved)" }
  else { Fail "stop killed the pty-host — a running session would have been destroyed" }

  # --- Case 5: session-preserving restart — one fresh launcher, pty-host still alive -----
  Note "case: restart preserves the pty-host and leaves exactly one launcher"
  Reset-Fixture
  Set-BaseEnv
  Invoke-Ctl 'start' (Join-Path $Work 'start5.log') | Out-Null
  if (Wait-For { (Count-Faux @($Manager)) -ge 1 -and (Count-Faux @($PtyHost)) -ge 1 }) { Ok "initial control plane + pty-host up" }
  else { Fail "initial start did not bring the fixture up" }
  $ptyPidBefore = @(Get-ByNeedle @($PtyHost))[0].Id
  $launcherBefore = 0
  if (Test-Path -LiteralPath $PidInTurma) { $launcherBefore = [int]((Get-Content -LiteralPath $PidInTurma -Raw) -replace '\D', '') }
  Invoke-Ctl 'restart' (Join-Path $Work 'restart5.log') | Out-Null
  # A fresh launcher pid is recorded, different from the old one.
  if (Wait-For { (Test-Path -LiteralPath $PidInTurma) -and ([int]((Get-Content -LiteralPath $PidInTurma -Raw) -replace '\D','') -ne $launcherBefore) -and (Count-Faux @($Manager)) -ge 1 }) {
    Ok "restart recorded a fresh launcher and a new manager came up"
  }
  else { Fail "restart did not bring a fresh launcher/manager up: $(Get-Content (Join-Path $Work 'restart5.log') -Raw -ErrorAction SilentlyContinue)" }
  # Exactly one manager — the old one was reaped, not doubled (the double-heartbeat bug).
  Start-Sleep -Milliseconds 400
  $mgrCount = Count-Faux @($Manager)
  if ($mgrCount -eq 1) { Ok "exactly one manager after restart (no doubled manager)" }
  else { Fail "expected 1 manager after restart, found $mgrCount (a doubled manager double-heartbeats)" }
  # The pre-restart pty-host is still alive — restart is manager-only.
  if (Get-Process -Id $ptyPidBefore -ErrorAction SilentlyContinue) { Ok "the pre-restart pty-host survived (restart is manager-only)" }
  else { Fail "restart killed the running pty-host" }
  Invoke-Ctl 'stop' (Join-Path $Work 'stop5.log') | Out-Null
}
finally {
  Reset-Fixture
  if (Test-Path $Work) { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }
}

if ($Script:Failed -eq 0) { Note "all turma-agentctl (windows) controller tests passed" }
else { Note "FAILURES" }
exit $Script:Failed
