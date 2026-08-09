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
- `docker` works and can pull from ghcr.

---

## 1. Rules of engagement on this host — read before you run anything

**A real Turma agent is running here right now, under systemd, serving the
operator's live sessions.** It is not a test fixture. Breaking it is worse than
any bug you might find.

Hard rules:

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

Baselines below are from `main` at v0.6 (commit c8347a9), so a deviation is
either your environment or a regression — find out which before filing.

### 2.1 Hub (`turma/`) — node, no build step

```bash
export PATH=/root/.local/node/bin:$PATH
cd turma && node --test tests/*.test.js        # baseline: 808 pass, ~5s
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
python3 -m unittest tests.test_hub_agent                       # 986 pass, ~9s
python3 -m unittest tests.test_guard tests.test_guard_settings tests.test_ask   # 48 pass
node --test tests/tunnel-agent.test.js                         # 80 pass
for t in tests/test_*.sh; do bash "$t"; done                   # native/entrypoint suites
```

**There is no pytest.** `python3 -m unittest` is the only runner.

### 2.3 Glasses (`glasses/`) — npm + vite + vitest

```bash
export PATH=/root/.local/node/bin:$PATH
cd glasses
npm ci --cache /tmp/claude-0/npm-cache
npm run typecheck && npx vitest run                            # baseline: 463 tests
```

### 2.4 Veiller (`veiller/`) — bun

```bash
cd veiller && bun install && bun test                          # baseline: 357 pass
bun run typecheck                                              # needs devDeps installed first
```

`bun run typecheck` calls bare `tsc`, so it fails with `command not found`
until `bun install` has run.

### 2.5 Android (`android/`) — only inside the agent image

There is no JDK on this host. Build in the container, which bundles JDK 17 +
Gradle + the Android SDK:

```bash
docker pull ghcr.io/xerktech/turma-agent:latest
```

Two traps, both from the verify skill and both still true:

- `assembleDebug` needs `ANDROID_USER_HOME` somewhere writable, or
  `validateSigningDebug` fails trying to create a debug keystore in
  `/root/.android`.
- The SDK in the image ships **build-tools 35.0.0 only**, and
  `app/build.gradle.kts` pins it.

`:latest` is the `android-build` tier — **no emulator, no system image**. An
install-and-drive-the-app run needs the separate `:emulator` tag (6.4 GB, built
on demand) or a real device over `adb connect`. If you cannot reach one, the
honest verdict is PARTIAL; say so rather than claiming you drove the UI.

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

---

## 7. Reporting

A finding needs: severity, `file:line`, one sentence on the defect, and a
reproduction someone else can run. Mark **CONFIRMED** (you reproduced it) apart
from **SUSPECTED** (you reasoned it). A suite passing is the floor, never the
verification — if you did not build and drive the thing, say so, and the verdict
is PARTIAL.

Two habits that paid off in XERK-235 and cost almost nothing:

- **Mutation-test your own verification.** Break three behaviors the suite
  claims to protect and confirm it notices. Every agent that did this found at
  least one thing the suite did not actually cover. Revert every mutation and
  confirm `git status` is clean — see §4 on why this matters with others in the
  tree.
- **Report what you could not exercise, by name.** The most useful lines in
  those reports were the "not verified" lists, because they are what the next
  pass starts from.
