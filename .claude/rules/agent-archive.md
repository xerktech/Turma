---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Archive sync

- The agent **ships every INACTIVE session's transcript to the hub's durable archive** so history
  survives this host being wiped/offline. `_archive_manifest()` enumerates ended transcripts (every
  ledger slug's `*.jsonl`, minus any backing a running session); the hub replies with per-transcript
  byte cursors (`archiveHave`), and `_archive_deltas()` POSTs the missing append-only deltas
  (pre-parsed through `_entry_text`), bounded per chunk/beat.
- **Both passes run on a WORKER THREAD, never the beat** (XERK-395, same fix as `prune`): their
  combined worst case (`ARCHIVE_CHUNK_TIMEOUT_SEC` + `ARCHIVE_RAW_FAILURES_MAX` x
  `ARCHIVE_RAW_TIMEOUT_SEC`) exceeds the hub's offline threshold. `run_forever` only calls
  `queue_archive_sync`, which STAGES the reply's cursors; `_archive_sync_pass` pushes. Beat-loop
  budget contract: `CLAUDE.md`.
  - **Jobs COALESCE, never queue** — only the newest cursors are worth a pass.
  - One long-lived daemon worker, never joined on shutdown: archive is append-only against
    HUB-held cursors, so a cut-short pass is re-offered next beat.
  - `_archive_wake` clears BEFORE the job is taken, never after, or a job staged mid-pass is dropped.
  - `self._archive_pending` is beat-written/worker-read with no lock — safe only because the beat
    REBINDS rather than mutates it, and each pass snapshots once.
  - **`queue_archive_sync` may not raise** — it runs on the beat loop, the agent's MAIN PROCESS with
    no retry loop of its own; an exception there takes the whole host down. `Thread.start()` at
    `pids_limit` is the realistic one. **The same guard now wraps `_start_limits_probe`'s thread start
    and `_session_payload`'s registry-field reads** (XERK-402) — the two sibling beat-loop raise sites
    XERK-395's QA pass found; the general rule they share is in `.claude/rules/agent.md`.
  - A pass whose cursors predate the previous pass's stores re-offers one chunk per transcript; the
    hub rejects at `startOffset !== have` before storing anything and answers its real cursor.
    Wasted bytes, never a double-store. **A pass is bounded in BYTES, not time**
    (`ARCHIVE_MANIFEST_MAX` transcripts). **A remembered cursor is NOT the fix** — one held across a
    reset/evicted hub archive is ahead forever and that transcript never ships again.
  - **A wedged pass is otherwise SILENT** — `urlopen`'s timeout is per SOCKET OPERATION, so a hub
    trickling bytes never trips it. `_warn_if_archive_pass_stalled` measures the LAST COMPLETED
    PUSH, never the pass's age (a naive "pass age" version false-fired on a healthy host).
  - Its signal chain is fragile end to end (worker pass-stamp, push-completion stamps, pass-start
    seed, throttle sentinel, the beat's warn call) — pin it through a real wedged pass, never a
    hand-set stamp.
  - **Runs BEFORE the `archiveHave` gate** — a wedged pass is the WORKER's state, not the reply's;
    behind that gate a manifest that emptied mid-wedge was silent forever.
  - **A BLACKHOLED hub does NOT trip it, by design** — every push still returns at its own timeout
    and logs its own failure. Only a peer answering slowly enough to keep the socket alive evades it.
    Tests: `TestArchiveSyncWorker`, `TestBeatLoopBudget`.
- **The manifest window is a QUEUE, not a cliff** (XERK-424). `_archive_window` splits
  `ARCHIVE_MANIFEST_MAX` into the newest `ARCHIVE_MANIFEST_RECENT` (so an ending session archives
  promptly), then what the hub is KNOWN to be short of oldest-first, then a **rotation** over
  everything else. Newest-by-mtime alone starves what falls out of the window permanently. An
  already-complete transcript costs nothing to re-offer (`_archive_deltas` skips on `have >= size`),
  so rotation cost is cheap.
  - **`_archive_known` is what the hub SAID; absent ≠ zero.** A reply only carries cursors for what
    was OFFERED, so an id never yet in-window is missing, not zero — the rotation exists to reach
    those. A reported cursor REPLACES what we held, including downwards (a reset/evicted hub answers
    smaller); a high-water mark would strand that transcript forever.
    - **May not raise either** (same beat-is-main-process constraint). `int(float("inf"))` raises
      OverflowError, and a bare `1e400` is valid JSON reachable from anything hostile answering
      `TURMA_URL`. Keys are length-capped too — bounding entry COUNT bounds no bytes when a key may
      be a megabyte.
  - **Three ways this reverts to a cliff, each closed deliberately — they all look like tidying:**
    - **The rotation is keyed on the TRANSCRIPT, never a position in the candidate list**
      (`_archive_offered`, least-recently-offered first). An index cursor is index-safe but not
      starvation-safe: it forms a limit cycle whenever the candidate count oscillates periodically
      (e.g. a session going busy/idle on a cadence, since candidates exclude whole slugs).
      - **Bounded against the high-water TRANSCRIPT UNIVERSE** (`_trim_archive_offered`) — every
        eligible slug's `.jsonl` count, RUNNING slugs included. Every prior bound (a flat constant, a
        multiple of this beat's candidate count) was structurally too small because it tracked the
        oscillating subset instead of the universe that can ever be live; `_archive_manifest` also
        drops a running slug before listing its files, so candidate counts alone undercount. Costs
        one extra `os.listdir` per running slug (at most `MAX_SESSIONS`).
      - **The mark never decays** — a roomier map costs bytes, never correctness.
        `ARCHIVE_OFFERED_HARD_MAX` bounds it (32.5 MB RSS measured at 200k real UUID keys); past it
        the loss is logged once, not silent.
      - **Both paths that can GROW the map also trim** (the normal window and the under-cap
        passthrough, since the passthrough runs every beat below the cap and the hard cap must hold
        there too); the two early-return paths that trim nothing also never stamp.
      - **State is in MEMORY, so a restart LOOP starves the rotation** (XERK-430) — the durable
        "what the hub already has" lives on the hub, which XERK-431 proposes moving the choice to.
      - Sharing `ARCHIVE_KNOWN_MAX` with this map was also wrong — it coupled the off-switches.
      - **Ties break oldest-first** (closest to lost wins); a re-stamp POPS before re-inserting.
    - **The stamps are NEVER cleared**, including under the cap — a root slug's session count swings
      by hundreds as sessions go busy/idle, and clearing on each dip starves everything else.
    - **The known-short slice takes at most HALF the backlog slots** — given all of them it starves
      the rotation once enough transcripts are permanently known-short. Bites the RAW layer hardest:
      a session with missing sidecars but a complete transcript reads as known-complete, so only the
      rotation ever reaches it.
    - **`ARCHIVE_MANIFEST_RECENT` is clamped to three quarters of the window** — at `>= MAX` there is
      no backlog or rotation at all; both are env-settable.
  - **The backlog gets a reserved share of `ARCHIVE_RAW_MANIFEST_FILES_MAX`** — a FLOOR, not a
    ceiling on the recent slice, or the backlog's sidecars never ship however often offered
    (invisible to any coverage check, since those sessions' rows read back fine).
  - **`ARCHIVE_BEAT_BUDGET` deliberately has no such floor** — a slot is re-contended every beat
    where those bytes aren't spent (a transport failure, 5xx, `skip`, `full` all cost zero; the hub
    REFUSES at `ARCHIVE_TOTAL_MAX` rather than evicting, so a cursor cannot regress in a loop). Not
    because running sessions are fixed-size: `_running_slugs` is this agent's own registry only, and
    a real drive archived transcripts that grew throughout it.
  - Tests: the `test_window_*`, `test_known_map_*`, `test_rotation_*`, `test_backlog_*`,
    `test_recent_slice_*`, `test_a_complete_transcript_*` cases in `TestArchiveSync`.
- Rows are dated by `_last_activity_ts` — the last message's own transcript timestamp, **NOT the
  file mtime** (XERK-73, which a synced `~/.claude`/backup restore inflates to copy-time). Falls
  back to mtime only when no entry is timestamped. Tests: `TestArchiveSync`, `TestLastActivityTs`,
  `TestResumableReport`.
- **The archive is the ONE place a SendUserFile preview is shed** (`_shed_block_payloads`,
  XERK-267) — payloads are bounded per delivery but unbounded relative to the transcript (a
  screenshot-heavy session can archive orders of magnitude larger than it records). Past
  `ARCHIVE_PAYLOAD_MAX` the rest ships as name-only chips flagged `shed`. Live tail and `history`
  re-read previews from the transcript on demand, at no durable cost.
- **The hub owns the ceiling; this is only an early stop.** `archiveShed`/`archiveFull` on the
  heartbeat are the hub's verdict (`turma/archive.js`); the hub re-applies both itself since an old
  agent pushes regardless. Counting differs on purpose: the hub spends STORED bytes, the agent only
  sheddable PAYLOAD bytes (an ordinary long conversation's prose shouldn't degrade), and the agent's
  counter is per PASS (restarts each beat) — only the hub's verdict sticks across passes. Both read
  `ARCHIVE_TRANSCRIPT_MAX_BYTES`; `_byte_ceiling` must agree with `byteCeiling` that 0 disables and a
  non-numeric value is a typo to reject. Tests: `TestArchivePayloadBudget`.
- A refused delta comes back as **the hub's real cursor plus a flag, never an error status** — read
  as no forward progress and drop it, never re-send forever (XERK-255).
- **What is cut to the hub's ceiling is the delta's BODY, never the read window** (XERK-356).
  `ARCHIVE_CHUNK_BYTES` is only how far `_archive_deltas` reads ahead to find whole lines;
  `_archive_chunk_entries` cuts at a LINE BOUNDARY so the body stays under `_archive_body_max()`. A
  SendUserFile turn is a short transcript line rendering to a disk-read preview of megabytes, so
  sizing the window bounds nothing. A chunk's byte range must contain exactly the entries it
  carries: an entry that doesn't fit opens the NEXT delta.
  - **The number comes from the hub** (`archiveChunkMax`), like `bodyMax`. The pre-handshake default
    is deliberately under an OLD hub's 1 MiB route cap (an 8 MiB delta into a 1 MiB route left the
    durable archive empty for every real session before this). A 413 forgets the learned number
    rather than resending the same delta forever.
  - **A stated ceiling SMALLER than the default is obeyed**, floored only at `ARCHIVE_BODY_MIN` — not
    at the default, or the post-413 fallback lands on a number the hub still refuses forever.
  - **A failed push costs that TRANSCRIPT, not the pass.** A 4xx skips that chunk permanently;
    anything else (5xx, dead socket) also skips it but spends one of `ARCHIVE_FAILURES_MAX`, so a
    genuinely-down hub still ends the pass. Conflated, one unpushable transcript starved every other
    transcript on the host every beat. Same line the raw layer draws.
  - `TURMA_ARCHIVE_BODY_MAX` may only LOWER the default — past the hub's cap plus drain slack the
    socket is destroyed with no status, so neither the 413 fallback nor the skip can fire.
  - An entry too big for its own delta degrades before being dropped: file previews first, then rich
    `blocks[]` (flat `text` carries the same turn), only then omitted — with one log line per
    transcript per pass, since a silently-missing turn is worse than a known hole.
  - A LINE longer than the read window is found via `_archive_line_end`; past
    `ARCHIVE_LINE_SCAN_MAX` the scanned range archives with nothing rendered. Resuming mid-line is
    safe (the leading fragment fails to parse like any unparseable line) — refusing to move would
    park that transcript at that offset for good.
  - **`meta` rides EVERY delta, measured before any entry is fitted**, so `summary` is capped
    (`ARCHIVE_META_SUMMARY_MAX`) — the spawn route takes a 100 KB label, and uncapped it would eat a
    whole delta, dropping every entry as "not fitting".
- **Beside the rendered entries it ships the session's OWN FILES, byte for byte** (XERK-338):
  `_session_files()` enumerates `<id>.jsonl` plus everything under `<id>/` (`subagents/`,
  `workflows/`, `tool-results/`, whatever Claude Code adds next); `_archive_raw_deltas()` pushes each
  as gzipped, append-only ranges against a PER-FILE cursor (`archiveRawHave`).
  - **Deliberately not filtered to `*.jsonl`** — the point is that nobody has to predict what's worth
    keeping. `<slug>/memory/` is excluded (project-owned; one copy per conversation has no owner).
  - Only regular files, **never through a symlink** (same hardening as `_project_transcripts`) — a
    link at `PROJECTS_ROOT` would drag every transcript on the host into one session's archive.
  - A source file SHORTER than the hub's cursor means a rewrite happened underneath — log and leave
    alone. **Never truncate the archive to match.**
  - **A dsh session's native log rides this layer at `<tid>/dsh/`** (`DSH_STORE_DIRNAME`, XERK-469),
    placed under the project-slug dir (not the worktree, which the raw layer excludes on purpose —
    those bytes are what prune/delete key on) so the walk carries it with no special case. This
    supersedes the worktree location `docs/dsh-session-lifecycle.md` had proposed.
  - **A qwen session's native log rides this layer at `<tid>/qwen/`** (`QWEN_STORE_DIRNAME`,
    XERK-512) the same way, but MIRRORED there rather than written directly: qwen owns its native log
    under `~/.qwen/projects/`, which this walk doesn't reach, so the projection tail
    (`QwenProjectionTail`) copies it in, append-only, on its own cursor. Migration ([Qwen K]) does
    NOT carry this mirror — qwen resumes from its own native log, which the migration bundle carries
    separately under `.qwen-store/`; the target rebuilds the mirror from new events.
  - **Every RUNNING WORKTREE-BACKED session ships its RENDERED transcript while running**
    (`_running_slugs` subtracts `_live_worktree_slugs`, any runtime) so its chat scrollback
    materializes hub-side and `/history` serves it INSTANTLY from the archive instead of round-
    tripping to the agent (the delay that motivated this). Only a running ROOT session stays
    excluded — its shared slug holds every root session ever (XERK-6), so un-excluding it would sync
    them all under one slug; `_live_worktree_slugs` requires `worktreePath`, so root is never dragged
    in (a worktree slug backs exactly one session).
    - **The RENDERED layer un-exclusion is at the SLUG level** — the raw layer hangs off the rendered
      `sessions` row (`ingestRaw` skips any transcript with no `filePath`), so the rendered row must
      exist for any raw bytes to land.
    - **The RAW layer while running is DSH-ONLY** (`offer_raw` skips `defer_raw` =
      `_live_worktree_slugs − _live_dsh_slugs`). dsh's `<tid>/dsh/` log is its live Trajectory's ONLY
      feed (XERK-498, headless, no ttyd) and must ship every beat; every OTHER runtime (claude, qwen)
      ships RENDERED only while running and DEFERS its raw sidecars to session end — bounding the new
      continuous cost to prose deltas, not screenshots/subagent trees.
    - Accepted minor effect: a running session can appear in the archive browser/hub search while
      still running; cosmetic (Ended-sessions dedupes on running `transcriptId`, Restore refuses a
      running conversation). Tests: `test_manifest_keeps_a_running_worktree_session_rendered_only`,
      `test_manifest_excludes_a_running_ROOT_session`,
      `test_manifest_keeps_a_running_dsh_session_so_its_trajectory_populates`.
  - **Only APPEND-ONLY bytes belong under `<tid>/dsh/`** — the per-file cursor ships bytes past an
    offset, right for an event-sourced log, wrong for a page-mutating SQLite (an in-place rewrite
    would leave archived early bytes stale). dsh's SQLite is a derived index it rebuilds from the
    log, so it is never archived. Migration ([K]) does NOT carry this feed either — dsh resumes from
    its own store under `DSH_SESSIONS_ROOT` (a separate file the bundle carries instead); the target
    rebuilds the feed from new events. Tests: `TestDshArchiveSync`.
  - The raw pass runs in its **own try/except** off the same reply — a raw failure must never cost
    the rendered transcript. Its read window stays at or under the hub's `ARCHIVE_RAW_CHUNK_MAX`
    (bounds its gunzip); a larger window is refused on every push, never truncated. Tests: the raw
    cases in `TestArchiveSync`.
