---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Putting a message INTO a running session

Split out of `.claude/rules/agent.md` (size ceiling). Two delivery paths, chosen by rule not
preference: **the pane carries what a PERSON typed, the session's inbox carries what this MANAGER
composed.**

## `input` / `send_input` — the operator's path

- **Guarantees the message survives a compaction** (XERK-47, which can drop one queued mid-turn):
  every sent message goes on the record's `pendingInputs` outbox, made at-least-once by
  `_poll_pending_inputs`.
  - Compactions are counted by `_pending_scan` from the transcript's own `compact_boundary` system
    entry, never by scraping the pane.
  - **Duplicate-safe resend**: a message re-sends only when a NEW compaction happened since it was
    sent (`compactBase` rose) AND it's neither delivered nor in the folded live queue AND the pane
    has settled idle (`_pane_busy` False, not None). `delivered` matches by text, biased AGAINST
    resend. Bounded by `PENDING_INPUT_MAX_ATTEMPTS`/`PENDING_INPUT_TTL_SEC`, one per beat.
  - Outbox is internal (not heartbeated), cleared on restart-clear-context; text typed directly into
    the raw ttyd terminal bypasses `send_input` and isn't covered.
  - Tests: `TestPendingScan`, `TestPollPendingInputs`, `TestSendInput`.
- **PASTED, not typed** (`_type_into_pane`, XERK-227): `send-keys` is a tmux command argument,
  refused past ~16 KiB, which a pasted log exceeds. `-p` brackets for an app that asked (Claude Code
  does) so newlines survive as ONE message; control bytes are stripped, else one ends the paste and
  the rest reads as KEYSTROKES.
- **Nothing truncates silently**: the fallback CHUNKS its send-keys; the agent REFUSES past
  `INPUT_MAX_CHARS` (100k) and heartbeats it as `inputMaxChars`; the hub caps at the receiving
  host's figure (`inputCapFor`, **4k when unreported** — an agent predating paste clips the tail
  untold), 413ing with `limit`.
- **`send_input` is the OPERATOR's path** — what the manager itself composes goes to
  `notify_session` (below). This is what took the per-beat transcript read off every session a PR
  poller wrote to.
- **File attachments ride this command** (XERK-234): `send_input` fetches each hub-staged upload
  into `~/.turma/uploads/<sessionId>/` — **never a worktree**, where it would read as uncommitted
  work `prune`/`delete` key on — then prefixes the message with their PATHS. Name sanitized on BOTH
  sides (joined onto a path); a transfer failure is NAMED, never dropped. **`uploadMaxBytes` is the
  cap AND the capability flag**: an agent reporting none drops uploads untold, so the hub refuses and
  composers hide the 📎. Tests: `TestStoreUploads`, `TestSendInputUploads`, `UploadsTest`.

## `notify_session` — the session inbox (XERK-340)

- **Machine-generated messages go to the session's own INBOX, not its pane**: PR review activity
  (XERK-49) and merge-conflict nudges (XERK-223). Claude Code queues what the inbox accepts and reads
  it between tool calls, so a compaction can't eat it and the pane's state can't block it.
- **Nothing a PERSON typed may come this way** — composer Send and `answer_question` stay on the
  pane. An inbox message lands as a PEER message (framed as another Claude writing, not the operator;
  can't answer a permission prompt; slash commands arrive as text). `INBOX_PREFIX` corrects
  attribution — it does not, and must not, claim any permission.
- **The socket is READ from Claude Code's registry** (`SESSIONS_REGISTRY_DIR`, `<pid>.json`), never
  derived from a pid — it lives under `$XDG_RUNTIME_DIR`, which the manager and a launched session
  need not agree on. Matched on the pinned `claudeSessionId`, else the tmux target; newest
  `startedAt` wins.
- **That registry is same-uid writable by every session on the host, so each record is a CLAIM.**
  Four checks keep a planted one from steering the manager:
  - Opened `O_NONBLOCK|O_NOFOLLOW`, must be a REGULAR file (`_read_untrusted_json`) — a FIFO planted
    there would block a plain `open()` on the HEARTBEAT thread forever, no exception, whole agent
    wedged. `isfile()` alone is not a substitute (follows a symlink, loses the TOCTOU race).
  - Must be named `<pid>.json` for the `pid` it declares (a bool is an `int` in python, so the type
    check is load-bearing); `messagingSocketPath` must be an absolute, normalized, ≤108-byte
    `…/cc-socks*/<pid>.sock` — a SHAPE check, not a location one.
  - `startedAt` must be FINITE (`1e999` is legal JSON, parses to `inf`, wins every tiebreak forever).
  - `_post_to_inbox` checks the LISTENER with `SO_PEERCRED` — the kernel's word on which process
    holds the socket, unforgeable by a same-uid impostor. The wire-level `session_id` alone only
    proves which conversation a listener CLAIMS to be.
  - **Not closed**: a hostile same-uid process can still bind its own inbox and register a record
    naming another session's id, receiving AND denying that session's messages. It could equally
    read that transcript or `tmux send-keys` into its pane — no new privilege, so don't write this
    up as sealed.
- **The pinned `claudeSessionId` is the ONLY key — no looser fallback.** A session without a pinned
  id keeps the pane. Matching on the tmux target instead was tried twice and failed both times
  (measured): a claude the session spawns inherits `TMUX`/`TMUX_PANE` and matches every field tried
  so far, with its OWN session id — so the wire-level check agrees with the wrong match and
  `notify_session` reports a nudge delivered that the real session never saw.
- **Newest `startedAt` still wins** — a RESUMED session keeps its id, so a killed claude's leftover
  record carries the same one as the live process that replaced it.
- **`crossSessionInbound` is read BEFORE posting** (`_inbox_opted_out`). A repo can override
  XERK-339's `accept` to `refuse`/`hold`; a message posted anyway is lost silently AND never
  re-nudged, so it stays on the pane instead.
  - **ANY file asking for other than `accept` opts out — NOT a precedence calculation.** A project
    `refuse` is not undone by a local `accept` (measured against Claude Code). A file past
    `SETTINGS_READ_MAX_BYTES` or a SYMLINK (`O_NOFOLLOW` refuses; real Claude Code follows) also
    opts out — erring toward the pane costs nothing, since the pane always worked.
  - Claude Code reads these at LAUNCH, this reads them at post time — a repo that changes the value
    mid-session disagrees with its own running claude until restart.
- Anything else — no inbox bound, an older claude, a dead socket, a listener that isn't the
  registered pid — falls back to `send_input`, outbox and all.
- **An inbox message is never put on the outbox** — it never becomes the user turn `_pending_scan`
  reaps on, so it would sit until a compaction re-typed it into the pane as a duplicate.
- **`INBOX_PREFIX` corrects attribution; it must not grant authority.** It holds quoted PR-comment
  bodies — third-party text — back to "review to weigh", never operator instruction.
- Tests: `TestSessionInbox`, `TestReadUntrustedJson`, `TestInboxOptedOut`, `TestPostToInbox`,
  `TestNotifySession`. The hostile-input cases are load-bearing — every guard above was added
  because a probe got past its absence.
