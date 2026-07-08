FROM node:24-bookworm-slim

# Static Docker CLI only (no daemon) — bump as needed (kept current so the
# bundled Go stdlib stays ahead of known CVEs; the image scan gates on this).
ARG DOCKER_CLI_VERSION=29.6.1
# GitHub CLI — used by Claude for PRs/issues and as git's credential helper.
ARG GH_VERSION=2.96.0
# ttyd — serves the in-container tmux session (the live Claude TUI) over the web
# so the Agent Hub can attach to it. Static single-file binary.
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

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep tmux \
      python3 python3-pip python3-venv python-is-python3 libicu72 \
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
 && rm -rf /var/lib/apt/lists/*

# Wire git to authenticate via gh, system-wide (so it applies regardless of the
# per-repo /mnt/data .git/config that carries the commit identity). gh reads the
# token from the read-only-mounted /root/.config/gh.
RUN git config --system credential.helper '!gh auth git-credential'

LABEL org.opencontainers.image.source="https://github.com/xerktech/DockerOps" \
      org.opencontainers.image.description="Headless Claude Code (Remote Control) for DockerOps"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY hub-agent.py /usr/local/bin/hub-agent.py
COPY tunnel-agent.js /usr/local/bin/tunnel-agent.js
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/hub-agent.py /usr/local/bin/tunnel-agent.js

# Start sessions in the DockerOps repo so Claude has the stacks in context.
WORKDIR /mnt/data/Docker/DockerOps

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
