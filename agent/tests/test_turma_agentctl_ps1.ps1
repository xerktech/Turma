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
#   4. SESSION-PRESERVING stop — the control plane is reaped, a detached pty-host is LEFT ALIVE
#      (KillMode=process), and the tunnel STAYS dead because the supervisor is actually reaped
#      and not left respawning it (the strict supervisor-before-tunnel ordering is inspection-
#      verified — it reuses the launcher's Stop-ByCommandLine order);
#   5. SESSION-PRESERVING restart — same, and it leaves exactly ONE fresh launcher (no
#      doubled manager) with the pty-host still alive;
#   6. a STALE/FOREIGN pidfile is not blindly killed — a recorded pid whose command line is
#      not our launcher (a crashed launcher's pid reused by an innocent process — worst case a
#      pty-host) SURVIVES stop, and the stale pidfile is cleared.
#   7. SERVICE-path stop reaps the broken-away tunnel + supervisor (XERK-698) — on a real host
#      WinSW's Stop-Service reaps only the in-job launcher+manager, LEAVING the tunnel + its
#      supervisor (which broke away from the job like the pty-hosts) orphaned; the fix runs the
#      SAME command-line control-plane reap on the service path too. Driven via the test-only
#      TURMA_FORCE_SERVICE_MODE hook (Get-Service is undefined on Linux pwsh): manager+supervisor
#      reaped, tunnel stays dead, pty-host left alive.
#   8. `logs` under the SERVICE reads the WinSW <service>.out.log, not agent.log (XERK-698) —
#      the pidfile-fallback agent.log is empty under the service, so reading it printed
#      "no log yet" while the service was running and logging to turma-agent.out.log.
#
# Like the launcher suite, the REAL controller runs; only the launcher it starts is stubbed
# (by a stub turma-agent.ps1 that backgrounds a faux MANAGER, a faux PTY-HOST, and a faux
# tunnel SUPERVISOR that MAINTAINS a faux tunnel — respawning it when gone, so the reap
# ORDER is a real property). PowerShell-on-POSIX, run on the same ubuntu-latest runner.

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

# Stub launcher: backgrounds a faux MANAGER (hub-agent.py) and PTY-HOST (pty-host.mjs, no
# needle), then a faux tunnel SUPERVISOR whose command line carries the launcher path +
# -TunnelSupervisor (the ctl's supervisor needle) and which MAINTAINS a faux tunnel
# (tunnel-agent.js) — spawning it and RESPAWNING it whenever it disappears, every ~40ms. That
# respawn is what makes the reap ORDER a real property: reap the supervisor first and a killed
# tunnel stays dead; reap it after the tunnel and the still-alive supervisor brings the tunnel
# back. The tunnel path is passed to the supervisor via ENV so it never appears in the
# supervisor's own command line (which would make the tunnel COUNT include the supervisor).
# The fauxes are independent processes, so killing this stub does not cascade to them: a
# pty-host survives a control-plane reap exactly as a detached pty-host does on a real host.
$stubBody = @'
Set-StrictMode -Version Latest
$SelfDir = Split-Path -Parent $PSCommandPath
$Prefix  = Split-Path -Parent $SelfDir
$me      = (Get-Process -Id $PID).Path
$launcher = Join-Path $SelfDir 'turma-agent.ps1'
$env:FAUX_PWSH   = $me
$env:FAUX_TUNNEL = (Join-Path $Prefix 'tunnel-agent.js')
Start-Process -FilePath $me -ArgumentList @('-NoProfile','-Command',"Start-Sleep -Seconds 300 # $(Join-Path $Prefix 'hub-agent.py')") | Out-Null
Start-Process -FilePath $me -ArgumentList @('-NoProfile','-Command',"Start-Sleep -Seconds 300 # $(Join-Path $Prefix 'pty-host.mjs')") | Out-Null
# The supervisor -Command is ONE LINE with NO double-quotes: a multi-line ArgumentList element
# does not round-trip through Start-Process on Linux (newlines mangled), and a nested double
# quote breaks the child's argv reconstruction — so the tunnel-spawn string is single-quote
# concatenation. The needle rides a harmless string literal ($null='...'), not a trailing '#'
# comment (which would comment out the loop).
$supCmd = "`$null='$launcher -TunnelSupervisor'; `$t=`$env:FAUX_TUNNEL; `$m=`$env:FAUX_PWSH; while(`$true){ `$alive=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { `$cl=`$null; try{`$cl=`$_.CommandLine}catch{}; `$cl -and `$cl.Contains(`$t) -and (-not `$cl.Contains('-TunnelSupervisor')) }); if(`$alive.Count -eq 0){ Start-Process -FilePath `$m -ArgumentList @('-NoProfile','-Command',('Start-Sleep -Seconds 300 # ' + `$t)) | Out-Null }; Start-Sleep -Milliseconds 40 }"
Start-Process -FilePath $me -ArgumentList @('-NoProfile','-Command',$supCmd) | Out-Null
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
# cases, so a leftover cannot bleed into the next assertion. The respawning supervisor is
# killed in the same pass, so once it is gone no tunnel comes back and the loop converges.
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
  Remove-Item env:TURMA_RUNTIME_DIR       -ErrorAction SilentlyContinue
  Remove-Item env:TURMA_SERVICE_NAME      -ErrorAction SilentlyContinue
  Remove-Item env:TURMA_FORCE_SERVICE_MODE -ErrorAction SilentlyContinue
}

$TurmaDir   = Join-Path $Home_ '.turma'
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

  # --- Case 4: session-preserving stop + reap order --------------------------------------
  Note "case: stop reaps the control plane, leaves the pty-host, and the tunnel stays dead"
  Reset-Fixture
  Set-BaseEnv
  Invoke-Ctl 'start' (Join-Path $Work 'start4.log') | Out-Null
  if (Wait-For { (Count-Faux @($Manager)) -ge 1 -and (Count-Faux @($Tunnel)) -ge 1 -and (Count-Faux @($Work, '-TunnelSupervisor')) -ge 1 -and (Count-Faux @($PtyHost)) -ge 1 }) {
    Ok "control plane (manager+tunnel+supervisor) + pty-host all up before stop"
  }
  else { Fail "not all faux processes came up (mgr=$(Count-Faux @($Manager)) tun=$(Count-Faux @($Tunnel)) sup=$(Count-Faux @($Work,'-TunnelSupervisor')) pty=$(Count-Faux @($PtyHost)))" }
  Invoke-Ctl 'stop' (Join-Path $Work 'stop4.log') | Out-Null
  if (Wait-For { (Count-Faux @($Manager)) -eq 0 -and (Count-Faux @($Work, '-TunnelSupervisor')) -eq 0 }) {
    Ok "stop reaped the manager and the supervisor"
  }
  else { Fail "control plane survived stop (mgr=$(Count-Faux @($Manager)) sup=$(Count-Faux @($Work,'-TunnelSupervisor')))" }
  # Settle well past the supervisor's 40ms respawn tick: the tunnel STAYS dead only because the
  # supervisor was reaped and is not left alive respawning it (a supervisor still running after
  # stop would bring the tunnel back within one tick — a leaked control-plane process). And the
  # pty-host is still alive — the KillMode=process guarantee. (The strict supervisor-BEFORE-
  # tunnel ordering within the adjacent control-plane reap is inspection-verified; it reuses the
  # launcher's own Stop-ByCommandLine order. This case proves the stronger no-respawn property.)
  Start-Sleep -Milliseconds 700
  if ((Count-Faux @($Tunnel)) -eq 0) { Ok "the tunnel stayed dead — the supervisor was reaped, not left respawning it" }
  else { Fail "the tunnel was respawned after stop — the supervisor was left alive (a leaked control-plane process)" }
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
  if (Wait-For { (Test-Path -LiteralPath $PidInTurma) -and ([int]((Get-Content -LiteralPath $PidInTurma -Raw) -replace '\D','') -ne $launcherBefore) -and (Count-Faux @($Manager)) -ge 1 }) {
    Ok "restart recorded a fresh launcher and a new manager came up"
  }
  else { Fail "restart did not bring a fresh launcher/manager up: $(Get-Content (Join-Path $Work 'restart5.log') -Raw -ErrorAction SilentlyContinue)" }
  # Exactly one manager — the old one was reaped, not doubled (the double-heartbeat bug).
  Start-Sleep -Milliseconds 400
  $mgrCount = Count-Faux @($Manager)
  if ($mgrCount -eq 1) { Ok "exactly one manager after restart (no doubled manager)" }
  else { Fail "expected 1 manager after restart, found $mgrCount (a doubled manager double-heartbeats)" }
  if (Get-Process -Id $ptyPidBefore -ErrorAction SilentlyContinue) { Ok "the pre-restart pty-host survived (restart is manager-only)" }
  else { Fail "restart killed the running pty-host" }
  Invoke-Ctl 'stop' (Join-Path $Work 'stop5.log') | Out-Null

  # --- Case 6: a stale/foreign pidfile is not blindly killed ----------------------------
  # A crashed launcher leaves its pidfile behind; on Windows that pid is reused fast, so the
  # recorded pid can end up naming an INNOCENT process — worst case a pty-host, killing which
  # would destroy a live session. stop must not kill a pid whose command line is not our
  # launcher (the guard status/start already apply), and must still clear the stale pidfile.
  Note "case: a stale/foreign pidfile is not blindly killed by stop"
  Reset-Fixture
  Set-BaseEnv
  New-Item -ItemType Directory -Force -Path $TurmaDir | Out-Null
  # An innocent long-lived process WITHOUT 'turma-agent.ps1' in its command line, tracked so
  # we can clean it up (it is not under $Work, so Reset-Fixture leaves it alone).
  $innocent = Start-Process -FilePath $PwshExe -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 300 # innocent-bystander') -PassThru
  Set-Content -LiteralPath $PidInTurma -Value ([string]$innocent.Id)
  Invoke-Ctl 'stop' (Join-Path $Work 'stop6.log') | Out-Null
  Start-Sleep -Milliseconds 300
  if (Get-Process -Id $innocent.Id -ErrorAction SilentlyContinue) { Ok "the innocent process (reused pid) survived stop" }
  else { Fail "stop killed an innocent process whose pid a stale pidfile named — a pty-host here loses a session" }
  if (-not (Test-Path -LiteralPath $PidInTurma)) { Ok "stop cleared the stale pidfile" }
  else { Fail "stop left the stale pidfile in place (a fresh start would read it as running)" }
  try { $innocent.Kill() } catch { }

  # --- Case 7: SERVICE-path stop reaps the broken-away tunnel + supervisor (XERK-698) ----
  # On a real host WinSW's Stop-Service reaps only the in-job launcher+manager; the tunnel + its
  # supervisor broke away from the job (ADR D2, like the pty-hosts) and SURVIVE it — the orphan
  # bug (which on uninstall then locks the prefix). The fix runs the same command-line control-
  # plane reap on the service path too. Bring the fixture up via the POSIX-drivable pidfile
  # start, then drive the SERVICE-path stop with the test-only TURMA_FORCE_SERVICE_MODE hook.
  Note "case: service-path stop reaps the tunnel + supervisor that break away from the job"
  Reset-Fixture
  Set-BaseEnv
  Invoke-Ctl 'start' (Join-Path $Work 'start7.log') | Out-Null
  if (Wait-For { (Count-Faux @($Manager)) -ge 1 -and (Count-Faux @($Tunnel)) -ge 1 -and (Count-Faux @($Work, '-TunnelSupervisor')) -ge 1 -and (Count-Faux @($PtyHost)) -ge 1 }) {
    Ok "control plane + pty-host up before the service-path stop"
  }
  else { Fail "not all faux processes came up (mgr=$(Count-Faux @($Manager)) tun=$(Count-Faux @($Tunnel)) sup=$(Count-Faux @($Work,'-TunnelSupervisor')) pty=$(Count-Faux @($PtyHost)))" }
  $env:TURMA_FORCE_SERVICE_MODE = '1'
  Invoke-Ctl 'stop' (Join-Path $Work 'stop7.log') | Out-Null
  Remove-Item env:TURMA_FORCE_SERVICE_MODE -ErrorAction SilentlyContinue
  if (Wait-For { (Count-Faux @($Manager)) -eq 0 -and (Count-Faux @($Work, '-TunnelSupervisor')) -eq 0 }) {
    Ok "service-path stop reaped the manager and the supervisor"
  }
  else { Fail "service-path stop left the control plane (mgr=$(Count-Faux @($Manager)) sup=$(Count-Faux @($Work,'-TunnelSupervisor')))" }
  # Settle past the supervisor's respawn tick: the tunnel stays dead only because the supervisor
  # was reaped on the service path too — the exact orphan the bug left running.
  Start-Sleep -Milliseconds 700
  if ((Count-Faux @($Tunnel)) -eq 0) { Ok "the tunnel stayed dead after the service-path stop (supervisor reaped, not orphaned)" }
  else { Fail "the tunnel was respawned after the service-path stop — the supervisor was orphaned (the XERK-698 bug)" }
  if ((Count-Faux @($PtyHost)) -ge 1) { Ok "the pty-host survived the service-path stop (the session is preserved)" }
  else { Fail "service-path stop killed the pty-host — a running session would be destroyed" }

  # --- Case 8: `logs` under the SERVICE tails <service>.out.log, not agent.log (XERK-698) -
  # Under WinSW the launcher's output is captured to ~/.turma\turma-agent.out.log (the roll-by-
  # size appender), NOT the agent.log the pidfile fallback writes — so `logs` reading agent.log
  # printed "no log yet" over a running, logging service.
  Note "case: logs under the service reads <service>.out.log, not agent.log"
  Reset-Fixture
  Set-BaseEnv
  New-Item -ItemType Directory -Force -Path $TurmaDir | Out-Null
  $svcOut   = Join-Path $TurmaDir 'turma-agent.out.log'   # WinSW basename = the service id
  $agentLog = Join-Path $TurmaDir 'agent.log'
  Remove-Item -LiteralPath $svcOut, $agentLog -Force -ErrorAction SilentlyContinue
  # 8a: with no service log yet, the "not yet" notice names the SERVICE out log, not agent.log.
  $env:TURMA_FORCE_SERVICE_MODE = '1'
  Invoke-Ctl 'logs' (Join-Path $Work 'logs8a.log') | Out-Null
  $out8a = (Get-Content (Join-Path $Work 'logs8a.log') -Raw -ErrorAction SilentlyContinue)
  if ($out8a -and $out8a.Contains($svcOut) -and -not $out8a.Contains($agentLog)) {
    Ok "logs under service names the WinSW out log (not agent.log) when nothing is written yet"
  }
  else { Fail "logs under service pointed at the wrong file: $out8a" }
  # 8b: with the service out log PRESENT (agent.log still absent), logs proceeds to TAIL it —
  # it blocks on Get-Content -Wait instead of printing the "no log" notice and exiting. A bug
  # reading the absent agent.log would exit immediately with the notice.
  Set-Content -LiteralPath $svcOut -Value ('svc-line-' + [guid]::NewGuid().ToString('N'))
  $p8b = Start-Ctl 'logs' (Join-Path $Work 'logs8b.log')
  $exited8b = $p8b.WaitForExit(2000)
  if (-not $exited8b) { Ok "logs under service is tailing the out log (blocked on -Wait, did not exit with a 'no log' notice)" }
  else { Fail "logs under service exited instead of tailing the present out log: $(Get-Content (Join-Path $Work 'logs8b.log') -Raw -ErrorAction SilentlyContinue)" }
  try { $p8b.Kill() } catch { }
  $null = $p8b.WaitForExit(3000)
  Remove-Item env:TURMA_FORCE_SERVICE_MODE -ErrorAction SilentlyContinue
}
finally {
  Reset-Fixture
  if (Test-Path $Work) { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }
}

if ($Script:Failed -eq 0) { Note "all turma-agentctl (windows) controller tests passed" }
else { Note "FAILURES" }
exit $Script:Failed
