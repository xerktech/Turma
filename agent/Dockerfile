# Which toolchain tier the final image is assembled on top of. The build is a
# chain of stages — tooling -> android-build -> android — each a superset of the
# last, and this ARG picks where the volatile agent layer lands. Sizes below are
# UNCOMPRESSED/on-disk (what buildkit snapshots and what Trivy extracts) rather
# than the compressed registry figure, because disk on the shared CI runner is
# the constraint that motivated the split. They are `du` totals inside each
# image, cross-checked against the `docker history` layer sums. Do NOT quote
# `docker images` here: it reports ~1.5x these numbers and disagrees with both.
#
#   android-build  (default) JDK + Gradle + SDK build tooling. Agents can build
#                  and JVM-unit-test Android apps, and can drive a REMOTE device
#                  over `adb connect` — but cannot boot an AVD in-container.
#                  This is what ships as :latest. 3.0 GB.
#   android        android-build + emulator + x86_64 system image + a `turma`
#                  AVD, for booting an app in-container. Ships as :emulator,
#                  built on workflow_dispatch only. 7.4 GB.
#   tooling        No Android at all. 2.4 GB. CI scans this.
#
# Every tier grew 1.0 GB when the cloud CLIs (terraform/az/aws — see their layer
# below) landed in `tooling`. They are NOT a tier of their own: unlike Android,
# which is a whole toolchain most sessions never invoke, these are credential-
# bearing runtime tools, they are what the Trivy gate most wants to see, and a
# fourth tier would double the tag matrix to spare :latest a third of what the
# emulator alone costs.
#
# Note the shape: the whole Android BUILD toolchain costs 0.6 GB, while the
# emulator + x86_64 system image cost 4.4 GB — 7x more. That asymmetry is why
# they are separate tiers, and why :latest sits at android-build: it keeps every
# capability the android/ client's CI and tests actually use (assembleDebug +
# testDebugUnitTest; there are no instrumented tests) for 0.6 GB, and leaves the
# 4.4 GB to the tag that needs it.
#
# Running an app does NOT require the :emulator tag. platform-tools (adb, 22 MB)
# is in android-build, and adb connects to a device over TCP — so an agent can
# install/logcat/debug against an emulator running on a KVM-capable host, or a
# physical phone, without carrying a system image. That path is also the only
# one with hardware acceleration today: booting the bundled AVD needs the compose
# to pass `/dev/kvm` (see the emulator stage), which no DockerOps stack does.
#
# `tooling` is what CI scans (turma-agent-image-scan.yml). That is not a
# coverage compromise: Trivy is already told to skip opt/gradle, opt/android-sdk
# and usr/lib/jvm — every path the Android stages write — so those layers have
# never contributed a finding. The JDK still ships in the `tooling` apt layer, so
# its dpkg record (which is what Trivy actually reports openjdk CVEs from,
# independent of --skip-dirs) is scanned exactly as before. Verified by scanning
# both tiers with the CI flags and diffing: identical OS-package inventory (231
# packages, openjdk-17-jdk-headless included) and identical findings; 8.1 GB ->
# 3.1 GB, a 62% cut in what the scan job has to build, export and extract.
#
# Declared before the first FROM so it can be consumed by one (global ARG scope).
ARG AGENT_BASE=android-build

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

# --- Cloud CLI layer (stable, ~1.0 GB) --------------------------------------
# terraform + az + aws, so a session can manage infrastructure the same way it
# already manages GitHub through `gh`. Each reuses the HOST's credentials via a
# bind mount (/root/.aws, /root/.azure, /root/.terraform.d) exactly as claude
# and gh do — nothing here logs in, bakes a credential, or fails when a host has
# no creds to mount; see the preflight in entrypoint.sh.
#
# Its own layer, ahead of the volatile agent layer below for the same reason the
# Android one is: a Claude Code bump must not re-download a GB of CLIs. Sizes
# below are on-disk (`du` inside the image), consistent with the tier figures at
# the top of this file:
#   azure-cli   628 MB  (bundles its own CPython + the SDK, in /opt/az)
#   aws-cli     240 MB  (bundles its own CPython, in /opt/aws-cli)
#   terraform    96 MB  (one static Go binary)
# That ~1.0 GB lands in `tooling`, so EVERY tier carries it and CI scans it —
# deliberate on both counts. These are network-facing runtime tools that talk to
# cloud control planes with real credentials, which is exactly the surface the
# Trivy gate is for, unlike the build toolchains it skips.
#
# az comes from Microsoft's apt repo rather than their install script so it has a
# dpkg record for Trivy to scan and a version to pin; aws and terraform ship as
# vendored archives with no repo, so they're pinned by URL like ttyd/docker.
# Bump these pins to clear CVEs the image scan flags.
#
# Part of `tooling` (not a stage of its own) because every tier and the CI scan
# need it — the tiers below are Android-only supersets. Its own RUN, after the
# base one, so the two cache independently.
#
# The trailing `rm -rf` undoes the smoke test's side effects, and is not
# cosmetic: merely running `az version` writes a full /root/.azure (empty
# azureProfile.json included) and `terraform version` writes /root/.terraform.d.
# Baked into the image, those are credential stores present on every host that
# mounts none — which is exactly what entrypoint.sh's preflight reads. It keys on
# a login-marker file rather than the directory for the same reason; keep both,
# they cover different halves of it (a store the BUILD baked vs one a session
# creates by running `az` at all).
ARG TERRAFORM_VERSION=1.15.8
ARG AWS_CLI_VERSION=2.35.23
ARG AZURE_CLI_VERSION=2.88.0-1~bookworm
RUN set -eux; \
    curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
      -o /tmp/terraform.zip; \
    unzip -q /tmp/terraform.zip -d /usr/local/bin terraform; \
    rm /tmp/terraform.zip; \
    chmod +x /usr/local/bin/terraform; \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip" -o /tmp/awscli.zip; \
    unzip -q /tmp/awscli.zip -d /tmp; \
    /tmp/aws/install --bin-dir /usr/local/bin --install-dir /opt/aws-cli; \
    rm -rf /tmp/aws /tmp/awscli.zip; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc -o /etc/apt/keyrings/microsoft.asc; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.asc] https://packages.microsoft.com/repos/azure-cli/ bookworm main" \
      > /etc/apt/sources.list.d/azure-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "azure-cli=${AZURE_CLI_VERSION}"; \
    rm -rf /var/lib/apt/lists/*; \
    terraform version; aws --version; az version; \
    rm -rf /root/.azure /root/.terraform.d

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
# CI pins this to the latest published release on every build, so it changes
# constantly. Isolated in this trailing layer, a version bump rebuilds only this
# npm install — never the base tooling above. Keep the ARG here (not up top)
# so declaring it can't invalidate the base layer's cache.
#
# This layer used to also install @openai/codex, @github/copilot and opencode-ai
# (959 MB between them) against a runtime AGENT env var that was going to select
# between them. That selection was never built: hub-agent.py launches `claude`
# unconditionally, and entrypoint.sh reads AGENT only to decide whether to run
# the claude credential preflight. Nothing in the repo ever exec'd the other
# three, and their auth was never wired up, so they were 959 MB of unreachable
# binaries. Re-add here (and build the dispatch) if a second agent is ever
# genuinely wired end-to-end.

# Claude Code npm version. CI pins this to the latest published release so the
# image tag reflects the bundled Claude Code version. Defaults to latest for
# local/manual builds.
ARG CLAUDE_CODE_VERSION=latest

# `npm cache clean --force` in the same layer: `npm install -g` populates
# ~/.npm with the tarballs it just unpacked, and nothing at runtime reads that
# cache — it was shipping 697 MB of dead weight in every pull. It has to run in
# THIS RUN, not a later one: a separate layer would delete the files in the
# overlay but the bytes would still ship in this one.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

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
#
# Credential mounts (all OPTIONAL and per-host; DockerOps' compose decides which
# a host gets). Each is the HOST's own store, reused read-through exactly like
# /root/.claude and /root/.config/gh — the image logs in as nobody and bakes no
# credential. A host that mounts none still boots and runs sessions; its cloud
# CLIs are simply unauthenticated. See the preflight in entrypoint.sh.
#   /root/.aws          aws CLI   — config + credentials (or AWS_* env creds)
#   /root/.azure        az CLI    — azureProfile.json + the MSAL token cache
#   /root/.terraform.d  terraform — credentials.tfrc.json, for Terraform Cloud
#   JIRA_SITE / JIRA_EMAIL / JIRA_TOKEN   optional Jira Cloud polling for the hub's
#                   /board Kanban: the org's *.atlassian.net site + a user-scoped
#                   API token (Basic auth, read-only — only issue search is ever
#                   called). All three unset = feature off, zero Jira calls.
#   TURMA_JIRA_REFRESH_EVERY   beats between Jira polls (default 30 ≈ 10 min)
WORKDIR /root

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
