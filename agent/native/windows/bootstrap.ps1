#!/usr/bin/env pwsh
# bootstrap.ps1 — one-command install of the latest native Turma agent on Windows
# (XERK-673, epic XERK-666; the PowerShell port of agent/native/bootstrap.sh, rules
# in .claude/rules/windows-launcher.md, decisions in docs/windows-agent-adr.md).
#
# The Windows front door for a host that just wants the agent, not the source. One
# pasted line does the ENTIRE job — resolve the newest windows-native asset, download
# it, sha256-verify it, unpack it to a temp dir, and hand off to the install.ps1
# inside it — so the operator does nothing but paste it (and, once, `claude /login`):
#
#   irm https://raw.githubusercontent.com/xerktech/turma/main/agent/native/windows/bootstrap.ps1 | iex
#
# Passthrough options (the Windows analog of `bash -s -- --verify …`) need the call form,
# since a piped `iex` cannot forward args:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/xerktech/turma/main/agent/native/windows/bootstrap.ps1))) -Verify
#   & ([scriptblock]::Create((irm .../bootstrap.ps1))) -Prefix 'D:\turma' -NoInstallDeps
#
# Once installed, the Windows self-updater (XERK-674) keeps the host current; this
# script is only the way IN. It deliberately duplicates none of install.ps1 —
# prerequisites, config, the ACL and the service are all still that script's job.
#
# ---------------------------------------------------------------------------------
# TWO Windows-specific wrinkles the Linux bootstrap does not have:
#
# 1. It MUST run under Windows PowerShell 5.1. A clean box has 5.1 (`powershell.exe`),
#    NOT PowerShell 7 — nothing has provisioned 7 yet — so `irm | iex` lands in 5.1.
#    Hence this file uses ONLY 5.1-safe surface: no $IsWindows, no ternary/`??`, no
#    `Set-StrictMode -Version Latest` reads of Core-only automatics. JSON parsing is
#    ConvertFrom-Json (built into 5.1 — the Windows analog of "parser-light": no
#    external tool, unlike bootstrap.sh which must grep because python isn't there yet).
#
# 2. install.ps1 REQUIRES PowerShell 7 ($IsWindows under StrictMode Latest). PowerShell
#    is the INTERPRETER the installer runs under, and an installer cannot provision the
#    interpreter it is already running in — the one genuine chicken-and-egg with no
#    Linux analog (bash is always present). So the single prerequisite this front door
#    legitimately ensures is pwsh 7 itself (via winget, if missing), then it hands the
#    unpacked install.ps1 to that pwsh. Everything else stays install.ps1's job.
# ---------------------------------------------------------------------------------

# NO param()/[CmdletBinding()] on purpose. This is a passthrough front door: every
# argument — named switches and their values alike (-Verify, -Uninstall, -Prefix
# 'D:\turma', -NoInstallDeps) — must land in the automatic $args verbatim to forward to
# install.ps1, the analog of bootstrap.sh's `install.sh "$@"`. An advanced function with
# a declared param would instead REJECT an unknown -Foo as a binding error, which is
# exactly what an arbitrary install.ps1 flag is to this script — so capture with $args.

$ErrorActionPreference = 'Stop'   # a resolve/download/verify failure must abort, never
                                  # limp on to a half-baked handoff.

$Repo = if ($env:TURMA_REPO) { $env:TURMA_REPO } else { 'xerktech/turma' }
$Api  = "https://api.github.com/repos/$Repo/releases?per_page=100"

# The windows-native release asset (XERK-676 will produce it; XERK-674's updater reads
# the same name). Parity with bootstrap.sh's turma-agent-native-v<ver>.tar.gz, but a
# .zip so the unpack is Expand-Archive — built into 5.1, no tar dependency.
$AssetRe = '^turma-agent-windows-v([0-9]+(?:\.[0-9]+)*)\.zip$'

# The temp working dir, registered here the moment it exists so Die can sweep it. The
# happy path is cleaned in Invoke-Bootstrap's finally; but a refusal (bad/missing
# checksum, download or unpack failure, malformed asset) exits THROUGH Die, which is
# before that finally, so without this the downloaded (possibly tampered) zip would be
# left in %TEMP% forever — the parity gap vs bootstrap.sh's `trap 'rm -rf' EXIT`.
$script:WorkDir = $null
function Remove-WorkDir {
  if ($script:WorkDir) {
    Remove-Item -Recurse -Force -LiteralPath $script:WorkDir -ErrorAction SilentlyContinue
    $script:WorkDir = $null
  }
}
function Die([string]$Message)  { Remove-WorkDir; [Console]::Error.WriteLine("[bootstrap] ERROR: $Message"); exit 1 }
function Info([string]$Message) { [Console]::Out.WriteLine("[bootstrap] $Message") }

# TLS 1.2 for the GitHub API on Windows PowerShell 5.1, whose default can still be
# SSLv3/TLS1.0 and is refused by GitHub. No-op / harmless on pwsh 7.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# --- HTTP helpers (overridable in tests) -------------------------------------------
# Thin wrappers so the behavioural suite can substitute a fake release stream / asset
# store without a network, exactly as test_bootstrap.sh stubs `curl` on PATH.
function Get-ReleaseJson([string]$Url) {
  # Anonymous by design: the repo is public, so no gh login or token here (unlike the
  # updater, which must also work against a private repo post-install).
  return Invoke-RestMethod -Uri $Url -Headers @{ 'User-Agent' = 'turma-bootstrap' } -UseBasicParsing
}
function Get-ReleaseFile([string]$Url, [string]$OutFile) {
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -Headers @{ 'User-Agent' = 'turma-bootstrap' } -UseBasicParsing
}

# --- resolve the newest windows-native asset ---------------------------------------
# Picked by the version in the ASSET's own filename, not by release tag — the trap
# bootstrap.sh documents: a release umbrella carries an unchanged component forward
# under its ORIGINAL older name (turma-agent-windows-v0.3.0.zip can sit on the v0.4.0
# release), so the highest tag does not always name the highest windows build, but the
# highest filename version always IS the newest windows build. Deriving the name from
# the tag would ask for an asset that was never built (a 404).
function Resolve-Asset {
  Info "resolving the latest windows agent from $Repo"
  $releases = $null
  try { $releases = Get-ReleaseJson $Api } catch { Die "cannot reach the GitHub release API" }
  if ($null -eq $releases) { Die "cannot reach the GitHub release API" }

  $best = $null
  foreach ($rel in @($releases)) {
    # Guard against a release with no assets array (drafts, image-only releases).
    if (-not ($rel.PSObject.Properties.Name -contains 'assets')) { continue }
    foreach ($asset in @($rel.assets)) {
      $name = [string]$asset.name
      $m = [regex]::Match($name, $AssetRe)
      if (-not $m.Success) { continue }
      $ver = $null
      # A malformed version string simply doesn't win, rather than aborting the scan.
      if (-not [version]::TryParse($m.Groups[1].Value, [ref]$ver)) { continue }
      $url = [string]$asset.browser_download_url
      if (-not $url) { continue }
      if (($null -eq $best) -or ($ver -gt $best.Version)) {
        $best = [pscustomobject]@{ Version = $ver; Name = $name; Url = $url }
      }
    }
  }
  if ($null -eq $best) { Die "no windows agent release found for $Repo" }
  Info "found $($best.Name)"
  return $best
}

# --- download, verify, unpack ------------------------------------------------------
# Returns the temp dir holding the unpacked, checksum-verified tree (install.ps1 at
# its root beside hub-agent.py — the flat layout the release asset ships and that
# install.ps1's own source-probe expects).
function Get-VerifiedTree($Asset) {
  $work = Join-Path ([System.IO.Path]::GetTempPath()) ("turma-bootstrap-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $script:WorkDir = $work   # register for Die's sweep before anything can refuse below

  $zip = Join-Path $work $Asset.Name
  $sha = "$zip.sha256"
  try { Get-ReleaseFile $Asset.Url $zip } catch { Die "download failed: $($Asset.Url)" }
  try { Get-ReleaseFile "$($Asset.Url).sha256" $sha }
  catch { Die "no checksum published for $($Asset.Name) — refusing to install unverified bits" }

  # The sidecar is the sha256sum(1) format: "<hex>  <filename>". Take the first token.
  $want = ((Get-Content -LiteralPath $sha -Raw) -split '\s+' | Where-Object { $_ })[0]
  if (-not $want) { Die "empty checksum sidecar for $($Asset.Name) — refusing to install" }
  $have = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
  if ($have.ToLowerInvariant() -ne $want.ToLowerInvariant()) {
    Die "checksum mismatch on $($Asset.Name) — refusing to install"
  }
  Info "checksum OK"

  $unpack = Join-Path $work 'unpacked'
  New-Item -ItemType Directory -Force -Path $unpack | Out-Null
  try { Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force }
  catch { Die "could not unpack $($Asset.Name): $_" }

  # A zip may nest everything under a single top folder; normalise so install.ps1 sits
  # at the returned root either way.
  $root = $unpack
  if (-not (Test-Path -LiteralPath (Join-Path $root 'install.ps1'))) {
    $sub = @(Get-ChildItem -LiteralPath $unpack -Directory)
    if ($sub.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $sub[0].FullName 'install.ps1'))) {
      $root = $sub[0].FullName
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'install.ps1'))) {
    Die "$($Asset.Name) has no install.ps1 — malformed release asset"
  }
  return @{ Work = $work; Root = $root }
}

# --- resolve a PowerShell 7 to run install.ps1 under -------------------------------
# install.ps1 is pwsh-7-only ($IsWindows under StrictMode Latest); this front door runs
# under whatever the operator pasted into, usually 5.1. So find pwsh 7, installing it via
# winget when genuinely absent — it is the interpreter the installer needs, and an
# installer cannot provision its own interpreter (see the header). Returns a pwsh path.
# Known 64-/32-bit Program Files install dirs — filtered for a null root (a 32-bit host
# has no ProgramFiles(x86)) so a probe never throws before the winget/fallback path.
function Get-PwshCandidatePaths {
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  return $roots | ForEach-Object { Join-Path $_ 'PowerShell\7\pwsh.exe' }
}
function Resolve-Pwsh {
  # Already in pwsh 7+? Use this very process's own executable.
  if ($PSVersionTable.PSVersion.Major -ge 6) { return (Get-Process -Id $PID).Path }

  $cmd = Get-Command 'pwsh' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  # Common winget/MSI install locations that may not be on THIS shell's PATH yet.
  foreach ($p in (Get-PwshCandidatePaths)) { if (Test-Path -LiteralPath $p) { return $p } }

  # Not present — install it. This is the ONE prerequisite the front door owns.
  if (-not (Get-Command 'winget' -ErrorAction SilentlyContinue)) {
    Die ("PowerShell 7 is required to run the installer and winget is unavailable to install it. " +
         "Install PowerShell 7 (https://aka.ms/powershell) or 'winget install --id Microsoft.PowerShell', then re-run.")
  }
  Info "installing PowerShell 7 (winget: Microsoft.PowerShell) — the installer requires it"
  try {
    & winget install --id Microsoft.PowerShell --exact --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } catch { }

  $cmd = Get-Command 'pwsh' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in (Get-PwshCandidatePaths)) { if (Test-Path -LiteralPath $p) { return $p } }
  Die "PowerShell 7 still not found after winget install — install it from https://aka.ms/powershell, then re-run"
}

# ===================================================================================
# main — resolve, verify, unpack, hand off. Returns the installer's exit code. Kept a
# function so the behavioural suite can drive it after substituting the HTTP + pwsh
# helpers above (there is no PATH-stubbable `curl` here, unlike test_bootstrap.sh); the
# guard at the bottom auto-runs it for real invocation (`iex`, scriptblock, or -File).
# ===================================================================================
function Invoke-Bootstrap([string[]]$ForwardArgs = @()) {
  $asset = Resolve-Asset
  $tree  = Get-VerifiedTree $asset
  try {
    $pwshExe = Resolve-Pwsh
    $installPs1 = Join-Path $tree.Root 'install.ps1'

    # Run install.ps1 as a real FILE (so its $PSCommandPath source-probe resolves the
    # unpacked tree beside it) under pwsh 7 with policy bypassed and no profile — the
    # analog of bootstrap.sh running install.sh THROUGH bash. Not copied into the prefix,
    # so a later -Verify/-Uninstall re-runs through this same download+unpack path.
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installPs1)
    if ($ForwardArgs -and $ForwardArgs.Count -gt 0) { $argv += $ForwardArgs }
    & $pwshExe @argv
    return $LASTEXITCODE
  }
  finally {
    # Best-effort cleanup of the whole temp tree, whatever install.ps1 did. Same dir Die
    # would have swept — Remove-WorkDir is idempotent, so the two paths never conflict.
    Remove-WorkDir
  }
}

if (-not $env:TURMA_BOOTSTRAP_NORUN) { exit (Invoke-Bootstrap $args) }
