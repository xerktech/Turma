#!/usr/bin/env pwsh
# turma-agent-update.ps1 -- self-updater for the native (no-WSL) Windows Turma agent
# (XERK-674, epic XERK-666; decisions in docs/windows-agent-adr.md, rules in
# .claude/rules/windows-launcher.md). The PowerShell port of agent/native/turma-agent-update.
#
# Updates TWO things, on DIFFERENT schedules, exactly as the bash updater does (XERK-254):
#   * The agent itself -- polls the release stream and, when a newer native build exists,
#     downloads + verifies it, swaps the runtime files into $Prefix, and restarts JUST the
#     manager (via turma-agentctl.ps1 restart, which is session-preserving: the pty-hosts
#     break away and the fresh manager re-adopts them). So an update never stops active
#     sessions. Runs on an interval (-Loop, the WinSW-has-no-timer stand-in for the systemd
#     .timer) AND on every agent start (-Boot).
#   * Claude Code (-ClaudeOnly) -- ONLY at agent start, before the manager exists. Replacing
#     the npm package leaves `claude` briefly absent from PATH, and a session launched in
#     that window dies on exec; at start nothing is launching yet. See update_claude.
#
# Entry points (mirroring the bash --flags):
#   (none)         one-shot agent self-update -- by hand, or the internal poller pass
#   -Loop          the same, on an interval (the Windows periodic poller -- no systemd timer)
#   -Boot          the same, rate-limited; fired detached by the launcher on every start
#   -ClaudeOnly    the Claude Code check, rate-limited; fired by the launcher and AWAITED,
#                  before it starts the manager
# Internal (not for humans, used by Invoke-RunLocked to bound a run under a deadline):
#   -LockedRun / -LockedClaude -- do the work directly, the lock already held by the parent.
#
# dsh is deliberately NOT carried onto Windows (no Windows dsh toolchain -- install.ps1 does
# not provision it), so there is no -DshOnly here, unlike the bash updater.
#
# Two release schemes, tried in order (same as bash):
#   1. UNIFIED (current): one `v<M>.<m>.<p>` release carries all components + a manifest.json.
#      We compare the manifest's WINDOWS agent COMPONENT version against what is installed --
#      never the release tag -- because a release can CARRY an unchanged (older) tarball while
#      its own tag moves ahead. Comparing the tag would reinstall the same bits every poll
#      and mis-stamp VERSION forever; comparing the component version makes a carried release
#      a correct no-op. The asset is downloaded by the exact name + release the manifest
#      records (a carried asset lives on an older release under an older name).
#   2. LEGACY (pre-cutover / rollback): the old per-component tag stream. Kept for parity; a
#      Windows fleet has no such legacy assets yet, so this normally finds nothing and stays
#      put -- it is the survives-the-cutover-in-either-direction path the bash updater has.
#
# The Windows manifest COMPONENT the updater reads is $ManifestComponent
# (TURMA_MANIFEST_COMPONENT, default "agent-windows" -- mirrors "agent-native"). CI packaging
# (the epic child this task BLOCKS) must emit that component with the same fields the bash one
# uses: {version, asset, sha256_asset, release_tag}, where `asset` is the Windows tarball/zip
# `turma-agent-windows-v<version>.zip` + a `.zip.sha256` sidecar. This name + component are the
# SHARED contract with the one-command installer (XERK-673, bootstrap.ps1), which resolves the
# SAME asset -- keep the three in step. Until packaging ships a component, this updater correctly
# no-ops (no component -> "up to date").
#
# Auth reuses the host's `gh` login when present (private repo, higher rate limit); falls
# back to the anonymous GitHub REST API (the repo is public) with an optional $GH_TOKEN, so
# a host with no gh login still self-updates (XERK-151). Manifest JSON is parsed with
# ConvertFrom-Json -- no python3 needed on this path.

[CmdletBinding()]
param(
  [switch]$Loop,
  [switch]$Boot,
  [switch]$ClaudeOnly,
  [int]$Interval = 0,
  # Internal re-entry points used by Invoke-RunLocked to run the work under an overall
  # deadline (XERK-549). The parent already holds the lock, so these never re-lock.
  [switch]$LockedRun,
  [switch]$LockedClaude
)

# StrictMode is the `set -u` analog. ErrorActionPreference stays 'Continue' so best-effort
# cleanup and probes never abort a run (the twin of the bash `2>/dev/null || true` this file
# leans on freely) -- the two idle/refuse cases are explicit.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# --- resolve the install prefix from our own location ($Prefix\bin\turma-agent-update.ps1) ---
$SelfPath = $PSCommandPath
$SelfDir  = Split-Path -Parent $SelfPath            # $Prefix\bin
$Prefix   = Split-Path -Parent $SelfDir             # $Prefix
$PwshExe  = (Get-Process -Id $PID).Path

# bash `${x:-default}`: first non-empty wins; '' and $null are both "unset".
function Coalesce {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Values)
  foreach ($v in $Values) { if ($v) { return $v } }
  return ''
}

# USERPROFILE is the $HOME analog every per-user path hangs off; a Session-0 / SYSTEM service
# can be launched without it (the Windows twin of the bash "HOME unset" trap), so derive it
# rather than fail under StrictMode -- the same guard the launcher/ctl/installer make.
if (-not $env:USERPROFILE) {
  $up = [Environment]::GetFolderPath('UserProfile')
  if (-not $up) {
    $up = if ($env:HOMEDRIVE -and $env:HOMEPATH) { "$env:HOMEDRIVE$env:HOMEPATH" }
          else { Join-Path (Coalesce $env:SystemDrive 'C:') 'Users\Default' }
  }
  $env:USERPROFILE = $up
}

$TurmaDir = Join-Path $env:USERPROFILE '.turma'
New-Item -ItemType Directory -Force -Path $TurmaDir -ErrorAction SilentlyContinue | Out-Null

$Repo             = Coalesce $env:TURMA_REPO 'xerktech/turma'
$ManifestComponent = Coalesce $env:TURMA_MANIFEST_COMPONENT 'agent-windows'
$LegacyTagPrefix  = Coalesce $env:TURMA_LEGACY_TAG_PREFIX 'agent-windows-v'

# num(): a plausible whole number of seconds within [1, cap], else the default -- the bash
# num() discipline. 0 is read as "use the default" (it disables a timeout in bash). Applied
# wherever a knob reaches an arithmetic/deadline so one config typo cannot disable a check.
function Get-Num([string]$Value, [int]$Default, [int]$Cap = 86400) {
  if (-not $Value) { return $Default }
  if ($Value -notmatch '^\d+$') { return $Default }
  $v = $Value.TrimStart('0'); if (-not $v) { return $Default }   # all-zero -> default
  if ($v.Length -le 6) { $n = [int]$v; if ($n -le $Cap) { return $n } }
  return $Default
}

$IntervalSec       = if ($Interval -gt 0) { $Interval } else { Get-Num $env:TURMA_UPDATE_INTERVAL 3600 }
$RunDeadline       = Get-Num $env:TURMA_RUN_DEADLINE 900          # overall bound on ONE agent self-update run
$LockReclaimAfter  = Get-Num $env:TURMA_LOCK_RECLAIM_AFTER 7200 604800  # a lock held this long is presumed wedged
$StrandWarnAt      = Get-Num $env:TURMA_UPDATE_STRAND_WARN_AT 3
$PollRetrySec      = Get-Num $env:TURMA_POLL_RETRY_SEC 60
$BootMinInterval   = Get-Num $env:TURMA_BOOT_UPDATE_MIN_INTERVAL 300
$ClaudePkg         = '@anthropic-ai/claude-code'

# --- per-install-scoped state files (XERK-551) ----------------------------------------------
# A short, stable token derived from THIS install's $Prefix, so the lock / holder / throttle
# stamps / skip counter are SCOPED to the install that owns them. Keyed off $HOME instead (as
# the bash bug had it) EVERY updater under one user shared one lock regardless of prefix, so a
# leaked/staged poller could hold or fight over it and starve the real poller forever. Derived
# from the resolved full path, exactly as the script derives $Prefix from its own location.
function Get-PrefixTag {
  $full = $Prefix
  try { $full = (Resolve-Path -LiteralPath $Prefix -ErrorAction Stop).Path } catch { }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($full))
  } finally { $sha.Dispose() }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
}
$PrefixTag = Get-PrefixTag

# The LOG is per-USER (the identity the SESSIONS run as writes it), so distinct installs share
# it -- but each line is tagged with $Prefix so concurrent updaters are distinguishable rather
# than reading as unattributable duplicates.
$Log             = Join-Path $TurmaDir 'update.log'
$Lock            = Join-Path $TurmaDir "update.$PrefixTag.lock"
$LockHolder      = Join-Path $TurmaDir "update.$PrefixTag.lock.holder"
$Stamp           = Join-Path $TurmaDir "last-update-check.$PrefixTag"
$ClaudeStamp     = Join-Path $TurmaDir "last-claude-check.$PrefixTag"
$SkipCount       = Join-Path $TurmaDir "update-skip-count.$PrefixTag"
# The raw `claude --version` of a repair that did NOT make it readable, so the same futile
# reinstall is not attempted on every start forever. Per-USER (not prefix-scoped): it is about
# the one `claude` this host runs, which every install shares.
$ClaudeUnparseable = Join-Path $TurmaDir 'claude-unparseable'
# A fixed contract the manager reads on boot (XERK-29): the expected-restart hint.
$UpdatingFlag    = Join-Path $TurmaDir 'updating.json'

function Log([string]$Message) {
  # Tag each line with the install $Prefix (XERK-551), else two concurrent installs' lines
  # interleave into one indistinguishable stream. Best-effort file append; the line also goes
  # to stderr, which the service log captures.
  $line = "[{0}] [{1}] {2}" -f ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')), $Prefix, $Message
  try { Add-Content -LiteralPath $Log -Value $line -ErrorAction Stop } catch { }
  [Console]::Error.WriteLine($line)
}

# --- safe read/write for ~/.turma files (temp + rename) -------------------------------------
function Read-Safe([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  try { return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop) } catch { return '' }
}
function Write-Safe([string]$Path, [string]$Content) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }
  $tmp = Join-Path $dir (".turma-tmp." + [guid]::NewGuid().ToString('N'))
  try {
    Set-Content -LiteralPath $tmp -Value $Content -NoNewline -ErrorAction Stop
    Move-Item -LiteralPath $tmp -Destination $Path -Force -ErrorAction Stop
  } catch {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}
function Set-StampNow([string]$Path) { Write-Safe $Path ([string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) }

function Get-InstalledVersion {
  $v = Read-Safe (Join-Path $Prefix 'VERSION')
  $v = ($v -replace '\s', '')
  if ($v) { return $v } else { return '0.0.0' }
}

# Is $A strictly newer than $B (dotted numeric, e.g. 0.3.12)? Compares component-wise so 0.3.12
# ranks above 0.3.9 (a lexical/string compare gets that wrong). A non-numeric or empty side
# NEVER reads as newer -- "stay put".
function Test-NewerThan([string]$A, [string]$B) {
  if (-not $A -or -not $B -or $A -eq $B) { return $false }
  $reA = [regex]::Match($A, '^\d+(\.\d+)*$'); $reB = [regex]::Match($B, '^\d+(\.\d+)*$')
  if (-not $reA.Success -or -not $reB.Success) { return $false }
  $pa = $A.Split('.'); $pb = $B.Split('.')
  $n = [Math]::Max($pa.Count, $pb.Count)
  for ($i = 0; $i -lt $n; $i++) {
    $da = if ($i -lt $pa.Count) { [int]$pa[$i] } else { 0 }
    $db = if ($i -lt $pb.Count) { [int]$pb[$i] } else { 0 }
    if ($da -gt $db) { return $true }
    if ($da -lt $db) { return $false }
  }
  return $false
}

# =====================================================================================
# Claude Code (XERK-254) -- see the header. ONLY ever at agent start (-ClaudeOnly), never on
# the poller/-Loop: replacing the package removes `claude` from PATH briefly and a session
# launched in that window dies on exec. Version-COMPARED, never an unconditional @latest.
# =====================================================================================
function Test-HasCommand([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# The bare semver claude reports ("2.0.14 (Claude Code)" -> 2.0.14). Empty when unparseable --
# which is NOT the same as claude being absent (see the unreadable branch below).
function Get-ClaudeVersion {
  if (-not (Test-HasCommand 'claude')) { return '' }
  $raw = Get-ClaudeRawVersion
  $m = [regex]::Match($raw, '\d+\.\d+\.\d+')
  if ($m.Success) { return $m.Value } else { return '' }
}
# What claude actually printed, first line, whitespace-collapsed -- tells a version this can't
# PARSE from one it can (the unreadable branch).
function Get-ClaudeRawVersion {
  if (-not (Test-HasCommand 'claude')) { return '' }
  try {
    $out = (& claude --version 2>$null | Select-Object -First 1)
    if ($null -eq $out) { return '' }
    return (($out -replace '\s+', ' ').Trim())
  } catch { return '' }
}
# Latest published version per the npm registry. Empty when unreachable OR non-version -- both
# must read as "stay put": a `sort`-style compare ranks a non-version above a semver, so an
# error line would otherwise look like an upgrade and replace the package every check.
function Get-ClaudeLatest {
  if (-not (Test-HasCommand 'npm')) { return '' }
  try {
    $out = (& npm view $ClaudePkg version --fetch-retries=1 --fetch-timeout=20000 2>$null |
            Select-Object -First 1)
    if ($null -eq $out) { return '' }
    $out = ($out -replace '\s', '')
  } catch { return '' }
  if ($out -match '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { return $out }
  return ''
}

# Report what an install ACHIEVED, never what it was asked to do: an install can report success
# while the claude this agent resolves does not move (the updated copy is not the one on PATH),
# and logging the old number as the new one hides that it repeats forever.
function Write-ClaudeInstallReport([string]$Before, [string]$Want) {
  $now = Get-ClaudeVersion
  if (-not $now) {
    Log "claude: install finished but claude still reports no readable version"
  } elseif ($now -eq $Before) {
    Log "claude: install reported success but this agent still resolves $Before -- that copy is not the one that was updated"
  } elseif ($Want -and $now -ne $Want) {
    Log "claude: now $now (wanted $Want)"
  } else {
    Log "claude: now $now"
  }
}

# npm install -g the package at @latest. On Windows npm's global bin is %APPDATA%\npm, which the
# launcher puts on PATH. Run directly (no inner deadline): -ClaudeOnly relies on the LAUNCHER's
# outer bound (Start-Process + WaitForExit + Kill), the bash `with_lock 0 claude` design -- an
# install killed halfway leaves NO claude, so bounding it here would be the wrong place.
function Install-ClaudeNpm {
  try {
    (& npm install -g "$ClaudePkg@latest" 2>&1) | Out-String | ForEach-Object { if ($_) { Add-Content -LiteralPath $Log -Value $_ -ErrorAction SilentlyContinue } }
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

# Install or repair, and VERIFY. Shared by the upgrade and repair paths so which mechanism owns
# this claude is the same question in both. On Windows npm is the mechanism; a non-npm claude
# (Anthropic's own installer) is handled by `claude update`.
function Install-Claude([string]$Before, [string]$Want) {
  if (-not (Test-HasCommand 'claude') -or (Test-ClaudeNpmManaged)) {
    if (Install-ClaudeNpm) {
      Write-ClaudeInstallReport $Before $Want
      return $true
    }
    Log "claude: install FAILED (see npm output above)"
    return $false
  }
  try {
    (& claude update 2>&1) | Out-String | ForEach-Object { if ($_) { Add-Content -LiteralPath $Log -Value $_ -ErrorAction SilentlyContinue } }
    if ($LASTEXITCODE -eq 0) {
      Write-ClaudeInstallReport $Before ''
      return $true
    }
  } catch { }
  Log "claude: not npm-managed and 'claude update' failed"
  return $false
}

# Is the claude ON PATH the one npm -g manages? `npm ls -g` alone answers a different question
# (npm can know about a copy the host does not RUN); compare the resolved paths.
function Test-ClaudeNpmManaged {
  if (-not (Test-HasCommand 'npm')) { return $false }
  try { & npm ls -g --depth=0 $ClaudePkg *> $null } catch { return $false }
  if ($LASTEXITCODE -ne 0) { return $false }
  $prefix = ''
  try { $prefix = ((& npm prefix -g 2>$null | Select-Object -First 1) -replace '\s', '') } catch { }
  if (-not $prefix) { return $false }
  $onPath = (Get-Command claude -ErrorAction SilentlyContinue)
  if (-not $onPath) { return $true }   # nothing on PATH yet: npm is who installs it
  return ($onPath.Source -like (Join-Path $prefix '*'))
}

function Update-Claude {
  if ((Coalesce $env:TURMA_CLAUDE_AUTO_UPDATE '1') -eq '0') {
    Log "claude: auto-update disabled (TURMA_CLAUDE_AUTO_UPDATE=0)"
    return
  }
  # ABSENT and UNREADABLE are different faults with the same repair -- both kept off the version
  # COMPARE (nothing to compare) and both VERIFIED afterwards, which is what keeps a repair that
  # cannot work from being retried blindly forever.
  if (-not (Test-HasCommand 'claude')) {
    if (-not (Test-HasCommand 'npm')) {
      Log "claude: MISSING and npm is not installed -- every session launch will fail"
      return
    }
    Log "claude: MISSING -- installing $ClaudePkg"
    Install-Claude '' '' | Out-Null
    return
  }

  $cur = Get-ClaudeVersion
  if (-not $cur) {
    # Present but unable to say what it is -- usually a half-written install, which reinstalling
    # repairs. But it can equally be a claude that works and prints a shape this can't parse (a
    # future calver/2-component version): reinstalling that fixes nothing, so a repair leaving
    # the SAME unreadable output is REMEMBERED and not retried until the output changes. The
    # marker is earned only by a repair that actually RAN -- an install that never reached the
    # registry (host restarted with no network) must not be remembered as "already tried", or
    # it would brick Claude Code permanently on an ordinary condition.
    $raw = Get-ClaudeRawVersion
    $marker = ((Read-Safe $ClaudeUnparseable) -split "`n" | Select-Object -First 1)
    if ($raw -and $raw -eq $marker) {
      Log "claude: still reports an unrecognised version ($raw); a repair already failed to change that, leaving it alone"
      return
    }
    Log "claude: reports no readable version ($raw) -- reinstalling"
    if (Install-Claude '' '') {
      $after = Get-ClaudeRawVersion
      if ($after -match '\d+\.\d+\.\d+') {
        Remove-Item -LiteralPath $ClaudeUnparseable -Force -ErrorAction SilentlyContinue
      } else {
        Write-Safe $ClaudeUnparseable $after
      }
    } else {
      Log "claude: the repair did not run, so it will be attempted again"
    }
    return
  }
  # A readable version means any past unparseable one is behind us.
  Remove-Item -LiteralPath $ClaudeUnparseable -Force -ErrorAction SilentlyContinue

  $latest = Get-ClaudeLatest
  if (-not $latest) {
    Log "claude: registry unreachable or unreadable; staying at $cur"
    return
  }
  if (-not (Test-NewerThan $latest $cur)) {
    Log "claude up to date ($cur)"
    return
  }
  Log "claude update available: $cur -> $latest"
  Install-Claude $cur $latest | Out-Null
}

# =====================================================================================
# Release read -- gh first (fresh token, private fork, higher rate limit), then the anonymous
# GitHub REST API (the repo is public, so a host with no gh login still self-updates -- XERK-151).
# =====================================================================================
function Test-HasGh {
  if (-not (Test-HasCommand 'gh')) { return $false }
  try { & gh auth status *> $null } catch { return $false }
  return ($LASTEXITCODE -eq 0)
}

# All release tag names, one per line (both schemes). Empty only if GitHub is unreachable.
function Get-AllTags {
  $out = ''
  if (Test-HasGh) {
    try { $out = (& gh api "repos/$Repo/releases?per_page=100" -q '.[].tag_name' 2>$null | Out-String) } catch { }
  }
  if (-not $out) {
    $headers = @{ 'User-Agent' = 'turma-agent-update' }
    if ($env:GH_TOKEN) { $headers['Authorization'] = "Bearer $env:GH_TOKEN" }
    try {
      $rels = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=100" -Headers $headers -ErrorAction Stop
      $out = (($rels | ForEach-Object { $_.tag_name }) -join "`n")
    } catch { }
  }
  return ($out -split "`r?`n" | Where-Object { $_ })
}

# Highest unified v<M>.<m>.<p> tag, or empty. Legacy-prefixed tags excluded.
function Get-LatestUnifiedTag {
  $tags = @(Get-AllTags | Where-Object { $_ -match '^v\d+\.\d+\.\d+$' })
  if ($tags.Count -eq 0) { return '' }
  return ($tags | Sort-Object -Property @{ Expression = { [version]($_.TrimStart('v')) } } | Select-Object -Last 1)
}
# Highest legacy version (bare, no prefix), or empty.
function Get-LatestLegacyVersion {
  $vers = @(Get-AllTags | Where-Object { $_.StartsWith($LegacyTagPrefix) } |
            ForEach-Object { $_.Substring($LegacyTagPrefix.Length) } |
            Where-Object { $_ -match '^\d+(\.\d+)*$' })
  if ($vers.Count -eq 0) { return '' }
  return ($vers | Sort-Object -Property @{ Expression = { [version]$_ } } | Select-Object -Last 1)
}

# Download named assets from a specific release tag into a dir. gh first, else the REST assets
# API (the asset endpoint + Accept: octet-stream serves a public release's bits unauthenticated,
# so no separate no-auth branch is needed). Returns $true iff at least one asset landed.
function Get-ReleaseAssets([string]$Tag, [string]$Dst, [string[]]$Patterns) {
  New-Item -ItemType Directory -Force -Path $Dst -ErrorAction SilentlyContinue | Out-Null
  if (Test-HasGh) {
    $ghArgs = @($Tag, '--repo', $Repo)
    foreach ($p in $Patterns) { $ghArgs += @('--pattern', $p) }
    $ghArgs += @('--dir', $Dst, '--clobber')
    try {
      & gh release download @ghArgs *> $null
      if ($LASTEXITCODE -eq 0) { return $true }
    } catch { }
  }
  # REST fallback.
  $headers = @{ 'User-Agent' = 'turma-agent-update' }
  if ($env:GH_TOKEN) { $headers['Authorization'] = "Bearer $env:GH_TOKEN" }
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers -ErrorAction Stop
  } catch { return $false }
  if (-not $rel -or -not $rel.assets) { return $false }
  $got = $false
  foreach ($want in $Patterns) {
    foreach ($a in $rel.assets) {
      if ($a.name -like $want) {
        $ah = $headers.Clone(); $ah['Accept'] = 'application/octet-stream'
        try {
          Invoke-WebRequest -Uri $a.url -Headers $ah -OutFile (Join-Path $Dst $a.name) -ErrorAction Stop
          $got = $true
        } catch { }
      }
    }
  }
  return $got
}

# Read a scalar field of the Windows agent component from a manifest file. Empty on any fault.
function Get-ManifestField([string]$ManifestFile, [string]$Field) {
  try {
    $m = Get-Content -LiteralPath $ManifestFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $c = $m.components.$ManifestComponent
    if ($null -eq $c) { return '' }
    $v = $c.$Field
    if ($null -eq $v) { return '' }
    return [string]$v
  } catch { return '' }
}

# =====================================================================================
# Payload swap -- the THIRD of the three lockstep packaging paths (installer copy, release
# staging, updater swap). It MUST carry hub-agent.py's siblings + hooks/ (kept in lockstep
# with install.ps1's $RuntimeFiles/$RuntimeDirs/$VerifyFiles): the swap DELETES the installed
# hooks first, so a payload missing a hook would leave the host with NO guard hook -- a missing
# hook command is a non-blocking hook, so the safety guard would fail OPEN while VERSION, the
# restart and the log all report a clean update. Hence the completeness refusal below.
# =====================================================================================
# Kept in lockstep with install.ps1. tmux.conf and the dsh toolchain are NOT carried onto Windows.
$RuntimeFiles = @('hub-agent.py', 'tunnel-agent.js',
  'runtime_projection.py', 'runtime_tail.py',
  'qwen_session.py', 'qwen_transcript.py')
$RuntimeDirs  = @('qwen')                          # recursive; hooks + win handled explicitly
$BinScripts   = @('turma-agent.ps1', 'turma-agentctl.ps1', 'turma-agent-update.ps1')

# Re-lay $SrcDir onto $DstDir, preserving named subdirs across the wipe (used to carry a built
# win\node_modules over a source re-lay -- the source tree has none). Same shape as install.ps1's
# Copy-Tree; the stash sits on the same volume so the move is an atomic rename.
function Copy-Tree([string]$SrcDir, [string]$DstDir, [string[]]$Preserve = @()) {
  $stashRoot = $null
  foreach ($name in $Preserve) {
    $p = Join-Path $DstDir $name
    if (Test-Path -LiteralPath $p) {
      if (-not $stashRoot) {
        $stashRoot = Join-Path (Split-Path -Parent $DstDir) (".turma-preserve-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $stashRoot -ErrorAction SilentlyContinue | Out-Null
      }
      Move-Item -LiteralPath $p -Destination (Join-Path $stashRoot $name) -Force
    }
  }
  if (Test-Path -LiteralPath $DstDir) { Remove-Item -Recurse -Force -LiteralPath $DstDir -ErrorAction SilentlyContinue }
  Copy-Item -Recurse -Force -LiteralPath $SrcDir -Destination $DstDir
  if ($stashRoot) {
    foreach ($name in $Preserve) {
      $stashed = Join-Path $stashRoot $name
      if (Test-Path -LiteralPath $stashed) { Move-Item -LiteralPath $stashed -Destination (Join-Path $DstDir $name) -Force }
    }
    Remove-Item -Recurse -Force -LiteralPath $stashRoot -ErrorAction SilentlyContinue
  }
}

# Extract a staged payload archive (.zip via Expand-Archive -- no external dep on Windows -- or
# .tar.gz via tar.exe, which ships in Windows 10 1803+ and is on the POSIX runner too). $false
# on any failure. The Windows release asset is a .zip (XERK-673 contract); .tar.gz is accepted
# for the legacy-stream fallback.
function Expand-Payload([string]$Archive, [string]$Dst) {
  try {
    if ($Archive -match '\.zip$') {
      Expand-Archive -LiteralPath $Archive -DestinationPath $Dst -Force -ErrorAction Stop
      return $true
    }
    & tar -xzf $Archive -C $Dst
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

# Extract the staged archive, validate the payload, swap runtime files in via atomic renames,
# stamp VERSION, and restart just the manager. $Archive must be verified before this is called.
function Install-Payload([string]$Archive, [string]$Version) {
  $update = "$Prefix.update"
  Remove-Item -Recurse -Force -LiteralPath $update -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $update | Out-Null
  if (-not (Expand-Payload $Archive $update)) { Log "could not extract staged payload; refusing to install"; return $false }

  $src = $update
  if (-not (Test-Path -LiteralPath (Join-Path $src 'hub-agent.py'))) {
    # Some tarballs wrap contents in a single top dir -- descend to hub-agent.py.
    $found = Get-ChildItem -Path $update -Recurse -Filter 'hub-agent.py' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $src = Split-Path -Parent $found.FullName }
  }

  # Completeness refusal (see the section header): hooks/ is checked HERE, not merely moved
  # below, because the swap deletes the installed hooks before moving the staged ones in.
  if (-not (Test-Path -LiteralPath (Join-Path $src 'hub-agent.py')) -or
      -not (Test-Path -LiteralPath (Join-Path $src 'tunnel-agent.js')) -or
      -not (Test-Path -LiteralPath (Join-Path $src 'hooks') -PathType Container)) {
    Log "staged payload incomplete (needs hub-agent.py + tunnel-agent.js + hooks/); refusing to install"
    Remove-Item -Recurse -Force -LiteralPath $update -ErrorAction SilentlyContinue
    return $false
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $Prefix 'bin') -ErrorAction SilentlyContinue | Out-Null

  # Core siblings: move each staged file over the installed one (atomic rename on same volume).
  foreach ($f in $RuntimeFiles) {
    $s = Join-Path $src $f
    if (Test-Path -LiteralPath $s) { Move-Item -LiteralPath $s -Destination (Join-Path $Prefix $f) -Force }
  }
  # hooks/ moves together with hub-agent.py -- DELETE installed first (the fail-open hazard the
  # completeness check above guards), then move the staged tree in.
  $hooksDst = Join-Path $Prefix 'hooks'
  Remove-Item -Recurse -Force -LiteralPath $hooksDst -ErrorAction SilentlyContinue
  Move-Item -LiteralPath (Join-Path $src 'hooks') -Destination $hooksDst -Force
  # qwen/ (stdlib-only tree). Conditional (not part of the completeness refusal): a payload
  # without it is a qwen REFUSAL, not the fail-open safety hole a missing hook is.
  foreach ($d in $RuntimeDirs) {
    $s = Join-Path $src $d
    if (Test-Path -LiteralPath $s) { Copy-Tree $s (Join-Path $Prefix $d) }
  }
  # win/ -- the ConPTY terminal layer (ADR D1). Refresh the SOURCE files, PRESERVE a built
  # node_modules across the re-lay (the source has none; a naive wipe would destroy the pty
  # deps and, until the next install.ps1 re-run, leave the terminal dead). node-pty is a binary
  # dep the updater does not rebuild -- the Windows twin of the bash updater leaving ttyd/tmux to
  # install.sh; a lockfile bump is healed by an install.ps1 re-run.
  $winSrc = Join-Path $src 'win'
  if (Test-Path -LiteralPath $winSrc -PathType Container) {
    Copy-Tree $winSrc (Join-Path $Prefix 'win') @('node_modules')
  }
  # bin scripts (the launcher, controller, and THIS updater).
  foreach ($b in $BinScripts) {
    $s = Join-Path $src $b
    if (Test-Path -LiteralPath $s) { Move-Item -LiteralPath $s -Destination (Join-Path $Prefix 'bin' $b) -Force }
  }

  # An unstampable VERSION means the next check sees the OLD version and does the whole download
  # + swap + restart again, every interval, forever. Say so instead of reporting a clean update.
  try {
    Set-Content -LiteralPath (Join-Path $Prefix 'VERSION') -Value $Version -NoNewline -ErrorAction Stop
  } catch {
    Log "installed $Version but could NOT stamp VERSION -- every later check will reinstall it; fix that file's permissions"
  }
  Log "installed $Version; restarting manager (sessions preserved)"

  # Leave the running manager a hint that its imminent stop is an EXPECTED update, not an outage
  # (XERK-29): its shutdown handler reads this and announces `updating` to the hub. Best-effort;
  # the new manager clears it on boot.
  try {
    Set-Content -LiteralPath $UpdatingFlag -Value ('{"reason":"update","version":"' + $Version + '"}') -ErrorAction Stop
  } catch { }

  # Restart just the manager, session-preserving, via the Windows control surface -- WinSW
  # restarts the launcher and the detached pty-hosts break away and survive; the pidfile
  # fallback reaps the control plane and never names a pty-host. NEVER the POSIX turma-agentctl.
  $ctl = Join-Path $Prefix 'bin' 'turma-agentctl.ps1'
  if (Test-Path -LiteralPath $ctl) {
    try { & $PwshExe -NoProfile -File $ctl restart *> $null } catch { Log "turma-agentctl restart failed ($_)" }
  } else {
    Log "turma-agentctl.ps1 not found at $ctl -- cannot restart; the swap is in place, restart the service by hand"
  }
  Remove-Item -Recurse -Force -LiteralPath $update -ErrorAction SilentlyContinue
  Log "update complete: now $Version"
  return $true
}

# Verify a staged archive's sha256 sidecar (if present) then install it. The Windows asset is a
# .zip; a .tar.gz is accepted for the legacy stream.
function Test-AndInstall([string]$Stage, [string]$Version) {
  $arc = Get-ChildItem -Path $Stage -File -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -match '\.zip$' -or $_.Name -match '\.tar\.gz$' } | Select-Object -First 1
  if (-not $arc) { Log "no payload archive staged; keeping install"; return $false }
  $sha = Get-ChildItem -Path $Stage -Filter '*.sha256' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($sha) {
    # The sidecar is `<hex>  <filename>` (sha256sum format) or a bare hex; take the first token.
    $want = ((Get-Content -LiteralPath $sha.FullName -Raw) -split '\s+' | Select-Object -First 1).ToLower()
    $have = (Get-FileHash -LiteralPath $arc.FullName -Algorithm SHA256).Hash.ToLower()
    if (-not $want -or $want -ne $have) {
      Log "checksum FAILED; refusing to install"
      return $false
    }
  }
  return (Install-Payload $arc.FullName $Version)
}

# Unified scheme. Returns $true if it HANDLED the decision (installed or up-to-date), $false if
# it couldn't (no unified release / unparseable manifest) so the caller falls back to legacy.
function Invoke-TryUnified([string]$Cur, [string]$Stage) {
  $utag = Get-LatestUnifiedTag
  if (-not $utag) { return $false }

  $mdir = Join-Path $Stage 'manifest'
  Get-ReleaseAssets $utag $mdir @('manifest.json') | Out-Null
  $manifest = Join-Path $mdir 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifest)) { Log "unified release $utag has no manifest.json; trying legacy"; return $false }

  $compVersion = Get-ManifestField $manifest 'version'
  $asset       = Get-ManifestField $manifest 'asset'
  $sha         = Get-ManifestField $manifest 'sha256_asset'
  $releaseTag  = Get-ManifestField $manifest 'release_tag'
  if (-not $compVersion -or -not $asset -or -not $releaseTag) {
    Log "manifest.json has no $ManifestComponent fields; trying legacy"
    return $false
  }

  if (-not (Test-NewerThan $compVersion $Cur)) {
    Log "up to date ($Cur; latest release $utag carries $ManifestComponent $compVersion)"
    return $true
  }
  Log "update available: $Cur -> $compVersion (from $releaseTag, release $utag)"

  $dl = Join-Path $Stage 'payload'
  $patterns = if ($sha) { @($asset, $sha) } else { @($asset) }
  if (-not (Get-ReleaseAssets $releaseTag $dl $patterns)) {
    Log "download failed for $asset; keeping $Cur"
    return $true
  }
  Test-AndInstall $dl $compVersion | Out-Null
  return $true
}

# Legacy scheme (pre-cutover / rollback).
function Invoke-TryLegacy([string]$Cur, [string]$Stage) {
  $latest = Get-LatestLegacyVersion
  if (-not $latest) {
    Log "no native release found (or auth unavailable); staying at $Cur"
    return
  }
  if (-not (Test-NewerThan $latest $Cur)) {
    Log "up to date ($Cur; latest $latest)"
    return
  }
  $tag = "$LegacyTagPrefix$latest"
  Log "update available (legacy): $Cur -> $latest ($tag)"
  $dl = Join-Path $Stage 'payload'
  if (-not (Get-ReleaseAssets $tag $dl @('*.zip', '*.tar.gz', '*.sha256'))) {
    Log "download failed for $tag; keeping $Cur"
    return
  }
  Test-AndInstall $dl $latest | Out-Null
}

# The agent self-update. Claude Code is NOT part of this -- it runs only at agent start.
function Invoke-RunOnce {
  Set-StampNow $Stamp   # stamp FIRST, so a run that then wedges/dies still bounds the next check
  $cur = Get-InstalledVersion
  $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("turma-update-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  try {
    if (Invoke-TryUnified $cur $stage) { return }
    Invoke-TryLegacy $cur $stage
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $stage -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force -LiteralPath "$Prefix.update" -ErrorAction SilentlyContinue
  }
}

function Invoke-ClaudeCheck {
  Set-StampNow $ClaudeStamp
  try { Update-Claude } catch { Log "claude update check errored (continuing): $_" }
}

# =====================================================================================
# Lock (XERK-549 + XERK-551) -- Windows primitives for the bash flock design. Single-flight,
# taken PER RUN and released BEFORE the sleep (holding it across the poller's hour made every
# start-fired check exit as "another update run holds the lock"). A wedged run cannot hold it
# forever: an overall deadline force-terminates the worker, and a staleness-aware reclaim kills
# a live wedged holder that has aged past the threshold.
# =====================================================================================
# The lock is an exclusively-opened FileStream (FileShare None). A second updater's Open throws
# a sharing violation -> contended. A .NET file handle is NOT inherited by child processes, so a
# hung child never holds the lock (the bash `9>&-` guarantee, for free). The OS releases the
# lock when the holder process dies, so a crashed holder needs no reclaim; the reclaim path is
# for a holder that is LIVE but wedged.
function Enter-Lock {
  try {
    return [System.IO.File]::Open($Lock, [System.IO.FileMode]::OpenOrCreate,
                                  [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    # Held right now. Reclaim it if the holder is wedged (XERK-549); else stand aside.
    if (Invoke-ReclaimStaleLock) {
      try {
        return [System.IO.File]::Open($Lock, [System.IO.FileMode]::OpenOrCreate,
                                      [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      } catch { }
    }
    return $null
  }
}
function Exit-Lock([System.IO.FileStream]$Stream) {
  if ($Stream) { try { $Stream.Dispose() } catch { } }
  Remove-Item -LiteralPath $LockHolder -Force -ErrorAction SilentlyContinue
}

# Is the recorded holder wedged, and if so reclaim it? Called only when Enter-Lock's Open has
# already failed, i.e. something holds the lock now. Kills the single holder pid (which the OS
# then releases the lock for), but ONLY when it is our updater, past the reclaim age.
function Invoke-ReclaimStaleLock {
  $holder = (Read-Safe $LockHolder).Trim()
  if (-not $holder) { return $false }
  $parts = $holder -split '\s+'
  if ($parts.Count -lt 2) { return $false }
  # NB: $pid is a read-only automatic variable in PowerShell -- use $holderPid.
  $holderPid = 0; $started = [long]0
  if (-not [int]::TryParse($parts[0], [ref]$holderPid)) { return $false }
  if (-not [long]::TryParse($parts[1], [ref]$started)) { return $false }
  $proc = Get-Process -Id $holderPid -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }   # holder gone; the OS already freed the lock
  # PID-reuse guard: only a process whose command line is THIS updater is a real holder.
  $cl = $null; try { $cl = $proc.CommandLine } catch { }
  if ($cl -and -not $cl.Contains('turma-agent-update')) { return $false }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $age = $now - $started
  if ($age -lt $LockReclaimAfter) { return $false }   # young (healthy) or clock skew: leave it
  Log "update.lock held by pid $holderPid for ${age}s (>= ${LockReclaimAfter}s) -- presumed wedged, reclaiming (XERK-549)"
  try { $proc.Kill($true) } catch { }
  for ($i = 0; $i -lt 5 -and -not $proc.HasExited; $i++) { Start-Sleep -Seconds 1 }
  Log "reclaimed update.lock from wedged pid $holderPid"
  return $true
}

# Run the locked work under an OVERALL deadline (XERK-549). The agent self-update (-Loop/-Boot/
# one-shot) is re-exec'd as -LockedRun via Start-Process and WaitForExit'd; on timeout the whole
# child process tree is killed, so a hung run is force-terminated instead of held. deadline 0
# (claude, or the escape hatch) runs the work in-process -- the child never holds the lock.
function Invoke-RunLocked([int]$Deadline, [string]$Mode) {
  if ($Deadline -gt 0) {
    $arg = if ($Mode -eq 'run') { '-LockedRun' } else { '-LockedClaude' }
    $p = Start-Process -FilePath $PwshExe -ArgumentList @('-NoProfile', '-File', $SelfPath, $arg) -PassThru -NoNewWindow
    if (-not $p.WaitForExit($Deadline * 1000)) {
      Log "update run '$Mode' exceeded ${Deadline}s and was force-terminated (XERK-549 watchdog); the lock is released so the next check can run"
      try { $p.Kill($true) } catch { }
      return $false
    }
    return ($p.ExitCode -eq 0)
  }
  try {
    if ($Mode -eq 'run') { Invoke-RunOnce } else { Invoke-ClaudeCheck }
    return $true
  } catch {
    Log "locked '$Mode' errored: $_"
    return $false
  }
}

# Single-flight wrapper: take the lock, record the holder, run, release. Returns $true iff the
# work ran (not skipped for contention).
function Invoke-WithLock([int]$Deadline, [string]$Mode) {
  $stream = Enter-Lock
  if (-not $stream) {
    Log "another update run holds the lock; skipping"
    return $false
  }
  # Record who holds it and since when, so a LATER run can reclaim us if we wedge.
  Write-Safe $LockHolder ("{0} {1}" -f $PID, [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
  try {
    Invoke-RunLocked $Deadline $Mode | Out-Null
    return $true
  } finally {
    Exit-Lock $stream
  }
}

# Consecutive skipped/errored AGENT checks -> a log warning, so a poller stuck on a stale build
# is visible without inspecting the host (XERK-549). Reset on the first clean run.
function Update-AgentCheckHealth([bool]$Ok) {
  if ($Ok) {
    $prev = ((Read-Safe $SkipCount) -replace '\D', '')
    if ($prev -and [int]$prev -ge $StrandWarnAt) {
      Log "agent update checks recovered after $prev consecutive skips/errors"
    }
    Remove-Item -LiteralPath $SkipCount -Force -ErrorAction SilentlyContinue
    return
  }
  $n = ((Read-Safe $SkipCount) -replace '\D', '')
  $n = (if ($n) { [int]$n } else { 0 }) + 1
  Write-Safe $SkipCount ([string]$n)
  if ($n -ge $StrandWarnAt -and ($n % $StrandWarnAt) -eq 0) {
    Log "WARNING: $n consecutive agent update checks skipped/errored -- this host may be stranded on $(Get-InstalledVersion); see update.log (XERK-549)"
  }
}

# The agent self-update, wrapped: lock + overall deadline + health signal.
function Invoke-AgentCheck {
  $ok = Invoke-WithLock $RunDeadline 'run'
  Update-AgentCheckHealth $ok
  return $ok
}

# Has a check of this kind run recently enough that this one is redundant? The launcher fires
# the start checks on EVERY start, and a start is not always an operator asking for one (WinSW's
# onfailure brings the unit back every few seconds while the manager is crash-looping).
# Unthrottled, that is a full check every few seconds. The rate limit is what makes "check on
# every start" safe to promise.
function Test-Throttled([string]$StampFile, [string]$Label) {
  $last = ((Read-Safe $StampFile) -replace '\D', '')
  if (-not $last) { return $false }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $age = $now - [long]$last
  if ($age -lt 0) { return $false }   # a future stamp (clock skew) is not a recent check
  if ($age -lt $BootMinInterval) {
    Log "$Label skipped: last check ${age}s ago (< ${BootMinInterval}s)"
    return $true
  }
  return $false
}

# =====================================================================================
# main
# =====================================================================================
# Internal re-exec entrypoints (XERK-549): Invoke-RunLocked starts us as -LockedRun/-LockedClaude
# under a deadline. The lock is already held by our parent, so these do the work directly and
# never re-enter the lock or throttle. Not for humans.
if ($LockedRun)    { Invoke-RunOnce;     exit 0 }
if ($LockedClaude) { Invoke-ClaudeCheck; exit 0 }

if ($ClaudeOnly) {
  # The launcher's start-time Claude Code check, run to completion BEFORE the manager exists so
  # no session can be launching while the package is replaced. Its own stamp, so it and the
  # agent check throttle independently.
  if (Test-Throttled $ClaudeStamp 'claude check') { exit 0 }
  Invoke-WithLock 0 'claude' | Out-Null
  exit 0
}

if ($Loop) {
  Log "auto-update poller started (every ${IntervalSec}s, repo $Repo)"
  $retry = $PollRetrySec
  if ($retry -lt 1) { $retry = 1 }
  if ($retry -gt $IntervalSec) { $retry = $IntervalSec }
  # The FIRST pass is the on-start agent check, but it honors the boot throttle: the launcher
  # (re)starts this poller, and on a host where a WinSW-job restart kills+respawns it, a
  # crash-looping unit would otherwise turn each 5s restart into an immediate check. A very
  # recent check means skip straight to the interval; then poll normally. (Where the poller
  # instead PERSISTS across restarts, the launcher never starts a second, so this is a no-op.)
  $skipFirst = Test-Throttled $Stamp 'poller first check'
  while ($true) {
    if ($skipFirst) {
      $skipFirst = $false
      Start-Sleep -Seconds $IntervalSec
      continue
    }
    if (Invoke-AgentCheck) {
      Start-Sleep -Seconds $IntervalSec
    } else {
      # A poll SKIPPED or ERRORED -- most importantly one lost to lock contention -- must NOT
      # forfeit the whole interval (XERK-551): sleeping the full hour on a skip is what let one
      # contended poll strand the host for an hour and sustained contention strand it forever.
      # Retry after a short bounded backoff instead; Update-AgentCheckHealth still escalates to a
      # WARNING after StrandWarnAt in a row.
      Log "update check skipped/errored; retrying in ${retry}s (continuing)"
      Start-Sleep -Seconds $retry
    }
  }
}

if ($Boot) {
  if (Test-Throttled $Stamp 'boot check') { exit 0 }
  Invoke-AgentCheck | Out-Null
  exit 0
}

# Default: a single agent self-update pass (by hand, or the internal poller pass).
Invoke-AgentCheck | Out-Null
exit 0
