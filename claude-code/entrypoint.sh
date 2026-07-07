#!/bin/sh
set -e

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

# Drop any stale bridge pointer so we never reattach to a dead session from a
# prior (crashed/replaced) container — that silently swallows prompts. The
# project slug is derived from the working dir (compose sets working_dir per
# service; Claude stores state under /root/.claude/projects/<path-as-dashes>).
slug=$(pwd | sed 's#/#-#g')
rm -f "/root/.claude/projects/$slug/bridge-pointer.json"

# Background heartbeat to the agent-hub dashboard (see compose/claude-code.yaml).
# Reports device/workdir/usage and executes hub-initiated restarts. Best-effort:
# it must never block or take down the session, so no `set -e` interaction here.
python3 /usr/local/bin/hub-agent.py &

# Background reverse tunnel to the hub for the web terminal. Keeps a persistent
# OUTBOUND WebSocket to HUB_URL so the hub can reach this container's ttyd from
# any network/host (see agent-hub/server.js + claude-code/tunnel-agent.js).
node /usr/local/bin/tunnel-agent.js &

# Each boot registers a FRESH environment named "$APP_NAME-<container hex>", so
# the live session is uniquely identifiable in claude.ai/code.
NAME="${APP_NAME:-truenas-docker}-$(hostname)"

# Container name = the Agent Hub key and the ttyd/proxy base path. The tunnel
# reaches this container's ttyd at /term/<container>/ (see agent-hub/server.js),
# so the base path must match the hub's agent key.
CN=$(docker inspect --format '{{.Name}}' "$(hostname)" 2>/dev/null | sed 's#^/##')
CN="${CN:-$NAME}"

# `claude --remote-control` is an *interactive* session (a real TUI) that also
# bridges to claude.ai/code + mobile. Run it inside tmux so it gets a PTY and
# renders, then serve that same tmux session over the web with ttyd — attaching
# from the Agent Hub lands you in the live session (full TUI + scrollback), not
# a copy. Spawned child sessions need IS_SANDBOX=1 (set in compose) to use
# skip-permissions under root.
#
# --spawn is REQUIRED headless: newer Claude Code prompts interactively
# ("Spawn mode: [1] same-dir [2] worktree — Choose [1/2]") on first launch, which
# has no TTY answer here and hangs the session at boot forever. Setting it
# explicitly skips the prompt. --spawn=worktree gives each session spawned from
# claude.ai/code its own isolated git worktree (switch to --spawn=same-dir to
# have sessions share this working dir instead).
echo "Starting Claude Code Remote Control session '$NAME' in tmux..."
tmux new-session -d -s claude -x 220 -y 50 \
  "claude remote-control --name '$NAME' --spawn=worktree --permission-mode bypassPermissions"

# Web terminal for the Agent Hub. Interactive (-W), scoped to the proxy base
# path (-b) so ttyd's own asset/WebSocket URLs resolve behind the hub prefix.
# Bound to loopback only — the sole reachable path is the local tunnel-agent,
# which the hub drives; basic auth (-c) is defense in depth on top of that,
# keyed off the same agent token everything else uses (the hub injects
# "term:$HUB_AGENT_TOKEN" on proxied requests — see agent-hub/server.js).
# Backgrounded — the crash-parity waiter below is the container's foreground.
echo "Serving live session via ttyd on 127.0.0.1:7681 (base /term/$CN)..."
ttyd -p 7681 -i 127.0.0.1 -b "/term/$CN" -W -m 8 \
  -c "term:${HUB_TOKEN:-changeme}" \
  tmux attach -t claude &

# Keep today's crash semantics: when the Claude session exits, its tmux session
# ends, this loop falls through, PID 1 exits, and `restart: unless-stopped`
# recreates the container (a fresh session). This is also what the hub's
# "Restart (clear context)" clears — the live tmux scrollback.
while tmux has-session -t claude 2>/dev/null; do
  sleep 5
done
echo "Claude session ended — exiting so the container restarts."
