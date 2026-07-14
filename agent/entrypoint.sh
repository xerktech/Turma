#!/bin/sh
set -e

# ONE container per physical host. It no longer bakes a single repo/session:
# the Python session manager (hub-agent.py) scans REPOS_ROOT and multiplexes N
# worktree-backed Claude sessions, each with its own tmux (agent-<id>) + ttyd
# (127.0.0.1:<port>, base /term/<id>), created/killed from the Turma UI.
# This entrypoint resolves the identity to run as, does the Claude creds
# preflight, starts the reverse tunnel, and then hands off to the manager as the
# long-lived foreground process. The container stays up with ZERO sessions (no
# more "session ends -> PID 1 exits -> container restarts" loop;
# restart/clear-context is now a per-session op the manager performs).

# Which coding agent this container runs. Selected by the AGENT env var (set
# per-stack in DockerOps). Defaults to claude; only claude is wired up today
# (it reuses the host's login via the /root/.claude bind mount and is the only
# agent the manager knows how to Remote-Control). The other agents are still
# installed in the image for future use.
AGENT="${AGENT:-claude}"

# --- Run-as identity (agent-agnostic) --------------------------------------
# Everything this container produces lands in bind-mounted HOST directories: the
# git root (worktree checkouts and every file a session edits) and the Claude
# login (~/.claude transcripts + settings). Running as root means all of it is
# written back root-owned, and the operator can't touch their own repo or
# settings without sudo. So run as the uid/gid that OWNS the git root — by
# definition the host user whose repos these are.
#
# Auto-detected from REPOS_ROOT's owner, so no per-host config is needed:
#   * root-owned git root (the TrueNAS stack)   -> 0:0, we stay root as before
#   * user-owned git root (WSL / a desktop)     -> that uid:gid, we drop to it
# PUID/PGID in the compose env override the detection if a host needs something
# else; PUID=0 forces the old always-root behaviour.
REPOS_ROOT="${REPOS_ROOT:-/mnt/data/Docker/git}"
export REPOS_ROOT
PUID="${PUID:-$(stat -c %u "$REPOS_ROOT" 2>/dev/null || echo 0)}"
PGID="${PGID:-$(stat -c %g "$REPOS_ROOT" 2>/dev/null || echo 0)}"

RUN_USER=root
DROP_PRIV=no

# Gate on PUID alone: uid 0 IS root whatever the gid says, so a PUID=0 host stays
# on the byte-for-byte original path and PGID is moot there.
if [ "$PUID" = "0" ]; then
  echo "[entrypoint] identity: root — nothing to drop (REPOS_ROOT is root-owned, or PUID=0 forces it)"
else
  DROP_PRIV=yes
  # Reuse whatever passwd/group entry already claims these ids and only create
  # one when the id is genuinely free — the node base image ships node:node at
  # 1000:1000, which is exactly where a WSL/desktop host user usually lands.
  RUN_GROUP="$(getent group "$PGID" | cut -d: -f1)"
  if [ -z "$RUN_GROUP" ]; then
    RUN_GROUP=agent
    groupadd -g "$PGID" "$RUN_GROUP"
  fi
  RUN_USER="$(getent passwd "$PUID" | cut -d: -f1)"
  if [ -z "$RUN_USER" ]; then
    RUN_USER=agent
    useradd -u "$PUID" -g "$PGID" -M -d /root -s /bin/sh "$RUN_USER"
  else
    usermod -g "$PGID" -d /root "$RUN_USER"
  fi

  # HOME stays /root: every bind mount targets /root/.claude, /root/.claude.json
  # and /root/.config/gh, and hub-agent.py resolves ~/.turma and
  # /root/.claude/projects off it. Moving HOME would mean re-plumbing all of that
  # plus the DockerOps compose, so instead give /root to the run-as user.
  # Deliberately NOT recursive: /root's children are the host's own bind mounts,
  # already correctly owned host-side, and recursing would rewrite the
  # operator's real ~/.claude wholesale.
  export HOME=/root
  export USER="$RUN_USER"
  export LOGNAME="$RUN_USER"
  chown "$PUID:$PGID" /root

  # ~/.android is the one exception to the not-recursive rule above: it is image
  # content (baked root-owned by the Dockerfile's avdmanager step), not a host
  # bind mount, so recursing rewrites nothing of the operator's. The Android
  # toolchain needs it writable or it fails hard rather than degrading —
  # `assembleDebug` dies in :app:validateSigningDebug ("Unable to create debug
  # keystore in /root/.android because it is not writable") and the emulator
  # can't open the baked turma AVD. It is a few MB of metadata, so the recursive
  # chown is cheap. Created here when absent so an image without the SDK layer
  # still lands a writable dir.
  mkdir -p /root/.android
  chown -R "$PUID:$PGID" /root/.android

  # The docker socket: `docker` CLI backs the container self-inspect behind the
  # device-name probe and log tail, plus the hub-initiated restart. Root got that
  # for free; a dropped user needs to be in the group that owns the socket.
  # NOTE: on a host where the socket is root:root this joins group 0 — broad, but
  # it is the only way to keep those features working once we're not root.
  DOCKER_SOCK=/var/run/docker.sock
  if [ -S "$DOCKER_SOCK" ]; then
    SOCK_GID="$(stat -c %g "$DOCKER_SOCK")"
    SOCK_GROUP="$(getent group "$SOCK_GID" | cut -d: -f1)"
    if [ -z "$SOCK_GROUP" ]; then
      SOCK_GROUP=dockersock
      groupadd -g "$SOCK_GID" "$SOCK_GROUP"
    fi
    usermod -aG "$SOCK_GROUP" "$RUN_USER"
    echo "[entrypoint] docker socket: joined ${SOCK_GROUP}(${SOCK_GID})"
  fi

  # Self-heal the legacy root-owned files. Everything written before this image
  # learned to drop privileges is still root-owned on the host — which is the
  # very breakage this exists to end, and it does NOT fix itself, because the
  # operator can no longer chown what they no longer own. Reclaim it here, once:
  # after the first boot this is a scan that finds nothing. -h so a symlink is
  # retargeted rather than followed out of the tree.
  echo "[entrypoint] identity: ${RUN_USER}(${PUID}:${PGID}) — reclaiming root-owned leftovers..."
  for p in "$REPOS_ROOT" /root/.claude /root/.claude.json /root/.turma; do
    [ -e "$p" ] || continue
    find "$p" -uid 0 -exec chown -h "$PUID:$PGID" {} + 2>/dev/null || true
  done
  echo "[entrypoint] identity: ${RUN_USER}(${PUID}:${PGID}) ready"
fi

# Run a command as the resolved identity. A plain pass-through when we stayed
# root, so the TrueNAS stack executes byte-for-byte the same commands as before.
run_as() {
  if [ "$DROP_PRIV" = "no" ]; then
    "$@"
  else
    setpriv --reuid "$PUID" --regid "$PGID" --init-groups "$@"
  fi
}

# exec form of run_as — replaces this shell, for the final long-lived process.
exec_as() {
  if [ "$DROP_PRIV" = "no" ]; then
    exec "$@"
  else
    exec setpriv --reuid "$PUID" --regid "$PGID" --init-groups "$@"
  fi
}

# --- Claude-only preflight -------------------------------------------------
# Reuse the host's subscription login. Remote Control requires a subscription
# OAuth login (a setup-token is inference-only and can't host RC). Per-worktree
# bridge-pointer cleanup is NOT done here anymore — the manager drops each
# worktree's stale bridge pointer right before it (re)launches that session's
# claude, so a fresh session never reattaches to a dead RC bridge.
if [ "$AGENT" = "claude" ] || [ "$AGENT" = "claude-code" ]; then
  CREDS="/root/.claude/.credentials.json"
  if [ ! -f "$CREDS" ]; then
    echo "=================================================================="
    echo " No Claude subscription credentials at $CREDS"
    echo
    echo " This container reuses the host's login via the bind mount"
    echo "   /root/.claude:/root/.claude"
    echo " Make sure you're logged in on the host ('claude /login'), then"
    echo " restart this container. Remote Control requires a subscription"
    echo " OAuth login (a setup-token is inference-only and can't host RC)."
    echo
    echo " Idling until credentials exist..."
    echo "=================================================================="
    exec sleep infinity
  fi
fi

# --- GitHub auth preflight (agent-agnostic) --------------------------------
# git authenticates through the image's system credential helper
# (`gh auth git-credential`, set in /etc/gitconfig), so private clone/fetch/push
# and `gh pr create` all need a usable gh login in the mounted /root/.config/gh.
# This is a Linux container with NO OS keyring, so the token must be present as
# PLAINTEXT there (hosts.yml: oauth_token):
#   * Linux hosts store it that way already, so mounting the host's ~/.config/gh
#     works out of the box.
#   * Windows hosts keep it in Credential Manager, which this container can't
#     read; the mounted dir must be seeded FROM WITHIN THIS CONTAINER (never a
#     host script) — see the seed command printed below.
# Probed as the run-as identity, not root, so what it reports is what the
# sessions will actually get.
# Non-fatal: we log the state (and the fix) but still start the manager, so
# sessions that don't touch private git keep working.
if command -v gh >/dev/null 2>&1; then
  if run_as gh auth status >/dev/null 2>&1; then
    echo "[entrypoint] gh: authenticated as $(run_as gh api user -q .login 2>/dev/null || echo '?')"
  else
    echo "[entrypoint] gh: NOT authenticated — private git ops and 'gh pr create' will fail."
    echo "[entrypoint]   Seed/refresh the token from WITHIN this container (the host keyring"
    echo "[entrypoint]   is not readable here); it persists to the mounted /root/.config/gh:"
    echo "[entrypoint]     docker exec -it $(hostname) gh auth login --hostname github.com"
  fi
fi

# --- Host identity (agent-agnostic) ----------------------------------------
# The hub keys each agent by its physical host name (device). A container can't
# see that on its own, so hub-agent.py --print-device auto-detects it (host
# mount -> docker socket -> SMB to the Windows host on Docker Desktop / WSL2).
# Resolve it ONCE here and export, so the reverse tunnel and the session manager
# both register under the same identity (no per-process re-resolution, and the
# SMB probe runs at most once). An explicit DEVICE_NAME from the compose still
# wins. The sed pulls the DEVICE_NAME= line out of the manager's boot logs.
if [ -z "${DEVICE_NAME:-}" ]; then
  DEVICE_NAME="$(run_as python3 /usr/local/bin/hub-agent.py --print-device 2>/dev/null | sed -n 's/^DEVICE_NAME=//p' | tail -n1)"
  export DEVICE_NAME
  echo "[entrypoint] resolved device name: ${DEVICE_NAME:-<unresolved>}"
fi

# --- Hub infrastructure (agent-agnostic) -----------------------------------
# Background reverse tunnel to the hub for the web terminals. Keeps a persistent
# OUTBOUND WebSocket to TURMA_URL so the hub can reach this container's per-session
# ttyds from any network/host. The hub tells it which port to bridge per data
# channel (see agent/tunnel-agent.js + turma/server.js).
run_as node /usr/local/bin/tunnel-agent.js &

# Session manager + heartbeat, in the FOREGROUND as the container's long-lived
# process. It owns the persisted registry (~/.turma/sessions.json), scans
# REPOS_ROOT for repos, auto-resumes running sessions, executes hub commands
# (spawn/kill/start/restart/delete), and heartbeats repos[]+sessions[] to the
# hub. exec so it becomes the main process (clean signal handling / restarts).
echo "Starting Turma session manager (REPOS_ROOT=${REPOS_ROOT})..."
exec_as python3 /usr/local/bin/hub-agent.py
