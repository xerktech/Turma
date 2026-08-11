---
paths:
  - "agent/entrypoint.sh"
  - "agent/Dockerfile"
  - "agent/tests/test_entrypoint.sh"
---

# `agent/entrypoint.sh` and the image's bundled toolchains

Split out of `.claude/rules/agent.md` to keep that file (which loads for ALL of `agent/**`) under
the size ceiling. Everything here is about what the CONTAINER does at boot and what it ships.

- Creds preflight, then launches the tunnel (a simple respawn loop, XERK-34) and `exec`s the session
  manager as PID 1 — the container stays up with zero sessions. Uid resolution is in `CLAUDE.md`'s
  "Run-as identity". Tests: `test_entrypoint.sh`.
- **Every start re-checks Claude Code** (XERK-254), otherwise frozen at the image's
  `CLAUDE_CODE_VERSION` for the life of the tag. The agent can't self-update here — it IS the image,
  and the Watchtower pull's recreate re-runs this code. A version COMPARE; never downgrades;
  junk/unreachable registry output = stay put; rate-limited off `~/.turma/last-claude-check`.
  `TURMA_CLAUDE_AUTO_UPDATE=0` pins it.
  - **AWAITED, before the manager starts.** The install leaves `claude` off PATH for ~1.7s and
    `resume_on_boot` relaunches sessions 1s apart just after, so backgrounding it put that hole
    under the first relaunches, which died on exec. Calls are `timeout`-bounded instead: a wedged
    registry delays the boot, never stops it.
  - Being awaited puts it in `set -e`'s path **at PID 1**, so the block is `||`-guarded and its
    scratch `HOME` is an `mktemp` dir: with a fixed `/tmp` path, any session could `touch` it and
    the `mkdir` failure killed PID 1 on every boot, forever. That scratch `HOME` also keeps npm's
    cache and claude's own writes out of the bind-mounted `/root`; the install itself is root's,
    since only root writes `/usr/local`.
- **Cloud CLIs** (terraform/`az`/`aws`, pinned via
  `TERRAFORM_VERSION`/`AZURE_CLI_VERSION`/`AWS_CLI_VERSION` in `agent/Dockerfile`) live in the
  `tooling` stage, so **every tier carries them and the CI scan covers them** — they are
  credential-bearing tools talking to cloud control planes.
  - **Creds are the host's, via optional bind mounts** (`/root/.aws` or `AWS_*`, `/root/.azure`,
    `/root/.terraform.d`); the image bakes none. **A host that mounts none is supported, not an
    error**: the preflight only LOGS which stores it found, keying on a **login-marker file** never
    the store dir, because each CLI creates its own store just by RUNNING. The Dockerfile's
    build-time smoke test drops the stores it creates. `permissions.deny` protects them.
- **Android toolchain** — JDK 17 + Gradle + Android SDK (`gradle`/`sdkmanager`/`avdmanager`/`adb`/
  `aapt2` on PATH), pinned via
  `GRADLE_VERSION`/`ANDROID_CMDLINE_TOOLS`/`ANDROID_PLATFORM`/`ANDROID_BUILD_TOOLS` in
  `agent/Dockerfile`; tiering in `.claude/rules/release.md`.
