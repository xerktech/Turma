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
  - **`claude_update_check` is a SUBSHELL body — `() ( … )`, never `() { … }`.** A `/bin/sh`
    function is not a subshell and has no `local`, so the scratch `HOME` escaped into the manager,
    the tunnel and every session — pointing `~/.turma` and `~/.claude` at a `/tmp` dir the check
    then deleted, against this file's own `HOME stays /root` invariant. The `||` guard is at the
    CALL site, so a subshell body costs nothing. Tests assert the manager's and tunnel's `HOME`.
  - **A repair that doesn't help is remembered** (`/root/.turma/claude-unparseable`): an unreadable
    version is usually a half-written install, but equally a working claude printing a shape this
    doesn't parse — there the reinstall fixes nothing and would run on every boot forever. Retried
    only when what claude prints CHANGES, and only ever written by an install that SUCCEEDED.
  - **`~/.turma` is writable by the DROPPED IDENTITY** — it is the manager's `REGISTRY_DIR` — so
    every file this check opens there is a DoS surface: a session `mkfifo`s the stamp or the marker,
    the open BLOCKS with no error for `|| true` to catch, and PID 1 sits there forever. Reads go
    through a regular-file guard and writes through a temp file + rename (no check-then-open race),
    and the call site adds a watchdog that bounds the whole block the way the native launcher's
    outer `timeout` does. Guards mean it never fires; the watchdog means a future unbounded call
    can't wedge a host.
  - **The watchdog's deadline is a FIXED generous number (1800s), not arithmetic over the per-call
    bounds.** It only ever had to sit above the legitimate worst case; deriving it TIGHTLY coupled
    it to the exact set of calls in the check, and every miscount of that was a defect (an
    overflowing floor, wrong multipliers, a count taken as the wrong uid). The one coupling kept is
    to the bound that matters: 2.5x the install budget, because a `kill` reaches the check's
    shell and not its npm grandchild — fire it during an install and npm keeps replacing the package
    while the manager launches sessions into it (measured: 100 launch failures out of 100).
    Interrupting a version read or a registry query orphans nothing. The effective deadline is
    logged every boot and the default is pinned by a test.
  - **Those per-call bounds use `timeout -k`.** Without `-k`, `timeout` only SIGNALS at the deadline
    and then waits for the child to leave (measured: 30s for a `trap "" TERM` child given `timeout
    2`), so every bound would be nominal and the derived floor would be arithmetic over numbers
    nothing keeps. The cost is that a killed install is SIGKILLed: npm rolls back cleanly on
    SIGTERM but leaves NO claude at all when killed outright — self-healing (the next start finds
    it missing and installs), but the failure lasts until that start rather than seconds, which is
    what the grace period buys back.
  - **`_num` rejects magnitude AND zero, not just non-digits.** An all-digit but oversized value
    overflows `$(( ))` to a NEGATIVE floor — below the sum it exists to exceed. And `timeout 0 cmd`
    DISABLES the timeout, so a `0` (the value an operator reaches for meaning "no limit") would
    leave that call unbounded and subtract its whole share from the floor: both halves of the
    orphan at once. Both read as "use the default". The effective deadline is logged every boot and
    the shipped default (1800s) is pinned by a test.
  - **Every `claude --version` here is `timeout`-wrapped, the post-install verification included.**
    These are children of PID 1 with no outer timeout anywhere (the `||` guard only runs once the
    block returns), and a hang is reachable from the very fault the repair branch handles: an
    unbounded one leaves the container `running` with no manager, no tunnel and no sessions, and
    because PID 1 looks alive no restart policy fires. Its test is TIMED — an unbounded read boots
    too, just minutes later.
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
