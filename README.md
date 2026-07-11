# Turma

Source and CI for the Claude Code agent fleet on the TrueNAS home lab. Two images,
built here and pushed to GHCR; the stack is deployed from the sibling **DockerOps**
repo (`compose/agents-truenas.yaml`).

## Components

- **`agent/`** — one agent container **per host**, mounted at a git root
  (`REPOS_ROOT`). It scans the root one level deep for git repos and, on command
  from the hub, spawns worktree-backed Claude Code Remote Control sessions
  (branch `agent/<id>`), each its own tmux + loopback ttyd, registered in
  claude.ai/code as `<host>-<repo>-<worktree>`. `hub-agent.py` is both the
  session manager (registry in `~/.turma/sessions.json`, spawn/kill/start/
  restart/delete, auto-resume on boot) and the heartbeat to the hub;
  `tunnel-agent.js` is the outbound reverse tunnel that carries each session's
  terminal to the hub; `entrypoint.sh` wires them up.

- **`turma/`** — the dashboard + terminal gateway (Node stdlib only). A
  **host → repo → session** tree: list repos per host, spawn a session per repo,
  and Attach / Restart (clear context) / Kill / Start / Delete per session, with
  per-session token-usage/cost, live working/idle/waiting state, and ntfy alerts.
  Killing a session frees its worktree but keeps its usage history. Behind
  single-user HTTP Basic auth; agents authenticate with one shared token.

- **`glasses/`** — an Even Realities G2 smart-glasses client (Vite + TypeScript):
  sessions list, scrollable transcript, question answering, spawn/kill/resume,
  and G2-mic dictation transcribed via the hub's Whisper-backed `/audio`
  endpoint. See `glasses/README.md` for dev, simulator, and packaging/sideload
  instructions.

## Deploy

Image content lives here; **how it runs** (mounts, tokens, `REPOS_ROOT`,
`MAX_SESSIONS`, resource limits, adding another host) lives in DockerOps'
`compose/agents-truenas.yaml`. See `CLAUDE.md` for the full architecture, the
session model, and the CI / PR-gate details.

Cost estimates come from a built-in pricing table in `hub-agent.py`; usage from
a model it doesn't match counts as $0.00 and is flagged ⚠ **unpriced** in the
dashboard. The agent's optional `PRICING_JSON` env var (inline JSON,
`{"model-substring": [input, output, cacheWrite, cacheRead]}` per MTok) adds
rates for such unknown models only — it can never override a built-in rate. The
loaded extras (or any parse error) are logged at boot.
