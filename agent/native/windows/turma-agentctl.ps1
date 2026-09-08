#!/usr/bin/env pwsh
# turma-agentctl.ps1 -- native (no-WSL) Windows process control for the Turma per-host
# agent (XERK-671, epic XERK-666; decisions in docs/windows-agent-adr.md D2, rules in
# .claude/rules/windows-launcher.md).
#
# The Windows equivalent of BOTH halves the bash side has: the systemd user unit AND the
# nohup `turma-agentctl` fallback. It drives the WinSW SERVICE (the systemd analog) when
# one is installed, and falls back to a pidfile-managed BACKGROUND launcher (the nohup
# analog) when it is not -- the same two-scope shape as the bash ctl's `restart_manager`
# (systemd-user / systemd-system / pidfile), collapsed to (service / pidfile) here.
#
# Commands mirror the bash turma-agentctl: start | stop | restart | status | logs, plus
# install | uninstall (thin WinSW wrappers, so the installer child -- which bundles
# WinSW.exe and this file -- can register the service with one call).
#
# Three invariants this file carries, all named in the ticket:
#
#   * SESSION-PRESERVING restart (the KillMode=process guarantee). A restart reaps only
#     the control plane -- the launcher, the manager (hub-agent.py), the tunnel + its
#     supervisor -- and NEVER the detached per-session pty-hosts, which survive and are
#     re-adopted on the next boot (resume_on_boot). On the service path WinSW restarts the
#     launcher and the pty-hosts' job-object breakaway (ADR D2) keeps them alive; on the
#     pidfile path we reap by command line and simply never name a pty-host.
#   * The supervisor is reaped BEFORE the tunnel (else the just-killed tunnel is respawned
#     by its own supervisor), the SAME ordering the launcher uses on every start.
#   * The pidfile lives in a Windows-CORRECT per-user location -- %USERPROFILE%\.turma, a
#     durable per-user dir -- NOT %TEMP% (which a Session-0 service identity and the
#     interactive user can resolve differently, and which gets swept). Keying it there is
#     the Windows twin of the bash ctl guarding against the never-created /run/user/<uid>:
#     a pidfile the writer and reader disagree on, or one whose write silently fails, lets
#     stop/restart miss the pid they must kill and orphan-then-DOUBLE the manager.
#
# NOT here (a later epic child): the WinSW service is DEFINED by the sibling turma-agent.xml
# but INSTALLED/packaged (winget + npm + bundled WinSW.exe) by the installer child. The Windows
# updater (turma-agent-update.ps1, XERK-674) IS wired now -- but its poller is started by the
# LAUNCHER (Invoke-UpdateChecks), not by this ctl's `start`, so both the service and pidfile
# paths get it uniformly.

[CmdletBinding()]
param(
  # NOT a [ValidateSet]: an unknown verb must print the usage line and exit 2 (the bash ctl's
  # behaviour) via the switch's default arm, not fail at parameter binding with a stack trace.
  [Parameter(Position = 0)]
  [string]$Command = 'status',
  # Optional trailing argument (the line count for `logs`).
  [Parameter(Position = 1)]
  [string]$Arg
)

# StrictMode is the `set -u` analog; ErrorActionPreference stays 'Continue' so best-effort
# process kills and cleanup do not abort a command (the twin of the bash `2>/dev/null ||
# true` this file leans on freely).
Set-StrictMode -Version Latest

# Log to the process stdout handle so a console, a WinSW capture and a test redirect all
# pick it up identically (Write-Host lands on a stream a plain `>` does not) -- same choice
# the launcher makes.
function Log([string]$Message) { [Console]::Out.WriteLine($Message) }

# bash `${x:-default}`: first non-empty wins; '' and $null are both "unset".
function Coalesce {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Values)
  foreach ($v in $Values) { if ($v) { return $v } }
  return ''
}

# --- resolve the install prefix from our own location ($Prefix\bin\turma-agentctl.ps1) ---
$SelfPath  = $PSCommandPath
$SelfDir   = Split-Path -Parent $SelfPath           # $Prefix\bin
$Prefix    = Split-Path -Parent $SelfDir            # $Prefix
$Launcher  = Join-Path $SelfDir 'turma-agent.ps1'   # what we (re)start
$Manager   = Join-Path $Prefix 'hub-agent.py'       # reaped by command line on stop
$Tunnel    = Join-Path $Prefix 'tunnel-agent.js'    # reaped by command line on stop

# USERPROFILE is the $HOME analog every per-user path hangs off, and a Session-0 / SYSTEM
# service can be launched without it in the environment (the Windows twin of the bash
# "HOME unset" trap). Derive it rather than fail under StrictMode -- exactly as the launcher
# does, so the two agree on where the pidfile and logs live.
if (-not $env:USERPROFILE) {
  $up = [Environment]::GetFolderPath('UserProfile')
  if (-not $up) {
    $up = if ($env:HOMEDRIVE -and $env:HOMEPATH) { "$env:HOMEDRIVE$env:HOMEPATH" }
          else { Join-Path (Coalesce $env:SystemDrive 'C:') 'Users\Default' }
  }
  $env:USERPROFILE = $up
}

$ServiceName = Coalesce $env:TURMA_SERVICE_NAME 'turma-agent'
# WinSW convention: the wrapper .exe is renamed to match the descriptor's basename and sits
# beside it. The installer child bundles both here; install/uninstall find them at $SelfDir.
$WinswExe = Join-Path $SelfDir "$ServiceName.exe"
$WinswXml = Join-Path $SelfDir "$ServiceName.xml"

# The durable per-user state dir the manager itself uses (~/.turma). Always writable by its
# owner, so both the launcher's logs and (in the pidfile path) both ends of a start/stop
# see the same files. Never %TEMP% -- see the header.
$TurmaDir = Join-Path $env:USERPROFILE '.turma'
$Log      = Join-Path $TurmaDir 'agent.log'
$ErrLog   = Join-Path $TurmaDir 'agent.err.log'

# --- pidfile location: prefer an override if usable, else the durable ~/.turma -----------
# Mirrors the bash ctl's "prefer XDG_RUNTIME_DIR, fall back to ~/.turma unless it is usable"
# so the SAME failure the bash ctl guards against cannot happen here: a set-but-unusable
# TURMA_RUNTIME_DIR must fall back, not silently fail every pidfile write and leave stop/
# restart unable to read the pid they kill (orphan-then-double). ${VAR:-default} only falls
# back for an UNSET value -- a set-but-unwritable dir is exactly the trap -- so we probe
# writability explicitly.
function Test-DirUsable([string]$Dir) {
  if (-not $Dir) { return $false }
  try { New-Item -ItemType Directory -Force -Path $Dir -ErrorAction Stop | Out-Null } catch { return $false }
  $probe = Join-Path $Dir (".turma-write-test-" + [guid]::NewGuid().ToString('N'))
  try {
    Set-Content -LiteralPath $probe -Value 'x' -ErrorAction Stop
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $true
  }
  catch { return $false }
}
function Resolve-RunDir {
  if (Test-DirUsable $env:TURMA_RUNTIME_DIR) { return $env:TURMA_RUNTIME_DIR }
  New-Item -ItemType Directory -Force -Path $TurmaDir -ErrorAction SilentlyContinue | Out-Null
  return $TurmaDir
}
$RunDir  = Resolve-RunDir
$PidFile = Join-Path $RunDir 'turma-agent.pid'

# --- liveness ----------------------------------------------------------------------------
# Alive AND still our launcher: on Windows a pid is reused faster than on Linux, so when the
# command line is readable we require it to name the launcher (guards a pidfile pointing at
# a recycled pid). Unreadable command line -> fall back to bare existence, as the bash
# `kill -0` does.
function Test-PidAlive([int]$ProcId) {
  if ($ProcId -le 0) { return $false }
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if (-not $p) { return $false }
  $cl = $null; try { $cl = $p.CommandLine } catch { }
  if ($cl) { return $cl.Contains('turma-agent.ps1') }
  return $true
}
function Read-Pid {
  if (Test-Path -LiteralPath $PidFile) {
    $raw = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue)
    if ($raw -and ($raw -match '\d+')) {
      # TryParse so a corrupt/oversize value (> Int32, tampered pidfile) degrades to "no pid"
      # instead of throwing an Int32-overflow error on a status/stop.
      $n = 0
      if ([int]::TryParse($Matches[0], [ref]$n)) { return $n }
    }
  }
  return 0
}

# --- service detection -------------------------------------------------------------------
# Get-Service is Windows-only (undefined on Linux pwsh) and throws for a not-installed
# service; either way we take the pidfile fallback path. So the POSIX test harness exercises
# the fallback exactly as CI does, the same way the bash suite runs with no systemd and the
# launcher suite leaves WinSW/ConPTY to a real Windows host.
function Get-AgentService {
  try { return Get-Service -Name $ServiceName -ErrorAction Stop } catch { return $null }
}
function Test-ServiceMode {
  # TURMA_FORCE_SERVICE_MODE is a TEST-ONLY hook: Get-Service is undefined on Linux pwsh, so
  # the service path is otherwise unreachable off a real Windows host, and the POSIX suite
  # must be able to drive the service-path stop/logs reap+log-target (XERK-698). Unset in
  # every real install; the Windows-only service cmdlets it forces past are guarded on it.
  if ($env:TURMA_FORCE_SERVICE_MODE) { return $true }
  return $null -ne (Get-AgentService)
}

# --- reap by command line (the launcher's Stop-ByCommandLine, prefix-scoped) --------------
# Kills every process whose command line contains ALL the needles (never ourselves). Reused
# for the tunnel supervisor, the tunnel and the manager on the pidfile stop path. A pty-host
# is never a needle here, so it is never reaped -- the session-preserving property.
function Stop-ByCommandLine([string[]]$Needles) {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    if ($_.Id -eq $PID) { return $false }
    $cl = $null
    try { $cl = $_.CommandLine } catch { return $false }
    if (-not $cl) { return $false }
    foreach ($n in $Needles) { if (-not $cl.Contains($n)) { return $false } }
    return $true
  } | ForEach-Object { try { $_.Kill() } catch { } }
}

# Reap the control plane BY COMMAND LINE, in the launcher's order, leaving pty-hosts (and thus
# the sessions) alive. SUPERVISOR FIRST so it cannot respawn the tunnel we then kill; then the
# tunnel; then the manager; then any remaining launcher process. A Windows teardown MUST reap
# the manager too (unlike the bash restart, where the launcher IS the manager via exec, so
# killing the launcher pid alone would leave the python manager running and a fresh launcher
# would start a SECOND -- two managers double-heartbeating, the very bug the pidfile discipline
# exists to prevent).
#
# Used on BOTH stop paths (XERK-698): the pidfile path (via Stop-ControlPlane, which also does
# the guarded pidfile-pid kill) AND the service path. On the service path the tunnel + its
# supervisor break away from WinSW's job object (ADR D2, exactly like the pty-hosts), so
# Stop-Service reaps only the in-job launcher + manager and LEAVES the tunnel + supervisor
# orphaned -- and on uninstall their still-open tunnel-agent.js / turma-agent.ps1 hold an
# exclusive file lock that makes the prefix Remove-Item silently fail and strand the prefix.
# The same prefix-scoped command-line reap sweeps them on either path.
function Stop-ControlPlaneProcesses {
  Stop-ByCommandLine @($Launcher, '-TunnelSupervisor')   # supervisor FIRST
  Stop-ByCommandLine @($Tunnel)                          # then the tunnel
  Stop-ByCommandLine @($Manager)                         # then the manager
  Stop-ByCommandLine @($Launcher)                        # then any remaining launcher process
}

# The pidfile-path full teardown: the command-line reap above, PLUS the guarded pidfile-pid
# kill of the launcher recorded at start (whose command line may be UNREADABLE, in which case
# the reap above cannot match it and only this pid-keyed kill reaps it). This is what BOTH the
# pidfile `stop` and the pidfile `restart` use.
function Stop-ControlPlane {
  Stop-ControlPlaneProcesses
  # Guard the destructive pidfile kill with the SAME command-line check status/start use
  # (Test-PidAlive). On Windows a pid is reused fast, and a stale pidfile left by a CRASHED
  # launcher (a clean stop/restart removes it) can point at an innocent process -- worst case
  # a pty-host, whose death would destroy the very session this reap must preserve. So kill
  # only a pid we can still confirm is our launcher; drop the (stale/foreign) pidfile
  # regardless so a fresh start is not blocked by it.
  $pidNum = Read-Pid
  if (Test-PidAlive $pidNum) {
    $p = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
    if ($p) { try { $p.Kill() } catch { } }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

# --- start (pidfile fallback) ------------------------------------------------------------
function Start-Fallback {
  $pidNum = Read-Pid
  if (Test-PidAlive $pidNum) {
    Log "turma-agent already running (pid $pidNum)"
    return
  }
  New-Item -ItemType Directory -Force -Path $TurmaDir | Out-Null
  # Background the launcher and record ITS pid. It backgrounds the manager + tunnel
  # supervisor itself, so this pid is the control-plane root the stop/restart reap on top
  # of. Output goes to the durable log; -PassThru gives us the pid to persist. The ctl
  # process exits right after, so no long-lived redirection reader is left to trip on.
  $child = Start-Process -FilePath (Get-Process -Id $PID).Path `
    -ArgumentList @('-NoProfile', '-File', $Launcher) `
    -RedirectStandardOutput $Log -RedirectStandardError $ErrLog -PassThru
  Set-Content -LiteralPath $PidFile -Value ([string]$child.Id)
  Log "turma-agent started (pid $($child.Id)); logs: $Log"
  # The auto-update poller is not started here: the LAUNCHER starts it (Invoke-UpdateChecks in
  # turma-agent.ps1, XERK-674), which covers both this pidfile path and the WinSW service path
  # uniformly -- unlike the bash ctl, which starts its own --loop poller on the nohup path.
}

# --- the commands ------------------------------------------------------------------------
function Invoke-Start {
  if (Test-ServiceMode) {
    Start-Service -Name $ServiceName
    Log "turma-agent service '$ServiceName' started"
  }
  else { Start-Fallback }
}

function Invoke-Stop {
  # Full teardown of the CONTROL PLANE only; the sessions (pty-hosts) are left running and a
  # later start re-adopts them -- the bash ctl's "kill keeps the worktree/session" philosophy.
  if (Test-ServiceMode) {
    # WinSW stops the launcher + the manager it started (both in the service job object); the
    # detached pty-hosts break away and survive (ADR D2). But the tunnel + its supervisor ALSO
    # broke away from the job (like the pty-hosts) and are NOT control plane WinSW can reach --
    # so run the SAME prefix-scoped command-line reap the pidfile path uses, on the service
    # path too, or they orphan (and on uninstall lock the prefix) (XERK-698). The env guard is
    # the test-only service-mode hook: no real service exists on the POSIX runner.
    if (-not $env:TURMA_FORCE_SERVICE_MODE) { Stop-Service -Name $ServiceName }
    Stop-ControlPlaneProcesses
    Log "turma-agent service '$ServiceName' stopped (sessions left running)"
  }
  else {
    Stop-ControlPlane
    Log "turma-agent stopped (sessions left running)"
  }
}

function Invoke-Restart {
  # Session-preserving (manager-only) restart. Service: WinSW brings the launcher back and
  # the pty-hosts survive via breakaway. Pidfile: reap the whole control plane (sparing the
  # pty-hosts), wait for the launcher pid to release, then start a fresh one that re-adopts
  # the still-running sessions on boot.
  if (Test-ServiceMode) {
    Restart-Service -Name $ServiceName
    Log "turma-agent service '$ServiceName' restarted (sessions preserved)"
    return
  }
  $pidNum = Read-Pid
  Stop-ControlPlane
  # Give the old launcher a moment to release before the new one binds/reads (bash waits the
  # same way).
  for ($i = 0; $i -lt 25; $i++) {
    if (-not (Test-PidAlive $pidNum)) { break }
    Start-Sleep -Milliseconds 200
  }
  Start-Fallback
}

function Invoke-Status {
  if (Test-ServiceMode) {
    $svc = Get-AgentService
    Log "turma-agent service '$ServiceName': $($svc.Status)"
    return
  }
  $pidNum = Read-Pid
  if (Test-PidAlive $pidNum) { Log "turma-agent: running (pid $pidNum)" }
  else { Log "turma-agent: stopped" }
}

function Invoke-Logs([string]$LogArg) {
  $n = 200
  if ($LogArg -and ($LogArg -match '^\d+$')) { $n = [int]$LogArg }
  # The two supervisors capture the launcher's output to DIFFERENT files, so `logs` must tail
  # the right one for the mode in play (XERK-698):
  #   * Under the WinSW service, WinSW's SizeBasedRollingLogAppender writes to
  #     <logpath>\<service>.out.log / .err.log (logpath is ~/.turma, basename is the service
  #     id) -- NOT the agent.log the pidfile fallback writes. Reading agent.log there printed
  #     "no log yet" while the service was running and logging.
  #   * On the pidfile fallback, Start-Fallback redirects to ~/.turma\agent.log.
  # -Wait THROWS on a not-yet-existent file rather than waiting for it, so return after a
  # notice instead of erroring when nothing has been written yet.
  $target = $Log
  if (Test-ServiceMode) {
    $svcOut = Join-Path $TurmaDir "$ServiceName.out.log"
    $svcErr = Join-Path $TurmaDir "$ServiceName.err.log"
    $target = if (Test-Path -LiteralPath $svcOut) { $svcOut }
              elseif (Test-Path -LiteralPath $svcErr) { $svcErr }
              else { $svcOut }   # name the out log in the "not yet" notice
  }
  if (-not (Test-Path -LiteralPath $target)) {
    Log "no log yet at $target (has the agent started?)"
    return
  }
  Get-Content -LiteralPath $target -Tail $n -Wait
}

# --- install / uninstall: thin WinSW wrappers (Windows host only) ------------------------
# The installer child bundles WinSW.exe as $ServiceName.exe beside turma-agent.xml; these
# just register/deregister so it (or an operator) needs one command, not the raw WinSW CLI.
function Invoke-Install {
  if (-not (Test-Path -LiteralPath $WinswExe)) {
    Log "install: WinSW wrapper not found at $WinswExe"
    Log "install: the Windows installer bundles it; run the installer, or drop WinSW.exe there as $ServiceName.exe."
    exit 1
  }
  if (-not (Test-Path -LiteralPath $WinswXml)) {
    Log "install: service descriptor not found at $WinswXml"
    exit 1
  }
  & $WinswExe install
  $rc = $LASTEXITCODE
  if ($rc -ne 0) { Log "install: WinSW exited $rc"; exit $rc }
  Log "turma-agent service '$ServiceName' installed (start it with: turma-agentctl start)"
}
function Invoke-Uninstall {
  if (-not (Test-Path -LiteralPath $WinswExe)) {
    Log "uninstall: WinSW wrapper not found at $WinswExe; nothing to do"
    return
  }
  & $WinswExe uninstall
  $rc = $LASTEXITCODE
  # WinSW uninstall stops + deregisters the service, but the tunnel + its supervisor broke away
  # from the job and survive it -- reap the whole control plane here, or their held-open
  # tunnel-agent.js / turma-agent.ps1 keep an exclusive lock that makes the caller's
  # (install.ps1 -Uninstall) prefix Remove-Item SILENTLY fail and leave the prefix behind
  # (XERK-698). Done regardless of WinSW's exit so a partial uninstall does not strand orphans.
  Stop-ControlPlaneProcesses
  if ($rc -ne 0) { Log "uninstall: WinSW exited $rc"; exit $rc }
  Log "turma-agent service '$ServiceName' uninstalled (running sessions were left alone)"
}

switch ($Command) {
  'start'     { Invoke-Start }
  'stop'      { Invoke-Stop }
  'restart'   { Invoke-Restart }
  'status'    { Invoke-Status }
  'logs'      { Invoke-Logs $Arg }
  'install'   { Invoke-Install }
  'uninstall' { Invoke-Uninstall }
  default {
    Log "usage: turma-agentctl.ps1 {start|stop|restart|status|logs [N]|install|uninstall}"
    exit 2
  }
}
