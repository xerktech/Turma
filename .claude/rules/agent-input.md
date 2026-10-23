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
  - **The beat only STAGES a resend** (`_stage_resend`); the input worker types it
    (`_deliver_staged_resends`), skipping one the session no longer holds on its outbox (delivered,
    or cleared by a clear-context restart) so a new conversation never gets the old one's text.
    Typing on the beat cost ~36s per message with a wedged tmux (rollup XERK-1701 #70.1).
  - **A waiting resend still expires at `PENDING_INPUT_TTL_SEC`**: a worker killed by a
    BaseException never types its batch. `_deliver_staged_resends` empties `resend_inflight`
    however its batch ends, and staging work revives a dead worker (`_revive_input_worker`).
  - The worker reads the pane epoch BEFORE the outbox check, and `restart` pops the outbox
    before it relaunches — so a resend either sees its message gone or stops at the relaunch.
  - Outbox is internal (not heartbeated), cleared on restart-clear-context; text typed directly into
    the raw ttyd terminal bypasses `send_input` and isn't covered.
  - Tests: `TestPendingScan`, `TestPollPendingInputs`, `TestSendInput`.
- **Via the paste BUFFER, never argv** (`_type_into_pane`, XERK-227): `send-keys` is a tmux command
  argument, refused past ~16 KiB. Control bytes are stripped, else one reads as a KEYSTROKE.
- **Chat-sized input is typed UNBRACKETED** (XERK-1718): Claude Code wraps bracketed (`-p`) input,
  and any one burst over ~800 chars, in `<pasted_content>` — the model then reads the operator's
  words as pasted DATA. So text ≤ `PASTE_SLICED_MAX_CHARS` with nothing in `_SLICE_UNSAFE_RE` goes
  in `PASTE_CHUNK_CHARS` slices with `-r` (LF = Ctrl+J = line break; tmux's default CR submits).
  - Do not slice past the cap or with astral/ZWJ/VS chars: typed dense emoji past ~10K chars never
    submit and arrive corrupted, and slicing costs ~2 tmux calls per slice on a worker (input,
    compaction resend, qwen peer). Those keep one bracketed paste; `chat.js` `stripFraming`
    hides the tags.
  - A typed TAB is autocomplete, so tabs go as 4 spaces. One writer per pane (`_PANE_TYPE_LOCKS`).
  - **A relaunch stops a message mid-typing** (`_PANE_EPOCHS`, rollup #70.1): `_launch_tmux`
    bumps the pane name's epoch under its write gate; every pane write (`_pane_write`) checks
    it, so a restart never gets the old conversation's Enter. The gate is held for ONE write,
    so a relaunch waits out at most one pane call. Epochs are pruned ONLY once the pane is gone
    for good (`_forget_pane` in `_kill_tmux`, see the comment) — never on a live pane.
    Tests: `TestPaneRelaunchStopsTyping`.
  - **Nothing is typed into a pane a dialog owns** (`_pane_blocking_dialog`): a typed digit picks
    an option and any Enter approves the highlighted one. Covers every caller (input, resend,
    notify fallback, qwen peer). `_submit_typed` also never presses into a dialog that came up
    while typing or after its Enter, and stops watching at once.
    Tests: `TestSubmitTypedDialogsAndBaselines`.
  - **Extreme pane sizes are read by POSITION, never by more wording** (XERK-2202, live frames
    in `TestExtremePaneSizes`): ≤19-cell panes match a stale-cell-tolerant "Esc to cancel"
    (`_narrow_hint_up`, capital `Esc` only — qwen's spinner and Claude's busy hint are
    lower-case); a cut Exit-plan dialog opens with an indented box rule under the ▔ edge; a
    qwen dialog ends in its "⠏ Waiting for user…" line; and an idle composer is its BOX
    (`_pane_boxed_composer_up`: two full-width column-0 rules, a prompt line, ≤3 footer lines).
    - Never match qwen's cut footer hint by text: an ellipsized dialog row then hid a live
      approval (XERK-2200). The box shape is what tells them apart.
    - An overlay whose footer is off-screen (Ctrl-R history search below ~120x40, a short
      /resume picker) is read by its area (`_pane_overlay_up`, XERK-2203): under a ▔ edge with
      no composer there, or under the last column-0 rule with an INDENTED `❯` cursor row or
      rounded search box, or with the history search's "Search" title as its first line (a
      no-match search at ≤8 rows draws nothing else).
      Tests: `TestOverlayWithItsFooterCut`.
    - qwen's Ctrl-R search draws `(r:)` as the first row of its composer box
      (`_qwen_history_search_up`, XERK-2215): Enter submits the best MATCH, so a typed "alp"
      re-sent an older prompt (verified on 0.22.3). Read by position, never anywhere on screen.
      While the box's column-0 row shows, it alone decides (`>` with an `@` popup below is NOT
      the search). Once a short pane's list scrolls it off, a bottom of only list rows (`▼`/
      `(k/N)` trailer allowed) counts: a popup over a draft is held then too, on purpose.
      Tests: `TestQwenHistorySearch`.
  - **The dialog check runs before EVERY write, not once per message** (`_slice_gate`): before
    each later slice, send-keys chunk and Enter, on tmux and Windows, whether or not draws are
    still awaited. QA: a dialog drawn mid-message got the rest, and a last slice "1" approved
    the tool 3/6. A stop returns `PANE_DIALOG` with nothing more typed (never a ^U either).
    Tests: `TestDialogMidMessage`.
  - **No slice after the first is short** (`_input_slices`: the last two share the remainder).
    A dialog ignores a multi-char slice but takes a lone digit; this closes the check-then-type
    window, and covers a pane whose composer can't be read. Never go back to a ragged tail.
  - **A message a dialog kept out is HELD, never dropped** (`_hold`, `_deliver_held`): input,
    notify fallback (its PR comment is already marked seen), compaction resend, qwen peer, and
    a trust modal a human must answer. The input worker retries every `INPUT_HOLD_RETRY_SEC`
    for `INPUT_HOLD_TTL_SEC`, then drops it with a log line.
    - A TTL drop also forgets the leftover record that held it (else it holds the NEXT message
      too) — that record object only (`h["leftover"]`), never a newer one stored since — and a
      dropped OPERATOR message logs `OPERATOR MESSAGE NOT DELIVERED`. The drop itself rides no
      agent→hub channel (spawnFailures is keyed to spawn cmdIds), but the HOLD is visible: the
      report's `paneDialog` makes the hub serve `needs-you:dialog` (XERK-2152,
      `turma-attention.md`), so every client says to open the terminal.
    - Accepted residual: after that drop, the composer may still hold our stale fragment plus
      the operator's text, and the NEXT message is typed into it and submitted glued to both.
    - One session's messages go in order: a later one queues behind a held one, and one
      waiting out its backoff blocks the rest (live rig: a due resend overtook it).
    - The worker sleeps to the earliest due time among each session's FIRST held message
      (`_held_wait`): a blocked later one's past due time spun it at 20 Hz.
    - A held entry stays on `input_held` until typed, so `_input_undelivered` (sleeper pause)
      sees it; it moves to `input_landed` in one locked step. `_resend_queued` sees held resends.
    - Pinned to the pane epoch it was typed against: a relaunch drops it (old conversation).
    - What a stopped message typed is RECORDED per pane (`_PANE_LEFTOVERS`, `_note_leftover`:
      the typed prefix, or "a paste" for the bracketed path). The next write into that pane
      clears it first (`_clear_leftover`), else the retry submits it twice, glued.
    - Only while the composer shows ONLY ours (`_leftover_view`: "head"/"piece"/"chip", at least
      `COMPOSER_MIN_SHOWN_CHARS` of it before the first press). Never "any piece of the message":
      that erased an operator's own draft "yes" (QA).
    - Ours WITH other text ("mixed"), an unreadable composer ("unknown"), or a clear past its
      bounds → `PANE_HOLD`: press nothing, type nothing, the message stays held (`_must_hold`)
      until the composer no longer shows ours (the operator submitted or cleared it; "gone"),
      which drops the record. Typing after a failed clear submitted the message twice (QA).
    - Keyed to the pane epoch; a relaunch, and `_kill_tmux` (`_forget_pane`), drop the record.
    - Residual: held state is in memory; an agent restart loses it.
    Tests: `TestHeldForDialog`.
  - **Clearing an unsent message CONVERGES on the composer read back** (`_clear_composer`):
    never a press count from the text. Measured on 2.1.300: Ctrl+U deletes to the start of the
    VISUAL row (a wrapped 400-char line at 120 cols lost ~65 chars a press; counting logical
    lines left 301 and the retry sent 3977 chars for 3201), joins a row to the one above at its
    start, clears a `[Pasted text #n ...]` chip in one press, and does nothing on an empty box.
    - Presses go ≤`CLEAR_KEYS_PER_WRITE` per write (a bigger burst drops presses; past ~800
      bytes it is a paste chip of literal ^U), re-reading after each, until none of ours is
      left. A dialog stops it at once.
    - Each batch is also ≤ rows drawn − 1: a press removes at most one row, so the top drawn
      row is never pressed until it is all there is. A composer taller than the pane draws only
      its last rows, ❯ on the first drawn, with no "more above" marker — text above ours scrolls
      in before any press can reach it, reads "mixed", and holds.
    - Bounds sized to the TYPED worst case (`CLEAR_MAX_PRESSES` = 2×`PASTE_SLICED_MAX_CHARS`+2;
      300 lines needed >400) and `CLEAR_DEADLINE_SEC`, both counted across retries on the
      leftover record (`budget`). A record written after a clear already ran (Windows'
      inline clear) carries that budget (`_note_leftover(budget=)`): a fresh one read a
      short remnant as maybe the operator's and typed the next message onto it (QA).
    - **One attempt presses for at most `CLEAR_ATTEMPT_SEC`, then the next retry resumes**: the
      ONE input worker delivers every session's messages, so a slow clear in one pane must not
      stall the rest. `CLEAR_ATTEMPT_SEC` (not the whole budget) is in `PANE_TYPE_LOCK_WAIT_SEC`.
    - **A batch that changes nothing (re-read once) = a DEAF composer** (tmux copy-mode: QA saw
      7830 presses in 90s, every retry): hold, and remember the view (`stuck`). A retry that
      reads the same view holds after that one read, until `CLEAR_STUCK_PROBE_SEC`, when one
      batch probes again (leaving copy-mode need not change the view).
    - Never a blind press: an unreadable composer holds.
    Tests: `TestClearComposer` (`_FakeComposer` models visual-row deletion and FAILS past
    `MAX_READS` — keep its harness plain functions: a recording mock grew to 14.5 GiB under a
    non-terminating mutant instead of failing).
  - **The cap is judged on the text AS TYPED** (tabs already 4 spaces), on tmux and Windows alike:
    judged before, 4000 tabs became 40 slices, each a pane call.
  - **A pane's lock entry lives only while a writer uses it** (`[lock, users]`): a writer counts
    itself in under the guard BEFORE waiting, the last out drops it. Never prune on kill/teardown
    instead — a waiting writer would hold the old lock while a newcomer got a fresh one.
  - **Each slice waits until the composer has DRAWN the text so far** (`_await_slice_drawn`,
    XERK-1842). A fixed gap is not enough under load: Claude Code isn't scheduled between slices,
    the pty buffers several, and one read past ~800 chars is a paste again — measured on 2.1.296,
    ~3.4K chars at ~30 load on 16 CPUs was tagged and reordered up to 7/8. Never revert to the bare
    gap. Bounded per MESSAGE (`PASTE_SLICE_DRAWN_DEADLINE_SEC`), not per slice, since this also
    runs on the beat; past it, or with no readable composer (None), the rest falls back to the gap.
    - **The pane lock outlasts a whole message** (`PANE_TYPE_LOCK_WAIT_SEC` = draw + submit
      deadlines + settles): a lock wait shorter than one writer's message lets the next writer type
      into its middle (QA spliced two messages that way). Keep the sum if you change either deadline.
    - **The comparison is NFC with format chars dropped** (`_composer_norm`): Claude Code draws
      e+U+0301 as U+00E9 and draws no ZWSP/soft hyphen/BOM/LRM, so a raw compare never matched.
    - A short pane shows only the composer's last lines (~55 chars at 40x12, under the 60-char
      tail), so a box that is itself the text's tail counts too (`_box_ends_with`, at least
      `COMPOSER_MIN_SHOWN_CHARS`); the "holds" read uses the same rule.
    Tests: the slice-wait cases in `TestSubmitTyped`.
  - **Typed text's Enter is settled and verified** (`_submit_typed`): an Enter close behind typed
    input is read as a LINE BREAK, leaving the message unsent in the composer with nothing to
    retry it. Measured on 2.1.296: a ~790-char two-slice message (the hub's PR-merged nudge)
    stuck 2/4 at a 10ms gap. So it waits `TYPED_SUBMIT_SETTLE_SEC`, Enters, then WATCHES the pane
    (`_composer_state`): "holds" (between the last two rules) → Enter again; "sent" or busy → done;
    neither → keep watching, to `TYPED_SUBMIT_DEADLINE_SEC`.
  - **"Sent" is the text's count ABOVE the box RISING past a pre-Enter baseline** (`_sent_count`),
    never "the text is above the box": an identical earlier message (a resend, a resumed session)
    or a short text inside a reply is already there, and QA stranded a message that way.
  - **A frame whose box still holds the text re-baselines that count**: any copy above it then
    is an earlier one drawn late (#72). And a FRAGMENT of the text left in the box is never
    "sent", whatever the count. Residual: a late copy and an undrawn box in ONE frame.
  - The box is between the LAST two rules: a reply can carry a rule of its own (#70.2).
  - **Never read one empty composer as "sent"** — a loaded TUI draws typed text seconds late, and
    stopping there left 7/12 stuck in QA. A FRESH session swallows its first Enter whatever the
    gap, so the re-press, not the settle, is the fix. Never Enter on a busy pane (it may be a
    dialog next). A message's cost is the draw deadline + the submit deadline (each can
    overshoot by one 5s capture), plus up to `PANE_TYPE_LOCK_WAIT_SEC` waiting out a writer —
    so nothing types on the beat. Tests: `TestSubmitTyped`.
  - **Except a composer that HELD the text before Enter and now shows none of it** (`held`,
    XERK-1853): that is a send. On a short pane (40x12) the turn wraps or scrolls off, so the
    count never rises and every send waited out the deadline holding the pane lock. A fragment of
    the text in the box is a redraw, not a send. Tests: `test_a_message_that_left_the_composer_*`.
  - Windows `_pty_inject` applies the same rule (XERK-1727, `windows-agent.md`). Tests:
    `TestSendInput`, the `_pty_inject` cases in `TestWindowsTerminalBackend`.
- **Nothing truncates silently**: the fallback CHUNKS its send-keys; the agent REFUSES past
  `INPUT_MAX_CHARS` (100k) and heartbeats it as `inputMaxChars`; the hub caps at the receiving
  host's figure (`inputCapFor`, **4k when unreported** — an agent predating paste clips the tail
  untold), 413ing with `limit`.
- **`send_input` is the OPERATOR's path** — what the manager itself composes goes to
  `notify_session` (below). This is what took the per-beat transcript read off every session a PR
  poller wrote to.
- **The `input` COMMAND is delivered OFF THE BEAT** (XERK-867), the dsh/qwen peer-worker pattern.
  `handle_commands` runs on the heartbeat loop, and delivery is a chain of ~5s-class pane RPCs — the
  Windows multi-line paste's settle+retry loop (`_pty_inject`) worst — whose cost ate most of the
  XERK-395 budget, with no per-cycle cap on how many `input`s a beat runs, so N queued inputs crossed
  `OFFLINE_AFTER_MS` and flapped a healthy host offline. So:
  - `handle_commands` only `_stage_input`s onto `input_queue` (bounded `INPUT_QUEUE_MAX`, drops OLDEST
    loudly — an operator message is precious, but an unbounded queue behind a wedged worker is worse)
    and ACKs — the command is off the hub's queue, delivered later (the accepted ack-vs-delivery gap).
  - `_input_worker_loop` (started once in `run_forever`, mirrors `_start_dsh_peer_worker`) drains via
    `_deliver_staged_inputs`, calling `send_input(..., defer_record=True)` per item — a per-item
    try/except so one wedged session can't starve the rest.
  - **`defer_record=True` does the delivery but stages the outbox RECORD onto `input_landed` for the
    BEAT** to apply (`_apply_landed_inputs` → `_record_delivered_input`: naming + `pendingInputs`
    append + `save()`). So the worker WRITES nothing to the registry and never `save()`s — the same
    "only the beat writes+saves the registry" line the PR-comment fetch/deliver split draws
    (`CLAUDE.md`). Its ONE in-memory registry touch is `_clear_trust_dialog` clearing
    `trustCheckUntil` (a benign key pop, never saved; `save()`'s C `json.dump` holds the GIL over the
    JSON-native records, so a concurrent pop cannot tear it) — do NOT grow the worker to write
    records or `save()`, and do NOT add a beat-side full-`sess`-dict iteration that a pop could race.
    Direct callers (tests) leave `defer_record` False and record inline. `notify_session`'s pane
    fallback STAGES onto this worker too: no message is typed on the beat.
  - **Off-beat pane typing is the established qwen-peer pattern** (`_type_into_pane` on
    `_qwen_peer_worker_loop`); all writers share the pane's `_PANE_TYPE_LOCKS` entry.
  - The compaction outbox (`pendingInputs`) still covers delivery — it is written a beat after the
    pane got the message, a tiny window narrower callers already tolerated.
  - The Windows `_pty_inject` retry loop is ALSO wall-clock bounded (`PTY_SUBMIT_DEADLINE_SEC`,
    `.claude/rules/windows-agent.md`), so one wedged paste can't tie up the worker either.
  - Tests: `TestOffBeatInputDelivery`, `TestPtyInjectDeadline`, and `TestHandleCommandsInputHistory`
    (the `input` command now STAGES, does not call `send_input` inline).
- **File attachments ride this command** (XERK-234): `send_input` fetches each hub-staged upload
  into `~/.turma/uploads/<sessionId>/` — **never a worktree**, where it would read as uncommitted
  work `prune`/`delete` key on — then prefixes the message with their PATHS. Name sanitized on BOTH
  sides (joined onto a path); a transfer failure is NAMED, never dropped. **`uploadMaxBytes` is the
  cap AND the capability flag**: an agent reporting none drops uploads untold, so the hub refuses and
  composers hide the 📎. Tests: `TestStoreUploads`, `TestSendInputUploads`, `UploadsTest`.

## Machine messages through the bridge mod (XERK-2135)

- A wake-up and the hub's `source: "nudge"` inputs go to the session's bridge mod
  (`$.prompt.submit`, idle-only) while it is live, and this pane path otherwise or as their
  fallback. Never an operator's message. Rules: `agent-bridge-mod.md`.

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
  registered pid — falls back to `send_input`, outbox and all, STAGED on the input worker
  (`_stage_input`): this runs on the beat. Tests: `TestNotifySession`'s fallback cases.
- **An inbox message is never put on the outbox** — it never becomes the user turn `_pending_scan`
  reaps on, so it would sit until a compaction re-typed it into the pane as a duplicate.
- **`INBOX_PREFIX` corrects attribution; it must not grant authority.** It holds quoted PR-comment
  bodies — third-party text — back to "review to weigh", never operator instruction.
- Tests: `TestSessionInbox`, `TestReadUntrustedJson`, `TestInboxOptedOut`, `TestPostToInbox`,
  `TestNotifySession`. The hostile-input cases are load-bearing — every guard above was added
  because a probe got past its absence.
