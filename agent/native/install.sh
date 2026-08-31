#!/usr/bin/env bash
# install.sh — install the native (non-Docker) Turma agent on a WSL/Linux host.
#
# Reuses the host's built-in tooling instead of a container. Auto-installs any
# missing prerequisites (apt + npm + a pinned static ttyd), copies the runtime
# files into a prefix, writes a config template, wires a service (systemd user
# unit + auto-update timer, or a nohup fallback), runs a preflight, and prints
# next steps. Idempotent; also does --verify and --uninstall.
set -euo pipefail

# ---- paths & args ---------------------------------------------------------
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# Works from a repo checkout (runtime files one level up in agent/) AND from an
# extracted release tarball (runtime files sit right next to this script).
if [ -f "$SELF_DIR/hub-agent.py" ]; then SRC_DIR="$SELF_DIR"; else SRC_DIR="$(cd "$SELF_DIR/.." && pwd)"; fi

PREFIX="${PREFIX:-$HOME/.local/share/turma-agent}"
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/turma-agent"
CFG="$CFG_DIR/turma-agent.env"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TTYD_VERSION="1.7.7"          # pinned static ttyd binary
GLAB_VERSION="1.111.0"        # pinned static glab binary
NODE_MAJOR_MIN=24            # standardized on Node 24 (tunnel-agent.js needs the global WebSocket, Node 22+)
# dsh (DeepSeek Harness) toolchain — see the "dsh runtime" section below.
# The dsh CLI is installed at LATEST and kept current on every agent restart by
# turma-agent-update --dsh-only, exactly like Claude Code (XERK-496).
# npm >= 11 blocks install scripts by default; dsh's native sandbox/subprocess
# layer needs these to compile. Without them a dsh spawn is broken at runtime.
DSH_ALLOW_SCRIPTS="koffi,node-pty,@deepseek-ai/dsh-subprocess-local"
# Written into $PREFIX when the dsh toolchain is laid down; turma-agent-update
# reads it to keep the toolchain in step with a payload swap (and to stop
# managing it once a host has it no more).
DSH_MARKER="$PREFIX/.dsh"

DO=install
INSTALL_DEPS=yes
AUTOSTART=no
WITH_DSH=no
while [ $# -gt 0 ]; do
  case "$1" in
    --verify)          DO=verify ;;
    --uninstall)       DO=uninstall ;;
    --no-install-deps) INSTALL_DEPS=no ;;
    --autostart)       AUTOSTART=yes ;;
    --with-dsh)        WITH_DSH=yes ;;
    --prefix)          shift; PREFIX="$1" ;;
    -h|--help)
      echo "usage: install.sh [--prefix DIR] [--no-install-deps] [--autostart] [--with-dsh] [--verify] [--uninstall]"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# Whether to lay down the dsh toolchain (CLI @latest + driver/guard plugins +
# Python sibling modules) beside hub-agent.py. --with-dsh is the explicit name;
# TURMA_DSH=1 in the *environment* also opts in (convenient for an unattended
# re-run on a host whose config already enables the runtime). This is a SHIPPING
# gate: it decides whether the native install carries the dsh bits at all. The
# RUNTIME gate hub-agent.py reads is the separate TURMA_DSH in the config file.
dsh_wanted() {
  [ "$WITH_DSH" = yes ] && return 0
  case "${TURMA_DSH:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac
}

info() { echo "[install] $*"; }
warn() { echo "[install] WARN: $*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
# Can we get root for the prerequisites? Prefer a credential we already hold —
# NOPASSWD, or a live sudo timestamp (`sudo -n`) — and otherwise ASK, when there
# is a terminal to ask on.
#
# The -n-only probe was a trap under the README's `curl … | bash` quickstart: an
# ordinary password-sudo host looks sudo-less to it, so every apt prerequisite is
# skipped with one warning and the install still "succeeds" — without node, which
# is exactly how a host ends up with no reverse tunnel and every session reading
# "terminal offline". The pipe was never what stopped sudo asking: it prompts on
# /dev/tty, not stdin. Only this probe did.
#
# Gated on stderr being a terminal so an unattended run (CI, cron, a piped log)
# still fails fast rather than hanging on a password nobody is there to type.
# The answer is cached because a DECLINED prompt must not be re-asked once per
# prerequisite (sudo's own timestamp already covers the granted case).
SUDO_PROBE=""
have_sudo() {
  case "$SUDO_PROBE" in yes) return 0 ;; no) return 1 ;; esac
  if ! command -v sudo >/dev/null 2>&1; then SUDO_PROBE=no; return 1; fi
  if sudo -n true 2>/dev/null; then SUDO_PROBE=yes; return 0; fi
  if [ -t 2 ] && [ -r /dev/tty ]; then
    info "a prerequisite needs root — sudo will ask for your password."
    info "(only the prereqs run as root; the agent itself installs as $USER)"
    if sudo -v; then SUDO_PROBE=yes; return 0; fi
  fi
  SUDO_PROBE=no; return 1
}

node_major() { have node && node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0; }
systemd_user_ok() { [ -d /run/systemd/system ] && systemctl --user show-environment >/dev/null 2>&1; }

SUDO=""
if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

# ---- prerequisites --------------------------------------------------------
# Appliance distros can ship a PRESENT-but-disabled apt: TrueNAS SCALE replaces
# apt-get with a /usr/local/bin shim that prints "Package management tools are
# disabled" and exits 1 (the real binary has its exec bit stripped). So `have
# apt-get` passes, and under `set -e` the first apt call used to kill the whole
# install. Every apt call below is therefore non-fatal: warn and carry on, the
# same posture as having no apt at all — the missing tools get named, and the
# installer stays idempotent so they can be provided another way and re-run.
ensure_apt_pkgs() {
  have apt-get || { warn "no apt-get — install manually: git tmux ripgrep ncurses-term python3 curl"; return 0; }
  if ! have_sudo && [ "$(id -u)" != 0 ]; then
    warn "no sudo — skipping apt. Ensure installed: git tmux ripgrep ncurses-term python3 curl"
    warn "  then re-run this installer; it is idempotent."
    return 0
  fi
  info "apt: ensuring git tmux ripgrep ncurses-term python3 curl ca-certificates"
  if ! $SUDO apt-get update -y \
     || ! $SUDO apt-get install -y --no-install-recommends \
          git tmux ripgrep ncurses-term python3 curl ca-certificates; then
    warn "apt-get failed (disabled on this host? e.g. TrueNAS) — continuing."
    warn "  Ensure these exist some other way: git tmux ripgrep ncurses-term python3 curl"
  fi
}

# No-apt fallback: the official nodejs.org linux tarball, unpacked into
# $PREFIX/node with the binary symlinked into $PREFIX/bin — which the launcher
# already puts on PATH (it must: that is also where a static ttyd lands). The
# exact version is resolved from the latest-v<major>.x SHASUMS256.txt (a dead
# hardcoded patch version would strand the install), and the tarball is
# verified against that same file. .tar.gz, not .xz — gzip is everywhere, xz
# isn't. Glibc hosts only, like NodeSource; a musl host gets the warning path.
node_tarball_install() {
  local arch base sums tarball
  case "$(uname -m)" in
    x86_64) arch=x64 ;; aarch64) arch=arm64 ;;
    *) warn "no nodejs.org tarball for arch $(uname -m)"; return 1 ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR_MIN}.x"
  sums="$(mktemp)"
  curl -fsSL -o "$sums" "$base/SHASUMS256.txt" || { rm -f "$sums"; return 1; }
  tarball="$(grep -o "node-v[0-9.]*-linux-${arch}\.tar\.gz" "$sums" | head -n1)"
  [ -n "$tarball" ] || { rm -f "$sums"; return 1; }
  info "installing ${tarball%.tar.gz} -> $PREFIX/node (nodejs.org tarball)"
  curl -fsSL -o "$sums.tgz" "$base/$tarball" || { rm -f "$sums" "$sums.tgz"; return 1; }
  grep " $tarball\$" "$sums" | sed "s| $tarball\$| $sums.tgz|" | sha256sum -c - >/dev/null \
    || { warn "checksum mismatch on $tarball"; rm -f "$sums" "$sums.tgz"; return 1; }
  rm -rf "$PREFIX/node"
  mkdir -p "$PREFIX/node" "$PREFIX/bin"
  tar -xzf "$sums.tgz" -C "$PREFIX/node" --strip-components=1
  ln -sf "$PREFIX/node/bin/node" "$PREFIX/bin/node"
  rm -f "$sums" "$sums.tgz"
}

ensure_node() {
  if [ "$(node_major)" -ge "$NODE_MAJOR_MIN" ]; then
    info "node $(node -v) OK"; return 0
  fi
  if { have_sudo || [ "$(id -u)" = 0 ]; } && have apt-get; then
    info "installing Node ${NODE_MAJOR_MIN}.x (NodeSource)"
    # Download the setup script to a file and run it as a separate step rather
    # than piping curl straight into a shell (avoids the pipe-to-shell foot-gun;
    # the file could also be inspected/checksummed if ever needed). Non-fatal:
    # on a disabled-apt appliance (TrueNAS) both steps fail — fall through to
    # the tarball below instead of dying under set -e.
    local ns; ns="$(mktemp)"
    if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" -o "$ns" \
       && $SUDO -E bash "$ns" && $SUDO apt-get install -y nodejs; then
      rm -f "$ns"; return 0
    fi
    rm -f "$ns"
    warn "NodeSource/apt install failed — trying the nodejs.org tarball instead"
  fi
  if node_tarball_install; then
    return 0
  else
    # Worth more than a one-line warning: node is what runs the reverse tunnel,
    # so an install that lands without it leaves every session on this host
    # reading "terminal offline" in the UI, while the host itself reads online.
    # The agent now retries for node rather than needing a restart, so saying so
    # here is what turns a mystery into a two-minute fix.
    warn "node >= ${NODE_MAJOR_MIN} is MISSING and could not be installed."
    warn "  Without it the reverse tunnel cannot run, so every session on this host"
    warn "  will read 'terminal offline' in the UI. Install it, either:"
    warn "    sudo apt-get install -y nodejs   (or re-run this installer with sudo available)"
    warn "    nvm install ${NODE_MAJOR_MIN}          (see https://github.com/nvm-sh/nvm)"
    warn "  The running agent picks it up on its own within seconds — no restart needed."
  fi
}

ensure_ttyd() {
  have ttyd && { info "ttyd present"; return 0; }
  # Prefer apt; fall back to the pinned static binary.
  if have apt-get && { have_sudo || [ "$(id -u)" = 0 ]; } && $SUDO apt-get install -y ttyd 2>/dev/null; then
    info "ttyd installed via apt"; return 0
  fi
  local arch; arch="$(uname -m)"
  case "$arch" in x86_64|aarch64) : ;; *) warn "no ttyd for arch $arch — install manually"; return 0 ;; esac
  info "downloading static ttyd $TTYD_VERSION ($arch) into $PREFIX/bin"
  mkdir -p "$PREFIX/bin"
  curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${arch}" \
    -o "$PREFIX/bin/ttyd"
  chmod +x "$PREFIX/bin/ttyd"
}

ensure_claude() {
  have claude && { info "claude present"; return 0; }
  have npm || { warn "npm not found — cannot install claude; install Node first"; return 0; }
  info "installing @anthropic-ai/claude-code (npm -g)"
  if ! npm install -g @anthropic-ai/claude-code 2>/dev/null; then
    warn "global npm install failed (EACCES?). Fix with a user prefix, then re-run:"
    warn "  npm config set prefix ~/.local && export PATH=~/.local/bin:\$PATH"
  fi
}

ensure_dsh() {
  # Install the LATEST dsh CLI into ~/.local — the prefix the launcher already
  # puts on PATH (XERK-94), so `dsh` just works for the agent. npm >= 11 blocks
  # install scripts by default; dsh's native build deps (koffi, node-pty,
  # @deepseek-ai/dsh-subprocess-local) must be allowed or dsh's sandbox /
  # subprocess layer is broken at runtime even though the package "installs".
  # A present CLI is left alone here; turma-agent-update --dsh-only keeps it
  # current on every agent restart (the same model as Claude Code).
  have npm || { warn "npm not found — cannot install the dsh CLI"; return 0; }
  if have dsh; then
    info "dsh present: $(dsh --version 2>/dev/null)"; return 0
  fi
  info "installing @deepseek-ai/dsh@latest (npm -g --prefix ~/.local)"
  if ! npm install -g --prefix "$HOME/.local" \
       --allow-scripts="$DSH_ALLOW_SCRIPTS" \
       "@deepseek-ai/dsh" 2>/dev/null; then
    warn "dsh CLI install failed. npm >= 11 needs the native-build scripts allowed"
    warn "  so koffi / node-pty / @deepseek-ai/dsh-subprocess-local compile:"
    warn "  npm install -g --prefix ~/.local --allow-scripts=$DSH_ALLOW_SCRIPTS @deepseek-ai/dsh"
  fi
}

ensure_gh() {
  have gh && { info "gh present"; return 0; }
  # gh powers auto-update against the private repo and private git ops.
  if have apt-get && { have_sudo || [ "$(id -u)" = 0 ]; } && $SUDO apt-get install -y gh 2>/dev/null; then
    info "gh installed via apt"
  else
    warn "gh not installed (optional but needed for auto-update on a private repo"
    warn "  and for private git/PR). Install it from https://cli.github.com and run 'gh auth login'."
  fi
}

ensure_glab() {
  # glab is how a session opens a GitLab MR that Turma can attribute — the MR
  # counterpart of `gh pr create`. Without it a session improvises with the raw
  # GitLab API and the MR never gets a chip. Static binary from GitLab's own
  # releases, pinned to GLAB_VERSION; best-effort like gh — a GitHub-only host
  # loses nothing.
  have glab && { info "glab present"; return 0; }
  local arch; arch="$(uname -m)"
  case "$arch" in
    x86_64)  arch=amd64 ;;
    aarch64) arch=arm64 ;;
    *) warn "no glab for arch $arch — GitLab MR chips need it; install manually"; return 0 ;;
  esac
  info "downloading static glab $GLAB_VERSION ($arch) into $PREFIX/bin"
  mkdir -p "$PREFIX/bin"
  if ! curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.tar.gz" \
      | tar -xz --strip-components=1 -C "$PREFIX/bin" bin/glab 2>/dev/null; then
    warn "glab download failed (optional — only GitLab MR creation needs it)"
    return 0
  fi
  chmod +x "$PREFIX/bin/glab"
}

# ---- file install ---------------------------------------------------------
install_files() {
  info "installing runtime files into $PREFIX"
  mkdir -p "$PREFIX/bin" "$PREFIX/hooks"
  cp "$SRC_DIR/hub-agent.py"     "$PREFIX/hub-agent.py"
  cp "$SRC_DIR/tunnel-agent.js"  "$PREFIX/tunnel-agent.js"
  cp "$SRC_DIR/tmux.conf"        "$PREFIX/tmux.conf"
  cp "$SRC_DIR"/hooks/*.py       "$PREFIX/hooks/"        # sibling to hub-agent.py (load-bearing)
  # Shared runtime scaffolding (XERK-528): imported by BOTH the dsh and qwen
  # transcript/tail siblings, so lay them down UNCONDITIONALLY like qwen's — a
  # host with either runtime that lacks them runs that runtime DARK (the
  # transcript import fails, the projector is None: no transcript/summary/PR/usage).
  cp "$SRC_DIR/runtime_projection.py" "$PREFIX/runtime_projection.py"
  cp "$SRC_DIR/runtime_tail.py"       "$PREFIX/runtime_tail.py"
  # qwen runtime (XERK-504+): the Python siblings (imported by _launch_qwen /
  # _start_qwen_tail) and agent/qwen/ (MCP servers, peer-inbox forger, guard
  # shim — all resolved relative to hub-agent.py's own dir). Stdlib-only and
  # only touched on a qwen launch, and qwen is core-enabled (QWEN_ENABLED), so
  # unlike the dsh toolchain they lay down UNCONDITIONALLY here — no --with-qwen,
  # no marker. A missing qwen_session.py is exactly the "No module named
  # 'qwen_session'" spawn failure on a TURMA_QWEN=1 host.
  cp "$SRC_DIR/qwen_session.py"    "$PREFIX/qwen_session.py"
  cp "$SRC_DIR/qwen_transcript.py" "$PREFIX/qwen_transcript.py"
  rm -rf "$PREFIX/qwen"; cp -a "$SRC_DIR/qwen" "$PREFIX/qwen"
  cp "$SELF_DIR/turma-agent"        "$PREFIX/bin/turma-agent"
  cp "$SELF_DIR/turma-agentctl"     "$PREFIX/bin/turma-agentctl"
  cp "$SELF_DIR/turma-agent-update" "$PREFIX/bin/turma-agent-update"
  chmod +x "$PREFIX/hub-agent.py" "$PREFIX/tunnel-agent.js" \
           "$PREFIX/bin/turma-agent" "$PREFIX/bin/turma-agentctl" \
           "$PREFIX/bin/turma-agent-update" "$PREFIX/hooks/"*.py
  # Record the installed native version (read by the updater and --verify). The
  # release tarball ships a stamped VERSION next to the files; a repo checkout
  # falls back to the repo-root VERSION (bare MAJOR.MINOR, which still sorts
  # below any published patch, so a dev install updates up to the latest).
  if [ -f "$SRC_DIR/VERSION" ]; then
    tr -d '[:space:]' <"$SRC_DIR/VERSION" >"$PREFIX/VERSION"
  elif [ -f "$SRC_DIR/../VERSION" ]; then
    tr -d '[:space:]' <"$SRC_DIR/../VERSION" >"$PREFIX/VERSION"
  else
    echo "0.0.0-dev" >"$PREFIX/VERSION"
  fi
  info "installed version $(cat "$PREFIX/VERSION")"
}

# Lay the dsh toolchain beside hub-agent.py. Its paths resolve relative to that
# file's own dir — DSH_PLUGIN_DIR = <dir>/dsh-session-driver, the guard at
# <dir>/dsh/guard, and _launch_dsh imports dsh_session/dsh_transcript as Python
# siblings — so they must live in $PREFIX exactly as in repo's agent/:
#   dsh_session.py, dsh_transcript.py       beside hub-agent.py
#   dsh-session-driver/ (with the committed dist/)   -> $PREFIX/dsh-session-driver
#   dsh/guard/                               -> $PREFIX/dsh/guard
# The CLI is a separate dependency install (ensure_dsh, in the deps pass).
install_dsh_files() {
  info "installing dsh toolchain into $PREFIX (driver + guard + python siblings)"
  mkdir -p "$PREFIX/dsh-session-driver" "$PREFIX/dsh/guard"
  cp "$SRC_DIR/dsh_session.py"      "$PREFIX/dsh_session.py"
  cp "$SRC_DIR/dsh_transcript.py"   "$PREFIX/dsh_transcript.py"
  cp -a "$SRC_DIR/dsh-session-driver/"* "$PREFIX/dsh-session-driver/"
  cp -a "$SRC_DIR/dsh/guard/"*           "$PREFIX/dsh/guard/"
  # The driver plugin is npm-installed into the dsh profile as-is, with NO build
  # step, so the compiled dist/ must be present or _ensure_dsh_profile refuses
  # every dsh spawn. Failing loudly here beats a host that ships a broken driver.
  if [ ! -f "$PREFIX/dsh-session-driver/dist/index.js" ]; then
    warn "dsh-session-driver/dist/index.js is MISSING — _ensure_dsh_profile will"
    warn "  refuse every dsh spawn. Build it:"
    warn "  npm --prefix $SRC_DIR/dsh-session-driver install"
    warn "  npm --prefix $SRC_DIR/dsh-session-driver run build"
  fi
  echo "1" >"$DSH_MARKER"
  info "dsh toolchain installed (CLI @latest, kept current by turma-agent-update)"
}

install_config() {
  mkdir -p "$CFG_DIR"; chmod 700 "$CFG_DIR" 2>/dev/null || true
  if [ -f "$CFG" ]; then
    info "config exists — preserved ($CFG). See $SELF_DIR/turma-agent.env for new keys."
    return 0
  fi
  info "writing config template $CFG (edit TURMA_URL/TURMA_TOKEN)"
  sed "s/^DEVICE_NAME=.*/DEVICE_NAME=$(hostname)/" "$SELF_DIR/turma-agent.env" >"$CFG"
  # A --with-dsh install WANTS the runtime on this host, so seed TURMA_DSH=1 in a
  # FRESH config — that is the switch hub-agent.py's dsh_configured() reads (the
  # install-time gate already decided to ship the bits). A preserved config is
  # left alone; the operator toggles it by editing this one line.
  if dsh_wanted; then
    printf '# dsh runtime (DeepSeek Harness) — client plugins + CLI were installed by install.sh --with-dsh\nTURMA_DSH=1\n' >>"$CFG"
  fi
  chmod 600 "$CFG" 2>/dev/null || true   # holds a bearer token
}

# A preserved (non-Turma) tmux.conf is the one silent parity gap vs the
# container, which always ships ours at /etc/tmux.conf: without the bundled
# settings the web terminal's truecolor flattens AND every copy made in it is
# dropped (the OSC 52 chain — the Ms override + set-clipboard on — is what
# forwards a copy to the viewer's clipboard; XERK-7). Colors failing are
# visible; the clipboard failing is not, so say so rather than leaving it to be
# discovered one lost copy at a time. Keyed on set-clipboard, the setting every
# copy path needs; escapes in the Ms line make it a poor thing to transcribe
# from a warn, so point at the bundled file to merge from instead.
_tmux_conf_check() {  # <conf in effect>
  grep -q "set-clipboard" "$1" 2>/dev/null && return 0
  warn "$1 lacks the web terminal's settings (truecolor + copy-to-clipboard)."
  warn "  Merge the lines from $PREFIX/tmux.conf into it, or copies made in the"
  warn "  web terminal are silently dropped and colors flatten."
}

install_tmux_conf() {
  if [ -f /etc/tmux.conf ]; then
    info "tmux: using existing /etc/tmux.conf"
    _tmux_conf_check /etc/tmux.conf
  elif have_sudo || [ "$(id -u)" = 0 ]; then
    $SUDO cp "$PREFIX/tmux.conf" /etc/tmux.conf
    info "tmux: installed /etc/tmux.conf (truecolor + OSC 52 clipboard for the web terminal)"
  elif [ ! -f "$HOME/.tmux.conf" ]; then
    cp "$PREFIX/tmux.conf" "$HOME/.tmux.conf"
    info "tmux: installed ~/.tmux.conf"
  else
    warn "$HOME/.tmux.conf exists; left as-is."
    _tmux_conf_check "$HOME/.tmux.conf"
  fi
}

# Rewrite %h-prefixed unit paths to the actual prefix/config for a custom --prefix.
_render_unit() {  # <src> <dst>
  sed -e "s|%h/.local/share/turma-agent|$PREFIX|g" \
      -e "s|%h/.config/turma-agent/turma-agent.env|$CFG|g" \
      "$1" >"$2"
}

# System-scope variant, for a root install with no user bus (TrueNAS-style
# appliance): default.target is a user-manager target, and a system service
# gets NO $HOME (the launcher's config/default paths all hang off it), so both
# are rendered in explicitly.
_render_system_unit() {  # <src> <dst>
  _render_unit "$1" /dev/stdout \
    | sed -e "s|WantedBy=default.target|WantedBy=multi-user.target|" \
          -e "/^\[Service\]/a\\
Environment=HOME=$HOME" >"$2"
}

# Root on a systemd host usually has no per-user manager (nothing ever logs
# root in through logind — `systemctl --user` just says "Failed to connect to
# bus"). The agent should still be a supervised service there, not a nohup
# orphan, so it lands as SYSTEM units instead.
systemd_system_ok() { [ -d /run/systemd/system ] && [ "$(id -u)" = 0 ]; }
SYS_UNIT_DIR=/etc/systemd/system

install_service() {
  if systemd_user_ok; then
    info "systemd user manager detected — installing units"
    mkdir -p "$UNIT_DIR"
    _render_unit "$SELF_DIR/turma-agent.service"         "$UNIT_DIR/turma-agent.service"
    _render_unit "$SELF_DIR/turma-agent-update.service"  "$UNIT_DIR/turma-agent-update.service"
    cp "$SELF_DIR/turma-agent-update.timer"              "$UNIT_DIR/turma-agent-update.timer"
    systemctl --user daemon-reload
    systemctl --user enable --now turma-agent.service
    systemctl --user enable --now turma-agent-update.timer
    # `enable --now` STARTS a stopped service but does nothing to a running one,
    # so on a re-run the old process keeps running against the files we just
    # replaced. That silently made re-running the installer — the natural fix for
    # a first install that landed without node, and the documented way to update
    # a checkout — a no-op on the very host that needed it. try-restart replaces
    # a running manager (KillMode=process, so the live sessions are re-adopted,
    # not killed) and stays quiet about a stopped one, which `--now` just started.
    systemctl --user try-restart turma-agent.service
    # Keep the user manager alive across logout (so the agent survives with no
    # shell open). Best-effort; needs a one-time sudo.
    if have loginctl; then
      if $SUDO loginctl enable-linger "$USER" 2>/dev/null; then
        info "lingering enabled for $USER"
      else
        warn "could not enable-linger (run: sudo loginctl enable-linger $USER)"
      fi
    fi
    info "service: systemctl --user status turma-agent"
  elif systemd_system_ok; then
    info "no user bus, running as root — installing SYSTEM units"
    _render_system_unit "$SELF_DIR/turma-agent.service"        "$SYS_UNIT_DIR/turma-agent.service"
    _render_system_unit "$SELF_DIR/turma-agent-update.service" "$SYS_UNIT_DIR/turma-agent-update.service"
    cp "$SELF_DIR/turma-agent-update.timer"                    "$SYS_UNIT_DIR/turma-agent-update.timer"
    systemctl daemon-reload
    systemctl enable --now turma-agent.service
    systemctl enable --now turma-agent-update.timer
    # Same re-run semantics as the user branch: replace a running manager
    # (KillMode=process keeps the live sessions), leave a just-started one be.
    systemctl try-restart turma-agent.service
    info "service: systemctl status turma-agent"
  else
    warn "no systemd user bus (WSL without [boot] systemd=true) — using the nohup fallback"
    info "start it with:  $PREFIX/bin/turma-agentctl start"
    if [ "$AUTOSTART" = yes ]; then _install_autostart; fi
  fi
}

_install_autostart() {
  local marker="# turma-agent autostart (install.sh --autostart)"
  local rc="$HOME/.bashrc"
  if [ -f "$rc" ] && grep -qF "$marker" "$rc"; then
    info "autostart already present in $rc"; return 0
  fi
  {
    echo ""
    echo "$marker"
    echo "command -v turma-agentctl >/dev/null 2>&1 && turma-agentctl start >/dev/null 2>&1 || \"$PREFIX/bin/turma-agentctl\" start >/dev/null 2>&1 || true"
  } >>"$rc"
  info "added autostart to $rc"
}

# ---- verify / uninstall ---------------------------------------------------
do_verify() {
  local ok=0
  echo "== turma native agent: verify =="
  echo "prefix: $PREFIX (version $( [ -f "$PREFIX/VERSION" ] && cat "$PREFIX/VERSION" || echo MISSING))"
  for f in hub-agent.py tunnel-agent.js hooks/guard.py hooks/fileguard.py \
           hooks/ask.py hooks/statusline.py \
           runtime_projection.py runtime_tail.py \
           qwen_session.py qwen_transcript.py \
           qwen/ask_mcp.py qwen/peer_mcp.py qwen/peer_inbox.py qwen/guard/shim.py \
           bin/turma-agent bin/turma-agentctl bin/turma-agent-update; do
    if [ -e "$PREFIX/$f" ]; then echo "  file $f: ok"; else echo "  file $f: MISSING"; ok=1; fi
  done
  for t in python3 node tmux ttyd claude git; do
    if have "$t"; then echo "  tool $t: $(command -v "$t")"; else echo "  tool $t: MISSING"; ok=1; fi
  done
  # Optional — only GitLab MR creation needs it, so absence doesn't fail verify.
  have glab && echo "  tool glab: $(command -v glab)" || echo "  tool glab: none (GitLab MR chips need it)"
  # dsh (when this host has the toolchain laid down): the driver dist + guard are
  # what _ensure_dsh_profile refuses a spawn without, and `dsh` is the CLI.
  if [ -f "$DSH_MARKER" ]; then
    for f in dsh_session.py dsh_transcript.py \
             dsh-session-driver/dist/index.js dsh/guard/index.mjs; do
      if [ -e "$PREFIX/$f" ]; then echo "  file $f: ok"; else echo "  file $f: MISSING"; ok=1; fi
    done
    if have dsh; then echo "  tool dsh: $(command -v dsh) ($(dsh --version 2>/dev/null))"; else echo "  tool dsh: MISSING"; ok=1; fi
  else
    echo "  dsh toolchain: not installed (run install.sh --with-dsh to enable)"
  fi
  echo "  node major: $(node_major) (need >= $NODE_MAJOR_MIN)"
  if [ -f "$CFG" ]; then
    echo "  config: $CFG"
    if grep -q '^TURMA_TOKEN=.\+' "$CFG"; then echo "  TURMA_TOKEN: set"; else echo "  TURMA_TOKEN: EMPTY (edit $CFG)"; ok=1; fi
  else
    echo "  config: MISSING ($CFG)"; ok=1
  fi
  { [ -f /etc/tmux.conf ] || [ -f "$HOME/.tmux.conf" ]; } && echo "  tmux.conf: reachable" || echo "  tmux.conf: none (colors may degrade)"
  if systemd_user_ok; then echo "  service: systemd user"
  elif systemd_system_ok; then echo "  service: systemd system"
  else echo "  service: nohup fallback (turma-agentctl)"; fi
  [ -f "$HOME/.claude/.credentials.json" ] && echo "  claude login: present" || echo "  claude login: MISSING (run: claude /login)"
  return $ok
}

do_uninstall() {
  info "uninstalling from $PREFIX"
  if systemd_user_ok; then
    systemctl --user disable --now turma-agent.service 2>/dev/null || true
    systemctl --user disable --now turma-agent-update.timer 2>/dev/null || true
    rm -f "$UNIT_DIR/turma-agent.service" "$UNIT_DIR/turma-agent-update.service" "$UNIT_DIR/turma-agent-update.timer"
    systemctl --user daemon-reload 2>/dev/null || true
  elif systemd_system_ok && [ -f "$SYS_UNIT_DIR/turma-agent.service" ]; then
    systemctl disable --now turma-agent.service 2>/dev/null || true
    systemctl disable --now turma-agent-update.timer 2>/dev/null || true
    rm -f "$SYS_UNIT_DIR/turma-agent.service" "$SYS_UNIT_DIR/turma-agent-update.service" "$SYS_UNIT_DIR/turma-agent-update.timer"
    systemctl daemon-reload 2>/dev/null || true
  else
    [ -x "$PREFIX/bin/turma-agentctl" ] && "$PREFIX/bin/turma-agentctl" stop 2>/dev/null || true
  fi
  rm -rf "$PREFIX"
  info "removed $PREFIX. Preserved: config ($CFG_DIR), ~/.turma, ~/.claude, /etc/tmux.conf."
  warn "already-running sessions are NOT stopped (tmux/ttyd outlive the manager)."
  warn "  sweep them with:  tmux ls | sed 's/:.*//' | grep '^agent-' | xargs -r -n1 tmux kill-session -t"
  info "remove config manually if desired:  rm -rf $CFG_DIR"
  # The dsh CLI was installed into ~/.local (outside the prefix) by --with-dsh;
  # flag it rather than silently leaving a ~150 MB npm tree behind.
  if have dsh; then
    warn "the dsh CLI stays installed in ~/.local. Remove it too with:"
    warn "  npm uninstall -g --prefix ~/.local @deepseek-ai/dsh"
  fi
}

# ---- main -----------------------------------------------------------------
case "$DO" in
  verify)    do_verify; exit $? ;;
  uninstall) do_uninstall; exit 0 ;;
esac

info "source: $SRC_DIR"
if [ "$INSTALL_DEPS" = yes ]; then
  ensure_apt_pkgs
  ensure_node
  ensure_ttyd
  ensure_gh
  ensure_glab
  ensure_claude
  if dsh_wanted; then ensure_dsh; fi
else
  info "--no-install-deps: skipping prerequisite installation"
fi
install_files
if dsh_wanted; then install_dsh_files; fi
install_config
install_tmux_conf
install_service

echo
info "preflight:"
"$PREFIX/bin/turma-agent" --preflight || true
echo
info "Done. Next steps:"
info "  1) Edit $CFG — set TURMA_URL and TURMA_TOKEN."
info "  2) Log in to Claude on this host if you haven't:  claude /login"
info "  3) (optional) gh auth login   — for private git and 'gh pr create'."
if systemd_user_ok; then
  info "  4) It's running under systemd:  systemctl --user status turma-agent"
elif systemd_system_ok; then
  info "  4) It's running under systemd (system):  systemctl status turma-agent"
else
  info "  4) Start it:  $PREFIX/bin/turma-agentctl start"
fi
if dsh_wanted; then
  info "  5) dsh is ready. A dsh session needs a model route in $CFG —"
  info "     set DSH_MODEL_BASE_URL + DSH_MODEL (fall back to LOCAL_MODEL_*) before spawning one."
fi
