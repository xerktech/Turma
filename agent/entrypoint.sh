#!/bin/sh
set -e

# Which coding agent this container runs. Selected by the AGENT env var (set
# per-stack in DockerOps' compose/agents-truenas.yaml); defaults to claude so
# the original single-agent behavior is preserved when AGENT is unset.
# Accepted: claude | codex | opencode | copilot.
#
# All agents launch in full auto-approve mode (see the case below) so the
# headless session runs unattended. NOTE: auth is only wired up for claude today
# (it reuses the host's login via the /root/.claude bind mount).
# codex/opencode/copilot are installed and launchable, but you'll have to sort
# out their credentials separately — for now they start unauthenticated and will
# prompt/fail at login until that's done.
AGENT="${AGENT:-claude}"

# --- Claude-only preflight -------------------------------------------------
# Reuse the host's subscription login, and drop any stale Remote Control bridge
# pointer so we never reattach to a dead session from a prior (crashed/replaced)
# container — that silently swallows prompts. The project slug is derived from
# the working dir (compose sets working_dir per service; Claude stores state
# under /root/.claude/projects/<path-as-dashes>). Other agents have no such
# host-login mount or bridge state yet, so this is skipped for them.
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

  slug=$(pwd | sed 's#/#-#g')
  rm -f "/root/.claude/projects/$slug/bridge-pointer.json"
fi

# --- Hub infrastructure (agent-agnostic) -----------------------------------
# Background heartbeat to the agent-hub dashboard (see compose/agents-truenas.yaml).
# Reports device/workdir/usage and executes hub-initiated restarts. Best-effort:
# it must never block or take down the session, so no `set -e` interaction here.
# (Its live-session/token-usage signals currently parse Claude transcripts, so
# they're only meaningful for AGENT=claude — the container status/log/restart
# reporting works for every agent.)
python3 /usr/local/bin/hub-agent.py &

# Background reverse tunnel to the hub for the web terminal. Keeps a persistent
# OUTBOUND WebSocket to HUB_URL so the hub can reach this container's ttyd from
# any network/host (see agent-hub/server.js + agent/tunnel-agent.js).
node /usr/local/bin/tunnel-agent.js &

# Each boot registers a FRESH environment named "$APP_NAME-<container hex>", so
# the live session is uniquely identifiable in claude.ai/code (claude only).
NAME="${APP_NAME:-truenas-docker}-$(hostname)"

# Container name = the Agent Hub key and the ttyd/proxy base path. The tunnel
# reaches this container's ttyd at /term/<container>/ (see agent-hub/server.js),
# so the base path must match the hub's agent key.
CN=$(docker inspect --format '{{.Name}}' "$(hostname)" 2>/dev/null | sed 's#^/##')
CN="${CN:-$NAME}"

# --- Resolve the interactive command for the selected agent ----------------
# Each is a normal *interactive* TUI, so the tmux+ttyd plumbing below is
# identical for all of them; only claude is additionally bridged to
# claude.ai/code + mobile via --remote-control.
#
# For claude: `claude --remote-control` starts a normal interactive Claude Code
# session (a real TUI with chat + input) that is ALSO bridged to claude.ai/code
# + mobile. IS_SANDBOX=1 (set in compose) lets bypassPermissions run under root.
# This is deliberately the interactive `--remote-control` form, NOT `claude
# remote-control` (server mode): server mode is a relay/lobby whose terminal only
# renders the QR/capacity/status screen and never a conversation, so a ttyd
# attach would have nothing to show and nowhere to type. The interactive form is
# single-session (session ends -> tmux ends -> container restarts, matching the
# crash / "Restart (clear context)" semantics below).
# Every agent runs in full auto-approve / bypass-permissions mode: this is a
# headless session driven remotely (claude.ai/code, mobile, or the hub's web
# terminal), and the container itself is the sandbox (full host access), so a
# per-action approval prompt would just hang with no one to click it. The flags
# below are each agent's documented "run unattended in an externally sandboxed
# environment" mode — the direct parallel to claude's bypassPermissions.
case "$AGENT" in
  claude|claude-code)
    AGENT_CMD="claude --remote-control '$NAME' --permission-mode bypassPermissions" ;;
  codex)
    AGENT_CMD="codex --dangerously-bypass-approvals-and-sandbox" ;;
  opencode)
    AGENT_CMD="opencode --auto" ;;
  copilot)
    AGENT_CMD="copilot --allow-all" ;;
  *)
    echo "Unknown AGENT '$AGENT' (want: claude | codex | opencode | copilot)" >&2
    exit 1 ;;
esac

# Run the agent inside tmux so it gets a PTY and renders, then serve that same
# tmux session over the web with ttyd — attaching from the Agent Hub lands you
# in the live session (full TUI + scrollback), not a copy, and you can type into
# it.
echo "Starting interactive '$AGENT' session '$NAME' in tmux..."
tmux new-session -d -s agent -x 220 -y 50 "$AGENT_CMD"

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
  tmux attach -t agent &

# Keep today's crash semantics: when the agent session exits, its tmux session
# ends, this loop falls through, PID 1 exits, and `restart: unless-stopped`
# recreates the container (a fresh session). This is also what the hub's
# "Restart (clear context)" clears — the live tmux scrollback.
while tmux has-session -t agent 2>/dev/null; do
  sleep 5
done
echo "'$AGENT' session ended — exiting so the container restarts."
