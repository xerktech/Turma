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
TTYD_VERSION="1.7.7"          # matches agent/Dockerfile
NODE_MAJOR_MIN=22            # tunnel-agent.js needs the global WebSocket

DO=install
INSTALL_DEPS=yes
AUTOSTART=no
while [ $# -gt 0 ]; do
  case "$1" in
    --verify)          DO=verify ;;
    --uninstall)       DO=uninstall ;;
    --no-install-deps) INSTALL_DEPS=no ;;
    --autostart)       AUTOSTART=yes ;;
    --prefix)          shift; PREFIX="$1" ;;
    -h|--help)
      echo "usage: install.sh [--prefix DIR] [--no-install-deps] [--autostart] [--verify] [--uninstall]"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

info() { echo "[install] $*"; }
warn() { echo "[install] WARN: $*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
have_sudo() { command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; }

node_major() { have node && node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0; }
systemd_user_ok() { [ -d /run/systemd/system ] && systemctl --user show-environment >/dev/null 2>&1; }

SUDO=""
if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

# ---- prerequisites --------------------------------------------------------
ensure_apt_pkgs() {
  have apt-get || { warn "no apt-get — install manually: git tmux ripgrep ncurses-term python3 curl"; return 0; }
  if ! have_sudo && [ "$(id -u)" != 0 ]; then
    warn "no passwordless sudo — skipping apt. Ensure installed: git tmux ripgrep ncurses-term python3 curl"
    return 0
  fi
  info "apt: ensuring git tmux ripgrep ncurses-term python3 curl ca-certificates"
  $SUDO apt-get update -y
  $SUDO apt-get install -y --no-install-recommends \
    git tmux ripgrep ncurses-term python3 curl ca-certificates
}

ensure_node() {
  if [ "$(node_major)" -ge "$NODE_MAJOR_MIN" ]; then
    info "node $(node -v) OK"; return 0
  fi
  if have_sudo || [ "$(id -u)" = 0 ]; then
    info "installing Node ${NODE_MAJOR_MIN}.x (NodeSource)"
    # Download the setup script to a file and run it as a separate step rather
    # than piping curl straight into a shell (avoids the pipe-to-shell foot-gun;
    # the file could also be inspected/checksummed if ever needed).
    local ns; ns="$(mktemp)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" -o "$ns"
    $SUDO -E bash "$ns"
    rm -f "$ns"
    $SUDO apt-get install -y nodejs
  else
    warn "node >= ${NODE_MAJOR_MIN} required and no sudo. Install it via nvm"
    warn "  (see https://github.com/nvm-sh/nvm), then:  nvm install ${NODE_MAJOR_MIN}"
  fi
}

ensure_ttyd() {
  have ttyd && { info "ttyd present"; return 0; }
  # Prefer apt; fall back to the pinned static binary (like the Dockerfile).
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

# ---- file install ---------------------------------------------------------
install_files() {
  info "installing runtime files into $PREFIX"
  mkdir -p "$PREFIX/bin" "$PREFIX/hooks"
  cp "$SRC_DIR/hub-agent.py"     "$PREFIX/hub-agent.py"
  cp "$SRC_DIR/tunnel-agent.js"  "$PREFIX/tunnel-agent.js"
  cp "$SRC_DIR/tmux.conf"        "$PREFIX/tmux.conf"
  cp "$SRC_DIR"/hooks/*.py       "$PREFIX/hooks/"        # sibling to hub-agent.py (load-bearing)
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

install_config() {
  mkdir -p "$CFG_DIR"; chmod 700 "$CFG_DIR" 2>/dev/null || true
  if [ -f "$CFG" ]; then
    info "config exists — preserved ($CFG). See $SELF_DIR/turma-agent.env for new keys."
    return 0
  fi
  info "writing config template $CFG (edit TURMA_URL/TURMA_TOKEN)"
  sed "s/^DEVICE_NAME=.*/DEVICE_NAME=$(hostname)/" "$SELF_DIR/turma-agent.env" >"$CFG"
  chmod 600 "$CFG" 2>/dev/null || true   # holds a bearer token
}

install_tmux_conf() {
  if [ -f /etc/tmux.conf ]; then
    info "tmux: using existing /etc/tmux.conf"
  elif have_sudo || [ "$(id -u)" = 0 ]; then
    $SUDO cp "$PREFIX/tmux.conf" /etc/tmux.conf
    info "tmux: installed /etc/tmux.conf (truecolor passthrough for the web terminal)"
  elif [ ! -f "$HOME/.tmux.conf" ]; then
    cp "$PREFIX/tmux.conf" "$HOME/.tmux.conf"
    info "tmux: installed ~/.tmux.conf"
  else
    warn "$HOME/.tmux.conf exists; left as-is. If web-terminal colors look flat, add:"
    warn "  set -g default-terminal 'tmux-256color'"
    warn "  set -ga terminal-overrides ',*:RGB'"
  fi
}

# Rewrite %h-prefixed unit paths to the actual prefix/config for a custom --prefix.
_render_unit() {  # <src> <dst>
  sed -e "s|%h/.local/share/turma-agent|$PREFIX|g" \
      -e "s|%h/.config/turma-agent/turma-agent.env|$CFG|g" \
      "$1" >"$2"
}

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
  for f in hub-agent.py tunnel-agent.js hooks/guard.py hooks/ask.py \
           bin/turma-agent bin/turma-agentctl bin/turma-agent-update; do
    if [ -e "$PREFIX/$f" ]; then echo "  file $f: ok"; else echo "  file $f: MISSING"; ok=1; fi
  done
  for t in python3 node tmux ttyd claude git; do
    if have "$t"; then echo "  tool $t: $(command -v "$t")"; else echo "  tool $t: MISSING"; ok=1; fi
  done
  echo "  node major: $(node_major) (need >= $NODE_MAJOR_MIN)"
  if [ -f "$CFG" ]; then
    echo "  config: $CFG"
    if grep -q '^TURMA_TOKEN=.\+' "$CFG"; then echo "  TURMA_TOKEN: set"; else echo "  TURMA_TOKEN: EMPTY (edit $CFG)"; ok=1; fi
  else
    echo "  config: MISSING ($CFG)"; ok=1
  fi
  { [ -f /etc/tmux.conf ] || [ -f "$HOME/.tmux.conf" ]; } && echo "  tmux.conf: reachable" || echo "  tmux.conf: none (colors may degrade)"
  systemd_user_ok && echo "  service: systemd user" || echo "  service: nohup fallback (turma-agentctl)"
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
  else
    [ -x "$PREFIX/bin/turma-agentctl" ] && "$PREFIX/bin/turma-agentctl" stop 2>/dev/null || true
  fi
  rm -rf "$PREFIX"
  info "removed $PREFIX. Preserved: config ($CFG_DIR), ~/.turma, ~/.claude, /etc/tmux.conf."
  warn "already-running sessions are NOT stopped (tmux/ttyd outlive the manager)."
  warn "  sweep them with:  tmux ls | sed 's/:.*//' | grep '^agent-' | xargs -r -n1 tmux kill-session -t"
  info "remove config manually if desired:  rm -rf $CFG_DIR"
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
  ensure_claude
else
  info "--no-install-deps: skipping prerequisite installation"
fi
install_files
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
else
  info "  4) Start it:  $PREFIX/bin/turma-agentctl start"
fi
