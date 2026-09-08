#!/usr/bin/env pwsh
# Behavioural tests for the native WINDOWS launcher (agent/native/windows/turma-agent.ps1).
#
# The port of test_turma_agent.sh: it pins the same launcher decisions, none of which
# PSScriptAnalyzer can see (it checks PowerShell correctness, not what the script does):
#   1. the reverse-tunnel supervisor respawns a tunnel that exits,
#   2. a missing node is SURVIVED and HEALED when node appears (no restart),
#   3. the run path exports the manager pid the tunnel's poke targets,
#   4. a re-launch replaces the supervisor rather than duplicating it,
#   5. an invalid config line is reported (names + line numbers, no values) and IDLED on,
#   6. -Preflight reports the same fault but never hangs,
#   7. a valid config still loads (export + quoted values),
#   8. the service PATH reaches claude at %APPDATA%\npm,
#   9. a genuinely missing claude is a loud warning, not a silent failure,
#  10. USERPROFILE unset (service context) does not kill the launcher.
#
# Like the bash suite, the REAL launcher runs with only what it hands off stubbed
# (node, the tunnel, python/hub-agent.py, claude). It is a PowerShell-on-POSIX harness
# (the launcher logic is OS-agnostic PowerShell; the stubs are /bin/sh), run on the same
# ubuntu-latest runner the bash launcher tests use — WinSW / ConPTY / a real Windows
# service are host-verified by later epic children, exactly as the bash suite leaves
# systemd to a real host.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Here      = Split-Path -Parent $PSCommandPath
$WinDir    = Join-Path (Split-Path -Parent $Here) 'native/windows'
$Launcher  = Join-Path $WinDir 'turma-agent.ps1'
$Work      = Join-Path ([System.IO.Path]::GetTempPath()) ("turma-ps1-" + [guid]::NewGuid().ToString('N'))
$Script:Failed = 0
# Keep the Process OBJECTS (not just pids) of every redirected child: a Start-Process with
# -RedirectStandardOutput spins up async stream readers, and if the process is killed and
# the object disposed (or GC'd) while a reader is mid-flush, .NET throws
# ObjectDisposedException on a background thread and crashes pwsh at exit. Cleanup drains
# each (Kill → WaitForExit → Dispose) so the readers finish against a live writer first.
$Script:Procs = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

function Ok([string]$m)   { [Console]::Out.WriteLine("  ok: $m") }
function Fail([string]$m) { [Console]::Out.WriteLine("  FAIL: $m"); $Script:Failed = 1 }
function Note([string]$m) { [Console]::Out.WriteLine($m) }

# The current pwsh, used to launch the script under test.
$PwshExe = (Get-Process -Id $PID).Path

# --- fixture: a PREFIX laid out the way the installer lays one out --------------------
$Prefix   = Join-Path $Work 'prefix'
$Bin      = Join-Path $Prefix 'bin'
$StubBin  = Join-Path $Work 'stub-bin'
$Home_    = Join-Path $Work 'home'
$AppData  = Join-Path $Home_ 'AppData\Roaming'
$NpmBin   = Join-Path $AppData 'npm'
New-Item -ItemType Directory -Force -Path $Bin, $StubBin, (Join-Path $Home_ '.claude'), $NpmBin, (Join-Path $Home_ 'git') | Out-Null

Copy-Item $Launcher (Join-Path $Bin 'turma-agent.ps1')
$LauncherPath = Join-Path $Bin 'turma-agent.ps1'

# Stub tunnel entrypoint (node is what runs it; the stub records each start then exits, so
# the supervisor's respawn is observable, and records the manager pid it inherited so the
# poke-target invariant can be checked).
Set-Content -Path (Join-Path $Prefix 'tunnel-agent.js') -Value '// stub tunnel' -NoNewline

$TunnelLog  = Join-Path $Work 'tunnel.log'
$ManagerLog = Join-Path $Work 'manager.log'

# Write a /bin/sh stub with LF endings and mark it executable.
function New-ShStub([string]$Path, [string]$Body) {
  $text = "#!/bin/sh`n" + ($Body -replace "`r`n", "`n")
  [System.IO.File]::WriteAllText($Path, $text)
  & chmod +x $Path
}

New-ShStub (Join-Path $StubBin 'node') @"
echo "tunnel-start mgrpid=`${TURMA_MANAGER_PID:-unset}" >> "$TunnelLog"
exit 0
"@

# Stands in for the session manager. Records the pid the tunnel would poke (its own `$$`,
# which Start-Process reports as the launched pid) and where claude resolves on the PATH
# it inherited (what every session launch uses), then blocks so the launcher stays alive
# for inspection.
New-ShStub (Join-Path $StubBin 'python') @"
echo "mgrpid=`$`$" > "$ManagerLog"
echo "claude=`$(command -v claude || echo missing)" >> "$ManagerLog"
sleep 30
"@

function Cleanup {
  # Reap any supervisor/tunnel/manager the cases left running, by command line.
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $cl = $null; try { $cl = $_.CommandLine } catch { }
    $cl -and ($cl.Contains($LauncherPath) -or $cl.Contains((Join-Path $Prefix 'tunnel-agent.js')))
  } | ForEach-Object { try { $_.Kill() } catch { } }
  # Drain each redirected child before the harness exits: Kill, wait for it to actually
  # exit (so its async output readers flush against a still-open writer), then Dispose —
  # skipping this lets .NET crash pwsh with ObjectDisposedException on a reader thread.
  foreach ($p in $Script:Procs) {
    try { if (-not $p.HasExited) { $p.Kill() } } catch { }
    try { $null = $p.WaitForExit(3000) } catch { }
    try { $p.Dispose() } catch { }
  }
  if (Test-Path $Work) { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }
}

# Poll a predicate up to ~ (Tries * 0.1)s rather than sleeping a fixed guess.
function Wait-For([scriptblock]$Cond, [int]$Tries = 60) {
  for ($i = 0; $i -lt $Tries; $i++) {
    if (& $Cond) { return $true }
    Start-Sleep -Milliseconds 100
  }
  return $false
}

function Count-TunnelStarts {
  if (Test-Path $TunnelLog) { @(Get-Content $TunnelLog).Count } else { 0 }
}
function Count-Supervisors {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $cl = $null; try { $cl = $_.CommandLine } catch { }
      $cl -and $cl.Contains($LauncherPath) -and $cl.Contains('-TunnelSupervisor')
    }).Count
}
function Stop-Supervisors {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $cl = $null; try { $cl = $_.CommandLine } catch { }
    $cl -and $cl.Contains($LauncherPath) -and $cl.Contains('-TunnelSupervisor')
  } | ForEach-Object { try { $_.Kill() } catch { } }
}
# Kill EVERY launcher/supervisor this suite spawned and WAIT until none remain. A supervisor
# is backgrounded a beat after its launcher boots, so a fire-and-forget kill can race and
# leak one into the next case (which then miscounts). Killing all $LauncherPath processes
# converges — a killed launcher's manager stub never respawns a supervisor. Used to give the
# supervisor-counting cases (4/5/11) a deterministic clean slate on a loaded CI runner.
function Reset-Launchers {
  for ($i = 0; $i -lt 40; $i++) {
    $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $cl = $null; try { $cl = $_.CommandLine } catch { }
        $cl -and $cl.Contains($LauncherPath)
      })
    if ($procs.Count -eq 0) { return }
    foreach ($p in $procs) { try { $p.Kill() } catch { } }
    Start-Sleep -Milliseconds 150
  }
}

# Start the launcher (or a re-entry mode) as a child pwsh, inheriting the case's env, with
# its combined stdout+stderr captured to $OutFile. The redirection is done by /bin/sh at
# the OS level (`exec pwsh ... > file 2>&1`), NOT by Start-Process's -RedirectStandard*
# — the latter spins up async stream readers that crash pwsh with ObjectDisposedException
# when a long-lived child is killed (which several cases do). `exec` means the returned pid
# IS the pwsh, so HasExited / ExitCode / WaitForExit are the launcher's.
function Start-Launcher([string[]]$ExtraArgs, [string]$OutFile) {
  $extra = ($ExtraArgs -join ' ')
  $cmd = "exec `"$PwshExe`" -NoProfile -File `"$LauncherPath`" $extra > `"$OutFile`" 2>&1"
  # [Process]::Start with ArgumentList passes each element as a DISTINCT argv (no
  # space-resplitting, unlike Start-Process -ArgumentList), so /bin/sh gets `-c` and the
  # whole command string intact. UseShellExecute=$false inherits the case's $env:* and
  # does no parent-side stream redirection, so there are no async readers to crash.
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = '/bin/sh'
  $psi.ArgumentList.Add('-c')
  $psi.ArgumentList.Add($cmd)
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $Script:Procs.Add($p)
  return $p
}

function Set-BaseEnv {
  $env:USERPROFILE      = $Home_
  $env:APPDATA          = $AppData
  $env:COMPUTERNAME     = 'TESTBOX'
  $env:TUNNEL_RETRY_SEC = '1'
  $env:REPOS_ROOT       = Join-Path $Home_ 'git'
  # A curated PATH shaped like a service's: the stubs, plus the minimum the launcher and
  # its helpers need, and NO claude (the host's own must not satisfy the lookup).
  $env:PATH = @($StubBin, '/usr/bin', '/bin') -join ':'
  Remove-Item env:TURMA_MANAGER_PID -ErrorAction SilentlyContinue
}

try {
  # The launcher's one fatal check — without this it idles instead of running.
  Set-Content -Path (Join-Path $Home_ '.claude/.credentials.json') -Value '{}'

  $goodCfg = Join-Path $Work 'agent.env'
  Set-Content -Path $goodCfg -Value "TURMA_URL=https://hub.invalid`nTURMA_TOKEN=t`n"

  # --- Case 1: the supervisor respawns a tunnel that exits ----------------------------
  Note "case: supervisor respawns the tunnel"
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $goodCfg
  Remove-Item $TunnelLog -ErrorAction SilentlyContinue
  Start-Launcher @('-TunnelSupervisor') (Join-Path $Work 'sup.log') | Out-Null
  if (Wait-For { (Count-TunnelStarts) -ge 2 }) { Ok "tunnel restarted after it exited ($(Count-TunnelStarts) starts)" }
  else { Fail "tunnel was not respawned (starts=$(Count-TunnelStarts)); see $Work/sup.log" }
  if (Wait-For { (Test-Path (Join-Path $Work 'sup.log')) -and (Select-String -Quiet 'tunnel exited' (Join-Path $Work 'sup.log')) }) { Ok "logged the exit" }
  else { Fail "no exit logged: $(Get-Content (Join-Path $Work 'sup.log') -Raw -ErrorAction SilentlyContinue)" }
  Stop-Supervisors

  # --- Case 2: node missing is survived, then HEALED when node appears -----------------
  Note "case: node missing — survives, then heals when node appears"
  Remove-Item $TunnelLog -ErrorAction SilentlyContinue
  # A PATH with the launcher's needs but NO node. %APPDATA%\npm (which the launcher
  # prepends) must not hold one either.
  $noNodeBin = Join-Path $Work 'nonode-bin'
  New-Item -ItemType Directory -Force -Path $noNodeBin | Out-Null
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $goodCfg
  $env:PATH = @($noNodeBin, '/usr/bin', '/bin') -join ':'
  $sup2 = Start-Launcher @('-TunnelSupervisor') (Join-Path $Work 'sup2.log')
  if (Wait-For { (Test-Path (Join-Path $Work 'sup2.log')) -and (Select-String -Quiet 'node not on PATH' (Join-Path $Work 'sup2.log')) }) { Ok "said why the terminals are offline" }
  else { Fail "no node guidance logged: $(Get-Content (Join-Path $Work 'sup2.log') -Raw -ErrorAction SilentlyContinue)" }
  if (-not $sup2.HasExited) { Ok "supervisor survived the missing runtime" }
  else { Fail "supervisor died on missing node — the failure would be permanent again" }
  # node arrives (operator installs it) — no restart of anything.
  Copy-Item (Join-Path $StubBin 'node') (Join-Path $noNodeBin 'node')
  if (Wait-For { (Count-TunnelStarts) -ge 1 }) { Ok "healed without a restart once node existed" }
  else { Fail "tunnel never started after node appeared" }
  Stop-Supervisors

  # --- Case 3: the run path names the manager pid and starts one supervisor ------------
  Note "case: run path exports the manager pid and supervises the tunnel"
  Remove-Item $TunnelLog, $ManagerLog -ErrorAction SilentlyContinue
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $goodCfg
  Start-Launcher @() (Join-Path $Work 'run.log') | Out-Null
  if (Wait-For { (Test-Path $ManagerLog) -and ((Get-Item $ManagerLog).Length -gt 0) }) {
    if (Wait-For { (Count-TunnelStarts) -ge 1 }) {
      $mgrpid  = (Select-String -Path $ManagerLog -Pattern 'mgrpid=(\d+)').Matches[0].Groups[1].Value
      $tunpid  = (Select-String -Path $TunnelLog  -Pattern 'mgrpid=(\d+)').Matches[0].Groups[1].Value
      if ($mgrpid -and $mgrpid -eq $tunpid) { Ok "TURMA_MANAGER_PID ($tunpid) is the manager's own pid — the poke can land" }
      else { Fail "manager pid mismatch: manager=$mgrpid tunnel-saw=$tunpid (poke would mis-signal)" }
    }
    else { Fail "run path started no tunnel: $(Get-Content (Join-Path $Work 'run.log') -Raw -ErrorAction SilentlyContinue)" }
  }
  else { Fail "manager never started: $(Get-Content (Join-Path $Work 'run.log') -Raw -ErrorAction SilentlyContinue)" }

  # --- Case 4: a re-run replaces the supervisor rather than duplicating it -------------
  Note "case: a second launch leaves exactly one supervisor"
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $goodCfg
  Start-Launcher @() (Join-Path $Work 'run2.log') | Out-Null
  # The second launch REAPS the prior supervisor before backgrounding its own, so the count
  # transiently passes through 0 (old gone, new not yet up) — a fixed `Wait-For{>=1}; sleep;
  # count` raced that gap and read 0 on a loaded CI runner. Wait until it SETTLES at exactly
  # one (through the 0), then settle briefly and confirm it is STILL one — which still catches
  # the real bug this guards (a duplicate supervisor persists at 2, never settling to 1).
  $settled = Wait-For { (Count-Supervisors) -eq 1 }
  Start-Sleep -Milliseconds 500
  $n = Count-Supervisors
  if ($settled -and $n -eq 1) { Ok "exactly one supervisor after a restart" }
  else { Fail "expected 1 supervisor, found $n (a duplicate tunnel fights for the channel)" }
  Reset-Launchers

  # --- Case 5: a non-assignment config line idles, does NOT crash-loop -----------------
  Note "case: an invalid config line is reported and idled on"
  $badCfg = Join-Path $Work 'bad.env'
  Set-Content -Path $badCfg -Value @"
# a comment, and a blank line, are both fine

TURMA_URL=https://hub.invalid
JIRA_SITE: "xerktech.atlassian.net"
JIRA_TOKEN: "ATATT3xFf-s3cret-whose-value-contains=an-equals-sign"
"@
  Remove-Item $ManagerLog -ErrorAction SilentlyContinue
  Reset-Launchers   # deterministic clean slate: no leftover supervisor from a prior case
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $badCfg
  $bad = Start-Launcher @() (Join-Path $Work 'bad.log')
  $badLog = Join-Path $Work 'bad.log'
  if (Wait-For { (Test-Path $badLog) -and (Select-String -Quiet 'Invalid line' $badLog) }) { Ok "named the file as the problem" }
  else { Fail "no invalid-config report: $(Get-Content $badLog -Raw -ErrorAction SilentlyContinue)" }
  # Both offending lines, by number — including the one whose VALUE holds an `=`. Wait for
  # the LAST-written of the two (line 5) so the whole banner has flushed through the OS
  # redirect before asserting.
  if ((Wait-For { (Select-String -Quiet 'line 5: JIRA_TOKEN' $badLog) }) -and (Select-String -Quiet 'line 4: JIRA_SITE' $badLog)) { Ok "named both bad lines with their line numbers" }
  else { Fail "did not report both bad lines: $(Get-Content $badLog -Raw -ErrorAction SilentlyContinue)" }
  # This banner goes to the service log; the config is ACL'd and holds tokens.
  if (Select-String -Quiet 's3cret' $badLog) { Fail "the invalid-config report leaked a token value into the log" }
  else { Ok "reported the bad lines without echoing their values" }
  Start-Sleep -Seconds 1
  if (-not $bad.HasExited) { Ok "idled instead of exiting — the service has nothing to restart-loop" }
  else { Fail "launcher exited on a bad config; auto-restart would loop it forever" }
  if ((Count-Supervisors) -eq 0) { Ok "started no tunnel against a config it never loaded" }
  else { Fail "a supervisor was started despite the config being rejected" }
  if (-not (Test-Path $ManagerLog)) { Ok "started no manager either" }
  else { Fail "the manager was started with a config that never loaded" }
  try { Stop-Process -Id $bad.Id -Force } catch { }

  # --- Case 6: -Preflight reports the same fault but never hangs ------------------------
  Note "case: -Preflight reports an invalid config and exits nonzero"
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $badCfg
  $pre = Start-Launcher @('-Preflight') (Join-Path $Work 'pre.log')
  if (Wait-For { $pre.HasExited } 100) {
    if ($pre.ExitCode -eq 1) { Ok "exited 1 rather than idling" }
    else { Fail "expected exit 1, got $($pre.ExitCode): $(Get-Content (Join-Path $Work 'pre.log') -Raw -ErrorAction SilentlyContinue)" }
  }
  else { Fail "-Preflight hung on a bad config — the installer --verify would never return"; try { Stop-Process -Id $pre.Id -Force } catch { } }

  # --- Case 7: a valid config still loads, quotes/export and all -----------------------
  Note "case: a valid config is unaffected"
  $exportCfg = Join-Path $Work 'good2.env'
  Set-Content -Path $exportCfg -Value "TURMA_URL=https://hub.invalid`nexport TURMA_TOKEN=`"t`"`nMAX_SESSIONS=6`n"
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $exportCfg
  $pre2 = Start-Launcher @('-Preflight') (Join-Path $Work 'pre2.log')
  if (Wait-For { $pre2.HasExited } 100) {
    if ($pre2.ExitCode -eq 0) { Ok "a plain KEY=value config (with an export/quoted line) still passes" }
    else { Fail "valid config rejected (rc=$($pre2.ExitCode)): $(Get-Content (Join-Path $Work 'pre2.log') -Raw -ErrorAction SilentlyContinue)" }
  }
  else { Fail "-Preflight hung on a valid config"; try { Stop-Process -Id $pre2.Id -Force } catch { } }

  # --- Case 8: the service PATH reaches claude at %APPDATA%\npm ------------------------
  Note "case: launcher puts %APPDATA%\npm on the runtime PATH"
  # claude where npm installs it globally on Windows; the curated PATH has none.
  New-ShStub (Join-Path $NpmBin 'claude') "exit 0"
  Remove-Item $ManagerLog -ErrorAction SilentlyContinue
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $goodCfg
  Start-Launcher @() (Join-Path $Work 'run3.log') | Out-Null
  if (Wait-For { (Test-Path $ManagerLog) -and (Select-String -Quiet 'claude=' $ManagerLog) }) {
    $resolved = (Select-String -Path $ManagerLog -Pattern '^claude=(.*)$').Matches[0].Groups[1].Value
    if ($resolved -eq (Join-Path $NpmBin 'claude')) { Ok "manager resolves claude at %APPDATA%\npm despite a bare service PATH" }
    else { Fail "claude resolved to '$resolved' — sessions would die with ENOENT: 'claude'" }
  }
  else { Fail "manager never started under the curated PATH: $(Get-Content (Join-Path $Work 'run3.log') -Raw -ErrorAction SilentlyContinue)" }
  if (Select-String -Quiet 'claude not on PATH' (Join-Path $Work 'run3.log')) { Fail "warned about a claude it can actually reach" }
  else { Ok "no spurious warning when claude is reachable" }
  Reset-Launchers

  # --- Case 9: a genuinely missing claude is warned about, loudly ----------------------
  Note "case: missing claude is a loud warning, not a silent failure"
  Remove-Item (Join-Path $NpmBin 'claude'), $ManagerLog -ErrorAction SilentlyContinue
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $goodCfg
  Start-Launcher @() (Join-Path $Work 'run4.log') | Out-Null
  if (Wait-For { (Test-Path (Join-Path $Work 'run4.log')) -and (Select-String -Quiet 'claude not on PATH' (Join-Path $Work 'run4.log')) }) { Ok "said sessions will fail and how to fix it" }
  else { Fail "no claude warning — the failure would be silent again: $(Get-Content (Join-Path $Work 'run4.log') -Raw -ErrorAction SilentlyContinue)" }
  if (Wait-For { (Test-Path $ManagerLog) -and ((Get-Item $ManagerLog).Length -gt 0) }) { Ok "manager still started (log-only, self-heals when claude appears)" }
  else { Fail "launcher refused to start over a missing claude" }
  Reset-Launchers

  # --- Case 10: USERPROFILE unset (service context) does not kill the launcher ---------
  # The Windows twin of the bash "HOME unset" trap: a Session-0 service can be launched
  # without USERPROFILE, and StrictMode would abort on the first read. The launcher must
  # derive one and carry on.
  Note "case: USERPROFILE unset (service context) does not kill the launcher"
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $goodCfg
  Remove-Item env:USERPROFILE -ErrorAction SilentlyContinue
  $pre3 = Start-Launcher @('-Preflight') (Join-Path $Work 'pre3.log')
  $ok = Wait-For { $pre3.HasExited } 100
  $out = if (Test-Path (Join-Path $Work 'pre3.log')) { Get-Content (Join-Path $Work 'pre3.log') -Raw } else { '' }
  if (-not $ok) { Fail "-Preflight hung with USERPROFILE unset"; try { Stop-Process -Id $pre3.Id -Force } catch { } }
  elseif ($out -match 'unbound|StrictMode|not been set') { Fail "launcher still dies with USERPROFILE unset: $out" }
  elseif ($out -match 'USERPROFILE was unset') { Ok "derived a USERPROFILE and said so" }
  else { Fail "expected a USERPROFILE-was-unset notice, got: $out" }
  if ($out -match 'preflight') { Ok "carried on into preflight rather than aborting" }
  else { Fail "launcher did not reach preflight with USERPROFILE unset: $out" }

  # --- Case 11: the manager failing to start IDLES, and orphans no supervisor ----------
  # If python is genuinely absent from PATH, Start-Process fails and $mgr is never set.
  # The launcher must IDLE (an exit reads as crash-loop to the service manager, the very
  # failure this launcher exists to avoid) and must NOT have backgrounded a supervisor
  # pointing at a hub with no manager. (A QA-found edge; the earlier code read $mgr.Id on
  # an unset $mgr under StrictMode and exited.)
  Note "case: a manager that cannot start idles instead of crash-looping"
  $noPyBin = Join-Path $Work 'nopy-bin'
  New-Item -ItemType Directory -Force -Path $noPyBin | Out-Null
  Copy-Item (Join-Path $StubBin 'node') (Join-Path $noPyBin 'node')   # node present, python absent
  Remove-Item $ManagerLog -ErrorAction SilentlyContinue
  Reset-Launchers   # deterministic clean slate before asserting NO supervisor
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $goodCfg
  # Deliberately NO python anywhere on PATH (this host has a real /usr/bin/python, so the
  # PATH is scoped to the node-only dir; the run path reaches manager-start with no other
  # external binary needed).
  $env:PATH = $noPyBin
  $noPy = Start-Launcher @() (Join-Path $Work 'run5.log')
  if (Wait-For { (Test-Path (Join-Path $Work 'run5.log')) -and (Select-String -Quiet 'could not start the session manager' (Join-Path $Work 'run5.log')) }) { Ok "said why the manager did not start" }
  else { Fail "no manager-start-failure notice: $(Get-Content (Join-Path $Work 'run5.log') -Raw -ErrorAction SilentlyContinue)" }
  Start-Sleep -Seconds 1
  if (-not $noPy.HasExited) { Ok "idled instead of exiting on a manager that could not start" }
  else { Fail "launcher exited (rc=$($noPy.ExitCode)) when the manager could not start — a crash loop" }
  if ((Count-Supervisors) -eq 0) { Ok "started no tunnel supervisor to orphan" }
  else { Fail "orphaned a tunnel supervisor pointing at a hub with no manager" }
  if (-not (Test-Path $ManagerLog)) { Ok "no manager ran (python was absent)" }
  else { Fail "a manager log appeared despite python being absent" }
  try { Stop-Process -Id $noPy.Id -Force } catch { }
  Stop-Supervisors

  # --- XERK-578 token self-enroll (XERK-675, the Windows launcher half) ----------------
  # A dedicated bin whose `python` stub stands in for BOTH hub-agent.py entrypoints: on
  # `--enroll` it emulates a successful enroll_self (rewrite TURMA_TOKEN in $TURMA_AGENT_ENV
  # to a derived token, exit $ENROLL_RC — the real one verifies the name half and writes
  # atomically); with no --enroll it is the manager, recording the TURMA_TOKEN it inherited.
  # The manager's recorded token is the round-trip's observable: it is the derived token iff
  # the launcher enrolled AND re-read TURMA_TOKEN from the rolled file into the env the
  # manager inherits.
  Set-BaseEnv   # restore a PATH with chmod on it (case 11 scoped PATH to a node-only dir)
  $enrollBin = Join-Path $Work 'enroll-bin'
  New-Item -ItemType Directory -Force -Path $enrollBin | Out-Null
  Copy-Item (Join-Path $StubBin 'node') (Join-Path $enrollBin 'node')
  $EnrollLog = Join-Path $Work 'enroll.log'
  New-ShStub (Join-Path $enrollBin 'python') @"
case "`$*" in
  *--enroll*)
    echo "enroll-called rc=`${ENROLL_RC:-0}" >> "$EnrollLog"
    rc="`${ENROLL_RC:-0}"
    if [ "`$rc" = 0 ]; then
      tmp="`$TURMA_AGENT_ENV.tmp"
      grep -v -E '^[[:space:]]*(export[[:space:]]+)?TURMA_TOKEN=' "`$TURMA_AGENT_ENV" > "`$tmp" 2>/dev/null || true
      printf 'TURMA_TOKEN=%s\n' "`${DERIVED_TOKEN}" >> "`$tmp"
      mv "`$tmp" "`$TURMA_AGENT_ENV"
    fi
    exit "`$rc"
    ;;
  *)
    echo "token=`${TURMA_TOKEN:-unset}" > "$ManagerLog"
    sleep 30
    ;;
esac
"@

  # Helper: run the launcher against a fresh copy of $goodCfg with the enroll bin on PATH,
  # returning the token the manager recorded (or '' if it never started).
  function Invoke-EnrollCase([hashtable]$Env) {
    Reset-Launchers
    Remove-Item $ManagerLog, $EnrollLog -ErrorAction SilentlyContinue
    $cfg = Join-Path $Work 'enroll.env'
    Set-Content -Path $cfg -Value "TURMA_URL=https://hub.invalid`nTURMA_TOKEN=master-shared`n"
    Set-BaseEnv
    $env:TURMA_AGENT_ENV = $cfg
    $env:PATH = @($enrollBin, '/usr/bin', '/bin') -join ':'
    $env:DERIVED_TOKEN = 'VEVTVEJPWA.deadbeef'   # name half decodes to TESTBOX
    Remove-Item env:TURMA_AGENT_SELF_ENROLL, env:ENROLL_RC -ErrorAction SilentlyContinue
    foreach ($k in $Env.Keys) { Set-Item -Path "env:$k" -Value $Env[$k] }
    Start-Launcher @() (Join-Path $Work 'enroll-run.log') | Out-Null
    $started = Wait-For { (Test-Path $ManagerLog) -and ((Get-Item $ManagerLog).Length -gt 0) }
    $tok = if ($started) { (Select-String -Path $ManagerLog -Pattern '^token=(.*)$').Matches[0].Groups[1].Value } else { '' }
    Reset-Launchers
    return $tok
  }

  # --- Case 12: opted in + hub succeeds → the manager runs on the DERIVED token ---------
  Note "case: self-enroll rolls the host onto its derived token"
  $tok = Invoke-EnrollCase @{ TURMA_AGENT_SELF_ENROLL = '1' }
  if (Test-Path $EnrollLog) { Ok "ran hub-agent.py --enroll on start" }
  else { Fail "self-enroll never invoked --enroll: $(Get-Content (Join-Path $Work 'enroll-run.log') -Raw -ErrorAction SilentlyContinue)" }
  if ($tok -eq 'VEVTVEJPWA.deadbeef') { Ok "manager re-authenticated on the derived token (re-read from the rolled file)" }
  else { Fail "manager ran on '$tok', not the derived token — the roll did not take effect" }

  # --- Case 13: NOT opted in (default) → no enroll, master token untouched --------------
  Note "case: self-enroll is off by default — no enroll, current token kept"
  $tok = Invoke-EnrollCase @{ }
  if (-not (Test-Path $EnrollLog)) { Ok "did not touch --enroll when TURMA_AGENT_SELF_ENROLL is unset" }
  else { Fail "enrolled without opt-in" }
  if ($tok -eq 'master-shared') { Ok "manager stayed on the existing token" }
  else { Fail "token changed to '$tok' without opt-in" }

  # --- Case 14: opted in but hub too old (exit 2) → soft skip, stay on current token ----
  Note "case: a hub too old to enroll (exit 2) is a soft skip, not a failed start"
  $tok = Invoke-EnrollCase @{ TURMA_AGENT_SELF_ENROLL = 'yes'; ENROLL_RC = '2' }
  if (Test-Path $EnrollLog) { Ok "attempted --enroll (truthy 'yes' opted in)" }
  else { Fail "did not attempt --enroll for a truthy opt-in" }
  if ($tok -eq 'master-shared') { Ok "stayed on the current token and still started (soft skip)" }
  else { Fail "exit 2 did not stay on the current token (got '$tok') — a soft skip must not roll or block" }

  # --- Case 15: the auto-update poller starts; the empty-poller check does not crash -----
  # (XERK-700) Invoke-UpdateChecks decides whether to start the detached -Loop poller with
  # `if (@(Get-UpdatePoller).Count -eq 0)`. On the normal FIRST start no poller is running, so
  # Get-UpdatePoller returns an empty array — and a PARENTHESISED call to a function that emits
  # `@()` collapses to $null, so the pre-fix `(Get-UpdatePoller).Count` threw PropertyNotFound
  # under StrictMode and the poller was silently never started (auto-update dead on the host).
  # Wrapping the call in @() makes the empty case a real 0-count. The fixture deliberately omits
  # the updater (so every earlier case's Invoke-UpdateChecks short-circuits on Test-Path $Updater,
  # which is why this went uncaught), so lay a stub updater here and assert the -Loop poller is
  # actually started and not duplicated on a second launch. (Get-ProcessCommandLine's Windows CIM
  # enumeration — the other half of XERK-700 — is host-verified; here the Linux Get-Process
  # fallback drives the same @()/count logic.)
  Note "case: the auto-update poller is started and the empty-poller check does not crash — XERK-700"
  $UpdaterPath = Join-Path $Bin 'turma-agent-update.ps1'
  # Stub updater: -ClaudeOnly (the awaited pre-manager check) returns at once; -Loop (the poller
  # the launcher then starts detached) just sleeps so it lingers if spawned. Any other mode exits.
  Set-Content -Path $UpdaterPath -Value @'
param([switch]$ClaudeOnly, [switch]$Loop, [switch]$Boot, [switch]$LockedRun, [switch]$LockedClaude)
if ($Loop) { Start-Sleep -Seconds 300 }
exit 0
'@
  # Reap any -Loop poller this case leaves running (by the updater path in its command line);
  # Reset-Launchers only reaps $LauncherPath, and Cleanup would miss a detached poller.
  function Stop-UpdatePollers {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $cl = $null; try { $cl = $_.CommandLine } catch { }
      $cl -and $cl.Contains($UpdaterPath)
    } | ForEach-Object { try { $_.Kill() } catch { } }
  }
  Stop-UpdatePollers   # deterministic clean slate (a leftover from a prior local run)
  Reset-Launchers
  Remove-Item $ManagerLog -ErrorAction SilentlyContinue
  Set-BaseEnv
  $env:TURMA_AGENT_ENV = $goodCfg
  New-ShStub (Join-Path $NpmBin 'claude') "exit 0"   # a reachable claude so the run path proceeds
  $updRun = Join-Path $Work 'run-upd.log'
  Start-Launcher @() $updRun | Out-Null
  # The observable of the fix: Invoke-UpdateChecks reaches and EXECUTES the poller-start branch,
  # which logs this line before spawning the detached poller. Pre-fix, `(Get-UpdatePoller).Count`
  # threw on the empty poller set (a parenthesised call to a function emitting @() collapses to
  # $null), so the `if` condition errored and this branch never ran — the line never appears.
  # (Asserting the LOG line, not the detached poller PROCESS, avoids racing pwsh cold-start /
  # command-line-visibility timing on a loaded CI runner; a poll waits for the launcher's stdout
  # to flush, exactly as the run-path case above waits on its manager log.)
  if (Wait-For { (Test-Path $updRun) -and (Select-String -Quiet 'starting the auto-update poller' $updRun) }) { Ok "reached and ran the poller-start branch (the empty-poller @() count is 0, not a StrictMode throw)" }
  else { Fail "poller-start branch never ran — (Get-UpdatePoller).Count threw on the empty set (XERK-700 regression): $(Get-Content $updRun -Raw -ErrorAction SilentlyContinue)" }
  if (Wait-For { (Test-Path $ManagerLog) -and ((Get-Item $ManagerLog).Length -gt 0) }) { Ok "manager still started after the update checks" }
  else { Fail "manager never started after Invoke-UpdateChecks: $(Get-Content $updRun -Raw -ErrorAction SilentlyContinue)" }
  Stop-UpdatePollers
  Reset-Launchers
  Remove-Item $UpdaterPath -ErrorAction SilentlyContinue
}
finally {
  Cleanup
}

if ($Script:Failed -eq 0) { Note "all turma-agent (windows) launcher tests passed" }
else { Note "FAILURES" }
exit $Script:Failed
