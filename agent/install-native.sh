#!/bin/sh
# Native (no-container) install of the Turma per-host agent.
#
# For hosts that can't run the turma-agent container — e.g. TrueNAS SCALE,
# whose read-only /usr and disabled apt make normal package installs fail
# (and whose noexec /tmp breaks the usual curl-and-run installers). Everything
# lands under $HOME/.local, which is writable on TrueNAS, survives across
# boots, and is already on root's PATH there; the agent then runs under
# systemd as turma-agent.service.
#
# What it does (idempotent — re-run to refresh the agent files or retry):
#   1. Installs the runtime binaries such hosts are usually missing: ttyd
#      (static release binary, checksum-verified) and node (official
#      linux-x64 tarball, checksum-verified). Skipped when already on PATH.
#      python3, tmux, git, and the coding agent (claude) must already exist —
#      the script checks and says exactly what's missing rather than failing
#      mid-way.
#   2. Copies the agent files (hub-agent.py, tunnel-agent.js, hooks/) from
#      this checkout into $HOME/.local/share/turma-agent and writes the
#      launcher (run.sh) that mirrors the container entrypoint: resolve
#      DEVICE_NAME once, start the reverse tunnel, exec the session manager.
#   3. Seeds /etc/tmux.conf from agent/tmux.conf (left alone if present).
#   4. With TURMA_STATE_DIR=<dir> set, symlinks ~/.turma to it so a prior
#      container install's state (session registry, closed history, usage
#      ledger, Jira pins) carries straight over — point it at whatever the
#      container mounted at /root/.turma.
#   5. Writes /etc/turma-agent.env (chmod 600) if missing. TURMA_TOKEN must
#      then be filled in before the agent can heartbeat.
#   6. Installs turma-agent.service, enables it, and (re)starts it.
#
# Usage, as root, from a Turma checkout:
#   sh agent/install-native.sh
#   TURMA_STATE_DIR=/mnt/data/Docker/Turma-agent sh agent/install-native.sh
#
# TrueNAS upgrade caveat: an OS upgrade builds a fresh boot environment, which
# can drop /etc/systemd/system/turma-agent.service and /etc/tmux.conf (the
# binaries and agent files under $HOME/.local survive). Re-run this script
# after an upgrade; existing state and /etc/turma-agent.env are kept.
set -eu

TTYD_VERSION="${TTYD_VERSION:-1.7.7}"   # match agent/Dockerfile
NODE_MAJOR="${NODE_MAJOR:-24}"          # match the image's node:24 base

PREFIX="${TURMA_NATIVE_PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin"
APP="$PREFIX/share/turma-agent"
ENV_FILE="/etc/turma-agent.env"
UNIT_FILE="/etc/systemd/system/turma-agent.service"
SRC="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$SRC/hub-agent.py" ]; then
  echo "error: run from a Turma checkout (agent/hub-agent.py not found next to this script)" >&2
  exit 1
fi

# --- Preflight: what must already be on the host ----------------------------
missing=""
for tool in python3 tmux git curl tar sha256sum systemctl; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo "error: required tools not found on this host:$missing" >&2
  exit 1
fi
command -v claude >/dev/null 2>&1 || \
  echo "WARNING: 'claude' not on PATH — install it (https://claude.ai/install.sh) and log in, or sessions will fail to spawn."

mkdir -p "$BIN" "$APP"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- ttyd (static binary, per-session web terminals) ------------------------
if command -v ttyd >/dev/null 2>&1; then
  echo "[install] ttyd: already present ($(command -v ttyd))"
else
  echo "[install] ttyd ${TTYD_VERSION} -> $BIN/ttyd"
  base="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}"
  curl -fsSL -o "$tmp/ttyd.x86_64" "$base/ttyd.x86_64"
  curl -fsSL "$base/SHA256SUMS" | grep ' ttyd\.x86_64$' > "$tmp/ttyd.sum"
  (cd "$tmp" && sha256sum -c ttyd.sum >/dev/null)
  install -m 755 "$tmp/ttyd.x86_64" "$BIN/ttyd"
fi

# --- node (runs tunnel-agent.js, the reverse tunnel) ------------------------
if command -v node >/dev/null 2>&1; then
  echo "[install] node: already present ($(command -v node))"
else
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  tarball="$(grep -o "node-v[0-9.]*-linux-x64\.tar\.xz" "$tmp/SHASUMS256.txt" | head -n1)"
  if [ -z "$tarball" ]; then
    echo "error: could not resolve a node ${NODE_MAJOR}.x linux-x64 tarball from $base" >&2
    exit 1
  fi
  echo "[install] ${tarball%.tar.xz} -> $PREFIX/node (node symlinked into $BIN)"
  curl -fsSL -o "$tmp/$tarball" "$base/$tarball"
  grep " $tarball\$" "$tmp/SHASUMS256.txt" > "$tmp/node.sum"
  (cd "$tmp" && sha256sum -c node.sum >/dev/null)
  rm -rf "$PREFIX/node"
  mkdir -p "$PREFIX/node"
  tar -xJf "$tmp/$tarball" -C "$PREFIX/node" --strip-components=1
  ln -sf "$PREFIX/node/bin/node" "$BIN/node"
fi

# --- Agent files ------------------------------------------------------------
# hooks/ must stay a sibling of hub-agent.py — guard_path()/ask_path() resolve
# relative to the script's own directory.
echo "[install] agent files -> $APP"
install -m 644 "$SRC/hub-agent.py" "$APP/hub-agent.py"
install -m 644 "$SRC/tunnel-agent.js" "$APP/tunnel-agent.js"
mkdir -p "$APP/hooks"
install -m 755 "$SRC/hooks/"*.py "$APP/hooks/"

# tmux sits between the TUI and the browser terminal; without this config it
# quantizes colors and swallows passthrough sequences (see tmux.conf).
if [ -f /etc/tmux.conf ]; then
  echo "[install] /etc/tmux.conf: already present, leaving as is"
else
  install -m 644 "$SRC/tmux.conf" /etc/tmux.conf
fi

# --- State dir --------------------------------------------------------------
# hub-agent.py resolves its state as ~/.turma. If the operator names a prior
# container install's state dir, link it in so history carries over.
if [ -n "${TURMA_STATE_DIR:-}" ] && [ "$HOME/.turma" != "$TURMA_STATE_DIR" ]; then
  if [ -e "$HOME/.turma" ] && [ ! -L "$HOME/.turma" ]; then
    echo "error: $HOME/.turma already exists and is not a symlink; move it aside or unset TURMA_STATE_DIR" >&2
    exit 1
  fi
  mkdir -p "$TURMA_STATE_DIR"
  ln -sfn "$TURMA_STATE_DIR" "$HOME/.turma"
  echo "[install] ~/.turma -> $TURMA_STATE_DIR"
fi

# --- Launcher ---------------------------------------------------------------
# Mirrors the container entrypoint (agent/entrypoint.sh): resolve the device
# name once so the tunnel and the manager register under one identity, start
# the reverse tunnel in the background, exec the session manager in the
# foreground. systemd kills the whole cgroup on stop/restart, so the tunnel
# never outlives the manager.
cat > "$APP/run.sh" <<EOF
#!/bin/sh
set -u
export PATH="$BIN:\$PATH"
if [ -z "\${DEVICE_NAME:-}" ]; then
  DEVICE_NAME="\$(python3 "$APP/hub-agent.py" --print-device 2>/dev/null | sed -n 's/^DEVICE_NAME=//p' | tail -n1)"
  export DEVICE_NAME
  echo "[run] resolved device name: \${DEVICE_NAME:-<unresolved>}"
fi
node "$APP/tunnel-agent.js" &
exec python3 "$APP/hub-agent.py"
EOF
chmod 755 "$APP/run.sh"

# --- Environment ------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  echo "[install] $ENV_FILE: already present, leaving as is"
else
  cat > "$ENV_FILE" <<'EOF'
# Environment for the native turma-agent (turma-agent.service). Same knobs the
# container took in DockerOps compose — see the Turma repo's CLAUDE.md.
AGENT=claude
LANG=C.UTF-8
LC_ALL=C.UTF-8
TZ=America/New_York
# Sessions run as root; bypassPermissions is refused under root without this.
IS_SANDBOX=1
# Git root this host exposes (scanned one level deep for repos).
REPOS_ROOT=/mnt/data/Docker/git
MAX_SESSIONS=6
TTYD_PORT_BASE=7700
TURMA_INTERVAL=8
# Where to reach the hub, and the shared agent token (= the hub's
# TURMA_AGENT_TOKEN). The agent cannot heartbeat until the token is set.
TURMA_URL=https://turma.xerktech.com
TURMA_TOKEN=CHANGE_ME
# Optional Jira polling for the /board Kanban (all three empty = feature off).
#JIRA_SITE=
#JIRA_EMAIL=
#JIRA_TOKEN=
EOF
  chmod 600 "$ENV_FILE"
  echo "[install] wrote $ENV_FILE — set TURMA_TOKEN (and any host-specific values) there"
fi

# --- systemd unit -----------------------------------------------------------
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Turma per-host agent (session manager + reverse tunnel)
Documentation=https://github.com/xerktech/Turma
Wants=network-online.target
After=network-online.target docker.service

[Service]
EnvironmentFile=$ENV_FILE
Environment=HOME=$HOME
ExecStart=$APP/run.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable turma-agent.service
if grep -q '^TURMA_TOKEN=CHANGE_ME$' "$ENV_FILE"; then
  echo "[install] NOT starting: $ENV_FILE still has TURMA_TOKEN=CHANGE_ME."
  echo "[install] Fill it in, then: systemctl restart turma-agent"
else
  systemctl restart turma-agent.service
  echo "[install] turma-agent.service started"
fi

echo "[install] done. Logs: journalctl -u turma-agent -f"
