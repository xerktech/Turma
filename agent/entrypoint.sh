#!/bin/sh
set -e

# ONE container per physical host. It no longer bakes a single repo/session:
# the Python session manager (hub-agent.py) scans REPOS_ROOT and multiplexes N
# worktree-backed Claude sessions, each with its own tmux (agent-<id>) + ttyd
# (127.0.0.1:<port>, base /term/<id>), created/killed from the Agent Hub UI.
# This entrypoint just does the Claude creds preflight, starts the reverse
# tunnel, and then hands off to the manager as the long-lived foreground
# process. The container stays up with ZERO sessions (no more "session ends ->
# PID 1 exits -> container restarts" loop; restart/clear-context is now a
# per-session op the manager performs).

# Which coding agent this container runs. Selected by the AGENT env var (set
# per-stack in DockerOps). Defaults to claude; only claude is wired up today
# (it reuses the host's login via the /root/.claude bind mount and is the only
# agent the manager knows how to Remote-Control). The other agents are still
# installed in the image for future use.
AGENT="${AGENT:-claude}"

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
# Non-fatal: we log the state (and the fix) but still start the manager, so
# sessions that don't touch private git keep working.
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    echo "[entrypoint] gh: authenticated as $(gh api user -q .login 2>/dev/null || echo '?')"
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
  DEVICE_NAME="$(python3 /usr/local/bin/hub-agent.py --print-device 2>/dev/null | sed -n 's/^DEVICE_NAME=//p' | tail -n1)"
  export DEVICE_NAME
  echo "[entrypoint] resolved device name: ${DEVICE_NAME:-<unresolved>}"
fi

# --- Hub infrastructure (agent-agnostic) -----------------------------------
# Background reverse tunnel to the hub for the web terminals. Keeps a persistent
# OUTBOUND WebSocket to HUB_URL so the hub can reach this container's per-session
# ttyds from any network/host. The hub tells it which port to bridge per data
# channel (see agent/tunnel-agent.js + agent-hub/server.js).
node /usr/local/bin/tunnel-agent.js &

# Session manager + heartbeat, in the FOREGROUND as the container's long-lived
# process. It owns the persisted registry (~/.agenthub/sessions.json), scans
# REPOS_ROOT for repos, auto-resumes running sessions, executes hub commands
# (spawn/kill/start/restart/delete), and heartbeats repos[]+sessions[] to the
# hub. exec so it becomes the main process (clean signal handling / restarts).
echo "Starting AgentHub session manager (REPOS_ROOT=${REPOS_ROOT:-/mnt/data/Docker/git})..."
exec python3 /usr/local/bin/hub-agent.py
