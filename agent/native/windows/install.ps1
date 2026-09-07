#!/usr/bin/env pwsh
# install.ps1 — install the native (no-WSL) Turma agent on a Windows host (XERK-672,
# epic XERK-666; decisions in docs/windows-agent-adr.md, rules in
# .claude/rules/windows-launcher.md). The PowerShell port of agent/native/install.sh.
#
# Idempotent install / -Verify / -Uninstall: provisions the base tools (ADR D3 —
# winget for git/node/python/gh, npm for claude + the pty terminal layer, a pinned
# bundled WinSW.exe), lays the shared runtime files down keeping hub-agent.py's Python
# siblings + hooks/ BESIDE it (a missing sibling runs the agent DARK — the XERK-528
# class), writes the token/config env file with an OWNER-ONLY NTFS ACL (the chmod-600
# equivalent, ADR D4), wires + try-restarts the WinSW service, and stamps $Prefix\VERSION.
#
# It mirrors install.sh function-for-function; where Windows differs (winget not apt,
# icacls not chmod, WinSW not systemd) it says so, and the Windows-only actions
# (provisioning, the ACL, the service) are GATED on $IsWindows so the SAME file logic
# (lay-down / verify / uninstall) is drivable on the POSIX CI runner exactly as
# turma-agentctl.ps1's Get-Service fallback and turma-agent.ps1's suite are.
#
# NOT here, each a later epic child (marked where they wire in): the curl|bash-style
# bootstrap front door; the Windows self-updater (turma-agent-update analog) and its
# "every start is an update check"; and the RELEASE staging that bundles these into the
# tarball. The XERK-528 lockstep is three packaging paths — this installer's copy +
# -Verify list is ONE; the updater and release staging are the other two, in their own
# tasks. dsh is not provisioned on Windows (no Windows dsh toolchain in the ADR).

[CmdletBinding()]
param(
  # Install prefix. Empty -> a per-user default under %LOCALAPPDATA% (POSIX: ~/.local/share).
  [string]$Prefix = '',
  # Skip provisioning the prerequisites (winget/npm). The file lay-down, config, service
  # wiring and VERSION stamp still run — idempotent, so a later run heals a missing tool.
  [switch]$NoInstallDeps,
  # Report-only: files, tools, config, service, login status table. Exit non-zero if red.
  [switch]$Verify,
  # Remove the prefix + service; PRESERVE config, ~/.turma and ~/.claude.
  [switch]$Uninstall,
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'   # best-effort throughout, like the bash `|| true`

if ($Help) {
  [Console]::Out.WriteLine("usage: install.ps1 [-Prefix DIR] [-NoInstallDeps] [-Verify] [-Uninstall]")
  exit 0
}

# --- tiny helpers (the info/warn/have of install.sh) -----------------------------------
function Info([string]$Message) { [Console]::Out.WriteLine("[install] $Message") }
function Warn([string]$Message) { [Console]::Error.WriteLine("[install] WARN: $Message") }
function Have([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# bash `${x:-default}`: first non-empty wins; '' and $null are both "unset".
function Coalesce {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Values)
  foreach ($v in $Values) { if ($v) { return $v } }
  return ''
}

$NodeMajorMin = 24   # tunnel-agent.js needs the global WebSocket (Node 22+); the fleet pins 24.

# winget package ids (ADR D3). node major is asserted AFTER install, since OpenJS.NodeJS
# tracks Current (>= 24 today) but a host could carry an older pinned install.
$WingetPkgs = @(
  @{ Cli = 'git';    Id = 'Git.Git' }
  @{ Cli = 'node';   Id = 'OpenJS.NodeJS' }
  @{ Cli = 'python'; Id = 'Python.Python.3.12' }
  @{ Cli = 'gh';     Id = 'GitHub.cli' }
)
# Pinned WinSW (the bundled-binary analog of install.sh's static ttyd/glab). Downloaded
# into $Prefix\bin as <service>.exe when absent; a release build may bundle it instead.
$WinswVersion = '2.12.0'
$WinswUrl = "https://github.com/winsw/winsw/releases/download/v$WinswVersion/WinSW-x64.exe"

# --- USERPROFILE / paths (the $HOME-relative defaults of install.sh, ADR D4) ------------
# USERPROFILE is the $HOME analog; a Session-0 service can be launched without it, so
# derive it rather than fail under StrictMode — the same guard the launcher/ctl make.
if (-not $env:USERPROFILE) {
  $up = [Environment]::GetFolderPath('UserProfile')
  if (-not $up) {
    $up = if ($env:HOMEDRIVE -and $env:HOMEPATH) { "$env:HOMEDRIVE$env:HOMEPATH" }
          elseif ($env:HOME) { $env:HOME }
          else { Join-Path (Coalesce $env:SystemDrive 'C:') 'Users\Default' }
  }
  $env:USERPROFILE = $up
}
$UserHome = $env:USERPROFILE

# Install prefix: %LOCALAPPDATA%\turma-agent on Windows, ~/.local/share/turma-agent
# elsewhere (so the POSIX suite lands somewhere sane). An explicit -Prefix always wins.
if (-not $Prefix) {
  $localApp = Coalesce $env:LOCALAPPDATA (Join-Path $UserHome '.local\share')
  $Prefix = Join-Path $localApp 'turma-agent'
}

# Config lives at %APPDATA%\turma-agent\turma-agent.env (ADR D4, the launcher's default
# and agent_env_path()'s Windows fallback). Holds TURMA_TOKEN, so it is ACL'd owner-only.
$AppData = Coalesce $env:APPDATA (Join-Path $UserHome 'AppData\Roaming')
$CfgDir  = Join-Path $AppData 'turma-agent'
$Cfg     = Join-Path $CfgDir 'turma-agent.env'

$ServiceName = Coalesce $env:TURMA_SERVICE_NAME 'turma-agent'
$Bin         = Join-Path $Prefix 'bin'
$TurmaDir    = Join-Path $UserHome '.turma'
$Creds       = Join-Path $UserHome '.claude\.credentials.json'

# --- resolve the source trees (repo checkout OR extracted release tarball) --------------
# install.ps1 sits at agent/native/windows/ beside the other Windows shell files; the
# SHARED runtime (hub-agent.py + siblings + hooks + win/) is at agent/ = ..\.. . A release
# tarball stages everything flat, so — exactly like install.sh — probe for hub-agent.py
# next to us first and fall back to two levels up only for the repo layout.
$SelfDir = Split-Path -Parent $PSCommandPath
if (Test-Path -LiteralPath (Join-Path $SelfDir 'hub-agent.py')) {
  $RuntimeSrc = $SelfDir           # release tarball: shared runtime staged beside us
  $WinSrc     = $SelfDir           # ...and the windows scripts too
}
else {
  $RuntimeSrc = (Resolve-Path (Join-Path $SelfDir '..\..')).Path   # repo: agent/
  $WinSrc     = $SelfDir                                           # repo: agent/native/windows/
}

# The runtime files that MUST land beside hub-agent.py, or the agent runs dark on the
# runtime whose sibling is missing (XERK-528). This mirrors install.sh's UNCONDITIONAL
# set: the two core siblings + hooks, the shared projection scaffolding both non-Claude
# runtimes import (runtime_projection/runtime_tail), and the qwen siblings + qwen/ tree
# (stdlib-only, only touched on a qwen launch, gated by qwen_runtime_present()). tmux.conf
# and the dsh toolchain are deliberately NOT carried onto Windows.
$RuntimeFiles = @('hub-agent.py', 'tunnel-agent.js',
  'runtime_projection.py', 'runtime_tail.py',
  'qwen_session.py', 'qwen_transcript.py')
$RuntimeDirs  = @('qwen')   # recursive; hooks and win are handled explicitly below

# The -Verify presence list — the exact siblings/hooks/tree whose absence runs a runtime
# dark, plus the Windows terminal layer and the launcher/controller. Keep in lockstep with
# $RuntimeFiles/$RuntimeDirs above AND with install.sh's do_verify list (the XERK-528 rule).
$VerifyFiles = @(
  'hub-agent.py', 'tunnel-agent.js',
  'hooks\guard.py', 'hooks\fileguard.py', 'hooks\ask.py', 'hooks\statusline.py',
  'runtime_projection.py', 'runtime_tail.py',
  'qwen_session.py', 'qwen_transcript.py',
  'qwen\ask_mcp.py', 'qwen\peer_mcp.py', 'qwen\peer_inbox.py', 'qwen\guard\shim.py',
  'win\pty-host.mjs', 'win\tty-protocol.mjs',
  'bin\turma-agent.ps1', 'bin\turma-agentctl.ps1'
)

function Get-NodeMajor {
  if (-not (Have 'node')) { return 0 }
  $v = (& node -v 2>$null)
  if ($v -match 'v(\d+)') { return [int]$Matches[1] }
  return 0
}

# =====================================================================================
# Provisioning (ADR D3) — winget for the base tools, npm for claude + the pty layer.
# Every step NAMES exactly what is missing and is idempotent (a present tool is left
# alone, a re-run heals a gap), mirroring the ensure_* functions of install.sh. All of
# this is Windows-only; the POSIX suite runs -NoInstallDeps so none of it fires there.
# =====================================================================================
function Install-WingetPackage([string]$Cli, [string]$Id) {
  if (Have $Cli) { Info "$Cli present"; return }
  if (-not (Have 'winget')) {
    Warn "$Cli is MISSING and winget is unavailable (older/Server SKU?)."
    Warn "  Install $Cli manually (winget id: $Id), or install App Installer, then re-run — this is idempotent."
    return
  }
  Info "winget: installing $Cli ($Id)"
  try {
    & winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } catch { }
  if (-not (Have $Cli)) {
    Warn "$Cli still not on PATH after winget (a new shell may be needed to pick up PATH, or the install failed)."
    Warn "  Re-run this installer once $Cli resolves; it is idempotent."
  }
}

function Ensure-BaseTools {
  foreach ($p in $WingetPkgs) { Install-WingetPackage $p.Cli $p.Id }
  $maj = Get-NodeMajor
  if ($maj -gt 0 -and $maj -lt $NodeMajorMin) {
    Warn "node $maj is older than the required $NodeMajorMin. The reverse tunnel needs the"
    Warn "  global WebSocket (Node >= $NodeMajorMin); every session reads 'terminal offline' without it."
    Warn "  Upgrade: winget install --id OpenJS.NodeJS --exact"
  }
}

function Ensure-Claude {
  if (Have 'claude') { Info "claude present"; return }
  if (-not (Have 'npm')) { Warn "npm not found — cannot install claude; install Node first"; return }
  Info "installing @anthropic-ai/claude-code (npm -g)"
  try { & npm install -g '@anthropic-ai/claude-code' | Out-Null } catch { }
  if (-not (Have 'claude')) {
    Warn "claude not on PATH after npm install. npm's global bin (%APPDATA%\npm) must be on PATH;"
    Warn "  the launcher adds it for the service, but a manual 'claude /login' needs it in your shell too."
  }
}

# The pty terminal layer (ADR D1/D3): node-pty + ws installed into $Prefix\win beside
# pty-host.mjs (node-pty ships Windows prebuilds, so no Visual Studio build tools in the
# common case). A built dependency tree here is what the per-session ConPTY host needs.
function Ensure-PtyLayer {
  $winDir = Join-Path $Prefix 'win'
  if (-not (Test-Path -LiteralPath (Join-Path $winDir 'package.json'))) {
    Warn "pty layer not laid down ($winDir\package.json missing) — cannot install node-pty/ws"
    return
  }
  if (-not (Have 'npm')) { Warn "npm not found — cannot install the pty layer (node-pty + ws); install Node first"; return }
  if (Test-Path -LiteralPath (Join-Path $winDir 'node_modules\node-pty')) { Info "pty layer deps present"; return }
  Info "installing the pty terminal layer (node-pty + ws) into $winDir"
  try {
    if (Test-Path -LiteralPath (Join-Path $winDir 'package-lock.json')) {
      & npm --prefix $winDir ci | Out-Null
    } else {
      & npm --prefix $winDir install | Out-Null
    }
  } catch { }
  if (-not (Test-Path -LiteralPath (Join-Path $winDir 'node_modules\node-pty'))) {
    Warn "node-pty did not install. The browser terminal (per-session pty-host) will not start until it does."
    Warn "  Retry:  npm --prefix `"$winDir`" install"
  }
}

# WinSW: the pinned bundled service wrapper (install.sh's static-binary analog). Downloaded
# to $Prefix\bin\<service>.exe when absent, where turma-agentctl.ps1 install expects it.
function Ensure-WinSW {
  $exe = Join-Path $Bin "$ServiceName.exe"
  if (Test-Path -LiteralPath $exe) { Info "WinSW present ($exe)"; return }
  New-Item -ItemType Directory -Force -Path $Bin -ErrorAction SilentlyContinue | Out-Null
  Info "downloading WinSW $WinswVersion into $exe"
  try {
    Invoke-WebRequest -Uri $WinswUrl -OutFile $exe -UseBasicParsing
  } catch {
    Warn "WinSW download failed ($_). The service cannot be registered without it."
    Warn "  Fetch $WinswUrl manually to $exe, or run the installer with network access, then re-run."
  }
}

# =====================================================================================
# File lay-down — the shared runtime beside hub-agent.py, the pty layer, the Windows
# shell scripts, VERSION. Pure file ops, so it runs on any OS (drives the POSIX suite).
# =====================================================================================
function Copy-Tree([string]$SrcDir, [string]$DstDir) {
  New-Item -ItemType Directory -Force -Path $DstDir -ErrorAction SilentlyContinue | Out-Null
  # Copy the directory's CONTENTS into $DstDir (a fresh destination, so remove first for a
  # clean idempotent re-lay — a payload that stops shipping a file must not leave a stale one).
  if (Test-Path -LiteralPath $DstDir) { Remove-Item -Recurse -Force -LiteralPath $DstDir -ErrorAction SilentlyContinue }
  Copy-Item -Recurse -Force -LiteralPath $SrcDir -Destination $DstDir
}

function Install-Files {
  Info "installing runtime files into $Prefix"
  New-Item -ItemType Directory -Force -Path $Prefix, $Bin, (Join-Path $Prefix 'hooks') -ErrorAction SilentlyContinue | Out-Null

  foreach ($f in $RuntimeFiles) {
    $src = Join-Path $RuntimeSrc $f
    if (Test-Path -LiteralPath $src) { Copy-Item -Force -LiteralPath $src -Destination (Join-Path $Prefix $f) }
    else { Warn "source missing: $src (the agent would run dark without $f)" }
  }
  # hooks/*.py (load-bearing siblings of hub-agent.py — a missing guard hook fails OPEN)
  $hookSrc = Join-Path $RuntimeSrc 'hooks'
  Get-ChildItem -LiteralPath $hookSrc -Filter '*.py' -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item -Force -LiteralPath $_.FullName -Destination (Join-Path $Prefix "hooks\$($_.Name)") }
  # qwen/ (stdlib-only tree, resolved relative to hub-agent.py's own dir)
  foreach ($d in $RuntimeDirs) {
    $src = Join-Path $RuntimeSrc $d
    if (Test-Path -LiteralPath $src) { Copy-Tree $src (Join-Path $Prefix $d) }
    else { Warn "source dir missing: $src" }
  }
  # win/ — the ConPTY pty-host terminal layer (ADR D1), laid beside hub-agent.py so the
  # manager resolves <base>\win\pty-host.mjs (node_modules populated by Ensure-PtyLayer).
  $winSrcDir = Join-Path $RuntimeSrc 'win'
  if (Test-Path -LiteralPath $winSrcDir) { Copy-Tree $winSrcDir (Join-Path $Prefix 'win') }
  else { Warn "source dir missing: $winSrcDir (the Windows terminal layer)" }

  # The Windows shell scripts into bin\ (the launcher + controller; the xml is rendered by
  # Install-Service). These sit at $WinSrc in both the repo and a sensible tarball layout.
  foreach ($s in @('turma-agent.ps1', 'turma-agentctl.ps1')) {
    $src = Join-Path $WinSrc $s
    if (Test-Path -LiteralPath $src) { Copy-Item -Force -LiteralPath $src -Destination (Join-Path $Bin $s) }
    else { Warn "source missing: $src" }
  }

  # VERSION (read by the updater + -Verify). Release tarball ships a stamped VERSION beside
  # the files; a repo checkout falls back to the repo-root VERSION (bare MAJOR.MINOR).
  $verOut = Join-Path $Prefix 'VERSION'
  $verCandidates = @((Join-Path $RuntimeSrc 'VERSION'), (Join-Path $RuntimeSrc '..\VERSION'))
  $wrote = $false
  foreach ($vc in $verCandidates) {
    if (Test-Path -LiteralPath $vc) {
      $raw = (Get-Content -LiteralPath $vc -Raw) -replace '\s', ''
      Set-Content -LiteralPath $verOut -Value $raw -NoNewline
      $wrote = $true; break
    }
  }
  if (-not $wrote) { Set-Content -LiteralPath $verOut -Value '0.0.0-dev' -NoNewline }
  Info "installed version $(Get-Content -LiteralPath $verOut -Raw)"
}

# =====================================================================================
# Config — write the env template ONCE (never overwrite), owner-only ACL (chmod-600).
# =====================================================================================
# The cross-platform restrict_file_to_owner (ADR D4): on Windows an icacls owner-only NTFS
# ACL (disable inheritance, grant only the running user + SYSTEM); a no-op elsewhere. BEST-
# EFFORT and never fatal — the bytes are already on disk, exactly as hub-agent.py's version.
function Restrict-FileToOwner([string]$Path) {
  if (-not $IsWindows) { return }
  try {
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls $Path /inheritance:r /grant:r "${me}:F" 'SYSTEM:F' | Out-Null
  } catch {
    Warn "icacls could not restrict $Path ($_) — the token file is readable to other users on this host"
  }
}

function Install-Config {
  New-Item -ItemType Directory -Force -Path $CfgDir -ErrorAction SilentlyContinue | Out-Null
  Restrict-FileToOwner $CfgDir
  if (Test-Path -LiteralPath $Cfg) {
    Info "config exists — preserved ($Cfg). See $WinSrc\..\turma-agent.env for new keys."
    return
  }
  $tmpl = Join-Path $RuntimeSrc 'native\turma-agent.env'
  if (-not (Test-Path -LiteralPath $tmpl)) { $tmpl = Join-Path $WinSrc 'turma-agent.env' }  # tarball: staged beside us
  if (-not (Test-Path -LiteralPath $tmpl)) { Warn "config template not found (looked in native\ and $WinSrc); skipping"; return }
  Info "writing config template $Cfg (edit TURMA_URL/TURMA_TOKEN)"
  $device = Coalesce $env:DEVICE_NAME $env:COMPUTERNAME ([System.Net.Dns]::GetHostName())
  $lines = [System.IO.File]::ReadAllLines($tmpl) | ForEach-Object {
    if ($_ -match '^DEVICE_NAME=') { "DEVICE_NAME=$device" } else { $_ }
  }
  Set-Content -LiteralPath $Cfg -Value $lines
  Restrict-FileToOwner $Cfg   # holds a bearer token
}

# =====================================================================================
# Service — render the WinSW descriptor and register + try-restart it (Windows only).
# =====================================================================================
# Render turma-agent.xml into bin\, substituting the installer placeholders: %BASE% -> the
# real prefix (WinSW's own %BASE% would be bin\ and mis-resolve the launcher path), and the
# TURMA_AGENT_ENV value -> the actual %APPDATA% config path. %USERPROFILE% in <logpath> is
# left for WinSW to expand at runtime.
function Render-ServiceXml {
  $src = Join-Path $WinSrc 'turma-agent.xml'
  if (-not (Test-Path -LiteralPath $src)) { Warn "service descriptor not found at $src; skipping service wiring"; return $false }
  New-Item -ItemType Directory -Force -Path $Bin -ErrorAction SilentlyContinue | Out-Null
  $xml = Get-Content -LiteralPath $src -Raw
  $xml = $xml -replace [regex]::Escape('%BASE%\..\turma-agent.env'), ([System.Security.SecurityElement]::Escape($Cfg))
  $xml = $xml -replace [regex]::Escape('%BASE%'), ([System.Security.SecurityElement]::Escape($Prefix))
  Set-Content -LiteralPath (Join-Path $Bin "$ServiceName.xml") -Value $xml
  return $true
}

function Install-Service {
  if (-not (Render-ServiceXml)) { return }
  if (-not $IsWindows) {
    Info "service: not Windows — descriptor rendered, WinSW registration skipped (start with: turma-agentctl start)"
    return
  }
  $exe = Join-Path $Bin "$ServiceName.exe"
  if (-not (Test-Path -LiteralPath $exe)) {
    Warn "WinSW ($exe) not present — service NOT registered."
    Warn "  Run without -NoInstallDeps (which downloads it), then re-run; or start unsupervised with"
    Warn "  'turma-agentctl start' (the pidfile fallback)."
    return
  }
  $ctl = Join-Path $Bin 'turma-agentctl.ps1'
  Info "registering the WinSW service via turma-agentctl"
  # `install` is idempotent-ish (WinSW re-install over an existing service updates it); a
  # running manager is then replaced by `restart` (session-preserving — the pty-hosts break
  # away and survive), the Windows twin of install.sh's `systemctl try-restart`.
  try { & $ctl install | Out-Null } catch { Warn "service install failed: $_" }
  try { & $ctl restart | Out-Null } catch {
    # No service yet to restart on a first install -> start it instead.
    try { & $ctl start | Out-Null } catch { Warn "could not start the service: $_" }
  }
  Info "service: turma-agentctl status"
}

# =====================================================================================
# -Verify — files, tools, config, service, login status table. Exit 1 if anything red.
# =====================================================================================
function Invoke-Verify {
  $ok = 0
  [Console]::Out.WriteLine("== turma native agent (windows): verify ==")
  $ver = if (Test-Path -LiteralPath (Join-Path $Prefix 'VERSION')) { Get-Content -LiteralPath (Join-Path $Prefix 'VERSION') -Raw } else { 'MISSING' }
  [Console]::Out.WriteLine("prefix: $Prefix (version $ver)")

  foreach ($f in $VerifyFiles) {
    if (Test-Path -LiteralPath (Join-Path $Prefix $f)) { [Console]::Out.WriteLine("  file ${f}: ok") }
    else { [Console]::Out.WriteLine("  file ${f}: MISSING"); $ok = 1 }
  }
  # The pty layer's built deps (what the per-session terminal actually needs at runtime).
  if (Test-Path -LiteralPath (Join-Path $Prefix 'win\node_modules\node-pty')) { [Console]::Out.WriteLine("  file win\node_modules\node-pty: ok") }
  else { [Console]::Out.WriteLine("  file win\node_modules\node-pty: MISSING (run without -NoInstallDeps)"); $ok = 1 }

  foreach ($t in @('python', 'node', 'git', 'claude')) {
    $cmd = Get-Command $t -ErrorAction SilentlyContinue
    if ($cmd) { [Console]::Out.WriteLine("  tool ${t}: $($cmd.Source)") }
    else { [Console]::Out.WriteLine("  tool ${t}: MISSING"); $ok = 1 }
  }
  # Optional but recommended — only private git / 'gh pr create' need it, so absence warns, not fails.
  if (Have 'gh') { [Console]::Out.WriteLine("  tool gh: $((Get-Command gh).Source)") }
  else { [Console]::Out.WriteLine("  tool gh: none (private git and 'gh pr create' need it)") }
  $maj = Get-NodeMajor
  [Console]::Out.WriteLine("  node major: $maj (need >= $NodeMajorMin)")
  if ($maj -gt 0 -and $maj -lt $NodeMajorMin) { $ok = 1 }

  if (Test-Path -LiteralPath $Cfg) {
    [Console]::Out.WriteLine("  config: $Cfg")
    $tokLine = (Get-Content -LiteralPath $Cfg -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*(export\s+)?TURMA_TOKEN=\S' })
    if ($tokLine) { [Console]::Out.WriteLine("  TURMA_TOKEN: set") }
    else { [Console]::Out.WriteLine("  TURMA_TOKEN: EMPTY (edit $Cfg)"); $ok = 1 }
  } else { [Console]::Out.WriteLine("  config: MISSING ($Cfg)"); $ok = 1 }

  # Service: prefer the real WinSW service (Windows), else the descriptor is at least present.
  $svc = $null
  try { $svc = Get-Service -Name $ServiceName -ErrorAction Stop } catch { }
  if ($svc) { [Console]::Out.WriteLine("  service: WinSW '$ServiceName' ($($svc.Status))") }
  elseif (Test-Path -LiteralPath (Join-Path $Bin "$ServiceName.xml")) { [Console]::Out.WriteLine("  service: descriptor present, not registered (turma-agentctl install)") }
  else { [Console]::Out.WriteLine("  service: not configured"); $ok = 1 }

  # Login status table.
  if (Test-Path -LiteralPath $Creds) { [Console]::Out.WriteLine("  claude login: present") }
  else { [Console]::Out.WriteLine("  claude login: MISSING (run: claude /login)"); $ok = 1 }
  if (Have 'gh') {
    & gh auth status *> $null
    if ($LASTEXITCODE -eq 0) { [Console]::Out.WriteLine("  gh auth: authenticated") }
    else { [Console]::Out.WriteLine("  gh auth: not logged in (run: gh auth login)") }
  }
  return $ok
}

# =====================================================================================
# -Uninstall — remove the prefix + service; PRESERVE config, ~/.turma, ~/.claude.
# =====================================================================================
function Invoke-Uninstall {
  Info "uninstalling from $Prefix"
  if ($IsWindows) {
    $ctl = Join-Path $Bin 'turma-agentctl.ps1'
    if (Test-Path -LiteralPath $ctl) {
      try { & $ctl uninstall | Out-Null } catch { }   # stops + deregisters the WinSW service
    }
  }
  if (Test-Path -LiteralPath $Prefix) { Remove-Item -Recurse -Force -LiteralPath $Prefix -ErrorAction SilentlyContinue }
  Info "removed $Prefix. Preserved: config ($CfgDir), $TurmaDir, $UserHome\.claude."
  Warn "already-running sessions are NOT stopped — the per-session pty-hosts break away and outlive the manager."
  Warn "  A fresh install re-adopts them on boot; to sweep them, stop them from the dashboard or end the pty-host processes."
  Info "remove config manually if desired:  Remove-Item -Recurse -Force '$CfgDir'"
}

# =====================================================================================
# main
# =====================================================================================
if ($Verify)    { exit (Invoke-Verify) }
if ($Uninstall) { Invoke-Uninstall; exit 0 }

Info "source: $RuntimeSrc"
if ($NoInstallDeps) {
  Info "-NoInstallDeps: skipping prerequisite installation"
} elseif ($IsWindows) {
  Ensure-BaseTools
  Ensure-WinSW
  Ensure-Claude
} else {
  Info "not Windows: skipping winget/npm provisioning (file lay-down still runs)"
}
Install-Files
if (-not $NoInstallDeps) { Ensure-PtyLayer }
Install-Config
Install-Service

[Console]::Out.WriteLine("")
Info "preflight:"
try { & (Join-Path $Bin 'turma-agent.ps1') -Preflight } catch { Warn "preflight could not run: $_" }
[Console]::Out.WriteLine("")
Info "Done. Next steps:"
Info "  1) Edit $Cfg — set TURMA_URL and TURMA_TOKEN (the hub's shared token to start; then"
Info "     roll onto this host's own token from the dashboard, with 'turma-agentctl enroll',"
Info "     or by setting TURMA_AGENT_SELF_ENROLL=1)."
Info "  2) Log in to Claude on this host if you haven't:  claude /login"
Info "  3) (optional) gh auth login   — for private git and 'gh pr create'."
if ($IsWindows) {
  Info "  4) It's running under the WinSW service:  turma-agentctl status"
} else {
  Info "  4) Start it:  turma-agentctl start"
}
