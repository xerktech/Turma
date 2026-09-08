#!/usr/bin/env pwsh
# install.ps1 -- install the native (no-WSL) Turma agent on a Windows host (XERK-672,
# epic XERK-666; decisions in docs/windows-agent-adr.md, rules in
# .claude/rules/windows-launcher.md). The PowerShell port of agent/native/install.sh.
#
# Idempotent install / -Verify / -Uninstall: provisions the base tools (ADR D3 --
# winget for git/node/python/gh, npm for claude + the pty terminal layer, a pinned
# bundled WinSW.exe), lays the shared runtime files down keeping hub-agent.py's Python
# siblings + hooks/ BESIDE it (a missing sibling runs the agent DARK -- the XERK-528
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
# tarball. The XERK-528 lockstep is three packaging paths -- this installer's copy +
# -Verify list is ONE; the updater and release staging are the other two, in their own
# tasks. dsh is not provisioned on Windows (no Windows dsh toolchain in the ADR).

[CmdletBinding()]
param(
  # Install prefix. Empty -> a per-user default under %LOCALAPPDATA% (POSIX: ~/.local/share).
  [string]$Prefix = '',
  # Skip provisioning the prerequisites (winget/npm). The file lay-down, config, service
  # wiring and VERSION stamp still run -- idempotent, so a later run heals a missing tool.
  [switch]$NoInstallDeps,
  # Report-only: files, tools, config, service, login status table. Exit non-zero if red.
  [switch]$Verify,
  # Remove the prefix + service; PRESERVE config, ~/.turma and ~/.claude.
  [switch]$Uninstall,
  # Run the WinSW service as this user (e.g. 'CORP\alice' or '.\alice') instead of
  # LocalSystem, which cannot see the user's ~/.claude login (XERK-678). Empty ->
  # prompt when interactive (default: the current user), else leave LocalSystem.
  # The password comes from $env:TURMA_SERVICE_PASSWORD (unattended) or an interactive
  # prompt -- never a plaintext CLI param -- and is stored by the SCM, LSA-encrypted.
  [string]$ServiceAccount = '',
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
# derive it rather than fail under StrictMode -- the same guard the launcher/ctl make.
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
# tarball stages everything flat, so -- exactly like install.sh -- probe for hub-agent.py
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

# The -Verify presence list -- the exact siblings/hooks/tree whose absence runs a runtime
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
# Provisioning (ADR D3) -- winget for the base tools, npm for claude + the pty layer.
# Every step NAMES exactly what is missing and is idempotent (a present tool is left
# alone, a re-run heals a gap), mirroring the ensure_* functions of install.sh. All of
# this is Windows-only; the POSIX suite runs -NoInstallDeps so none of it fires there.
# =====================================================================================
# --- Direct (winget-less) prerequisite installers (XERK-678) ---------------------------
# winget ships as part of App Installer, which a Windows Server image or a stripped/older
# Windows install can simply not have -- there the old Install-WingetPackage could only WARN
# and skip, leaving git/node/python/gh uninstalled and the agent broken on exactly the
# "clean-machine one-liner" the epic promises (a real host hit this). These install each
# tool DIRECTLY from its vendor, MACHINE-WIDE so it lands on the SYSTEM PATH the WinSW
# service inherits. Each vendor spells its arch differently, hence the per-tool tag. The
# actual installer launch sits behind Invoke-ToolInstaller so the POSIX suite can drive the
# resolve/arch/download logic without a real installer, exactly as bootstrap.ps1's MSI
# fallback does. Best-effort: a failure WARNS with a manual path, never aborts the install.
$PythonVersion = Coalesce $env:TURMA_PYTHON_VERSION '3.12.8'
try {
  [Net.ServicePointManager]::SecurityProtocol = `
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

function Get-ToolArch {
  switch -Regex ("$env:PROCESSOR_ARCHITECTURE") {
    'ARM64'     { return 'arm64' }
    'AMD64|x64' { return 'x64' }
    default     { return 'x64' }   # unknown/absent -> the common case
  }
}
function Get-ToolJson([string]$Url) {
  return Invoke-RestMethod -Uri $Url -Headers @{ 'User-Agent' = 'turma-install' } -UseBasicParsing
}
function Get-ToolFile([string]$Url, [string]$OutFile) {
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -Headers @{ 'User-Agent' = 'turma-install' } -UseBasicParsing
}
# The one genuinely host-only step (a real installer, needing elevation) -- a seam so the
# suite drives the resolve/download without running it. Returns the process exit code.
function Invoke-ToolInstaller([string]$FilePath, [string[]]$Arguments) {
  $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru
  return $p.ExitCode
}
function Test-InstallerExit([int]$Code) { return ($Code -eq 0 -or $Code -eq 3010) }  # 3010 = ok, reboot pending

# A fresh machine-wide install lands on the SYSTEM PATH but not THIS process's PATH (read
# at start), so refresh $env:PATH from the registry after one, or a later Have/Ensure-Claude
# in the same run cannot resolve the tool just installed. No-op off Windows (Machine/User
# scopes return null there), so the POSIX suite is untouched.
function Update-ProcessPathFromMachine {
  try {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($m -or $u) { $env:PATH = (@($m, $u) | Where-Object { $_ }) -join ';' }
  } catch { }
}

function Install-NodeDirect {
  $arch = Get-ToolArch
  $idx = $null
  try { $idx = Get-ToolJson 'https://nodejs.org/dist/index.json' } catch { Warn "cannot reach nodejs.org dist index: $_"; return $false }
  $want = "win-$arch-msi"
  $pick = $null
  foreach ($e in @($idx)) {                    # index is newest-first
    $v = "$($e.version)"                        # e.g. v24.4.1
    if ($v -notmatch '^v(\d+)\.') { continue }
    if ([int]$Matches[1] -lt $NodeMajorMin) { continue }
    if (@($e.files) -notcontains $want) { continue }
    $pick = $v; break
  }
  if (-not $pick) { Warn "no Node >= $NodeMajorMin $arch MSI on nodejs.org"; return $false }
  $msi = Join-Path ([System.IO.Path]::GetTempPath()) "node-$pick-$arch.msi"
  Info "installing Node $pick ($arch) from nodejs.org"
  try { Get-ToolFile "https://nodejs.org/dist/$pick/node-$pick-$arch.msi" $msi } catch { Warn "Node download failed: $_"; return $false }
  $code = Invoke-ToolInstaller 'msiexec.exe' @('/i', "`"$msi`"", '/quiet', '/norestart', 'ADDLOCAL=ALL')
  Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
  return (Test-InstallerExit $code)
}
function Install-GitDirect {
  $arch = Get-ToolArch
  $rel = $null
  try { $rel = Get-ToolJson 'https://api.github.com/repos/git-for-windows/git/releases/latest' } catch { Warn "cannot reach Git for Windows releases: $_"; return $false }
  $re = if ($arch -eq 'arm64') { 'Git-.*-arm64\.exe$' } else { 'Git-.*-64-bit\.exe$' }
  $asset = $null
  foreach ($a in @($rel.assets)) { if ("$($a.name)" -match $re) { $asset = $a; break } }
  if (-not $asset) { Warn "no Git for Windows $arch installer in the latest release"; return $false }
  $exe = Join-Path ([System.IO.Path]::GetTempPath()) $asset.name
  Info "installing $($asset.name) from Git for Windows"
  try { Get-ToolFile $asset.browser_download_url $exe } catch { Warn "Git download failed: $_"; return $false }
  $code = Invoke-ToolInstaller $exe @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES')
  Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
  return (Test-InstallerExit $code)
}
function Install-PythonDirect {
  $tag = if ((Get-ToolArch) -eq 'arm64') { 'arm64' } else { 'amd64' }   # python.org uses amd64
  $exe = Join-Path ([System.IO.Path]::GetTempPath()) "python-$PythonVersion-$tag.exe"
  Info "installing Python $PythonVersion ($tag) from python.org"
  try { Get-ToolFile "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-$tag.exe" $exe } catch { Warn "Python download failed: $_"; return $false }
  $code = Invoke-ToolInstaller $exe @('/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_launcher=1', 'Include_pip=1')
  Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
  return (Test-InstallerExit $code)
}
function Install-GhDirect {
  $tag = if ((Get-ToolArch) -eq 'arm64') { 'arm64' } else { 'amd64' }   # gh uses amd64
  $rel = $null
  try { $rel = Get-ToolJson 'https://api.github.com/repos/cli/cli/releases/latest' } catch { Warn "cannot reach GitHub CLI releases: $_"; return $false }
  $re = "gh_.*_windows_$tag\.msi$"
  $asset = $null
  foreach ($a in @($rel.assets)) { if ("$($a.name)" -match $re) { $asset = $a; break } }
  if (-not $asset) { Warn "no GitHub CLI $tag MSI in the latest release"; return $false }
  $msi = Join-Path ([System.IO.Path]::GetTempPath()) $asset.name
  Info "installing $($asset.name) from GitHub CLI"
  try { Get-ToolFile $asset.browser_download_url $msi } catch { Warn "gh download failed: $_"; return $false }
  $code = Invoke-ToolInstaller 'msiexec.exe' @('/i', "`"$msi`"", '/quiet', '/norestart')
  Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
  return (Test-InstallerExit $code)
}
function Install-ToolDirect([string]$Cli) {
  switch ($Cli) {
    'node'   { return (Install-NodeDirect) }
    'git'    { return (Install-GitDirect) }
    'python' { return (Install-PythonDirect) }
    'gh'     { return (Install-GhDirect) }
    default  { return $false }
  }
}

function Install-WingetPackage([string]$Cli, [string]$Id) {
  if (Have $Cli) { Info "$Cli present"; return }
  # Prefer winget when it is there; fall back to a direct vendor install when it is not (or
  # when it ran but the tool still is not resolvable) -- so a winget-less box installs the
  # prereq instead of dead-ending on a WARN (XERK-678).
  if (Have 'winget') {
    Info "winget: installing $Cli ($Id)"
    try {
      & winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements | Out-Null
    } catch { }
    Update-ProcessPathFromMachine
    if (Have $Cli) { return }
    Warn "$Cli still not on PATH after winget; trying a direct install."
  } else {
    Info "$Cli missing and winget unavailable (older/Server SKU?); installing $Cli directly."
  }
  if (Install-ToolDirect $Cli) {
    Update-ProcessPathFromMachine
    if (Have $Cli) { Info "$Cli installed"; return }
    Warn "$Cli installed but not yet on this process's PATH; the service restart (or a new shell) picks it up."
  } else {
    Warn "$Cli could not be installed automatically. Install $Cli by hand, then re-run -- this is idempotent."
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
  if (-not (Have 'npm')) { Warn "npm not found -- cannot install claude; install Node first"; return }
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
    Warn "pty layer not laid down ($winDir\package.json missing) -- cannot install node-pty/ws"
    return
  }
  if (-not (Have 'npm')) { Warn "npm not found -- cannot install the pty layer (node-pty + ws); install Node first"; return }
  # Skip only when the built deps are present AND the lockfile they were built from is
  # UNCHANGED (a fingerprint stamped inside node_modules, so it travels with the preserved
  # tree across a re-lay). Bare presence would keep stale deps after a lockfile bump -- a
  # re-run is the interim upgrade path until the Windows updater child, so a bumped
  # package-lock.json must trigger a rebuild, while an unchanged one skips the needless one.
  $lockSrc = Join-Path $winDir 'package-lock.json'
  if (-not (Test-Path -LiteralPath $lockSrc)) { $lockSrc = Join-Path $winDir 'package.json' }
  $wantHash = (Get-FileHash -LiteralPath $lockSrc -Algorithm SHA256).Hash
  $stamp = Join-Path $winDir 'node_modules\.turma-deps-lock'
  $haveHash = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { '' }
  if ((Test-Path -LiteralPath (Join-Path $winDir 'node_modules\node-pty')) -and $haveHash -eq $wantHash) {
    Info "pty layer deps present (lockfile unchanged)"; return
  }
  Info "installing the pty terminal layer (node-pty + ws) into $winDir"
  try {
    if (Test-Path -LiteralPath (Join-Path $winDir 'package-lock.json')) {
      & npm --prefix $winDir ci | Out-Null
    } else {
      & npm --prefix $winDir install | Out-Null
    }
  } catch { }
  if (Test-Path -LiteralPath (Join-Path $winDir 'node_modules\node-pty')) {
    # Stamp the lockfile fingerprint so the next re-run can tell a stale tree from a current one.
    Set-Content -LiteralPath $stamp -Value $wantHash -NoNewline
  } else {
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
# File lay-down -- the shared runtime beside hub-agent.py, the pty layer, the Windows
# shell scripts, VERSION. Pure file ops, so it runs on any OS (drives the POSIX suite).
# =====================================================================================
# Re-lay $SrcDir onto $DstDir: remove the destination first for a CLEAN copy (a payload
# that stops shipping a file must not leave a stale one), but PRESERVE any subdirs named in
# $Preserve across the wipe -- used to carry a built win\node_modules over a source re-lay
# (the source tree has no node_modules, so a naive wipe would destroy the pty deps and,
# under -NoInstallDeps, never rebuild them -- a caught defect). Stashed to a SIBLING dir so
# the move stays on one volume (an atomic rename), then restored into the fresh destination.
function Copy-Tree([string]$SrcDir, [string]$DstDir, [string[]]$Preserve = @()) {
  $stashRoot = $null
  foreach ($name in $Preserve) {
    $p = Join-Path $DstDir $name
    if (Test-Path -LiteralPath $p) {
      if (-not $stashRoot) {
        $stashRoot = Join-Path (Split-Path -Parent $DstDir) (".turma-preserve-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $stashRoot -ErrorAction SilentlyContinue | Out-Null
      }
      Move-Item -LiteralPath $p -Destination (Join-Path $stashRoot $name)
    }
  }
  if (Test-Path -LiteralPath $DstDir) { Remove-Item -Recurse -Force -LiteralPath $DstDir -ErrorAction SilentlyContinue }
  Copy-Item -Recurse -Force -LiteralPath $SrcDir -Destination $DstDir
  if ($stashRoot) {
    foreach ($name in $Preserve) {
      $stashed = Join-Path $stashRoot $name
      if (Test-Path -LiteralPath $stashed) { Move-Item -LiteralPath $stashed -Destination (Join-Path $DstDir $name) }
    }
    Remove-Item -Recurse -Force -LiteralPath $stashRoot -ErrorAction SilentlyContinue
  }
}

function Install-Files {
  Info "installing runtime files into $Prefix"
  New-Item -ItemType Directory -Force -Path $Prefix, $Bin, (Join-Path $Prefix 'hooks') -ErrorAction SilentlyContinue | Out-Null

  foreach ($f in $RuntimeFiles) {
    $src = Join-Path $RuntimeSrc $f
    if (Test-Path -LiteralPath $src) { Copy-Item -Force -LiteralPath $src -Destination (Join-Path $Prefix $f) }
    else { Warn "source missing: $src (the agent would run dark without $f)" }
  }
  # hooks/*.py (load-bearing siblings of hub-agent.py -- a missing guard hook fails OPEN)
  $hookSrc = Join-Path $RuntimeSrc 'hooks'
  Get-ChildItem -LiteralPath $hookSrc -Filter '*.py' -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item -Force -LiteralPath $_.FullName -Destination (Join-Path $Prefix "hooks\$($_.Name)") }
  # qwen/ (stdlib-only tree, resolved relative to hub-agent.py's own dir)
  foreach ($d in $RuntimeDirs) {
    $src = Join-Path $RuntimeSrc $d
    if (Test-Path -LiteralPath $src) { Copy-Tree $src (Join-Path $Prefix $d) }
    else { Warn "source dir missing: $src" }
  }
  # win/ -- the ConPTY pty-host terminal layer (ADR D1), laid beside hub-agent.py so the
  # manager resolves <base>\win\pty-host.mjs (node_modules populated by Ensure-PtyLayer).
  $winSrcDir = Join-Path $RuntimeSrc 'win'
  # PRESERVE a built node_modules across the re-lay: the source has none, so a plain wipe
  # would destroy the pty deps and -- under -NoInstallDeps -- never rebuild them (QA finding).
  if (Test-Path -LiteralPath $winSrcDir) { Copy-Tree $winSrcDir (Join-Path $Prefix 'win') @('node_modules') }
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
# Config -- write the env template ONCE (never overwrite), owner-only ACL (chmod-600).
# =====================================================================================
# The cross-platform restrict_file_to_owner (ADR D4): on Windows an icacls owner-only NTFS
# ACL (disable inheritance, grant only the running user + SYSTEM); a no-op elsewhere. BEST-
# EFFORT and never fatal -- the bytes are already on disk, exactly as hub-agent.py's version.
function Restrict-FileToOwner([string]$Path) {
  if (-not $IsWindows) { return }
  try {
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls $Path /inheritance:r /grant:r "${me}:F" 'SYSTEM:F' | Out-Null
  } catch {
    Warn "icacls could not restrict $Path ($_) -- the token file is readable to other users on this host"
  }
}

function Install-Config {
  New-Item -ItemType Directory -Force -Path $CfgDir -ErrorAction SilentlyContinue | Out-Null
  Restrict-FileToOwner $CfgDir
  if (Test-Path -LiteralPath $Cfg) {
    Info "config exists -- preserved ($Cfg). See $WinSrc\..\turma-agent.env for new keys."
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
# Service -- render the WinSW descriptor and register + try-restart it (Windows only).
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

# --- Service run-as account (XERK-678) -------------------------------------------------
# The WinSW service MUST run as the user logged into Claude, not LocalSystem: the agent
# reads that user's ~/.claude login, gh auth and per-user tools, none of which LocalSystem's
# profile (C:\Windows\system32\config\systemprofile) can see -- so a LocalSystem service
# idles forever "no Claude credentials" on a fully logged-in host (a real-host finding).
# Running as a user account needs its PASSWORD and the "Log on as a service" right
# (SeServiceLogonRight); WinSW's own Change grants neither, so a bare reconfigure leaves the
# service unable to START. We set the credential via sc.exe (SCM stores it LSA-ENCRYPTED,
# never a plaintext file like WinSW's <serviceaccount> would) and grant the right via
# secedit. All BEST-EFFORT + $IsWindows-only; a failure warns with the manual path.
function Resolve-ServiceAccount([string]$Preset) {
  if ($Preset) { return $Preset }
  if ($env:TURMA_SERVICE_ACCOUNT) { return $env:TURMA_SERVICE_ACCOUNT }
  if (-not [Environment]::UserInteractive) { return '' }
  $default = if ($env:USERDOMAIN -and $env:USERNAME) { "$env:USERDOMAIN\$env:USERNAME" } else { "$env:USERNAME" }
  Info "The agent service must run as the user logged into Claude -- LocalSystem cannot see"
  Info "  ~/.claude, so it would idle. Enter that account, or leave blank to configure later."
  $ans = Read-Host "Service account [$default]"
  if (-not $ans) { $ans = $default }
  return $ans
}
# The plaintext password sc.exe needs, from the env (unattended) or an interactive
# SecureString prompt. Nothing is stored; the SCM re-encrypts it into LSA secrets.
function Get-ServicePassword {
  if ($env:TURMA_SERVICE_PASSWORD) { return $env:TURMA_SERVICE_PASSWORD }
  if (-not [Environment]::UserInteractive) { return '' }
  $sec = Read-Host "Password for the service account" -AsSecureString
  if (-not $sec) { return '' }
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function Get-AccountSid([string]$Account) {
  try {
    return (New-Object System.Security.Principal.NTAccount($Account)).Translate(
      [System.Security.Principal.SecurityIdentifier]).Value
  } catch { return '' }
}
function Grant-ServiceLogonRight([string]$Account) {
  $sid = Get-AccountSid $Account
  if (-not $sid) { Warn "could not resolve a SID for $Account; not granting the service-logon right"; return $false }
  $g = [guid]::NewGuid().ToString('N')
  $inf = Join-Path ([System.IO.Path]::GetTempPath()) "turma-secpol-$g.inf"
  $sdb = Join-Path ([System.IO.Path]::GetTempPath()) "turma-secpol-$g.sdb"
  try {
    # secedit reads/writes a UTF-16LE .inf. Get-Content auto-detects the BOM on read, but the
    # re-write MUST be Unicode too (Set-Content's default is ANSI on 5.1 / UTF-8 on 7), or
    # secedit /configure mis-parses it and the grant silently no-ops.
    & secedit /export /areas USER_RIGHTS /cfg $inf | Out-Null
    $lines = Get-Content -LiteralPath $inf
    $cur = ($lines | Where-Object { $_ -match '^SeServiceLogonRight' })
    if ($cur) {
      if ($cur -match [regex]::Escape("*$sid")) { Info "$Account already has the service-logon right"; return $true }
      $lines = $lines | ForEach-Object { if ($_ -match '^SeServiceLogonRight') { "$_,*$sid" } else { $_ } }
    } else {
      $lines = $lines | ForEach-Object { $_; if ($_ -match '^\[Privilege Rights\]') { "SeServiceLogonRight = *$sid" } }
    }
    Set-Content -LiteralPath $inf -Value $lines -Encoding Unicode
    & secedit /configure /db $sdb /cfg $inf /areas USER_RIGHTS | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch { Warn "granting the service-logon right failed: $_"; return $false }
  finally { Remove-Item -LiteralPath $inf, $sdb -Force -ErrorAction SilentlyContinue }
}
function Set-ServiceRunAsUser([string]$Account) {
  if (-not $IsWindows) { return }
  if (-not $Account) {
    Warn "service left as LocalSystem -- it will IDLE ('no Claude credentials'), since LocalSystem"
    Warn "  cannot see your ~/.claude login. Set the run-as user later by re-running:"
    Warn "    pwsh -File install.ps1 -ServiceAccount '$env:USERDOMAIN\$env:USERNAME'"
    return
  }
  $plain = Get-ServicePassword
  if (-not $plain) {
    Warn "no password for $Account; leaving the service as LocalSystem. Set TURMA_SERVICE_PASSWORD"
    Warn "  (unattended) or run the installer interactively, then re-run."
    return
  }
  if (-not (Grant-ServiceLogonRight $Account)) {
    Warn "could not grant $Account the service-logon right; the service may refuse to start as that user."
  }
  # sc.exe stores the credential LSA-encrypted (no plaintext file). The SPACE after obj=/
  # password= is required sc.exe syntax. The plaintext is briefly on sc.exe's argv -- an
  # accepted, transient exposure (WinSW's <serviceaccount> would persist it on disk instead).
  & sc.exe config $ServiceName obj= "$Account" password= "$plain" | Out-Null
  if ($LASTEXITCODE -ne 0) { Warn "sc.exe config (run-as $Account) exited $LASTEXITCODE" }
  else { Info "service configured to run as $Account (credential stored by the SCM, LSA-encrypted)" }
}

function Install-Service([string]$RunAsAccount = '') {
  if (-not (Render-ServiceXml)) { return }
  if (-not $IsWindows) {
    Info "service: not Windows -- descriptor rendered, WinSW registration skipped (start with: turma-agentctl start)"
    return
  }
  $exe = Join-Path $Bin "$ServiceName.exe"
  if (-not (Test-Path -LiteralPath $exe)) {
    Warn "WinSW ($exe) not present -- service NOT registered."
    Warn "  Run without -NoInstallDeps (which downloads it), then re-run; or start unsupervised with"
    Warn "  'turma-agentctl start' (the pidfile fallback)."
    return
  }
  $ctl = Join-Path $Bin 'turma-agentctl.ps1'
  Info "registering the WinSW service via turma-agentctl"
  # `install` is idempotent-ish (WinSW re-install over an existing service updates it); a
  # running manager is then replaced by `restart` (session-preserving -- the pty-hosts break
  # away and survive), the Windows twin of install.sh's `systemctl try-restart`.
  try { & $ctl install | Out-Null } catch { Warn "service install failed: $_" }
  # Reconfigure the run-as identity BEFORE the (re)start, so the service comes up as the user
  # and can see ~/.claude on its very first launch instead of idling as LocalSystem once.
  Set-ServiceRunAsUser $RunAsAccount
  try { & $ctl restart | Out-Null } catch {
    # No service yet to restart on a first install -> start it instead.
    try { & $ctl start | Out-Null } catch { Warn "could not start the service: $_" }
  }
  Info "service: turma-agentctl status"
}

# =====================================================================================
# -Verify -- files, tools, config, service, login status table. Exit 1 if anything red.
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
  # Optional but recommended -- only private git / 'gh pr create' need it, so absence warns, not fails.
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
# -Uninstall -- remove the prefix + service; PRESERVE config, ~/.turma, ~/.claude.
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
  Warn "already-running sessions are NOT stopped -- the per-session pty-hosts break away and outlive the manager."
  Warn "  A fresh install re-adopts them on boot; to sweep them, stop them from the dashboard or end the pty-host processes."
  Info "remove config manually if desired:  Remove-Item -Recurse -Force '$CfgDir'"
}

# =====================================================================================
# main
# =====================================================================================
# A test can dot-source this file to drive individual functions (e.g. the winget-less
# direct-installer resolvers) without running the install, exactly as bootstrap.ps1's
# TURMA_BOOTSTRAP_NORUN does. Off by default, so a real invocation always runs.
if ($env:TURMA_INSTALL_NORUN) { return }

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
# Resolve the run-as account at SCRIPT scope (may prompt on Windows) and hand it in, so the
# service comes up as the user rather than LocalSystem (XERK-678). Off Windows this is '' and
# Install-Service no-ops the service wiring anyway.
Install-Service (Resolve-ServiceAccount $ServiceAccount)

[Console]::Out.WriteLine("")
Info "preflight:"
try { & (Join-Path $Bin 'turma-agent.ps1') -Preflight } catch { Warn "preflight could not run: $_" }
[Console]::Out.WriteLine("")
Info "Done. Next steps:"
Info "  1) Edit $Cfg -- set TURMA_URL and TURMA_TOKEN (the hub's shared token to start; then"
Info "     roll onto this host's own token from the dashboard, with 'turma-agentctl enroll',"
Info "     or by setting TURMA_AGENT_SELF_ENROLL=1)."
Info "  2) Log in to Claude on this host if you haven't:  claude /login"
Info "  3) (optional) gh auth login   -- for private git and 'gh pr create'."
if ($IsWindows) {
  Info "  4) It's running under the WinSW service:  turma-agentctl status"
} else {
  Info "  4) Start it:  turma-agentctl start"
}
