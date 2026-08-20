---
paths:
  - "agent/entrypoint.sh"
  - "agent/Dockerfile"
  - "agent/tests/test_entrypoint.sh"
---

# `agent/entrypoint.sh` and the image's bundled toolchains

Split out of `.claude/rules/agent.md` to keep that file (which loads for ALL of `agent/**`) under
the size ceiling. Everything here is about what the CONTAINER does at boot and what it ships.

## Run-as identity (host permission parity)

- The container writes into bind-mounted HOST dirs — the git root and the Claude login (`~/.claude`)
  — so the uid it runs as is the uid those files end up owned by on the host.
- `entrypoint.sh` resolves an identity BEFORE anything starts and `setpriv`s down to it: **`PUID`/
  `PGID` if set, else auto-detected from the owner of `REPOS_ROOT`**. A root-owned git root
  (TrueNAS) resolves to `0:0`; a user-owned one (WSL/desktop) drops to that uid, so nothing lands
  root-owned in the operator's repo or `~/.claude`. `PUID=0` forces always-root.
- Because it drops, the entrypoint also reuses an existing passwd/group entry for the id (the node
  base image ships `node` at `1000:1000`); `chown`s `/root` **non-recursively** (its children are
  the host's own bind mounts) since **HOME stays `/root`**, which every mount target and
  `PROJECTS_ROOT`/`~/.turma` path depends on; joins the group owning `/var/run/docker.sock`; and
  **self-heals on boot**, `chown`ing leftover uid-0 paths under `REPOS_ROOT`/`~/.claude`.
- That heal only ever touches uid-0 paths, so a mis-set `PUID` can misplace root-owned files but
  never take the host user's own files away.
- Verified by building the entrypoint on the real base image against root-owned / user-owned /
  `PUID`-override / `PUID=0` roots (`test_entrypoint.sh`).

## Boot sequence and the bundled toolchains

- Creds preflight, then launches the tunnel (a simple respawn loop, XERK-34) and `exec`s the session
  manager as PID 1 — the container stays up with zero sessions. Uid resolution is above. Tests:
  `test_entrypoint.sh`.
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
- **Cluster CLIs** (`kubectl`/`helm`/`talosctl`/`omnictl`, pinned via `KUBECTL_VERSION`/
  `HELM_VERSION`/`TALOSCTL_VERSION`/`OMNICTL_VERSION` in `agent/Dockerfile`) sit in `tooling` beside
  the cloud CLIs, on the same terms and for the same reason (XERK-369).
  - **Their versions track the `k8x` CLUSTER, not `latest`.** kubectl tolerates one minor of skew
    either side of the API server and talosctl's machine API is versioned with Talos, so both follow
    `xerktech/Talos` `cluster.env` (`KUBERNETES_VERSION`, `TALOS_VERSION`) and omnictl follows the
    Omni release `xerktech/ArgoCD` deploys. A CVE bump alone is not a reason to move them.
  - **Their digests are pinned**, unlike ttyd/docker/terraform: these four run with cluster-admin-
    shaped credentials against infrastructure this fleet owns, and a version tag can be re-pointed
    at a new artifact by whoever controls the release. Refresh from the publishers' checksum files
    (URLs are in the Dockerfile comment) in the same commit as the version bump.
  - Creds are the host's, optional, and log-only exactly like the cloud stores: `/root/.kube/config`,
    `/root/.talos/config`, `/root/.config/omni/config`, all `permissions.deny`-protected. **A
    `~/.talos/config` that EXISTS may still hold no context** — `talosctl` writes one just by being
    run, and truenas's is `context: ""` — so the preflight's line means a store is there, never that
    it works.
- **In-cluster, the kubeconfig is the POD'S OWN ServiceAccount and nothing is mounted** (XERK-369).
  `entrypoint.sh` writes `/root/.kube/config` from the projected token when — and only when —
  `KUBERNETES_SERVICE_HOST` is set, the token and `ca.crt` are readable, and neither `KUBECONFIG`
  nor a `/root/.kube/config` this block did not write says otherwise.
  - **It is a CONVENIENCE, not the credential**, and that is what decides how hard it may try:
    client-go falls back to the in-cluster ServiceAccount on its own, so `kubectl` and `helm` in a
    pod authenticate with no kubeconfig at all (measured). What the file adds is a named
    current-context and the pod's own namespace as the default. **So every step of it is guarded
    and every failure is one log line** — it runs under `set -e` as PID 1 before the manager
    starts, and QA measured an unguarded `mkdir` killing the container on a read-only `/root` and
    on a `/root/.kube` that was a file, and an unbounded read of `namespace` hanging PID 1 on a
    fifo. Never "fix" one of those guards by making it fatal.
  - **It must be `tokenFile:`, never an inline `token:`.** The projected token is rewritten in place
    at ~80% of its TTL; QA measured a copy taken at boot returning `Unauthorized` eight minutes
    later while the generated config authenticated in the same second.
  - **A line-1 marker is what makes it safe to overwrite**, and it is load-bearing: `/root` is a
    persistent volume in a pod, so without it the first boot's config is frozen there forever and a
    changed apiserver address or namespace loses silently. A file without the marker — and a
    SYMLINK, dangling included, which fails `-e` and would otherwise read as absent — is the
    operator's and is never touched.
  - Everything interpolated into it is validated first (`KUBERNETES_SERVICE_HOST`,
    `KUBERNETES_SERVICE_PORT`, the `namespace` file), because it is a YAML heredoc and a namespace
    with a stray newline produces a file that parses as something else entirely.
  - **And every interpolated scalar is QUOTED, which validation does not cover.** Kubernetes accepts
    `no`, `on`, `off`, `yes`, `true`, `null` and `123` as namespace names and YAML reads each as a
    bool, a number or null, so an unquoted `namespace:` yields a config kubectl refuses to LOAD —
    every call in the pod dies at config load while the same pod with no kubeconfig authenticates
    fine. Those names are all `[a-z0-9-]`, so no character filter catches it.
  - The temp file is `mktemp`, not a fixed name: it is created 0600 before anything is written, so
    the mode is never a race and no `umask` is touched (a bare `umask 077 … umask 022` pair leaks a
    hardcoded 022 into the manager and every session), and it cannot destroy an operator's file
    that happened to sit at a name we picked.
  - It is written as root before the manager starts, so it is `chown`ed to the run-as identity —
    otherwise every session on a `PUID` host gets a permission error on a file the operator cannot
    see. The write's `umask` is scoped to a SUBSHELL: a bare pair leaks into the manager, the
    tunnel and every session, and restores a hardcoded value rather than the operator's.
  - **`KUBERNETES_SERVICE_HOST` is taken on trust** and is what the generated config pairs with the
    pod's real bearer token, so whoever sets it decides where that token is sent. Not a boundary
    being crossed — setting env on a container means choosing its image and entrypoint too — and
    there is nothing in the SA directory to check the address against. Recorded so it stays a
    decision.
  - Tests: the XERK-369 cases in `test_entrypoint.sh`.
- **Android toolchain** — JDK 17 + Gradle + Android SDK (`gradle`/`sdkmanager`/`avdmanager`/`adb`/
  `aapt2` on PATH), pinned via
  `GRADLE_VERSION`/`ANDROID_CMDLINE_TOOLS`/`ANDROID_PLATFORM`/`ANDROID_BUILD_TOOLS` in
  `agent/Dockerfile`; tiering in `.claude/rules/release.md`.
