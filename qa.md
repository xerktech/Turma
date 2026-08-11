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

| | agent container | TrueNAS native (this host) |
|---|---|---|
| `npm` / `npx` | on PATH | **not on PATH** — see below |
| `java`, `gradle`, Android SDK | bundled | **absent** |
| `apt`, writable `/usr` | yes | **no** — read-only, no sudo |
| `ps` / `pkill` | absent | present |
| `~/.claude`, `~/.turma` | bind mounts | the operator's real ones |

Check with `which java gradle npm` before you plan anything. Assuming the
container's toolchain on a native host is the single most common way to waste
a QA session.

### Native-host facts

- **`npm`/`npx` are installed but not linked.** `node` is symlinked into
  `/root/.local/bin`, `npm` is not. Every npm command must start with:
  ```bash
  export PATH=/root/.local/node/bin:$PATH
  ```
  Without it you get `command not found: npm` and may wrongly conclude Node
  tooling is unavailable.
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

Baselines below are from `main` at v0.6 + XERK-251 (commit 5c78834), so a deviation is
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
cd turma && node --test tests/*.test.js        # baseline: 911 pass, ~6s
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
python3 -m unittest tests.test_guard tests.test_guard_settings tests.test_ask   # 48 pass
node --test tests/tunnel-agent.test.js                         # 80 pass
for t in tests/test_*.sh; do bash "$t"; done                   # native/entrypoint suites
```

**There is no pytest.** `python3 -m unittest` is the only runner.

The single node command `code-scan.yml` really runs (1042 pass) — use this to
reproduce that gate rather than per-directory runs:

```bash
node --test turma/tests/*.test.js agent/tests/*.test.js .github/scripts/tests/*.test.js
```

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

Baseline: **282 JVM unit tests** (was 278 before XERK-252), 0 failures, and a ~21 MB
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
built; read it before inventing your own invocation.

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

On the **native host** run Chrome with `--network host` (the verify skill's
`--network container:$CID` is for the agent container, where 127.0.0.1 is shared
with the hub). Name the container after your ticket — a stray `qa-chrome` from
another run is usually already up. `connectOverCDP` reuses one long-lived
browser context, so **`ctx.clearCookies()` first** or `/login` 302s away and
`page.fill("#username")` times out looking for a form that isn't there.

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

From the XERK-235 pass, ranked by how much they'd have cost in the field. Use
this as a hunting guide, not a checklist — the *shapes* repeat, and every one of
these was found by running the thing rather than reading it.

### 5.1 Escaping that is right for one context and useless in another

The single most serious finding. `esc()` escapes `'` to `&#39;`, which is correct
for text — and no protection at all inside `onclick="f('${esc(x)}')"`, because
the HTML parser decodes the entity **before** the handler source is compiled. 38
sites did that, and a repo directory name (raw `os.listdir`, never validated) was
enough to run attacker JS in the operator's authenticated browser on page load.

**Look for the sink's real context, not the escaper's name.** Grep for
`on[a-z]*="` and check what is interpolated inside it; grep for `href="${` and
check whether anything validates the *scheme*.

### 5.2 Guards that cannot fire

A test exists, is green, and is wired to nothing.

- `glasses`/`veiller` vendor `turma/public/{chat,board}.js` verbatim and assert
  byte-identity — but their CI only triggered on their own directories. A PR
  editing the source of truth never ran the guard, and three vendored copies
  drifted before anyone noticed.
- `veiller`'s copy of that test compared the vendored file against a hash baked
  in from **that same file**. It could only catch someone editing the copy,
  never the upstream moving. Green the whole time it was wrong.
- `code-scan.yml` omitted `android/**`, so an Android-only PR ran zero SAST —
  while two Android files carried `nosemgrep` annotations written on the
  assumption that it runs.

**For every test that asserts two things agree, check the CI path filter covers
both.** For every pinned hash, check what it is pinned *to*. For every
`nosemgrep`, check the scanner actually reaches that file.

### 5.3 Fixtures that encode a shape the producer never emits

`ChatItemsTest` built a `tool_use` and its `tool_result` in one entry. The hub
always puts the result in the *next* entry. The test passed; every tool card in
the shipped Android chat rendered empty with a duplicate card beside it.

**When a test double and a real producer disagree, the double wins the test and
loses the product.** Cross-check fixtures against what the producer actually
writes — here, `agent/hub-agent.py`'s `_entry_blocks` and the web's own tests.

### 5.4 Claims in comments and CLAUDE.md the runtime does not honor

`CLAUDE.md` is unusually detailed and mostly accurate, which makes it easy to
trust:

- `_GUARD_DENY_PATH_RULES` shipped `Write(~/.ssh/**)` rules Claude Code
  **rejects at startup**, printing 7 warnings into every session pane. The unit
  test asserted the rejected rules were present, locking it in. (The `Edit(...)`
  twins did hold, so this was noise, not exposure — but only launching the
  product showed it.)
- `engines.ts` claimed "CI fails the moment they drift". It did not.

Cheap way to catch this: **launch the real thing once and read its first 20 lines
of output.** Static reading finds none of it.

### 5.5 A cap that cannot say so

`readBody` destroyed the socket past 1 MiB without writing a response, so the
agent saw `ECONNRESET` with no status to branch on — and because it holds staged
results until a POST succeeds, it re-sent the same oversized body every beat and
the host stayed offline forever, silently. The cap was also far below a
legitimate heartbeat.

**Every limit needs an answer, not just an enforcement.** Check what the *client*
sees when it trips one, and whether the client can recover.

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
- Type validation on hub routes: `!body.repo` passes an object; a non-string
  `model` coerced to `""` silently *released* a pin.
- The two mirrors of any rule (`liveState` in `index.html` vs `sessions.html`,
  `core/*.kt` vs its web original). They drift, and the drift is invisible until
  you diff them side by side with a concrete input.

### 5.7 Shapes the SECOND round found — all of them in the FIRST round's fixes

Every one of these was introduced or left behind by a pass that believed it was
done. Re-QA a fix as hard as you QA'd the original; the fix is the newest, least
exercised code in the tree.

- **A sanitiser reached through a variable.** The first XSS pass converted every
  `esc(` written *inside* an `on*="…"` attribute and missed all 20 sites that
  did `const key = esc(a.key)` and interpolated `${key}` — same bug, one
  indirection away. **The regression test had the same blind spot**, greps for a
  literal `esc(` inside the attribute, and was green with the vulnerability
  shipped. When you write or judge a taint guard, mutation-test it in the shape
  the bug *actually shipped in*, not the shape it is easiest to grep for.
- **A fix placed in the wrong loop.** The Android `repoOptions` union was added
  over the `byUser` winners instead of over every agent — and `board.js` has a
  comment naming that exact loop as the wrong one. It did nothing in the common
  case, and the three tests added with it all used two different tracker users,
  which is the one arrangement where the wrong loop still works. **Fixture
  choice hid the bug**, exactly as it had in the commit being fixed.
- **A cap that bounds the small thing and not the large one.** `SPAWN_FIELD_MAX`
  bounded queued-command fields while the heartbeat spread an unbounded payload
  onto a persisted record — and the same commit raised that body cap 32×. One
  agent could then park 30 MiB per beat and, with enough hosts, kill the hub
  outright: `JSON.stringify` throws past ~512 MiB and the throw was inside a
  timer callback, so it was uncaught. Look for the *biggest* unbounded thing,
  not the one nearest the change.
- **A guard with a lower bound and no upper one.** The archive cursor refused a
  rewind but accepted `endOffset` past 2^53, which SQLite stores and then
  refuses to read back — bricking that transcript forever.
- **Security fixes with nothing that can fail.** Reverting the Android WebView
  debug flag left `testDebugUnitTest`, `lintVitalRelease` and semgrep all green,
  and `android-ci.yml` runs neither of the last two on a PR. Ask of every
  security fix: *what turns red if someone undoes this?* If the answer is
  nothing, that is a finding.
- **Two fixes that were regressions of their own fixes.** Substituting a
  placeholder for an unknowable `$( )` cured one false positive and made
  `rm -rf /$(cat x)` look like a deep path; following exec wrappers to a client
  missed the normal spelling, where the remote command is a single quoted token.
  **Always diff the new behaviour against `origin/main` over a corpus**, in one
  process, and treat "main denied this and we now allow it" as a finding unless
  it is deliberate and written down.
- **A bound that is per-item with no aggregate.** Capping each unknown heartbeat
  key at 64 KiB was defeated by sending 400 of them in one beat — 25 MiB through
  the very path written to stop it — and left every KNOWN key unbounded besides.
  When you see a per-item limit, always ask what N of them costs.
- **A fix nothing can reach.** The glasses online gate was added as
  `if (hostLastSeen != null)` with two optional parameters, and every production
  caller omitted them; only the new unit test exercised it. **Check the call
  sites, not just the function** — a fix behind an optional argument is a fix
  only for whoever passes it.
- **A doc that undercounts.** CLAUDE.md said "four mirrors must agree" for
  `readyForReview`; there are five, and the fifth (`veiller/src/core/sessions.ts`,
  a fork rather than an import) was missed for exactly that reason. When a rule
  names its own copies, grep for a sixth before believing the list.
- **A test that asserts presence rather than meaning.** The Android backup-rules
  test checked that both prefs filenames appeared in the XML. Flipping `<exclude>`
  to `<include>` keeps both names present and INVERTS the rule — those two files
  become the only things backed up — and the suite stayed green through it.

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

- **An agent tunnel flap permanently kills an open chat's live stream.** Drop the
  `/agent/control` channel: the browser's `/live/<host>/<id>` socket closes and
  never reopens, the bubble freezes on the last text, and the poll fallback then
  requests `/api/agents/null/sessions/null/history` (404) because `close()` has
  already nulled `hostKey`/`sessionId`. Reconnecting the agent does not recover
  it; re-selecting the session does. Verified identical on `main` at 5c78834.
- **`preserveScrollOffset` in the glasses `App.onTurn` path has no test.**
  Deleting the call leaves all 455 vitest tests green while a scrolled-up view
  gets yanked down by a growing live turn. The behaviour is correct on both
  `main` and HEAD — it is the coverage that is missing.

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
