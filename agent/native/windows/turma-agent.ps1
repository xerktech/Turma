#!/usr/bin/env pwsh
# turma-agent.ps1 -- native (no-WSL) Windows launcher for the Turma per-host agent
# (XERK-669, epic XERK-666; the decisions it implements are in docs/windows-agent-adr.md,
# the operative rules in .claude/rules/windows-launcher.md).
#
# This is the Windows port of the LAUNCHER ROLE of agent/native/turma-agent (the bash
# launcher), rewritten in PowerShell per ADR D5 ("PowerShell for the OS-facing shell
# layer; the python + node runtime stays one cross-platform codebase"). It does exactly
# what the bash launcher does and nothing the manager/pty/service children own:
#
#   1. resolve + VALIDATE the runtime env file (a bad one IDLES, never exits), applying
#      Windows-relative defaults for the paths the bash launcher derives from $HOME;
#   2. put the per-user tool dir on PATH so `claude` resolves from a non-login service
#      context (the Windows twin of XERK-94's ~/.local/bin problem);
#   3. supervise the reverse tunnel with the node check INSIDE the retry loop (a
#      fire-and-forget check makes a missing node silent AND permanent);
#   4. export the manager PID (for the tunnel's heartbeat poke) and TURMA_AGENT_ENV (the
#      resolved env-file path, so the manager can rewrite this host's token -- XERK-578);
#   5. idle (never crash-loop) when the Claude subscription login is absent;
#   6. start + wait on the shared manager (hub-agent.py) as the long-lived process.
#
# The self-updater (turma-agent-update.ps1, XERK-674) and its "every start is an update
# check" ARE wired now -- see Invoke-UpdateChecks below (Claude Code awaited before the
# manager; the agent self-update poller started detached, the Windows stand-in for the
# systemd .timer WinSW has no analogue for).
#
# Deliberately NOT here, each owned by a later epic child (kept out to keep this focused
# and testable, and marked below where they wire in):
#   * the Windows SERVICE wrapper (WinSW) that supervises THIS script -- ADR D2;
#   * the per-session pty-host that replaces tmux+ttyd -- ADR D1.

[CmdletBinding()]
param(
  # Re-entry point for the supervised reverse tunnel (the run path backgrounds a second
  # copy of THIS script with this switch, so the supervisor inherits the env we resolve).
  [switch]$TunnelSupervisor,
  # Report-only mode for the installer's --verify hook: answer and leave, never idle.
  [switch]$Preflight
)

# PowerShell has no `set -u`; StrictMode is the closest analog (an undefined variable is
# an error, not a silent empty). We read env vars through helpers, never bare, so this
# only guards genuine typos. ErrorActionPreference stays at the default 'Continue' -- the
# bash launcher's `set -e` maps badly here (we WANT to idle on a bad config, not die),
# so the two idle cases are explicit and everything else uses ordinary error semantics.
Set-StrictMode -Version Latest

# Log straight to the process's stdout handle so a real console, a WinSW log, and a test
# redirect ALL capture it identically -- Write-Host / Write-Output land on streams a plain
# `>` redirect (and WinSW) do not reliably pick up.
function Log([string]$Message) { [Console]::Out.WriteLine($Message) }

# The bash `${x:-default}` idiom: first non-empty wins; '' and $null are both "unset".
function Coalesce {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Values)
  foreach ($v in $Values) { if ($v) { return $v } }
  return ''
}

# Never returns -- the Windows equivalent of `exec sleep infinity`. Idling is
# self-healing (fix the file / log in, restart the service) and, unlike an exit, it does
# not read as a crash the service manager should restart-loop.
function Enter-Idle {
  while ($true) { Start-Sleep -Seconds 3600 }
}

# --- Resolve the install prefix from our own location ($Prefix\bin\turma-agent.ps1) ----
$SelfPath = $PSCommandPath
$SelfDir  = Split-Path -Parent $SelfPath           # $Prefix\bin
$Prefix   = Split-Path -Parent $SelfDir            # $Prefix
$Manager  = Join-Path $Prefix 'hub-agent.py'
$Tunnel   = Join-Path $Prefix 'tunnel-agent.js'
$Updater  = Join-Path $SelfDir 'turma-agent-update.ps1'   # the self-updater (XERK-674)

# USERPROFILE is the $HOME analog every default below hangs off. A Session-0 / SYSTEM
# service can be launched without it in the environment (the Windows twin of the
# systemd-system-scope "HOME unset" trap that once cost a host its agent for 7.5 hours),
# so derive it rather than fail. GetFolderPath answers even when the var is missing.
if (-not $env:USERPROFILE) {
  $up = [Environment]::GetFolderPath('UserProfile')
  if (-not $up) {
    $up = if ($env:HOMEDRIVE -and $env:HOMEPATH) { "$env:HOMEDRIVE$env:HOMEPATH" }
          else { Join-Path (Coalesce $env:SystemDrive 'C:') 'Users\Default' }
  }
  $env:USERPROFILE = $up
  Log "[turma-agent] USERPROFILE was unset (service context?); using $up"
}
$AppData = Coalesce $env:APPDATA (Join-Path $env:USERPROFILE 'AppData\Roaming')

# --- Locate + export the config path BEFORE loading it --------------------------------
# The manager (hub-agent.py agent_env_path()) rewrites THIS file when it rolls the host's
# token (XERK-578); it otherwise sees only the sourced VALUES, not where they came from.
# Export the resolved path first so it holds even for a bad/idle config, matching the
# bash launcher. Default location is %APPDATA%\turma-agent (ADR D4's known-folder map),
# and the launcher always exports it, so the manager never falls back to its own
# ~/.config default.
$Cfg = Coalesce $env:TURMA_AGENT_ENV (Join-Path $AppData 'turma-agent\turma-agent.env')
$env:TURMA_AGENT_ENV = $Cfg

# Every non-conforming line in the config, as objects carrying the 1-based line number
# and the leading key name (NEVER the value). We parse this file (we do not source it, so
# a YAML-style `JIRA_SITE: "x"` is inert here rather than an executed command as in bash)
# but the SAME validation is kept, because the file format is shared with the bash hosts
# and systemd, and a malformed line still means "do not start against a half-applied
# config." A `#` comment, a blank line, and an `export ` prefix are all legal.
function Get-ConfigErrors([string]$Path) {
  $bad = @()
  $n = 0
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    $n++
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -match '^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=') { continue }
    $trimmed = $line -replace '^\s+', ''
    $name = if ($trimmed -match '^[A-Za-z_][A-Za-z0-9_]*') { $Matches[0] } else { '(unreadable)' }
    $bad += [pscustomobject]@{ Line = $n; Name = $name }
  }
  return , $bad
}

# Apply a validated config: set $env:KEY for each assignment, honouring an `export `
# prefix and stripping ONE layer of matching surrounding quotes from the value (the
# common `export TURMA_TOKEN="t"` / `MAX_SESSIONS=6` forms). No shell expansion -- these
# files hold plain literals, and the values are read back as-is by the manager.
function Import-Config([string]$Path) {
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -notmatch '^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { continue }
    $key = $Matches[2]
    $val = $Matches[3]
    if ($val.Length -ge 2 -and (($val[0] -eq '"' -and $val[-1] -eq '"') -or ($val[0] -eq "'" -and $val[-1] -eq "'"))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    Set-Item -Path "env:$key" -Value $val
  }
}

$cfgBad = @()
if (Test-Path -LiteralPath $Cfg) {
  $cfgBad = Get-ConfigErrors $Cfg
  if ($cfgBad.Count -eq 0) { Import-Config $Cfg }
}

# A bad config is reported ONCE (names + line numbers, no values -- this file is ACL'd
# owner-only and holds TURMA_TOKEN / JIRA_TOKEN, while this banner goes to the service log,
# a different audience) and then idled on. Never exit here: a launcher that exits reads,
# to the service manager, exactly like one worth restarting in a few seconds -- which is
# the invisible crash loop this whole discipline exists to prevent. Nothing is loaded in
# this state: a half-applied config would report to the wrong hub, or none.
if ($cfgBad.Count -gt 0) {
  Log "=================================================================="
  Log " Invalid line(s) in $Cfg"
  Log " (values hidden -- this file holds tokens; only names are shown)"
  Log ""
  foreach ($b in $cfgBad) { Log ("   line {0}: {1} ..." -f $b.Line, $b.Name) }
  Log ""
  Log " Expected plain KEY=value, one per line (the same format the bash agent's"
  Log " systemd EnvironmentFile takes). A line like  JIRA_SITE: `"x`"  is YAML, not"
  Log " a KEY=value assignment, and the agent cannot start."
  Log ""
  Log " Nothing from this file was loaded. Fix the line(s) above, then restart the"
  Log " turma-agent service."
  Log "=================================================================="
  if ($Preflight) { exit 1 }
  Enter-Idle
}

# --- Native-safe defaults, applied only where the config left a key blank/unset --------
# CLAUDE_PROJECTS_ROOT / REPOS_ROOT map onto the Windows known folders (ADR D4): where
# Claude Code already writes on Windows, and a HOME-relative repos root. DEVICE_NAME
# defaults to the machine name (COMPUTERNAME, which the manager also reads as a fallback).
$env:CLAUDE_PROJECTS_ROOT = Coalesce $env:CLAUDE_PROJECTS_ROOT (Join-Path $env:USERPROFILE '.claude\projects')
$env:REPOS_ROOT           = Coalesce $env:REPOS_ROOT (Join-Path $env:USERPROFILE 'git')
$env:DEVICE_NAME          = Coalesce $env:DEVICE_NAME $env:COMPUTERNAME ([System.Net.Dns]::GetHostName())

# Put the per-user tool dirs on PATH ourselves. A Windows service running without an
# interactive login does NOT inherit the user's shell PATH, so `claude` is otherwise
# unreachable and every session dies on exec. Claude Code lands in ONE of two per-user
# places depending on how it was installed, and we cannot predict which, so cover BOTH:
#   * %APPDATA%\npm       -- npm's global bin (`claude.cmd`), what install.ps1 lays down;
#   * %USERPROFILE%\.local\bin -- the native `claude` installer's dir (`claude.exe`), the
#     Windows twin of the ~/.local/bin the bash launcher blesses (XERK-94, XERK-678:
#     a real host had it here, not under npm).
# The install prefix's bin dir goes on too (bundled tools like WinSW). System-PATH tools
# (git/node/python, installed machine-wide by install.ps1) ride the inherited $env:PATH.
$NpmBin   = Join-Path $AppData 'npm'
$LocalBin = Join-Path $env:USERPROFILE '.local\bin'
$env:PATH = @($SelfDir, $NpmBin, $LocalBin, $env:PATH) -join [System.IO.Path]::PathSeparator

$TunnelRetrySec = [int](Coalesce $env:TUNNEL_RETRY_SEC '10')
$Creds = Join-Path $env:USERPROFILE '.claude\.credentials.json'

# --- XERK-578 optional zero-touch token onboarding (self-enroll) ----------------------
# When opted in (TURMA_AGENT_SELF_ENROLL truthy), roll this host onto its OWN derived agent
# token (XERK-268/284) on start, so a fleet self-rolls off the shared master with no
# per-host ritual -- the Windows twin of the bash launcher's self-enroll block. IDEMPOTENT
# (a host already on its derived token is a hub-side no-op) and BEST-EFFORT (never blocks
# start): a hub too old to offer the endpoint (exit 2), or ANY failure, leaves the current
# token in place. hub-agent.py --enroll fetches + verifies + writes the new token to $Cfg
# ATOMICALLY with an owner-only NTFS ACL (restrict_file_to_owner's icacls, the chmod-600
# analog), refusing to persist a token whose name half is not this host's DEVICE_NAME. On
# success we re-read ONLY TURMA_TOKEN from the file -- re-importing the WHOLE file would
# reset every blank Windows-relative default we just applied -- so the tunnel and manager
# below start authenticated on the new token. Called from the MAIN run path only (below),
# never the -TunnelSupervisor re-entry or -Preflight: the manager + supervisor we start
# inherit the re-read token, and the supervisor's own Import-Config re-reads the rolled
# file regardless, so one enroll per launcher start is enough.
function Invoke-SelfEnroll {
  switch -Regex ((Coalesce $env:TURMA_AGENT_SELF_ENROLL '')) {
    '^(1|true|yes|on)$' { break }
    default { return }
  }
  if (-not (Test-Path -LiteralPath $Cfg)) { return }
  $rc = 1
  try {
    & python "$Manager" --enroll
    $rc = $LASTEXITCODE
  }
  catch {
    Log "[turma-agent] self-enroll: could not run the manager's --enroll ($_); staying on the current token"
    return
  }
  # 2 = hub too old (soft skip); any other non-zero = a failure. Either way stay put -- the
  # manager still authenticates on the existing TURMA_TOKEN. --enroll never prints a token.
  if ($rc -ne 0) { return }
  # Re-read ONLY TURMA_TOKEN from the (now atomically-rewritten) config. Last assignment
  # wins, matching how the file is sourced/imported; one layer of surrounding quotes is
  # stripped, as Import-Config does. Wrapped best-effort like the --enroll call above: on
  # Windows a just-renamed file can be momentarily locked (AV/indexer/backup handle) or
  # vanish in a TOCTOU window, and ReadAllLines throws -- degrade with one log line and stay
  # on the current token, not a stack trace to the service log (bash's grep degrades
  # silently; parity). The enroll already persisted the new token, so the next start reads
  # it via Import-Config regardless.
  $rolled = ''
  try {
    foreach ($line in [System.IO.File]::ReadAllLines($Cfg)) {
      if ($line -match '^\s*(export\s+)?TURMA_TOKEN=(.*)$') {
        $v = $Matches[2]
        if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
          $v = $v.Substring(1, $v.Length - 2)
        }
        $rolled = $v
      }
    }
  }
  catch {
    Log "[turma-agent] self-enroll: rolled the token but could not re-read $Cfg ($_); the next start picks it up"
    return
  }
  if ($rolled) { $env:TURMA_TOKEN = $rolled }
}

# --- reverse-tunnel supervisor --------------------------------------------------------
# Re-entry point: `turma-agent.ps1 -TunnelSupervisor`, backgrounded by the run path. It
# is this script (not a file of its own) so the supervisor inherits the config we just
# loaded and the PATH above, and so its command line carries a precise, greppable key the
# run path reaps on. The node check lives INSIDE the loop, never in front of it: on a
# native install node is a setup-time prerequisite, not a baked layer, so it can be
# genuinely absent -- and a fire-and-forget check would make that both silent (the manager
# keeps heartbeating, so the host reads ONLINE) and permanent (nothing retries). Checking
# each pass heals the terminals within one retry the moment node is installed, no restart.
if ($TunnelSupervisor) {
  while ($true) {
    if (Get-Command node -ErrorAction SilentlyContinue) {
      & node $Tunnel
      Log "[turma-agent] tunnel exited (rc=$LASTEXITCODE); web terminals are offline until it is back"
    }
    else {
      Log "[turma-agent] node not on PATH -- the reverse tunnel cannot start, so every"
      Log "[turma-agent] session on this host reads 'terminal offline'. Install Node >= 24"
      Log "[turma-agent] (the installer does this); it is picked up here with no restart."
    }
    Start-Sleep -Seconds $TunnelRetrySec
  }
  return
}

# --- log-only credentials preflight ---------------------------------------------------
function Report-Creds {
  if (Test-Path -LiteralPath $Creds) {
    Log "[turma-agent] claude: subscription credentials present"
  }
  else {
    Log "[turma-agent] claude: NO credentials at $Creds -- run 'claude /login' on this host"
  }
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    & gh auth status *> $null
    if ($LASTEXITCODE -eq 0) {
      $who = (& gh api user -q .login 2>$null); if (-not $who) { $who = '?' }
      Log "[turma-agent] gh: authenticated as $who"
    }
    else {
      Log "[turma-agent] gh: NOT authenticated -- private git ops and 'gh pr create' will fail (run: gh auth login)"
    }
  }
  # Cloud CLIs are optional and usually absent natively; the command guard makes this a
  # silent no-op. Keyed on a login-marker FILE, never the store dir (each CLI creates its
  # own store just by running) -- same rule as the bash launcher / entrypoint.sh.
  $pairs = @(
    @{ Cli = 'aws';       Marker = (Join-Path $env:USERPROFILE '.aws\credentials') }
    @{ Cli = 'az';        Marker = (Join-Path $env:USERPROFILE '.azure\msal_token_cache.json') }
    @{ Cli = 'terraform'; Marker = (Join-Path $env:USERPROFILE '.terraform.d\credentials.tfrc.json') }
  )
  foreach ($p in $pairs) {
    if (-not (Get-Command $p.Cli -ErrorAction SilentlyContinue)) { continue }
    if (Test-Path -LiteralPath $p.Marker) {
      Log "[turma-agent] $($p.Cli): host creds present"
    }
    else {
      Log "[turma-agent] $($p.Cli): installed; no creds on this device -- ignoring"
    }
  }
}

# --- Report-only mode for the installer's --verify: no idling, no launches ------------
if ($Preflight) {
  Log "[turma-agent] preflight (Prefix=$Prefix)"
  Report-Creds
  foreach ($t in @('claude', 'git', 'node', 'python')) {
    $cmd = Get-Command $t -ErrorAction SilentlyContinue
    if ($cmd) { Log "[turma-agent] tool ${t}: $($cmd.Source)" }
    else { Log "[turma-agent] tool ${t}: MISSING" }
  }
  exit 0
}

# Optional token self-enroll (XERK-578), before the credential gate so a host that will
# idle for a missing Claude login still rolls onto its derived token. Main run path only.
Invoke-SelfEnroll

Report-Creds

# --- update checks on every start (XERK-254 / XERK-674) --------------------------------
# A restart -- an operator's, WinSW's after a crash, the hub's token-roll, a host reboot -- is
# the moment to be running current code, so every start checks both halves of what this host
# runs. They are fired DIFFERENTLY, and the difference is the whole safety argument:
#   * Claude Code, AWAITED, right here, before the manager exists. Replacing the npm package
#     leaves `claude` briefly absent from PATH and a session launched in that window dies on
#     exec; before the manager starts nothing can be launching. Bounded by a deadline so a slow
#     registry delays but cannot hang the start.
#   * The agent self-update, via a DETACHED poller. WinSW has no timer (unlike the bash host's
#     systemd .timer), so the launcher starts the poller itself; it does the on-start agent
#     check (its first pass) AND the periodic poll. Started only if one is not already running,
#     so a session-preserving restart (which the updater itself triggers) does not stack
#     pollers, and its first pass is rate-limited so a crash-looping unit cannot turn WinSW's
#     restart into a check every few seconds. TURMA_BOOT_UPDATE=0 opts out.
# dsh is NOT provisioned on Windows, so there is no dsh check here (unlike the bash launcher).
function Get-IntEnv([string]$Value, [int]$Default) {
  if ($Value -and ($Value -match '^\d+$')) { $n = [int]$Value; if ($n -gt 0) { return $n } }
  return $Default
}
# A running -Loop poller for THIS install (its command line names our updater + -Loop).
function Get-UpdatePoller {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $cl = $null; try { $cl = $_.CommandLine } catch { return $false }
      if (-not $cl) { return $false }
      return ($cl.Contains($Updater) -and $cl.Contains('-Loop'))
    })
}
function Invoke-UpdateChecks {
  if ((Coalesce $env:TURMA_BOOT_UPDATE '1') -eq '0') { return }
  if (-not (Test-Path -LiteralPath $Updater)) { return }
  New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE '.turma') -ErrorAction SilentlyContinue | Out-Null

  # Claude Code, AWAITED + bounded. The deadline is a FIXED generous number floored well clear
  # of the npm install budget (2.5x, as the bash launcher does) so it cannot fire mid-install --
  # `Kill` would only interrupt a version read or a registry query, orphaning nothing, but an
  # install killed halfway leaves NO claude where letting it be is merely stale.
  $installBudget = Get-IntEnv $env:TURMA_NPM_INSTALL_TIMEOUT 300
  $deadline = Get-IntEnv $env:TURMA_CLAUDE_UPDATE_TIMEOUT 1800
  $min = [int]($installBudget * 5 / 2)
  if ($deadline -lt $min) {
    Log "[turma-agent] TURMA_CLAUDE_UPDATE_TIMEOUT=${deadline}s could fire mid-install; using ${min}s"
    $deadline = $min
  }
  Log "[turma-agent] checking Claude Code before any session can launch (bounded at ${deadline}s)"
  try {
    $c = Start-Process -FilePath (Get-Process -Id $PID).Path `
      -ArgumentList @('-NoProfile', '-File', $Updater, '-ClaudeOnly') -PassThru -NoNewWindow
    if (-not $c.WaitForExit($deadline * 1000)) {
      Log "[turma-agent] claude update check did not finish in ${deadline}s; carrying on (a mid-install claude may briefly be missing)"
      try { $c.Kill($true) } catch { }
    }
  } catch {
    Log "[turma-agent] claude update check could not run ($_); carrying on"
  }

  # The agent self-update poller (the WinSW-has-no-timer stand-in for the systemd .timer),
  # started detached only if one is not already running for this install.
  if ((Get-UpdatePoller).Count -eq 0) {
    Log "[turma-agent] starting the auto-update poller (detached)"
    try {
      Start-Process -FilePath (Get-Process -Id $PID).Path `
        -ArgumentList @('-NoProfile', '-File', $Updater, '-Loop') | Out-Null
    } catch {
      Log "[turma-agent] could not start the auto-update poller ($_); carrying on"
    }
  }
}
# Placed BEFORE the credential gate: a host idling for want of a Claude login is exactly a host
# that should still be picking up new builds, and a MISSING claude is something this installs.
Invoke-UpdateChecks

# The one fatal check: Remote Control needs a subscription OAuth login. Idle rather than
# crash-loop, so the service self-heals the moment the user logs in on the host without a
# manual restart.
if (-not (Test-Path -LiteralPath $Creds)) {
  Log "=================================================================="
  Log " No Claude subscription credentials at $Creds"
  Log ""
  Log " Log in on this host:   claude /login"
  Log " (Remote Control requires a subscription OAuth login; a setup-token"
  Log "  is inference-only and can't host RC.)"
  Log ""
  Log " Idling until credentials exist..."
  Log "=================================================================="
  Enter-Idle
}

# claude is what every session execs, so its absence must be LOUD. Log-only, not idle:
# %APPDATA%\npm is on PATH above, so installing claude there heals the next launch with no
# restart.
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Log "[turma-agent] WARNING: claude not on PATH -- every session launch will fail"
  Log "[turma-agent] until it is installed. Install it with npm:"
  Log "[turma-agent]   npm install -g @anthropic-ai/claude-code"
  Log "[turma-agent] It is picked up here (%APPDATA%\npm is on PATH) with no restart needed."
}

# --- reap any prior tunnel, then start ours -------------------------------------------
# Kill a prior supervisor + tunnel first, so each (re)start replaces the tunnel with the
# current code and never leaves a duplicate (the service supervises only THIS process; a
# prior tunnel can outlive a manager restart). The SUPERVISOR goes first and the tunnel
# second: the reverse order lets the old supervisor respawn the tunnel we just killed.
# Matching is on the command line and prefix-scoped (like the bash pkill keys), so a
# second install only ever reaps its own. Get-Process exposes CommandLine on both Windows
# and Linux in PowerShell 7, so this is the same code the tests drive.
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
Stop-ByCommandLine @($SelfPath, '-TunnelSupervisor')   # supervisor FIRST
Stop-ByCommandLine @($Tunnel)                          # then the tunnel

$PwshExe = (Get-Process -Id $PID).Path

# Start the manager and learn its pid, then export it BEFORE backgrounding the supervisor
# so the tunnel (the supervisor's child) inherits the right TURMA_MANAGER_PID for its
# heartbeat poke. This reorders the bash sequence slightly -- bash names $$ up front
# because `exec` preserves it, which has no Windows analog -- but the invariant the poke
# depends on (the tunnel targets the live manager) holds. -NoNewWindow keeps the manager's
# output on the launcher's stdout so the service log captures it.
#
# If the manager cannot start at all (python genuinely absent from PATH), IDLE rather than
# exit -- an exit here reads to the service manager as a crash-loop worth restarting every
# few seconds, the exact failure this launcher exists to avoid, and reading $mgr.Id on an
# unset $mgr would abort under StrictMode. Idling BEFORE the supervisor is started also
# means no orphaned tunnel pointing at a hub with no manager. Self-heals when python
# appears (a restart relaunches this whole path); %APPDATA%\npm etc. are already on PATH.
$mgr = $null
try {
  $mgr = Start-Process -FilePath 'python' -ArgumentList @("`"$Manager`"") -NoNewWindow -PassThru
}
catch { $mgr = $null }
if (-not $mgr) {
  Log "[turma-agent] could not start the session manager (is python on PATH? see the installer)."
  Log "[turma-agent] Idling rather than crash-looping; a restart retries once python is present."
  Enter-Idle
}
$env:TURMA_MANAGER_PID = $mgr.Id

Start-Process -FilePath $PwshExe `
  -ArgumentList @('-NoProfile', '-File', $SelfPath, '-TunnelSupervisor') | Out-Null

Log "[turma-agent] starting session manager (REPOS_ROOT=$($env:REPOS_ROOT) DEVICE_NAME=$($env:DEVICE_NAME))"
$mgr.WaitForExit()
exit $mgr.ExitCode
