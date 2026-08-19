---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Putting a message INTO a running session

Split out of `.claude/rules/agent.md`, which is at its size ceiling. Two delivery paths, and which
one a message takes is a rule rather than a preference: **the pane carries what a PERSON typed, the
session's inbox carries what this MANAGER composed.**

## `input` / `send_input` — the operator's path

- **Guarantees the message survives a compaction** (XERK-47), which can drop one queued mid-turn:
  every sent message goes on the record's `pendingInputs` outbox, made at-least-once by
  `_poll_pending_inputs`.
  - Compactions are counted by `_pending_scan` from the transcript's own `compact_boundary` **system
    entry**, never by scraping the pane.
  - A message is **re-sent** only when a NEW compaction happened since it was sent (`compactBase`
    rose) AND it is neither delivered nor still in the folded live queue AND the pane has settled to
    idle (`_pane_busy` False, not None). That three-way gate is what makes the resend
    **duplicate-safe**; `delivered` matches by text alone, biased AGAINST a resend. Bounded by
    `PENDING_INPUT_MAX_ATTEMPTS`/`PENDING_INPUT_TTL_SEC`, one per beat.
  - The outbox is internal (not heartbeated), cleared on restart-clear-context; text typed into the
    raw ttyd terminal bypasses `send_input` and isn't covered.
  - Tests: `TestPendingScan`, `TestPollPendingInputs`, `TestSendInput`.
- **PASTED, not typed** (`_type_into_pane`, XERK-227): `send-keys` is a tmux command argument,
  refused past ~16 KiB, which a pasted log exceeds. `-p` brackets only for an app that asked (Claude
  Code does) so **newlines survive as ONE message**; control bytes are stripped, else one ends the
  paste and the rest reads as KEYSTROKES.
- **Nothing truncates silently**: the fallback CHUNKS its send-keys; the agent REFUSES past
  `INPUT_MAX_CHARS` (100k) and heartbeats it as **`inputMaxChars`**; the hub caps at the receiving
  host's figure (`inputCapFor`, **4k when unreported** — that agent predates the paste and clips the
  tail untold), 413ing with `limit`.
- **`send_input` is the OPERATOR's path.** What the manager itself composes goes to
  `notify_session` (below); the outbox above therefore covers operator traffic plus the inbox-less
  fallback, which is what took the per-beat transcript read off every session a PR poller wrote to.
- **File attachments ride this command** (XERK-234): `send_input` fetches each hub-staged upload
  into `~/.turma/uploads/<sessionId>/` — **never a worktree**, where it would read as the
  uncommitted work `prune`/`delete` key on (`build_guard_settings` pre-approves `Read` there) — then
  prefixes the message with their PATHS, so the COMPOSED text is what lands on the outbox. The name
  is sanitized on BOTH sides (it is joined onto a path); one that fails to transfer is NAMED, never
  dropped. **`uploadMaxBytes` is the cap AND the capability flag** (like `inputMaxChars`): an agent
  reporting none drops uploads untold, so the hub refuses and the composers hide the 📎. Tests:
  `TestStoreUploads`, `TestSendInputUploads`, `UploadsTest`.

## `notify_session` — the session inbox (XERK-340)

- **Machine-generated messages go to the session's own INBOX, not its pane**: PR review activity
  (XERK-49) and merge-conflict nudges (XERK-223). Claude Code queues what the inbox accepts and
  reads it between tool calls, so a compaction cannot eat it, the pane's state cannot block it, and
  it needs neither the XERK-47 outbox nor the read that confirms one.
- **Nothing a PERSON typed may come this way** — the composer's Send and `answer_question` stay on
  the pane. An inbox message lands as a PEER message: framed to the receiver as another Claude
  writing rather than their operator, unable to answer a permission prompt, with slash commands
  arriving as text (`skipSlashCommands`). Operator input needs all three the other way round.
  `INBOX_PREFIX` corrects the attribution — it does not, and must not, claim any permission.
- **The socket is READ from Claude Code's registry** (`SESSIONS_REGISTRY_DIR`, `<pid>.json`), never
  derived from a pid: it lives under `$XDG_RUNTIME_DIR`, which the manager and a session it
  launched need not agree on, and a late bind is only recorded there. Matched on the pinned
  `claudeSessionId`, else the tmux target; newest `startedAt` wins.
- **That registry is same-uid writable by every session on the host, so each record is a CLAIM.**
  Four checks keep a planted one from steering the manager, and each has a test:
  - the file is opened `O_NONBLOCK|O_NOFOLLOW` and must be a REGULAR file (`_read_untrusted_json`,
    which the settings read above shares). A plain `open()` of a FIFO planted there blocks until
    someone writes, on the HEARTBEAT thread — no exception, no exit, the whole agent wedged. **An
    `isfile()` pre-check is not a substitute**: it follows a symlink and loses the race against a
    file being swapped for a FIFO between the check and the open. The size cap bounds the read,
    never the open.
  - the record must be named `<pid>.json` for the `pid` it declares, and `messagingSocketPath` must
    be an absolute, already-normalized, ≤108-byte `…/cc-socks*/<pid>.sock`. That is a SHAPE check,
    not a location one — `cc-socks*` matches a directory the sender owns, so it bounds what gets
    connected to rather than proving whose it is.
  - `startedAt` must be FINITE. `1e999` is legal JSON, parses to `inf`, and would win every
    tiebreak forever.
  - `_post_to_inbox` then checks the LISTENER with `SO_PEERCRED`: the kernel's word on which
    process holds that socket, which a same-uid impostor cannot forge. The registry cannot give us
    this, which is why the wire-level `session_id` check is not the whole story — it proves which
    conversation a listener claims to be, never that it is the right listener.
  - **Not closed**: a hostile same-uid process can still bind its OWN inbox at a `cc-socks*` path
    it owns and register a record naming another session's id — it then both receives that
    session's messages AND denies them (the post succeeds, so there is no pane fallback). It could
    equally read that session's transcript or `tmux send-keys` into its pane, so this adds no
    privilege — don't write it up as sealed, and don't describe it as interception alone.
- **The tmux fallback additionally requires `entrypoint: cli`**, plus `kind: interactive`, the
  session's own cwd, and the tmux target. A claude a session SPAWNS inherits `TMUX`/`TMUX_PANE` and
  — measured, not assumed — matches on target, cwd, `kind` AND a newer `startedAt`; `entrypoint` is
  the only field that differs (`sdk-cli` for `claude -p`). Its own session id makes the wire check
  agree, so this branch is the only thing that can catch it, and dropping the entrypoint check
  hands a session's PR nudge to a subagent's claude and reports it delivered.
- **`crossSessionInbound` is read BEFORE posting** (`_inbox_opted_out`). A repo can override
  XERK-339's `accept` to `refuse`/`hold`; the inbox acknowledges nothing and the PR pollers burn a
  retry either way, so a message posted into such a session is lost in silence AND never nudged
  again. It stays on the pane instead, which is what that repo wants: no PEER messages, not the
  loss of its own PR nudges.
  - **ANY of the files asking for something other than `accept` opts out — this is NOT a precedence
    calculation.** Measured against Claude Code, a project `refuse` is *not* undone by a local
    `accept`, so "highest-precedence definition wins" posts into a session that drops the message.
    A file that exists but will not parse (or is past `SETTINGS_READ_MAX_BYTES`) opts out too.
    Erring this way costs only the pane, which has always worked.
  - Claude Code reads these at LAUNCH and this reads them at post time, so a repo that changes the
    value mid-session disagrees with its own running claude until it restarts.
- Anything else — no inbox bound, an older claude, a dead socket, a listener that isn't the
  registered pid — falls back to `send_input`, outbox and all.
- **An inbox message is never put on the outbox.** It never becomes the user turn `_pending_scan`
  reaps on, so it would sit there until a compaction re-typed it into the pane as a duplicate.
- **`INBOX_PREFIX` corrects attribution; it must not grant authority.** It says Turma is speaking
  and that the message is about the session's OWN work (without which the peer framing makes a
  conflict nudge read as advisory), and it explicitly holds quoted PR-comment bodies — third-party
  text — back to "review to weigh", never operator instruction.
- Tests: `TestSessionInbox`, `TestInboxOptedOut`, `TestPostToInbox`, `TestNotifySession`. The
  hostile-input cases are load-bearing: every guard above was added because a probe got past its
  absence, and three of them because the first attempt at the guard did not work.
