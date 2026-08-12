# qa-findings.md — the defects a QA pass actually found

The case-study half of `qa.md` §5, split out to keep that file readable.
Neither file is auto-loaded into a session, so the 40,000-character ceiling that
governs `CLAUDE.md` and `.claude/rules/**` does not apply to them and CI does not
gate them — `qa.md` has since grown past it, and that is a readability question
rather than a context-budget one. `qa.md` is the method; this is the evidence. Ranked by what each would have
cost in the field, and every one was found by RUNNING the thing, not reading
it. Use them as a hunting guide, not a checklist — the shapes repeat.

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
- **A page-global "last known" flag whose edge handler fires against a different
  subject.** `sessions.html` remembers one `stageTunnelOnline` for whatever the
  stage shows, and acts on the false→true edge. Selecting a session on ANOTHER
  host while the flag is false makes that edge land on the session just opened.
  When you see a module-level flag paired with an edge test, ask what resets it
  when the thing it describes is REPLACED rather than changed.
- **A guard written against an object that is null for the whole window that
  matters.** `chat.js`'s `reconnectNow` skips work when `ws` is OPEN or
  CONNECTING — but `startWs` awaits a `/api/ws-token` fetch before it assigns
  `ws`, so through that await `ws` is null and the guard waves a second
  connection through. Unit tests that hand the guard a socket object never see
  it. Count the sockets (§3, `page.on("websocket")`), don't read the guard.

### 5.8 Shapes that only appear when you RUN it (XERK-254, thirteen rounds)

Every one of these passed review, shellcheck and a green suite. Attack these before anything else
in shell that runs at boot.

- **A `/bin/sh` function is not a subshell and has no `local`.** An `export` inside one escapes into
  everything the script starts afterwards. A scratch `HOME` set that way, then `rm -rf`'d, gave the
  container's manager, tunnel and every session a `$HOME` that did not exist — `~/.turma` (the
  session registry) and `~/.claude` (the login) both silently missed. Use `f() ( ... )` when the
  body changes the environment.
- **A blocking open at PID 1 is unrecoverable.** The container stays `running`, PID 1 is alive and
  healthy-looking, so no restart policy ever fires — worse than a crash loop, which at least
  retries. Signature: no manager line in the log, `docker inspect` says running; confirm with
  `/proc/1` and the child chain (there is no `ps` in the image).
- **`kill` on a shell does not reach its grandchildren.** A watchdog that kills a check leaves that
  check's `npm install` running — which then replaces `claude` while the manager relaunches
  sessions into it. Either signal the process group, or keep the outer deadline clear of the inner
  ones by construction.
- **`timeout` without `-k` does not bound anything a child can ignore.** It signals at the deadline
  and then WAITS: measured 30s for a `trap "" TERM; sleep` child given `timeout 2`. And
  `timeout ... 0 ...` DISABLES the bound — `0` is the value an operator reaches for when they mean
  "no limit". Sanitise timeout knobs where they are USED, not only where arithmetic reads them: a
  malformed one makes `timeout` exit 125 without running the command, which reads as "the tool is
  broken" rather than "the config is wrong".
- **SIGKILL and SIGTERM leave different wreckage.** A SIGTERM'd `npm install -g` rolls back (5/5
  kill points left the old version working); a SIGKILL'd one leaves NO `claude` at all (4/5). Any
  `-k` grace is what buys the rollback.
- **Arithmetic derived from a call graph rots.** A deadline computed from per-call timeouts has to
  be re-derived whenever the call graph changes, and each miscount was a defect (wrong multipliers,
  an overflowing floor, a count taken as the wrong uid, a clock-skewed budget). A fixed generous
  number with one explicit coupling retired the whole class. Prefer that shape.

### 5.9 Techniques that found what reading the source did not (XERK-254)

For `agent/native/` and `agent/entrypoint.sh`; each of these surfaced a defect that
review, shellcheck and a green suite had all passed.

- **Measure as the identity the code runs as.** `[ "$(id -u)" = 0 ]` guards a whole branch of the
  updater (the EACCES retry into `~/.local`), so a root-only fixture set cannot see it and every
  count taken with one is wrong. Drive it with
  `setpriv --reuid 1000 --regid 1000 --clear-groups env HOME=... PATH=... <script>` after
  `chown -R 1000:1000` on the staged prefix. The shell suites pass under uid 1000 too — run them
  both ways.
- **Count bounded calls by shimming `timeout` on PATH**, never by reading them off the source:
  ```sh
  printf '#!/bin/sh\n{ printf "%s " "$@"; echo; } >> LOG\nexec /usr/bin/timeout "$@"\n' > $bin/timeout
  ```
  This is how a memo that never memoised (`$(...)` is a subshell, so the global never propagates)
  and a deadline derived from the wrong call count both showed up.
- **`mkfifo` in `~/.turma` is the cheapest wedge test.** That dir is writable by the identity the
  SESSIONS run as, so a session can replace any state file there with a FIFO — and opening one
  blocks forever, with no error for `|| true` to catch. Plant one at every path the start-time
  check opens and assert the agent still boots.
- **Stub `date +%s`** to test elapsed-time arithmetic. Clocks step BACKWARDS at boot (chrony /
  timesyncd on a host with no battery-backed RTC), which is exactly when this code runs, and
  `$(( now - started ))` is then negative.
- **Time the recovery, don't just assert it happened.** "Never blocked" and "rescued by a watchdog
  after N seconds" both end with a booted container; only the elapsed time tells them apart.
- **Sample fast when measuring a swap window.** `npm install -g` unlinks the bin before extracting,
  so `claude` is absent from PATH for ~1.5-2s; a single probe misses it, a 50ms loop doesn't.

Staging and driving them, which every case above needed:

- Stage a fake prefix the way `agent/tests/test_turma_agent_update.sh` does:
  `$PREFIX/{VERSION,hub-agent.py,tunnel-agent.js,hooks/}` + `$PREFIX/bin/` with the script under
  test, a fake `gh` serving canned releases from `$FAKE_GH_DIR`, and stub
  `systemctl`/`turma-agentctl`.
- Real systemd behaviour (`Restart=always`, `KillMode=process`, a detached child surviving a unit
  restart) without touching /etc:
  ```bash
  systemd-run --unit=qa-$$ --collect --property=Restart=always \
    --property=RestartSec=1 --property=KillMode=process --property=Type=exec \
    --setenv=HOME=$SCRATCH --setenv=PATH=$BIN:/usr/bin:/bin $BIN/turma-agent
  ```
  Stop with `systemctl stop qa-$$`, then `rm /run/systemd/transient/qa-$$.service` and
  `systemctl daemon-reload` — a stopped transient unit lingers as `loaded` otherwise.
- The **real** npm registry is cheap and safe if you sandbox it: `export
  npm_config_prefix=$SCRATCH/pfx npm_config_cache=$SCRATCH/cache`. The install is ~250 MB and ~3s;
  `npm view @anthropic-ai/claude-code version` answers in <0.5s.
- The container half is drivable end to end with a REAL claude: `node:24-bookworm-slim` + `npm i -g
  @anthropic-ai/claude-code@<older>` + the real `entrypoint.sh` + stub
  `python3`/`hub-agent.py`/`tunnel-agent.js`. Keep the stub manager alive (`sleep`) or the container
  exits first. `test_entrypoint.sh` stubs claude+npm, so it observes the DECISION only — never file
  ownership, writes under `/root`, or timing.
- A **running** claude survives the package swap (one static ELF, the kernel keeps the inode); only
  a new exec in the window fails.

### 5.10 What the ELEVENTH round found — again in the previous round's own fix

- **`typeof [] === "object"`, in a validator whose whole job is "is this an
  object".** `normalizeSessions` dropped a `null` and a bare string from
  `sessions` and served a nested ARRAY element raw, because its predicate was
  `!s || typeof s !== "object"`. The comment above it named the two cases the
  fixture used, and the fixture used the two cases the comment named — so the
  third non-object shape existed in neither, and the fix read as complete from
  every angle except running it. Measured as the phone unable to SIGN IN, since
  the login probe decodes `/api/agents` and reads the throw as "Could not reach
  the hub". **When you write an is-an-object test in JS, write `Array.isArray`
  in the same breath, and put every non-object shape in the fixture — `null`,
  a string, a number, `[]`, and a non-empty array — not a representative one.**
  This is §5.3 again, one round later, in the code that fixed §5.3.
- **A TTL read from a Composable body is a timer that never fires.** The
  model-switch memo aged out inside `canSwitchModelSource()`, evaluated at
  composition time from `System.currentTimeMillis()`. Compose skips
  recomposition while the state compares equal, so on a quiet fleet nothing
  re-read the clock: the control vanished on an unconfirmed switch and was still
  gone at t+120s, with the bar naming a model the session was not running.
  **Expiry has to change STATE, not merely change what a read would return** —
  retire the value from the store on a bounded alarm. The web had no such bug
  because its poll recomputes the same predicate unconditionally every beat;
  when porting a per-beat web computation to Compose, ask what re-runs it.
- **A discarded `Result` turns every refusal into a success.** `setModel` and
  `setMode` ran `runCatching { … }` and then emitted "✓ queued" unconditionally.
  Harmless while those routes only failed on the network — and then a sibling
  commit gave the hub a first-class 409 for them, which the bar reported as a
  success. **Grep for `runCatching` whose result is not bound**; each one is a
  silent success waiting for someone to add a refusal to that route.
