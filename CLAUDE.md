# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

AgentHub is the source and CI for the Claude Code agent fleet used with the TrueNAS-based home lab: a headless Claude Code container image (Remote Control sessions) and a central dashboard ("agent-hub") that monitors those containers. It builds two images and pushes them to GHCR; the running stack is deployed from the sibling **DockerOps** repo (`compose/claude-code.yaml`, deployed via Portainer GitOps).

## Repository Structure

- `agent/` — Headless agent image (currently Claude Code, Remote Control sessions; the name is agent-generic so it can host other agents later); includes `hub-agent.py`, a background heartbeat that reports device/workdir/git/token-usage, live session signals (transcript freshness, pending questions, new PR links), and a container-log tail to agent-hub, and executes hub-initiated restarts via the mounted docker socket. Also `entrypoint.sh` (startup/session registration) and `tunnel-agent.js` (the reverse tunnel to the hub for the live terminal).
- `agent-hub/` — Central dashboard for the Claude Code containers (https://agents.xerktech.com via the Cloudflare tunnel; port 8300 on the LAN): per-container status with working/idle/waiting-on-question session state, repo/path, per-project token usage parsed from `~/.claude/projects` transcripts, an expandable log tail, and a "Restart (clear context)" button. Pushes edge-triggered alerts to the self-hosted ntfy on topic `agents` (offline/recovered, restart loop, daily cost threshold, turn finished, question waiting, PR created). UI, API, and the click-to-attach live terminal (`/term/`, reverse-tunneled to each container's ttyd) sit behind single-user HTTP Basic auth (`HUB_USER`/`HUB_PASSWORD` on the hub service); agents authenticate heartbeats, tunnel WebSockets, and ttyd with one shared token (`HUB_TOKEN` in the agents' env = `HUB_AGENT_TOKEN` on the hub) — all set inline in DockerOps' `compose/claude-code.yaml`.
- `.github/workflows/` — GHCR image builds (see Build & Deploy below).

## Build & Deploy

- `.github/workflows/agent-image.yml` builds `ghcr.io/xerktech/agent` on any change under `agent/**`. The primary version tag IS the bundled Claude Code release (pinned into the build via the `CLAUDE_CODE_VERSION` build-arg so tag and contents can't drift); `github.run_number` disambiguates repo-side rebuilds of the same version.
- `.github/workflows/agent-hub-image.yml` builds `ghcr.io/xerktech/dockerops-agent-hub` on any change under `agent-hub/**`. No upstream package to version against, so the build counter is the version.
- Both push `:latest`, a versioned/build tag, and `:sha-<sha>`; Watchtower keeps `:latest` current on the host. The DockerOps `compose/claude-code.yaml` references `ghcr.io/xerktech/agent:latest` — keep that image ref in sync if you ever rename it here.
- **Deployment lives in the DockerOps repo**, not here: `compose/claude-code.yaml` defines the `agent-hub` service and the per-repo `agent-*` session containers (host mounts, the shared `HUB_TOKEN`/`HUB_AGENT_TOKEN`, ntfy publisher creds, basic-auth). Editing image content here + pushing rebuilds the image; changing how it's run means editing that compose file in DockerOps.

## Conventions

- All credentials are inline in environment variables (no Docker secrets mechanism) — this matches the DockerOps convention. The live secrets (`HUB_TOKEN`, `HUB_AGENT_TOKEN`, basic-auth, ntfy) are set in DockerOps' `compose/claude-code.yaml`, not in this repo.
- The RC listener runs as root (needs full host access) and spawns each session with `--dangerously-skip-permissions`, which Claude Code refuses under root unless `IS_SANDBOX` is set — set in the compose env.
- Agents connect purely outbound to the public `HUB_URL` (the Cloudflare tunnel), so they work from any host/network, not just the hub's.
