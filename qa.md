# qa.md — how to QA Turma

Written for the next QA agent. Everything here was learned the hard way during
XERK-235 (the first full-app QA pass). If you find a new trap, add it — the point
of this file is that nobody pays the same hour twice.

Read this **before** `.claude/skills/verify/SKILL.md`. That skill assumes the
**agent container**; this file covers the TrueNAS-native host most sessions
actually run on, where several of its recipes do not apply as written.

---

## 0. Know which box you are on

Turma runs its fleet two ways, and they are not interchangeable:

| | agent container | TrueNAS native | WSL workstation (`MaxAI`) |
|---|---|---|---|
| `npm` / `npx` | on PATH | **not on PATH** — see below | on PATH |
| `java`, `gradle`, Android SDK | bundled | **absent** | **installed** — see §2.5 |
| emulator / `adb` | only the `:emulator` tag | absent | **a running AVD** |
| `apt`, writable `/usr` | yes | **no** — read-only, no sudo | yes, with sudo |
| `ps` / `pkill` | absent | present | present |
| `~/.claude`, `~/.turma` | bind mounts | the operator's real ones | the operator's real ones |

Check with `which java gradle npm adb` before you plan anything. Assuming the
container's toolchain on a native host is the single most common way to waste
a QA session — and assuming the TrueNAS host's *absences* on the WSL
workstation is the second, because it sends you into a docker pull and an
emulator download you don't need.

### Native-host facts

- **`npm`/`npx` live in `/root/.local/node/bin` and are now symlinked into
  `/root/.local/bin`** (`node`, `npm`), so they ARE on the systemd units' PATH
  (the launcher and updater both prepend `$HOME/.local/bin`). `npx` is not
  linked; for it, prepend `/root/.local/node/bin` yourself.
- **npm's global prefix is `/root/.local/node`, NOT `~/.local`** (`npm config
  get prefix`). So `npm i -g <pkg>` lands a binary in `/root/.local/node/bin`,
  which is *not* on the agent's PATH. Anything that installs a tool and then
  expects to find it must pass `--prefix ~/.local` or set `npm_config_prefix`.
- **`claude` here is Anthropic's NATIVE installer build**, not npm:
  `/root/.local/bin/claude -> /root/.local/share/claude/versions/<ver>`, and
  `npm ls -g @anthropic-ai/claude-code` exits 1. Code that branches on
  "npm-managed?" takes the `claude update` path on this host.
- **npm's cache must be redirected** — `/root/.npm` is root-owned and npm dies
  with EACCES: `npm ci --cache /tmp/claude-0/npm-cache`.
- **`bun` is available** at `/root/.local/bin/bun` — this is what `veiller/`
  builds and tests with.
- **No `java`/`gradle`/`adb`.** Android work must happen inside the agent image
  (see §2.5).
- **`/tmp` is `noexec`.** Write scratch files there freely, but anything that
  must be *executed* (a downloaded binary, an extracted tool) goes in
  `/root/.local`.
- **`/etc` is mounted read-only** (`boot-pool/ROOT/<ver>/etc`, `ro`), hardened
  after the incident in §1.
- Those two together **fail six of the agent's shell suites for environmental
  reasons only** — `test_bootstrap`, `test_entrypoint`, `test_install_sudo`,
  `test_turma_agent`, `test_turma_agent_update`, `test_turma_agentctl`. They
  install into a temp prefix and `exec` what they installed, so `noexec /tmp`
  makes them die with `setsid: Permission denied`, and `test_entrypoint` also
  tries to `cp` a `tmux.conf` into the read-only `/etc`. **Do not file these as
  regressions.** Point `TMPDIR` at an exec-capable filesystem and all six pass:
  ```bash
  mkdir -p /mnt/data/tmp-qa && export TMPDIR=/mnt/data/tmp-qa
  cd agent && for t in tests/test_*.sh; do bash "$t"; done   # all 6 OK
  ```
  CI runs them on `ubuntu-latest`, where neither constraint exists.
- `docker` works and can pull from ghcr.

---

## 1. Rules of engagement on this host — read before you run anything

**A real Turma agent is running here right now, under systemd, serving the
operator's live sessions.** It is not a test fixture. Breaking it is worse than
any bug you might find.

Hard rules:

- **NEVER EXECUTE A COMMAND YOU ARE TESTING THE GUARD AGAINST.** This is the
  first rule because breaking it cost this project its `/etc`. During XERK-235 a
  QA agent proving a `guard.py` bypass ran the payload for real behind a fake-`rm`
  PATH shim; the payload was `bash -lc 'rm -rf /etc'`, `bash -l` re-read
  `/etc/profile`, `/etc/profile` reset `PATH`, the shim went out of scope and the
  **real `/bin/rm` deleted `/etc` on the live host**. The box had to be rebooted
  and rolled back from a ZFS snapshot.
  - **The shim is not a sandbox.** Anything that re-execs, re-reads a profile,
    resets `PATH`, or uses an absolute path steps straight around it. There is no
    safe way to "just check whether it would really run".
  - **You never need to.** `guard.decide()` / `is_destructive()` /
    `policy_reason()` are **pure functions over a string** — they return a
    verdict and execute nothing. Testing the guard means calling them and
    comparing the verdict. Import the module and assert:
    ```python
    import sys; sys.path.insert(0, "agent/hooks"); import guard
    guard.decide("Bash", {"command": "bash -lc 'rm -rf /etc'"})  # -> ('deny', ...)
    ```
    `agent/tests/test_guard.py::TestKnownBypasses` is the pattern to copy. The
    probe used to close this pass's 19 bypasses executed nothing at all.
  - If you genuinely believe a payload must *run* to prove something, it runs in
    `docker run --rm` on a throwaway image, never on the host — and say in your
    report that you did it.
- **Your own Bash calls are policed by the INSTALLED guard, not the one in your
  worktree.** The hook path is baked into the session's `--settings` file, so
  editing `agent/hooks/guard.py` changes what your *tests* see and nothing about
  what *you* are allowed to run. During XERK-235 this looked exactly like a fresh
  false positive: a commit message quoting `DROP DATABASE … | mysql` was refused
  even though the branch's own guard allowed it. It was the installed (older)
  guard refusing — the very bug the branch was fixing. Before filing a false
  positive against your branch, check both:
  ```python
  # branch copy vs the installed one, same string, in one process
  import sys; sys.path.insert(0, "agent/hooks"); import guard
  guard.is_destructive(cmd)
  ```
  If they disagree, you are looking at the deployed version, not a regression.
- **Never write to the real `~/.turma` or `~/.claude`.** Override `HOME` to a
  temp dir for anything that boots `hub-agent.py`; `REGISTRY_DIR` is hardcoded to
  `~/.turma` and is *not* env-overridable, so `HOME` is the only lever.
- **Never kill a `tmux` session or `ttyd` you did not start.** `tmux ls` shows
  the operator's live sessions *and your own Claude session* side by side —
  killing the wrong one ends the session you are working in. Identify the target
  by creation time and by grepping `/proc/*/cmdline`, then kill exactly it.
- **Never restart the systemd agent**, and never run `agent/native/install.sh`
  or `turma-agent-update` against the real prefix. Use `--verify`, a dry run, or
  a throwaway `PREFIX` in your scratch dir.
- **Ports.** The operator's hub is on **8300**; other sessions use **8399**.
  Never bind either. Pick a lane and stay in it — during XERK-235 the split was
  hub-backend 8410-19, web UI 8420-29, agent 8430-49, glasses 8450-59, android
  8460-69, cross-component E2E 8480.
- **`TTYD_PORT_BASE` defaults to 7700, which the live agent already holds.**
  A second `hub-agent.py` on this box will provision a session onto an occupied
  port and its terminal silently attaches to *someone else's* tmux. Always
  override `TTYD_PORT_BASE` for an isolated agent run.
- **Credentials leak in through the environment.** The systemd agent's env
  (`JIRA_SITE`/`JIRA_TOKEN`/`AZDO_*`, and whatever points `claude` at the real
  login) is visible to shells on this host. A "hermetic" `hub-agent.py` you boot
  will happily poll the **real Jira** and use the **real Claude login** unless
  you blank those explicitly. Verified during XERK-235: a test agent polled 25
  live tickets and launched a real `claude`. Blank them, and check the agent log
  afterwards to confirm it stayed offline from real services.
- Always install an exit trap that kills what you spawned. A crashed driver
  leaves a hub holding its port and the next run silently talks to the orphan —
  the symptom is an inexplicable 401, because the orphan holds a different token.

---

## 2. Building and running each component

Baselines below are from `main` at v0.6 + XERK-252 (commit 4b638a4), so a deviation is
either your environment or a regression — find out which before filing.

**Pin your copy on `/mnt/data`, never in the `/tmp` scratchpad.** §4 tells you to
`git archive HEAD | tar -x` into a scratch dir; do it under `/mnt/data/tmp-qa/`,
because `/tmp` is `noexec` and that breaks the toolchains silently-ish:
`npm ci` dies in esbuild's postinstall (`spawnSync .../esbuild EACCES`) and
`bun run typecheck` dies on `node_modules/.bin/tsc: Permission denied`. Same
reason `--cache` must point at `/mnt/data/tmp-qa/npm-cache`, not `/tmp`.

### 2.1 Hub (`turma/`) — node, no build step

```bash
export PATH=/root/.local/node/bin:$PATH
cd turma && node --test tests/*.test.js        # baseline: 926 pass, ~6s
```

Boot a real hub with everything pointed at temp paths:

```bash
PORT=84xx TURMA_USER=qa TURMA_PASSWORD=qapass TURMA_AGENT_TOKEN=tok \
STATE_FILE=$T/state.json ARCHIVE_DIR=$T/archive ARCHIVE_DB=$T/index.db \
node turma/server.js
```

`STATE_FILE`, `ARCHIVE_DIR` and `ARCHIVE_DB` are the three that must be
redirected — miss one and you write into the operator's `/data`.

### 2.2 Agent (`agent/`) — python 3.11 stdlib, no pytest

```bash
cd agent
python3 -m unittest tests.test_hub_agent                       # 1138 pass, ~14s
python3 -m unittest tests.test_guard tests.test_guard_settings tests.test_ask   # 108 pass
node --test tests/tunnel-agent.test.js                         # 95 pass
for t in tests/test_*.sh; do bash "$t"; done                   # native/entrypoint suites
```

**There is no pytest.** `python3 -m unittest` is the only runner.

The fourth thing `code-scan.yml` gates is the **instruction-file size limit**, and it is the one
that is easy to trip without noticing (a rules file grows a few bullets at a time). Run it exactly
as the workflow does — note `-m`, not `wc -c`; these files are full of multibyte glyphs:

```bash
for f in CLAUDE.md .claude/rules/*.md; do
  python3 -c "import sys;print(sys.argv[1], len(open(sys.argv[1],encoding='utf-8').read()))" "$f"
done   # anything >= 40000 fails the PR; >= 36000 warns at Claude Code startup
```

The single node command `code-scan.yml` really runs (1057 pass) — use this to
reproduce that gate rather than per-directory runs:

```bash
node --test turma/tests/*.test.js agent/tests/*.test.js .github/scripts/tests/*.test.js
```

`agent/native/`'s launcher and updater run as **root under systemd here** and
touch the live install: stage a fake `$PREFIX` + scratch `$HOME`, never
`HOME=/root` (it stamps `last-update-check`, suppressing the real agent's
next boot check, and can restart it); stub **all three** restart paths (a real
system unit exists here); it holds `flock` on `update.lock` for the whole run.
Recipes: `qa-findings.md` §5.9.

### 2.3 Glasses (`glasses/`) — npm + vite + vitest

```bash
export PATH=/root/.local/node/bin:$PATH
cd glasses
npm ci --cache /mnt/data/tmp-qa/npm-cache
npm run typecheck && npx vitest run                            # baseline: 455 tests
npm run build                                                  # glasses-ci gates on this too
```

`src/vendor/vendor.test.ts` asserts `chat.cjs`/`board.cjs` are **byte-identical**
to their `turma/public/` sources. Editing `turma/public/chat.js` without
re-copying both vendored files fails here and in `veiller-ci` — verified by
mutating one byte.

### 2.4 Veiller (`veiller/`) — bun

```bash
cd veiller && bun install && bun test                          # baseline: 344 pass
bun run typecheck                                              # needs devDeps installed first
bun run build                                                  # veiller-ci gates on this too
```

`bun run typecheck` calls bare `tsc`, so it fails with `command not found`
until `bun install` has run.

### 2.5 Android (`android/`) — inside the agent image, and it does work

There is no JDK on this host, but the **whole `android-ci` gate runs locally** in
`ghcr.io/xerktech/turma-agent:latest` in ~3.5 min. Do not report Android as
unbuildable — that is only true of the *UI*, below. The image already carries
JDK 17.0.20, Gradle **8.11.1** at `/opt/gradle` (the same version android-ci
pins) and `/opt/android-sdk` with `platforms/android-35` + `build-tools/35.0.0`,
so nothing needs downloading in-job:

```bash
mkdir -p /mnt/data/tmp-qa/andhome /mnt/data/tmp-qa/gradlehome
docker run --rm --entrypoint bash \
  -v <checkout>/android:/work \
  -v /mnt/data/tmp-qa/andhome:/andhome -v /mnt/data/tmp-qa/gradlehome:/gradlehome \
  -e ANDROID_USER_HOME=/andhome -e GRADLE_USER_HOME=/gradlehome \
  ghcr.io/xerktech/turma-agent:latest -c \
  'cd /work && gradle :app:testDebugUnitTest --no-daemon && gradle :app:assembleDebug --no-daemon'
```

Baseline: **281 JVM unit tests** (was 278 before XERK-252), 0 failures, and a ~21 MB
`app/build/outputs/apk/debug/app-debug.apk`. Per-suite counts are in
`app/build/test-results/testDebugUnitTest/TEST-*.xml`.

Traps:

- **`--entrypoint bash` is required.** The image's own entrypoint resolves a
  run-as identity and `setpriv`s; a plain `docker run … bash -lc '…'` just hangs.
- `assembleDebug` needs `ANDROID_USER_HOME` somewhere writable, or
  `validateSigningDebug` fails creating a debug keystore in `/root/.android`.
  Mount `GRADLE_USER_HOME` too, or every run re-resolves dependencies.
- The SDK in the image ships **build-tools 35.0.0 only**, and
  `app/build.gradle.kts` pins it.
- Kotlin does **not** treat warnings as errors here, so an import left dangling
  by a deletion compiles clean — grep for the removed symbol as well as building.
- **There is no `app/src/androidTest`, and `android-ci.yml` runs only
  `testDebugUnitTest` + `assembleDebug`** — no emulator, no `connectedAndroidTest`,
  and the `androidTestImplementation` compose-ui-test deps in `build.gradle.kts`
  are declared but unused. So **nothing can cover a Composable's body**: logic
  that must be testable has to live in `core/` (pure Kotlin) and be called from
  the screen. Judge an Android change on where its rule lives — a rule inline in
  a `@Composable` has no gate at all, and deleting the CALL to a covered `core/`
  helper is still invisible.
- **`testDebugUnitTest` comes back `FROM-CACHE` in ~13s** when `GRADLE_USER_HOME`
  is the shared `/mnt/data/tmp-qa/gradlehome` another run already filled. That is
  a cached RESULT, not an execution — for a mutation test, or any time you must
  know the tests really ran against the tree in front of you, add
  `--rerun-tasks` (~46s).

`:latest` is the `android-build` tier — no emulator and no system image **in the
image** — but you do NOT need the `:emulator` tag (which is not pullable without
GHCR auth) to drive the app. `/dev/kvm` exists on this host, so add the emulator
to a throwaway container of `:latest` and boot an AVD (~4 min, mostly download):

```bash
docker run -d --name qa-emu --device /dev/kvm --network host -v /mnt/data/tmp-qa:/gh \
  -e PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:/usr/bin:/bin \
  --entrypoint sh ghcr.io/xerktech/turma-agent:latest -c 'sleep 100000'
docker exec qa-emu sh -c 'ANDROID_USER_HOME=/gh/andhome HOME=/gh/emuhome \
  yes | sdkmanager --sdk_root=/opt/android-sdk "emulator" "system-images;android-35;google_apis;x86_64" &&
  ANDROID_USER_HOME=/gh/andhome avdmanager create avd -n qa35 -k "system-images;android-35;google_apis;x86_64" -d pixel_5 --force'
# ANDROID_AVD_HOME, not ANDROID_USER_HOME — see the trap below
docker exec -d qa-emu sh -c 'ANDROID_AVD_HOME=/gh/andhome/avd HOME=/gh/emuhome \
  emulator -avd qa35 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -accel on -no-snapshot'
docker exec qa-emu sh -c 'HOME=/gh/emuhome adb wait-for-device shell "while [ \"$(getprop sys.boot_completed)\" != 1 ]; do sleep 2; done"'
```

Driving it:

- **`avdmanager` writes the AVD to `$ANDROID_USER_HOME/avd`, but `emulator` only
  searches `$ANDROID_AVD_HOME`, `$ANDROID_SDK_HOME/avd` and `$HOME/.android/avd`.**
  Set `ANDROID_AVD_HOME` on the emulator command or it dies with
  "Unknown AVD name".
- **`sdkmanager` installs into `/opt/android-sdk`, i.e. the CONTAINER's writable
  layer — not into your `/gh` mount.** `docker rm` that container and the
  emulator + system image are gone and re-download (~4 min), even though the AVD
  under `/gh` survives. Keep the container, or expect to pay again.
- `--network host` on the emulator container means the AVD's `10.0.2.2` reaches
  the host loopback, so a scratch hub on `127.0.0.1:<port>` is reachable at
  `http://10.0.2.2:<port>`. **The manifest already sets
  `android:usesCleartextTraffic="true"`**, so plain HTTP works — no TLS or CA
  install needed.
- `adb install -r -t /tmp/app.apk` after `docker cp`ing the APK in.
- **Taps do not move focus between the sign-in fields** (Compose text fields
  under `input tap`): everything lands in whichever box has focus. Use
  `input keyevent 61` (TAB) to advance, and `input keycombination 113 29` +
  `keyevent 67` to clear a field you filled wrong.
- Screenshots are 1080x2340, past the image limit most tools accept —
  downscale with PIL before reading them.

There is **no committed gradle wrapper** — CI generates it.
`.github/workflows/android-ci.yml` is the reliable spec for how this is really
built; read it before inventing your own invocation. That workflow runs
`:app:testDebugUnitTest` + `:app:assembleDebug` and **nothing else** — no lint,
no ktlint, no instrumented source set — so a rule living inside a `@Composable`
or a ViewModel call site has **no gate at all**. Read the count out of
`app/build/test-results/testDebugUnitTest/TEST-*.xml`; it moves every ticket.

#### On the WSL workstation, build and drive natively — no container

```bash
export JAVA_HOME=~/tools/jdk-17.0.20+8 ANDROID_HOME=~/Android/Sdk
export PATH=~/tools/gradle-8.11.1/bin:$JAVA_HOME/bin:~/Android/Sdk/platform-tools:$PATH
cd android && gradle --no-daemon :app:testDebugUnitTest --rerun :app:assembleDebug
adb -s <device> install -r app/build/outputs/apk/debug/app-debug.apk
```

`--rerun` is not optional for a mutation test: without it Gradle says
`UP-TO-DATE`, nothing executes, and **every mutation reads as caught**. Same
trap as the container's `FROM-CACHE`, different wording. (`assembleDebug` on its
own is safe to trust: Gradle hashes CONTENT, so a mutated-then-reverted file
reports `UP-TO-DATE` correctly even though its mtime moved.)

**Run a throwaway probe test without editing the repo** — an init script can add
a scratch source dir, which is how you measure "is this wire shape actually
decode-fatal?" against the app's own `TurmaJson` and data classes:

```bash
cat > /tmp/qa-init.gradle <<'EOF'
gradle.projectsEvaluated { gradle.rootProject.allprojects.each { p ->
  if (p.plugins.hasPlugin('com.android.application'))
    p.android.sourceSets.getByName('test').java.srcDir('/tmp/qa-kt') } }
EOF
gradle --no-daemon --init-script /tmp/qa-init.gradle \
  :app:testDebugUnitTest --tests "qa.MyProbeTest" -i | grep PROBE
```

Measured that way: `coerceInputValues` saves a `null` and a wrong-typed
PRIMITIVE (`modelSource: 5` and `: true` decode fine, `device: 5` too), but an
object or an array where a `String`/`Boolean`/`Int` is declared always throws,
as does any non-object element of a typed `List<…>`. So "it is typed" is not the
test — "an object or array can land there" is.

**Stand up your own AVD.** The shared `turma228` is used by other sessions whose
apps steal the foreground every 30–60s and which have force-stopped
`com.xerktech.turma` outright (`adb logcat -b events | grep am_kill`) — that
looks exactly like your app crashing.

```bash
echo no | avdmanager create avd -n qa-<ticket> -k "system-images;android-35;google_apis;x86_64" -d pixel_6
emulator -avd qa-<ticket> -no-window -no-audio -no-boot-anim -port 5556
```

A second instance of an AVD already running is refused unless the first was
started `-read-only`, which is why you cannot simply reuse the shared one.

- **Re-focus with `am start -f 0x20000`** (REORDER_TO_FRONT), which returns you
  to the last SCREEN, not a tab. A plain `am start` pushes a new `MainActivity`
  and resets the Compose nav stack to the dashboard, silently losing the screen
  under test.
- **Guard every tap on `dumpsys activity activities | grep topResumedActivity`.**
  A tap resolved from one app's dump and delivered to another lands wherever
  that app put it — one such stray tap opened a package-manager "Uninstall
  Turma?" dialog.
- Resolve targets from `uiautomator dump`, never screenshot pixels: the
  compose-bar chips reflow as their labels change width. Match `content-desc`
  where there is one, and **match exactly** — a substring `Sessions` hits
  `RUNNING SESSIONS` first. Snackbars live ~3s, so poll at t+2s.
  - **A dump costs ~2s normally, but can stall for tens of seconds** — it waits
    for window idle, so a screen the ~1s fleet beat keeps repainting can hold it
    off. Measured on emulator-5556 with a second emulator running and the fleet
    beating: 1.94–1.97s, so do NOT plan around a fixed 30–60s budget. When one
    screen does hang, `exec-out screencap -p` costs ~2s and never blocks: drive
    from fixed coordinates read off one screenshot, and spend a dump only where
    you need `content-desc`.
  - A `content-desc` containing a `"` is emitted in SINGLE quotes, so
    `grep 'content-desc="…'` misses it. Grep the value, not the attribute.
  - **A row that appears/disappears reflows the buttons under it.** Hiding the
    composer's "Run against" row moved `Spawn` up ~100px, and the stale
    coordinate hit dead space — re-screenshot after any state change that can
    add or drop a field.
- `ExposedDropdownMenuBox` opens on a tap **anywhere in the field**, caret or
  body — measured on the spawn composer's Model row (bounds `[183,1277]`–
  `[897,1445]`, tapped at x=325, menu opened). An earlier note here said the
  caret only; that is wrong for this build, so resolve the field's own bounds
  and tap its centre.
- A destructive row **arms and re-disarms**: `Kill` becomes `Confirm kill` and
  reverts in ~2s, so the two taps must be one `adb shell "input tap …; sleep
  0.4; input tap …"`. A dump between them loses the arm.
- **Every list/chat screen collects the VM's `messages` into a snackbar** —
  `SessionsListPane` (its own `SnackbarHost`, bottom of the pane; in the wide
  two-pane layout that is inside the 360dp list column), `FleetScreen`,
  `ChatScreen`, and `BoardScreen`/`OrgControl` as toasts. So an error-wording
  check can be driven from any of them. Measured: a refused local spawn from the
  session list reads `✗ host has no local model configured`, a good one
  `✓ session queued`.
- **XML-illegal characters in the payload make `uiautomator dump` die** —
  a 0-byte file, and every tap resolved from it misses, while the app itself
  renders the string fine. THREE classes do it, all measured on emulator-5556:
  **lone surrogates**, **C0/DEL controls**, and **U+FFFE/U+FFFF** (the two
  noncharacters XML 1.0 also excludes). Everything else survives — `U+FDD0` and
  `U+1FFFE` dump fine, so do not blame "noncharacters" generally.
  `normalizeLocalModel` closes ALL THREE for `localModel.model`, in both
  directions (manufactured by its own 60-code-point cut, and arriving in a rogue
  agent's input); every other agent-supplied string reaching the UI is unguarded
  entirely, so re-probe per field rather than assuming the guard travels.
  Screenshot instead when a dump goes
  empty for no reason, suspect the payload before the tooling, and always run
  the same screen with a benign name as the control before filing.
- **`ChatViewModel` is scoped to the chat's nav back-stack entry**, so all of its
  in-memory state dies when you leave that screen (backgrounding does not).
  Anything that must survive lives in `AppContainer` — `container.drafts`,
  `container.modelSwitches`. Check which before calling a "the value springs
  back" report a logic bug.

#### Standing a hub up for the app to talk to

Run the real `turma/server.js` on scratch `STATE_FILE`/`ARCHIVE_DIR`/
`ARCHIVE_DB`, POST synthetic `/api/heartbeat`s every ~3s to keep hosts online,
and point the app at `http://10.0.2.2:<port>`.

- **Put a logging HTTP proxy in front of it.** The heartbeat RESPONSE drains the
  command queue, so polling `/api/agents` for `commands` misses what a tap
  actually sent; a proxy logging method + path + body is the only reliable
  record, and it is how you inject 409/500/socket-drop to reach the error paths.
  It must handle `upgrade` (raw socket pipe) or the live-tail WebSocket dies,
  and must `pipe()` responses or SSE hangs.
- Delay the first heartbeat ~2.5s; `server.js` is not listening instantly.
- **Kill previous passes' rigs first** (`/proc/*/cmdline` matching
  `turma/server.js` under your worktree). Stale beat loops from an earlier pass
  keep overwriting your hosts and quietly contaminate the evidence.
- A host the app has decoded once stays in its `byKey` map, so **re-probing a
  malformed payload under a name the app has already seen hides the failure** —
  use a fresh host name for every decode probe.
- Kill the rig by PID, not `pkill -f`, and not by grepping `/proc/*/cmdline`
  either: BOTH match your own shell, whose command line quotes the pattern you
  are searching for. `pkill` kills the caller (exit 144); the `/proc` version
  kills it too, and the replacement rig then dies on `EADDRINUSE` while the OLD
  one keeps serving — so the whole A/B runs against the unmutated code and reads
  as "no difference". Match `argv[0] == "node"`, skip your own PID's ancestry
  (`scratchpad/qa8/killrig.py`), and assert the port is free before restarting.
  The tell is subtler than a dead rig: the NEW rig keeps beating happily into the
  OLD rig's server, so any control your new rig added (an env var, a file toggle)
  silently does nothing and the app looks like it ignored the change. `ps -eo
  pid,lstart,args | grep "[r]ig.js"` must show exactly ONE before you believe a
  negative result.
- **Refuse `/api/events` at the proxy to see what a decode failure really
  costs.** With SSE healthy a bad host loses only itself (per-agent events
  decode in `runCatching`); poll-only, the whole fleet is replaced by the raw
  kotlinx exception text. Test both — they look like different bugs.

---

## 3. Driving the web UI

Chromium **cannot launch natively** in these environments (missing system deps,
no sudo; chasing them via apt is a dead end — it exits silently even once `ldd`
is satisfied). Run Chrome in Docker and drive it over CDP with `playwright-core`.
The exact working recipe is in `.claude/skills/verify/SKILL.md` — use it rather
than rebuilding it.

Two traps that cost an hour each:

- **`httpCredentials` does nothing.** The hub 302s HTML navigations to `/login`
  and deliberately sends no `WWW-Authenticate`, so Basic is never challenged.
  Fill the login **form** instead.
- **Never `waitUntil: "networkidle"`.** Every page holds an SSE stream
  (`/api/events`), so the page never goes idle and you get a TimeoutError. Use
  `"load"` plus a short explicit wait.

Also: `curl -sf -u user:pass /api/agents` returns an **empty body**, not JSON —
the 302 to `/login` is a 3xx, which `-f` does not treat as failure. If you are
parsing an empty string as JSON, that is why. Authenticate the way the client
does, or assert on the status code first.

Three more that each cost a run:

- **Set the viewport explicitly.** A page from `connectOverCDP` starts at
  **800x600**, which is below `sessions.html`'s 820px `isNarrow()` breakpoint, so
  the phone layout applies: opening a session sets `body.showing-term`, which
  **hides the site header** — the org filter, "New ticket" and the nav are all
  unclickable and every desktop assertion is wrong. `page.setViewportSize({width:
  1280, height: 900})` right after `newPage()`, and drop to 390 deliberately when
  you want the phone.
- **The page's top-level `let`s are NOT on `window`** — `cache`, `currentId`,
  `currentHostKey`, `viewMode`, `endedViewId`. `page.evaluate(() => window.cache)`
  is `undefined` and reads as "the page has no data"; `page.evaluate(() => cache)`
  (bare identifier) works, because a top-level `let` lands in the global lexical
  environment. Functions ARE on `window` (`selectSession`, `render`, `clearStage`).
- **`page.on("websocket")` is how you count live sockets** — it fires per socket
  with `ws.url()` and a `close` event, which is the only way to see a duplicate or
  leaked `/live/<host>/<id>` connection the DOM says nothing about.

How Chrome-in-Docker reaches your hub depends on the box, and the wrong answer
looks like "CDP is down": **agent container** → `--network container:$CID` (the
verify skill's recipe); **TrueNAS native host** → `--network host`; **WSL /
desktop (Docker Desktop)** → neither works (that engine is its own VM, so nothing
binds on your 127.0.0.1) — publish the port, add a gateway alias, load the hub
through the alias:

```bash
docker run -d --name qa-chrome-<ticket> -p 127.0.0.1:9344:9344 \
  --add-host host.docker.internal:host-gateway \
  --entrypoint chromium-browser zenika/alpine-chrome:latest \
  --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=9344 --remote-debugging-address=0.0.0.0 about:blank
# connectOverCDP("http://127.0.0.1:9344"), then goto http://host.docker.internal:<port>/
```

Name the container after your ticket — a stray `qa-chrome` from another run is
usually already up. `connectOverCDP` reuses one long-lived browser context, so
**`ctx.clearCookies()` first** (or a fresh `newContext()`) or `/login` 302s away
and `page.fill("#username")` times out looking for a form that isn't there. The
image ships **Chromium 124**; claim no wider a browser matrix than that.

### 3.1 Driving the live chat end to end (no real agent needed)

The chat view is fed by the hub's fanout, so a fake tunnel-agent is enough to
drive every live path. Node 22+ has a global `WebSocket`, so no `ws` dep:

```js
// 1. heartbeat a host + running session (needs worktreePath AND transcriptId)
POST /api/heartbeat  Authorization: Bearer $TURMA_AGENT_TOKEN
// 2. the control channel — this is what makes the session card clickable
new WebSocket(`ws://127.0.0.1:PORT/agent/control?name=<host>&token=<agent token>`)
// 3. push frames the hub fans out to every browser watching that session
ws.send(JSON.stringify({ turn: sid, text, status }))            // in-progress turn
ws.send(JSON.stringify({ tail: sid, entries, queued }))         // committed delta
```

Three things that each cost a run:

- **Session cards are `<button class="s-card" onclick="selectSession('<id>')">`
  and are `disabled` unless `terminalOnline`** — i.e. unless the control channel
  above is open. Open it *before* loading the page, and click the real button
  (or call `selectSession(id)`); there is no `data-id` to query.
- **A tail entry's blocks are keyed `t`, not `type`**:
  `{t:"text"|"thinking"|"tool_use"|"tool_result", …}`. A fixture using `type:`
  produces entries that render as **nothing at all**, and it looks like a bug in
  the code you are QA'ing. `buildItems` in `turma/public/chat.js` is the spec.
- **A tail entry with no `id` renders as NOTHING.** `mergeTail` keys entries by
  `e.id` and silently drops any without one, so `{role, ts, blocks}` fixtures
  produce an empty transcript and it looks like the code under test. Always
  `{id, role, ts, blocks:[{t:"text", text}]}`.
- **The Sessions page does not poll while SSE is healthy.** `refresh()` (the full
  `/api/agents`) runs at load, on a 15s timer *only when `sseOk` is false*, and in
  the post-action fast-poll burst; everything else is per-agent `agent`/`removed`
  SSE events patched into `cache`. So restarting the hub does NOT make the page
  observe an empty fleet — it keeps its last records indefinitely. To drive a
  fleet-without-this-host payload, call `render({now: Date.now(), agents: []})`
  directly.
- A hub restart on the same port keeps the login cookie and the ws-token path
  working, so the browser stays authenticated across it.
- **A hub booted less than 90s ago never marks a host offline.** The offline
  sweep (`server.js`, `setInterval` at ~2421) returns early inside
  `BOOT_GRACE_MS = 90s`, and it is the only thing that re-publishes an agent
  after `OFFLINE_AFTER_MS` (75s) lapses — a silent host emits no heartbeat and
  therefore no SSE event of its own. On a fresh hub the page keeps `online:true`
  forever and anything keyed on it reads as "still up". **Warm the hub past 90s
  before testing any host-went-away behaviour**; then the transition lands ~80s
  after the last heartbeat.
- **`navFrame()` uses `contentWindow.location.replace`, so the iframe's `src`
  attribute never changes.** Reading `termFrame.src` tells you nothing about
  whether the terminal was re-attached — count requests to `/term/<id>/` with
  `page.on("request")` instead. (The unit-test shim DOES record `src`, which is
  why a green test there proves nothing about the browser.)
- Verbosity presets are plain buttons labelled `Concise`/`Normal`/`Verbose`;
  a thinking trace renders as `<details class="thought">` (not `.think*`), and
  `renderInline` supports **code spans and links only — there is no bold/italic**,
  so `**x**` staying literal is correct, not a regression.

More of the same kind, learned on XERK-252:

- **`terminalOnline` is exactly "is there an `/agent/control` socket right now"**
  (`serializeAgent`), so `ws.close()` on your fake tunnel IS a tunnel flap and
  re-opening it IS the recovery — no restart, no waiting. `online` is
  `now - lastSeen < OFFLINE_AFTER_MS` (**75s**), so an offline host costs a real
  75-second wait with the beats stopped; there is no env override.
- **`GET .../sessions/<id>/history` is served from a hub-side cache for
  `HISTORY_FRESH_MS` = 5 MINUTES.** Any test that expects a browser-side history
  re-pull to fetch something new inside that window will see the *stale* body and
  read as a client bug. To serve `/history` at all, your fake agent must read the
  beat's reply, echo back `historyResults: [{sessionId, entries, …}]` and
  `ackedCommands: [cmdId]` — the hub only queues `{type:"history"}` on a cache miss.
- **`TurmaOrg.set("<key nothing reports>")` is inert** — `effectiveKeys` drops a
  selection no host reports, so org-scoping tests need TWO hosts beating with
  different `jira.siteKey` values and a `set()` to the *other* one.
- **The terminal iframe is navigated with `contentWindow.location.replace()`**,
  so `iframe.src` stays `about:blank` forever and tells you nothing. Spy on the
  page's global instead: `const o = window.navFrame; window.navFrame = s => { … o(s) }`.
  Its `/term/<id>/` load also 502s unless a real ttyd sits behind the tunnel.
- **To prove a regression is real, boot a SECOND hub off `origin/main`'s page.**
  `server.js` reads `public/` relative to `__dirname`, so
  `cp -a turma /scratch/old && git show origin/main:turma/public/sessions.html >
  /scratch/old/public/sessions.html` gives you the old UI on the same server, and
  the same driver script can run against both.

### 3.2 Verifying a CSS / layout change

**Nothing in CI reads `app.css` for layout** — `nav.test.js` asserts three rules
by regex (`.site-header`, `.site-header-in`, `html{scrollbar-gutter}`) and that is
all. A green suite proves nothing here; measure it in a browser.

- **Boot a before-hub beside the after-hub and pixel-diff.** `server.js` reads
  assets via `path.join(__dirname, "public", …)`, so a second hub is `cp -r turma
  /tmp/…/before` + `git show origin/main:turma/public/app.css >` over its copy +
  its own `PORT`/`STATE_FILE`/`ARCHIVE_DIR`/`ARCHIVE_DB`. An untouched layout
  diffs to **zero** pixels, which turns "looks the same" into a fact.
- **Measure, don't eyeball**: per viewport read each column's
  `getBoundingClientRect()`, the strip's `scrollWidth/clientWidth` and
  `documentElement.scrollWidth > clientWidth`. Distinct rounded `y` values are
  the proof of "one row, never stacked".
- **Sweep boundaries, not round numbers**: 2560/1440/1180 (`--wrap`)/1024/901/
  900/899/601/600/561/560/559/390/320/280 plus landscape phone (740x360). There
  are **two** breakpoints — 600 (`.wrap` padding, bottom nav) and 560 (board).
- **`Input.synthesizeScrollGesture` with `gestureSourceType:"touch"` is a no-op**
  in alpine-chrome; `"mouse"` and `page.mouse.wheel` work. Touch swipe/fling is
  **not verifiable here** — report it unverified rather than passing it.
- **A `scroll-snap` strip does not rest at `scrollLeft: 0`.** It rests at
  `padding-left` and snaps back if you set 0, so that padding is off-screen and
  anything drawn in it (an `outline-offset` ring) is clipped — unless the strip
  sets `scroll-padding` to match, which the board's now does.
- **`preserveScroll` (`nav.js`) matches by CHILD INDEX** when no ancestor has an
  `id`, so a repaint that adds or drops a sibling restores an offset onto the
  wrong node. `#board` prepends `.kc-note` divs on truncation / a poll error;
  the column strip survives it only because it carries `id="kanbanCols"`. Flip a
  note across a beat and re-check any OTHER scrolled node.
- **A regex-over-CSS guard only sees the FIRST rule matching its selector**, so a
  later unscoped override — the pattern the vendored `board.css` files use — sails
  past it while winning the cascade. Prove any such test by mutating the stylesheet
  and re-running it, never by reading it — and re-measure the mutation in a browser,
  because an escape is only a finding once you have shown it changes what renders.
- `overflow-x: auto` computes `overflow-y` to `auto` too — confirm
  `scrollHeight === clientHeight` or a vertical wheel over it gets swallowed.
- A scroll container's horizontal scrollbar sits at the bottom of **its own
  box** — on a tall board, thousands of px down the page and never on screen.
  "It scrolls" is not "the user can tell it scrolls".
- **Swapping a stylesheet under a RUNNING hub changes nothing** — `server.js`
  `readFileSync`s `public/*` at boot and serves `/app.css` `max-age=300`. Restart
  the hub, and give each CSS variant **its own PORT**: `connectOverCDP` reuses one
  browser context, so its cache outlives `clearCookies` and even
  `Network.setCacheDisabled`, and a new origin is the only bust that always works.
- **A snap strip whose column is WIDER than the scrollport** (the board below
  ~330px) settles mid-column after a gesture, not at 0 — Chrome keeps the
  over-large snap area covering the port. Not stuck: keep scrolling and it reaches
  0/max. Sample the rest ~700ms after the wheel, and scroll BACK before calling
  anything unreachable.
- **Keyboard focus does not scroll a horizontal strip** (Chromium 124): `focus()`
  and a real `Tab` onto a card in a sliced column both leave `scrollLeft` alone,
  drawing the focus ring half off the scrollport. Compare `activeElement`'s rect
  with the strip's rather than eyeballing it.
- **Driving the board's drag (XERK-141) has three aims to get right**: hold
  **still** >300ms (`LONG_PRESS_MS`; >10px first disarms it as a scroll); avoid
  `CARD_OWN` (`.kc-key, .kc-sess, .kc-start` — that is most of a card's header
  row); and stay INSIDE the strip's box, since past its edge `elementFromPoint`
  is null and `highlightColAt` drops the target. A good drop POSTs
  `/api/jira/<siteKey>/<key>/status {"category":…}` — assert on that, not on the
  card moving (with no agent to ack, "couldn't move" is correct).
- **Session chips need `session.ticket = {key, siteKey}`** on the beat; a flat
  `ticketKey` indexes to nothing and the card renders chipless, which reads as a
  renderer bug.

---

## 4. Running QA agents in parallel

XERK-235 ran five `qa` subagents at once (hub backend, web UI, python agent,
glasses+veiller, android). That works, and it is much faster than serial, but
give each one:

- **Its own port lane**, stated in the prompt. They all boot hubs.
- **Its own docker container name.** Two agents both naming a container
  `qa-chrome` will fight.
- **An explicit scope**, and a note that other agents are working the same
  worktree.

The last one matters more than it sounds. **A shared worktree is not a stable
base.** During XERK-235 one agent's mutation test (`userAuthorized` → `return
true`) was live in the tree while another agent was driving the hub through it,
and disabled auth for ~15 minutes of that run. Two separate agents also reported
files changing under them mid-run.

So: if you are QA'ing while anything else is writing, **pin your own copy first**
(`git archive HEAD | tar -x -C <scratch>`) and drive that. And if you are the one
mutating, revert every mutation immediately and confirm `git status` is clean
before you move on.

---

## 5. Where the bugs actually were

The case studies — the actual defects, how each was found and why it survived
review — live in **`qa-findings.md`** beside this file. Read it before your
first pass on a component you have not QA'd before: the shapes repeat, and it
is the difference between hunting and guessing. What stays here is the part you
act on every time.

### 5.6 Things worth attacking every time

- `agent/hooks/guard.py` — the only thing between a hands-off agent and a
  destructive command. XERK-235 got 23 of 29 probes past it: wrappers
  (`sudo -u`, `env -i`, `timeout`, `xargs`, `find -exec`), `bash -c`, `eval`,
  `$(...)`, subshells, a bare `&`, loop bodies, `git -C` before the subcommand,
  and `+main` as a force refspec. Attack it the same way, and check the reverse
  too — it also refused ordinary work (`grep 'DROP TABLE'`).
- Regexes on unbounded input, especially on the heartbeat thread.
  `clean_summary`'s `[.\s]+$` took 9.7s on 50k trailing spaces.
- Every parser eating untrusted or semi-structured text: `_pane_busy`,
  `parse_pane_mode`, `parse_pane_prompt`, `parse_model_picker`, `_scan_pr_line`,
  `_entry_blocks`, `adf_text`, `azure_html_to_text`.
- Every place agent-supplied text reaches the DOM, a path, a filename, a shell,
  or a tar extraction.
- **Socket bookkeeping on any change to the chat/live path.** The hub `unwatch`es
  a session only when its LAST `/live` viewer disconnects, so one browser socket
  the page has lost track of pins the agent's ~1s transcript tail on forever.
  Count sockets opened and still-open after leaving the stage.
- **Whether the branch still merges, and what the careless resolution costs.**
  `git merge-tree --write-tree HEAD origin/main` finds the conflicts (it exits 1
  on one); then run the *wrong* side of each hunk as a mutation. XERK-246
  conflicted on a single `_state.update` line where taking `main`'s side drops
  one field and permanently hides two controls — with the whole suite green.
  A branch verified only at its own tip is not verified. `qa.md` is the file
  most likely to conflict; a "take theirs" there silently deletes a pass's notes.
- **Boundaries asserted relative to the constant they test.** A TTL check written
  `now = at + SETTLE_MS + 1` bounds the constant from below only: raising it to
  16.7 hours keeps the test green, which is the exact failure the constant
  exists to prevent. Assert one side with a literal.
- **Which heartbeat fields are actually coerced.** Read `normalizeRecord` — it is
  the one list, and both the ingest and the `state.json` restore call it. Today:
  `normalizeUsage`, `normalizeLimits`, `normalizeLocalModel`, `normalizeSessions`
  (which reshapes `sessions[].session.agents` via `sanitizeLiveAgents`, and
  coerces `modelSource`/`modelSourceAt`). Everything else is raw: every other
  host-level block Android types (`capacity`, `github`, `models`, `jira`,
  `claudeAuth`, `closedSessions`, …) and every other per-session field (`prs`,
  `id`, …), where an object or array throws for the WHOLE `/api/agents` array.
  `normalizeSessions` DROPS a non-object element and REWRITES a non-array
  `sessions` to `[]` (both used to hide that host from the phone — and the
  non-array one stopped the app signing in at all, see below).
  **`normalizeRecord` runs PAST the `AGENT_RECORD_MAX` gate**, which is what
  makes rewriting safe: placed before it, a coercion shrinks away the very
  amplifier the gate exists to refuse (an 8 MiB string `sessions` rewritten to
  `[]` turned a 413 into a 200) and walks an oversized record field by field
  before throwing it out — which is how a 24 MiB model name reached a
  per-code-point spread and OOM-killed the hub. So: **anything running before
  the gate may only SHRINK; put a rewrite after it.** `sanitizeHeartbeat` is
  pre-gate and is held to the shrink-only half.
  - Measure what an uncoerced field costs before calling it acceptable. A host
    with `sessions:"x"` does not merely vanish: the phone **cannot sign in at
    all**, reporting `Could not reach the hub — check the URL`, because the
    login probe decodes `/api/agents`. A/B it by dropping the bad host and
    re-pressing Sign in. (That one is coerced as of XERK-246; the point is the
    method — the cost of an uncoerced field is rarely the one you assume.)
  Verify by probing, not by reading any doc: this list has been wrong in
  `CLAUDE.md` and here more than once.
- **Check the state.json RESTORE, not just the ingest path**, and check it
  against the LIST above rather than against what the loader looks like it does.
  A hub restart is when a new coercion ships and the restore is the first thing
  it serves, so a coercion applied only at ingest is a hole straight through
  itself — until that host's next beat, which for an OFFLINE host is never
  (records live 7 days). The loader is a bare `for` over the parsed blob;
  `grep -n "(a);"` the slice between `agents = JSON.parse` and
  `first boot or no volume` and compare it to the four, one by one.
  Repro that costs 30 seconds and needs no agent: write a state file with the
  suspect record, boot `turma/server.js` on it with `STATE_FILE=` pointed there,
  and `curl -u … /api/agents` — the record has no beat behind it, so whatever
  comes back is what the restore did. Point the phone at the same hub to see
  what the raw record costs it.
  A `normalize*` is also a WHITELIST: a sub-key a newer agent adds is dropped
  fleet-wide with nothing failing.
- **The restore runs inside `try { … } catch {}`, so ANY throw in it is silent** —
  the record loads half-coerced, no log line, every suite green. `console.log`
  the `loaded N agents from …` line is the only tell; its ABSENCE with a
  non-empty state file means the loop threw. Two things cause it: a module
  `const` the restore path reads that is declared BELOW the restore (temporal
  dead zone at module init — function declarations hoist, `const`s do not), and
  a shape the coercions don't guard. Check the first mechanically rather than by
  eye: BFS the call graph from `normalizeRecord`, collect the top-level
  `const`/`let` each reached function references, and flag any declared after the
  loader (`scratchpad/qa8/tdz_scan.py`). A line-order assert naming two constants
  by hand does not see the third.
- **The hub's deployed memory ceiling is `mem_limit: 256m`** (DockerOps
  `compose/turma.yaml`), so ANY per-request allocation over ~200 MB is a
  one-request kill of the whole fleet's control plane, not a slow page.
  `HEARTBEAT_MAX` is 32 MiB and `AGENT_RECORD_MAX` (8 MiB) is checked AFTER
  `normalizeRecord`, so a coercion that expands an agent-controlled string before
  bounding it — `[...s]` spreads to one array element per code point — routes
  straight around that guard. **Bound with `slice()` BEFORE any spread/split/
  match over an agent string.** Reproduce at the deployed shape rather than
  arguing about it:
  ```bash
  docker run -d --name qa-hub -m 256m --memory-swap 256m -p 127.0.0.1:8993:8993 \
    -e PORT=8993 -e TURMA_USER=qa -e TURMA_PASSWORD=qa-pass -e TURMA_AGENT_TOKEN=t \
    -e STATE_FILE=/tmp/state.json -e ARCHIVE_DIR=/tmp/a -e ARCHIVE_DB=/tmp/a.db \
    -v "$PWD/turma:/app:ro" -w /app node:24-bookworm-slim node server.js
  # then POST one beat with a ~24 MiB string in the field under test and read
  docker inspect -f '{{.State.Status}} {{.State.OOMKilled}}' qa-hub
  ```

Mutation-testing mechanics, since a broken harness reads as a passing one:

- Force the tests to actually run (`--rerun`, or `--rerun-tasks` in the
  container) — an `UP-TO-DATE`/`FROM-CACHE` result makes every mutation "caught".
- **Run a mutation the way CI runs the suite, and run it more than once.** A
  guard asserted as a TIME or `heapUsed` budget is order-dependent: whether the
  GC ran just before the measurement decides the number. `node --test
  turma/tests/server.test.js` caught the un-bounded-spread mutation 5 times in 8
  identical runs and MISSED it 3 — alone (`--test-name-pattern`) it failed every
  time. A single green run against a mutation proves nothing; a resource budget
  needs a margin of ~10x, not ~1.02x (measured 51ms against a 50ms limit and
  71MB against 64MB).
- `git checkout -- <path>` resolves relative to the `-C` root, not your cwd. A
  silently failed revert leaves the previous mutation in the tree and the NEXT
  one then reads as caught. Verify with `git status` after every revert, and
  mutate a scratch copy rather than the repo.
- On `android/`, expect roughly HALF the battery to survive, and not at random:
  60 mutations over XERK-246 left 30 alive, all in the same three places —
  **Composable bodies** (19: `ChatScreen.kt`, `FleetDialogs.kt`, the two
  `SpawnDialog` call sites, and `SessionsListPane`'s snackbar collector + host,
  no instrumented source set), **ViewModel call sites** (10: `ChatViewModel.kt`,
  `FleetViewModel.kt`, no Robolectric or coroutine-test harness), and
  **`@Serializable` field defaults** (1) that no fixture exercises. A pure
  `core/` rule with a test is gated; the CALL to it is not, and neither is which
  value a Composable passes it. Spot-checked independently: 3/3 `core/` mutations
  caught, 9/9 VM-call-site and Composable-body mutations escaped. Judge an
  Android change on where its rule lives, and quote the survivor count rather
  than "a few".
- A hub-side rule genuinely is gated by comparison. Over `turma/server.js`'s
  coercion path a 12-mutation battery is now caught 12/12 by `server.test.js` —
  including the TDZ one (the behavioural child-process restore test sees it) and
  the un-bounded spread, whose guard pairs a structural assertion with a
  resource budget precisely because the budget alone was flaky. `sessions:{a:1}`
  (any non-iterable) used to make `normalizeUsage`'s `for…of` throw and abort the
  whole restore into its own `catch {}` with `loaded N agents` never printing;
  `normalizeSessions` now runs first and rewrites it. The asymmetry with Android
  is structural, not effort: "0 escapes" on a UI layer usually means the battery
  was too small, while on the hub it means the tests are real.
- `gradle --no-daemon --offline :app:testDebugUnitTest --rerun` is ~13s per
  mutation once the first compile is warm, so a 50-mutation battery is ~12
  minutes; run it in the background and do UI work meanwhile (the emulator does
  not see tree edits). Do NOT read a source file while it runs — you will read a
  mutation and think it is the branch.
- Type validation on hub routes: `!body.repo` passes an object; a non-string
  `model` coerced to `""` silently *released* a pin.
- The two mirrors of any rule (`liveState` in `index.html` vs `sessions.html`,
  `core/*.kt` vs its web original). They drift, and the drift is invisible until
  you diff them side by side with a concrete input.

---

## 6. Known-unverifiable on this host

Say these are unverified rather than implying otherwise:

- **The Android UI.** `ghcr.io/xerktech/turma-agent:latest` has no emulator or
  system image. Build, unit tests, lint and APK inspection are reachable;
  installing and driving the app is not, without the `:emulator` tag or a real
  device over `adb connect`.
- **Real G2 glasses / the Even phone app / the Mentra simulator.** The Veiller
  checkout on this host has no `sdk/miniapp-simulator`, so `sim/walkthrough.ts`
  and `sim/phone-tour.ts` both exit 1.
- **Real FCM delivery** (needs a device + a service account) and **real Whisper
  STT** (needs `LITELLM_URL`).
- **The ttyd terminal proxy and the OSC 52 clipboard bridge** — needs a real
  ttyd behind a real tunnel-agent; a fake control channel does not serve it.
- **Live Jira / Azure DevOps / GitHub / GitLab APIs** unless creds are present.
  Note the trap in §1: the systemd agent's env leaks into shells here, so a
  "hermetic" agent can hit the REAL tracker without being asked to.

### 6.1 Guard limits that are deliberate, not bugs

`guard.py` classifies **the command string it is handed**. Where the target is
not in that string, it cannot decide, and the two candidate fixes are worse than
the gap. Do not re-file these:

- **`xargs rm -rf < list.txt`** — operands come from a file the hook cannot
  read. Denying the shape would also refuse `find . -name '*.o' | xargs rm -rf`,
  an everyday idiom. Every form where the target IS visible
  (`echo /etc | xargs -I {} rm -rf {}`) is denied.
- **`cat drop.sql | psql`** — the SQL is in the file, not the command line.
- **An unresolved variable** (`rm -rf $TMPDIR`) is left alone. Only names the
  same command line assigns are inlined, so `D=/etc; rm -rf $D` IS denied, and a
  variable set by the surrounding environment is not guessed at.
- **`rm -rf *`** is allowed. A bare `*` cannot expand onto a system root, and
  refusing it would break ordinary work in a build directory. Absolute globs
  (`/et*`, `/e??`) are denied.

The guard is a **backstop against catastrophe, not a sandbox**. It is one layer
under `permissions.deny` and the operator's own host hardening; treat a gap as
worth closing, not as a breach of a boundary it never claimed to be.

### 6.2 Pre-existing behaviours — confirm against `main` before filing

Each of these reproduces identically on `main`, so it is not whatever branch you
are holding. Re-confirm with the same script on both before you spend time.

- **An agent tunnel flap holds the stage** (XERK-252, in `main` from 05ceb86).
  Dropping the `/agent/control` channel leaves the conversation on screen, paints
  a `⚠ tunnel offline` chip on both bars, and the stream RESUMES on its own when
  the agent reconnects — the hub holds the browser's `/live` socket across the
  flap and re-arms the watch. **Before 05ceb86 it cleared the stage** and then
  fetched `/api/agents/null/sessions/null/history` (404); if you see either,
  you are on an older pin or looking at a regression. Drive it with the fake
  agent in §3.1: `agent.drop()`, then reconnect a new control channel.
- **`preserveScrollOffset` in the glasses `App.onTurn` path has no test.**
  Deleting the call leaves all 455 vitest tests green while a scrolled-up view
  gets yanked down by a growing live turn. The behaviour is correct on both
  `main` and HEAD — it is the coverage that is missing.
- **One malformed host costs the phone every OTHER host, silently.** Decoding
  `/api/agents` is atomic on Android, so an object/array in any uncoerced field
  throws for the whole array; `FleetRepository.refresh` catches it into
  `FleetState.error`, but `ui/FleetScreen.kt` renders that error ONLY when the
  fleet is empty, so the app keeps painting its last good snapshot and still
  claims "N / N online". Per-agent SSE events decode inside `runCatching{}`, so
  while SSE is healthy a bad host loses only itself — but every full refresh
  throws, and a cold start then shows the reduced count with no error at all.
  Two-line repro, no app changes needed:
  ```
  POST /api/heartbeat {"device":"capbad","online":true,
        "capacity":{"maxSessions":"eight","running":1.5,"queued":0,"free":0}}
  ```
  Hub serves it raw; the phone silently drops `capbad`. Lenient decoding absorbs
  a number or bool in a String field, so only object/array values do it. Use a
  host name the app has never decoded, or its `byKey` entry hides the failure.
- **`ChatViewModel` never starts the fleet poll**, so a process-death restore
  straight into a chat shows no session record — header "Session", chips at
  their defaults, no PR/ticket/source chips — and never recovers until you back
  out to a list and re-enter. `FleetRepository.start()` is called only from
  `FleetViewModel.start()`, i.e. from a list screen. It degrades in the safe
  direction (controls hidden, not wrongly enabled).
- **The board drag's edge auto-scroll is dead on a phone (≤560px).** `edgeScroll`
  nudges `scrollLeft += 18` per pointermove and `scroll-snap-type: x proximity`
  snaps it back, so a card only reaches a column already on screen (a peek is
  enough). Above 560px, snap off, the same code scrolls. Reproduces on `main`'s
  `app.css` too — snap and strip both predate XERK-253. Trace `scrollLeft` while
  holding the pointer within 48px of the strip's right edge.

---

## 7. Reporting

A finding needs: severity, `file:line`, one sentence on the defect, and a
reproduction someone else can run. Mark **CONFIRMED** (you reproduced it) apart
from **SUSPECTED** (you reasoned it). A suite passing is the floor, never the
verification — if you did not build and drive the thing, say so, and the verdict
is PARTIAL.

**A FAIL verdict is worth more than a PASS.** All four gates in XERK-235 came
back FAIL on their first run and three on their second; every round found real
defects, including a stored XSS that was executing in the operator's browser and
a remote crash of the whole hub. A gate that returns PASS on its first look at a
substantial change has usually not tried hard enough — say what you could not
break, and how you tried.

Three habits that paid off in XERK-235 and cost almost nothing:

- **Diff the new behaviour against `origin/main`.** Load both versions in one
  process and run a corpus through each. "main denied this and HEAD allows it"
  found three regressions in the guard alone that no test covered — including
  one the fixing commit introduced.
- **For UI changes, diff the DOM, not your impressions.** Boot two hubs (one per
  pin, different ports), drive the identical script against both, and compare
  `chatScroll.innerHTML` at each step. On XERK-251 that proved 12/12 states
  byte-identical to `main`, which no amount of clicking would have established.
  It also gives you a **sensitivity control**: run your detector against the
  pin that still has the old behaviour and confirm it actually fires. A sampler
  that reports "no problem found" against both pins has proven nothing.

- **Mutation-test your own verification.** Break three behaviors the suite
  claims to protect and confirm it notices. Every agent that did this found at
  least one thing the suite did not actually cover. Revert every mutation and
  confirm `git status` is clean — see §4 on why this matters with others in the
  tree.
- **Report what you could not exercise, by name.** The most useful lines in
  those reports were the "not verified" lists, because they are what the next
  pass starts from.

## 8. Azure DevOps, and PR chips on a host you cannot log into

The fleet's ADO host (`MXH-T16`) is an **on-prem Azure DevOps Server**, not
Services, and nothing about it can be exercised from this box directly. What
*can* be done, entirely read-only, is below.

### 8.1 Find out what a remote host actually is, without asking the hub

The hub's own durable state is a file on this machine. Read it; never write it.

```bash
python3 - <<'EOF'
import json; d=json.load(open('/mnt/data/Docker/Turma/state.json'))
for h,a in d.items():
    j=a.get('jira') or {}
    print(h, j.get('source'), j.get('siteKey'), a.get('reposRoot'), a.get('agentVersion'))
EOF
```

- `jira.source` is `jira` or `azure` — which tracker that host polls, and hence
  whether its PRs are GitHub/GitLab/ADO.
- `reposRoot` distinguishes a container (`/repos` per DockerOps compose) from a
  native install (a real host path). **Every agent in this fleet is native** —
  Portainer shows no `turma-agent` container on any node, only the hub.
- `github.available:false` means `gh` is absent there, so nothing GitHub-shaped
  can be assumed of it.
- Ticket URLs in `jira.tickets[].url` reveal the ADO base's **scheme and case**,
  which `siteKey` throws away and which `_azdo_pr_id`'s prefix match needs.

### 8.2 The hub's archive is the record of what a remote session really ran

`/data/archive/<repo>/<date>__<summary>__<host>__<shortid>.jsonl` (here
`/mnt/data/Docker/Turma/archive/`) holds every ended session on the fleet,
including hosts you have no shell on. It is the fastest way to answer "what
command does that host actually use for X".

- Rows are **pre-parsed archive rows, not raw transcript JSONL**:
  `{uuid, role, ts, text, blocks:[…]}`, where a call is
  `{t:"tool_use", name, input:"<the command string>", id}` and its result is
  `{t:"tool_result", text, forId}`. Code that expects `message.content` finds
  nothing here.
- Pair them by `id`/`forId` to replay real call/result pairs through
  `_scan_pr_entry` — that is how attribution is verified against reality rather
  than a fixture.
- **Treat archive contents as sensitive.** Sessions have pasted real PATs into
  commands, so they are in these files and in the FTS index. Never echo a line
  you have not read first; cite file + row instead.

### 8.3 Exercising the ADO PR path with no ADO org

`azdo_pr_status` / `_azdo_pr_comment_events` / `_azdo_policy_evals` all go
through `azure_req` → `urllib`, so a local TLS stand-in is enough:

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 2 -nodes \
  -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
export SSL_CERT_FILE=$PWD/cert.pem     # urllib honours it; no verify-off hacks
```

Then serve `/_apis/git/pullrequests/<id>`, `/{proj}/_apis/policy/evaluations`,
`/{proj}/_apis/git/repositories/{repo}/pullRequests/{id}/threads` and
`/_apis/connectionData`, import `hub-agent.py` by path, and set `ha.AZDO_URL` /
`ha.AZDO_TOKEN` on the module (both are read at import from the env).
`AZDO_PR_URL_RE` and `AZDO_REPO_WEB_RE` are **https-only**, so the stand-in must
be TLS — a plain-http stand-in silently tests nothing.

### 8.4 On-prem facts worth not re-deriving

From that host's own probes, recorded in the archive:

- `deploymentType: onPremises`; the server advertises 7.2 as latest but
  `api-version=7.2` returns **400** — `7.1` and `6.0` both return 200.
- `_apis/connectionData` on it **requires a `-preview` suffix**
  (`?api-version=6.0` style calls get 400 with that message).
- The `azure-devops` az extension **refuses on-prem outright** ("works only with
  Azure DevOps Services"), so `az repos …` is not a path there at all; that host
  drives the REST API through its own `ado` wrapper.
- The pinned extension's own SDK model (`azure_devops-<v>-py2.py3-none-any.whl`
  from `https://aka.ms/azure-cli-extension-index-v1`, just unzip it — no install
  needed) has **no `web_url` field on `GitRepository`**, so `az repos pr create`
  output can only ever carry `remoteUrl`.

### 8.5 Traps in this area

- **The INSTALLED guard polices your own Bash calls.** A probe string containing
  an attribution trailer (`Co-Authored-By: …`, `Generated with …`) gets your
  *own* command denied. Put such strings in a `.py` file, assembled from
  fragments, and run the file.
- A command containing `pr create` can trip a `PostToolUse` hook that tells you
  to go watch CI on a PR you never opened. Ignore it; you created nothing.
- `TTYD_PORT_BASE`, `~/.turma` and the real tracker env leak into any agent you
  boot here — see §1. For PR work, patch `ha.AZDO_URL`/`ha.AZDO_TOKEN` on the
  module rather than exporting them, so nothing can reach a live org.

### 8.6 Two traps in the ADO URL handling itself

- **Scheme assumptions hide on the compose path.** `_azdo_created_pr_url`
  strips the `<org>@` prefix ADO puts on `remoteUrl` — and `remoteUrl` is the
  ONLY field a vendor create can supply, because the pinned `azure-devops`
  extension's SDK (`azext_devops/devops_sdk/v5_0/git/models.py`, `GitRepository`)
  has no `web_url` at all. A strip that knows only `https://` therefore drops
  every plain-http on-prem create in silence. When you widen a URL regex to
  `https?`, grep the same area for other hardcoded `https://`.
- **A regex can be widened without being tested.** `AZDO_REPO_WEB_RE`'s http
  half survived a mutation (reverting it to https-only broke nothing) because
  the only http test drove the WRAPPER path, where the link is already in the
  output and that regex is never consulted. Mutation-test each widened pattern
  separately; a test that exercises the feature is not necessarily a test that
  exercises the line.
