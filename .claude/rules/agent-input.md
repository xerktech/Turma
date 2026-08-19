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
- **Every post names the session id it is for** and Claude Code drops a mismatch — that is what
  makes connecting to a socket named after a RECYCLED pid safe.
- **Delivery is what XERK-339's `crossSessionInbound: accept` buys.** The inbox acknowledges
  nothing, so a repo whose own settings override that to `refuse` drops these messages silently:
  the one failure this path cannot see. Anything else — no inbox bound, an older claude, a dead
  socket — falls back to `send_input`, outbox and all.
- **An inbox message is never put on the outbox.** It never becomes the user turn `_pending_scan`
  reaps on, so it would sit there until a compaction re-typed it into the pane as a duplicate.
- Tests: `TestSessionInbox`, `TestPostToInbox`, `TestNotifySession`.
