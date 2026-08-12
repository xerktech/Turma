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
