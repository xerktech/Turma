FROM node:24-bookworm-slim

# UTF-8 locale so the TUI's box-drawing, braille spinners, and other Unicode
# glyphs render instead of turning into tofu in the web terminal. C.UTF-8 ships
# with the base image (no locale generation needed).
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Static Docker CLI only (no daemon) — bump as needed (kept current so the
# bundled Go stdlib stays ahead of known CVEs; the image scan gates on this).
ARG DOCKER_CLI_VERSION=29.6.1
# GitHub CLI — used by Claude for PRs/issues and as git's credential helper.
ARG GH_VERSION=2.96.0
# ttyd — serves the in-container tmux session (the live Claude TUI) over the web
# so the Turma can attach to it. Static single-file binary.
ARG TTYD_VERSION=1.7.7
# PowerShell — cross-platform shell/scripting available to Claude. Self-contained
# linux-x64 tarball (needs libicu, installed below). Bump as needed for CVEs.
ARG POWERSHELL_VERSION=7.6.3
# npm — pinned ahead of the base image's bundled npm to pull in patched
# transitive deps (e.g. undici); the image scan gates on npm's node_modules.
ARG NPM_VERSION=11.18.0
# Claude Code npm version. CI pins this to the latest published release so the
# image tag reflects the bundled Claude Code version. Defaults to latest for
# local/manual builds.
ARG CLAUDE_CODE_VERSION=latest
# Additional coding agents, selectable at runtime via the AGENT env var (see
# entrypoint.sh); claude stays the default. Track latest so each rebuild pulls
# the newest release (like CLAUDE_CODE_VERSION above); pin to a specific version
# here if you ever need to freeze one. Auth for these is not wired up yet; only
# claude reuses the host login today.
ARG CODEX_VERSION=latest
ARG COPILOT_VERSION=latest
ARG OPENCODE_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep tmux \
      python3 python3-pip python3-venv python-is-python3 libicu72 ncurses-term \
 && curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
 && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      | tar -xz --strip-components=2 -C /usr/local/bin "gh_${GH_VERSION}_linux_amd64/bin/gh" \
 && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
      -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd \
 && mkdir -p /opt/powershell \
 && curl -fsSL "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-x64.tar.gz" \
      | tar -xz -C /opt/powershell \
 && ln -s /opt/powershell/pwsh /usr/local/bin/pwsh \
 && npm install -g "npm@${NPM_VERSION}" \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
                   "@openai/codex@${CODEX_VERSION}" \
                   "@github/copilot@${COPILOT_VERSION}" \
                   "opencode-ai@${OPENCODE_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

# Wire git to authenticate via gh, system-wide (so it applies regardless of the
# per-repo /mnt/data .git/config that carries the commit identity). gh reads the
# token from the read-only-mounted /root/.config/gh.
RUN git config --system credential.helper '!gh auth git-credential'

LABEL org.opencontainers.image.source="https://github.com/xerktech/DockerOps" \
      org.opencontainers.image.description="Headless Claude Code host multiplexer (worktree-backed Remote Control sessions) for the Turma"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY hub-agent.py /usr/local/bin/hub-agent.py
COPY tunnel-agent.js /usr/local/bin/tunnel-agent.js
# PreToolUse hooks — invoked by claude via the generated --settings file:
# guard.py (safety guard over Bash) and ask.py (AskUserQuestion → glasses
# bridge). Resolved as hooks/<name>.py next to hub-agent.py.
COPY hooks/ /usr/local/bin/hooks/
COPY tmux.conf /etc/tmux.conf
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/hub-agent.py \
      /usr/local/bin/tunnel-agent.js /usr/local/bin/hooks/guard.py \
      /usr/local/bin/hooks/ask.py

# No baked repo WORKDIR anymore: this is ONE container per host that scans
# REPOS_ROOT for repos and multiplexes N worktree-backed sessions. A neutral
# home is fine — the manager cds each Claude session into its own worktree.
#
# Runtime env (set per-stack in DockerOps' compose; defaults live in the code):
#   REPOS_ROOT      git-root to scan one level deep for repos (default /mnt/data/Docker/git)
#   MAX_SESSIONS    cap on concurrently running sessions            (default 6)
#   TTYD_PORT_BASE  first per-session ttyd port, allocated upward    (default 7700)
#   TURMA_URL / TURMA_TOKEN / TURMA_INTERVAL   hub endpoint + shared agent token + beat
#   IS_SANDBOX      lets claude bypassPermissions run under root
#   AGENT           coding agent (claude only, for now)
WORKDIR /root

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
