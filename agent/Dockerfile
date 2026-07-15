# Which toolchain tier the final image is assembled on top of. The build is a
# chain of stages — tooling -> android-build -> android — each a superset of the
# last, and this ARG picks where the volatile agent layer lands. Sizes below are
# UNCOMPRESSED/on-disk (what `docker images` reports, what buildkit snapshots,
# and what Trivy extracts) rather than the compressed registry figure, because
# disk on the shared CI runner is the constraint that motivated the split:
#
#   android        (default) JDK + Gradle + SDK + emulator + system image + AVD.
#                  Agents can build, test, AND run/troubleshoot Android apps.
#                  This is what ships as :latest. 12.4 GB (~3.7 GB compressed).
#   android-build  JDK + Gradle + SDK build tooling, no emulator/system image.
#                  Agents can BUILD Android apps but not boot one. 5.7 GB.
#   tooling        No Android at all. 4.7 GB (~1.4 GB compressed).
#
# The emulator + x86_64 system image alone account for 6.7 GB of that — over
# half the shipped image — which is why they get their own tier.
#
# `tooling` is what CI scans (turma-agent-image-scan.yml). That is not a
# coverage compromise: Trivy is already told to skip opt/gradle, opt/android-sdk
# and usr/lib/jvm — every path the Android stages write — so those layers have
# never contributed a finding. The JDK still ships in the `tooling` apt layer, so
# its dpkg record (which is what Trivy actually reports openjdk CVEs from,
# independent of --skip-dirs) is scanned exactly as before. Verified by scanning
# both tiers with the CI flags and diffing: identical OS-package inventory (231
# packages, openjdk-17-jdk-headless included) and identical findings; 12.4 GB ->
# 4.7 GB, a 62% cut in what the scan job has to build, export and extract.
#
# Declared before the first FROM so it can be consumed by one (global ARG scope).
ARG AGENT_BASE=android

FROM node:24-bookworm-slim AS tooling

# UTF-8 locale so the TUI's box-drawing, braille spinners, and other Unicode
# glyphs render instead of turning into tofu in the web terminal. C.UTF-8 ships
# with the base image (no locale generation needed).
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# --- Base tooling layer (stable) --------------------------------------------
# These pins change rarely, so they live in their own layer, ahead of and
# separate from the volatile coding-agent installs below. That way a Claude Code
# release bump (which changes CLAUDE_CODE_VERSION on every CI build) invalidates
# ONLY the agent layer — this apt/curl/npm-upgrade layer stays cached and isn't
# re-downloaded every build. The agent ARGs are deliberately declared *after*
# this RUN so their churn can't reach back and bust this layer's cache.

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

# The libpulse0..libasound2 run of packages below are the Android emulator's
# system shared libs (see the Android layer). It bundles most of its own deps,
# but not these — libxkbfile1 in particular is needed by qemu-system-x86_64,
# which fails to exec without it even fully headless. Don't prune them.

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep tmux \
      python3 python3-pip python3-venv python-is-python3 libicu72 ncurses-term \
      unzip openjdk-17-jdk-headless \
      libpulse0 libnss3 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
      libxrandr2 libxkbfile1 libgl1 libasound2 \
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
 && rm -rf /var/lib/apt/lists/*

# --- Android BUILD tooling layer (stable, ~0.5 GB) --------------------------
# JDK 17 (installed in the base apt layer above) + Gradle + the Android SDK
# (cmdline-tools, platform-tools, one platform + build-tools) so an agent can
# BUILD and JVM-unit-test Android apps (e.g. the android/ Turma client) —
# `gradle`, `sdkmanager`, `avdmanager`, `adb`, and `aapt2` on PATH. Booting an
# app needs the emulator stage below.
#
# Its own layer with its own version ARGs, placed AHEAD of the volatile
# coding-agent ARGs in the final stage so a Claude Code release bump can't
# invalidate (and re-download) any of this. Bump these pins to clear CVEs the
# image scan flags; add more platforms/build-tools here if a project needs a
# different compileSdk.
#
# The ENV PATH below covers processes that inherit the container env (hub-agent,
# each session's claude, and its Bash tool). A *login* shell — what tmux/ttyd
# spawns when an operator attaches — does NOT: Debian's /etc/profile
# unconditionally resets root's PATH, dropping /opt/gradle and /opt/android-sdk
# (tools in /usr/local/bin survive). The generated /etc/profile.d/android.sh
# re-exports the toolchain so it's on PATH either way — keep both. Both cover the
# emulator dir, which only exists in the stage below; a stale PATH entry is inert.
FROM tooling AS android-build
ARG GRADLE_VERSION=8.11.1
ARG ANDROID_CMDLINE_TOOLS=11076708
ARG ANDROID_PLATFORM=android-35
ARG ANDROID_BUILD_TOOLS=35.0.0
# ANDROID_PLATFORM/ANDROID_BUILD_TOOLS are promoted from ARG to ENV so the
# emulator stage above can interpolate the SAME values without re-declaring the
# ARGs (which don't cross stages) and risking a silent drift where the SDK
# platform and the system image get installed for different API levels. Both
# stay overridable here via --build-arg; the emulator stage just follows.
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_PLATFORM=${ANDROID_PLATFORM} \
    ANDROID_BUILD_TOOLS=${ANDROID_BUILD_TOOLS} \
    GRADLE_HOME=/opt/gradle/gradle-${GRADLE_VERSION}
ENV PATH="${GRADLE_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/emulator:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/${ANDROID_BUILD_TOOLS}:${PATH}"
RUN set -eux; \
    curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip; \
    mkdir -p /opt/gradle; unzip -q /tmp/gradle.zip -d /opt/gradle; rm /tmp/gradle.zip; \
    mkdir -p "${ANDROID_HOME}/cmdline-tools"; \
    curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip" -o /tmp/actools.zip; \
    unzip -q /tmp/actools.zip -d "${ANDROID_HOME}/cmdline-tools"; rm /tmp/actools.zip; \
    mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest"; \
    yes | sdkmanager --licenses >/dev/null; \
    sdkmanager --install "platform-tools" "platforms;${ANDROID_PLATFORM}" \
      "build-tools;${ANDROID_BUILD_TOOLS}" >/dev/null; \
    chmod -R a+rX "${ANDROID_HOME}" /opt/gradle; \
    printf '%s\n' \
      'export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64' \
      "export ANDROID_HOME=${ANDROID_HOME}" \
      "export ANDROID_SDK_ROOT=${ANDROID_HOME}" \
      "export GRADLE_HOME=${GRADLE_HOME}" \
      "export PATH=\"\${GRADLE_HOME}/bin:\${ANDROID_HOME}/cmdline-tools/latest/bin:\${ANDROID_HOME}/emulator:\${ANDROID_HOME}/platform-tools:\${ANDROID_HOME}/build-tools/${ANDROID_BUILD_TOOLS}:\${PATH}\"" \
      > /etc/profile.d/android.sh; \
    chmod 0644 /etc/profile.d/android.sh

# --- Android EMULATOR layer (stable, ~1.9 GB) -------------------------------
# The emulator + a headless x86_64 system image + a pre-created AVD, so an agent
# can RUN and troubleshoot Android apps (and run connectedAndroidTest), not just
# build them. This is the single largest thing in the image — the system image
# alone is ~1.5 GB — which is why it's isolated here: a deployment that only
# needs to build Android can target the android-build stage instead and skip it.
#
# Running the emulator needs hardware acceleration: the DockerOps compose must
# pass the host's KVM device through to the agent container (`devices:
# ["/dev/kvm"]`, plus `group_add: ["kvm"]`). Without it, boot the emulator in
# software mode (`emulator -avd turma -no-window -gpu swiftshader_indirect
# -no-accel`), which works but is slow. The X11/GL/audio shared libs the
# (windowless) emulator still links are installed in the base apt layer above.
#
# Licences were already accepted in android-build and persist in
# ${ANDROID_HOME}/licenses, so sdkmanager needs no re-prompt here.
FROM android-build AS android
# System-image coordinates for the emulator. google_apis (not google_apis_playstore)
# so the image is rootable/writable for testing; x86_64 so it runs KVM-accelerated
# on the host. The full package id is system-images;<platform>;<tag>;<abi>.
# ANDROID_PLATFORM is NOT re-declared here — android-build promotes it to an ENV,
# which (unlike an ARG) crosses the stage boundary, so this stage and the SDK
# platform it pairs with can never drift to different API levels.
ARG ANDROID_EMULATOR_TAG=google_apis
ARG ANDROID_EMULATOR_ABI=x86_64
# chmod is scoped to just the two trees this stage adds. A recursive chmod over
# all of ${ANDROID_HOME} would re-touch every file android-build already fixed
# and copy that whole ~500MB tree up into THIS layer — the emulator tier would
# grow by the size of the tier below it, and android-build would stop being a
# strict prefix of android for caching. The AVD lands in /root/.android, which
# the tier below never chmod'd either.
RUN set -eux; \
    sdkmanager --install "emulator" \
      "system-images;${ANDROID_PLATFORM};${ANDROID_EMULATOR_TAG};${ANDROID_EMULATOR_ABI}" >/dev/null; \
    echo "no" | avdmanager create avd -n turma --force \
      -k "system-images;${ANDROID_PLATFORM};${ANDROID_EMULATOR_TAG};${ANDROID_EMULATOR_ABI}"; \
    chmod -R a+rX "${ANDROID_HOME}/emulator" "${ANDROID_HOME}/system-images"

# --- Final assembly ---------------------------------------------------------
# Lands on whichever toolchain tier AGENT_BASE selected (see the top of this
# file). Everything below is identical across tiers, and everything above it is
# stable — so the volatile layers here rebuild without touching the toolchain.
FROM ${AGENT_BASE} AS final

# --- Coding-agent layer (volatile) ------------------------------------------
# CI pins these to the latest published release on every build, so they change
# constantly. Isolated in this trailing layer, a version bump rebuilds only this
# npm install — never the base tooling above. Keep these ARGs here (not up top)
# so declaring them can't invalidate the base layer's cache.

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

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
                   "@openai/codex@${CODEX_VERSION}" \
                   "@github/copilot@${COPILOT_VERSION}" \
                   "opencode-ai@${OPENCODE_VERSION}"

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
#   PUID / PGID     uid:gid to run as, so files written into the mounted git root
#                   and ~/.claude land owned by the HOST user rather than root.
#                   Defaults to the owner of REPOS_ROOT (root-owned root -> stay
#                   root; user-owned root -> drop to that user). PUID=0 forces root.
#   MAX_SESSIONS    cap on concurrently running sessions            (default 6)
#   TTYD_PORT_BASE  first per-session ttyd port, allocated upward    (default 7700)
#   TURMA_URL / TURMA_TOKEN / TURMA_INTERVAL   hub endpoint + shared agent token + beat
#   IS_SANDBOX      lets claude bypassPermissions run under root
#   AGENT           coding agent (claude only, for now)
#   JIRA_SITE / JIRA_EMAIL / JIRA_TOKEN   optional Jira Cloud polling for the hub's
#                   /board Kanban: the org's *.atlassian.net site + a user-scoped
#                   API token (Basic auth, read-only — only issue search is ever
#                   called). All three unset = feature off, zero Jira calls.
#   TURMA_JIRA_REFRESH_EVERY   beats between Jira polls (default 30 ≈ 10 min)
WORKDIR /root

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
