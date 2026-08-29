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
- **Both passes run on a WORKER THREAD, never the beat** (XERK-395), the same fix `prune` got:
  their combined worst case is larger than the hub's offline threshold, so inline a lossy link made
  a healthy host read as dead. `run_forever` only calls `queue_archive_sync`, which STAGES the
  reply's cursors; `_archive_sync_pass` pushes. See the beat-loop budget contract in `CLAUDE.md`.
  - **Jobs COALESCE, they do not queue.** A pass is only worth running against the NEWEST cursors,
    so a job staged behind a slow pass replaces the one waiting — queuing them would grow an
    unbounded backlog on any host pushing slower than `INTERVAL`, all of it aimed at cursors the hub
    has already moved past.
  - One long-lived daemon worker (prune's exits when drained; a job here arrives every beat), never
    joined on shutdown: the archive is append-only against HUB-held cursors, so a pass cut short is
    re-offered on the next beat.
  - `_archive_wake` is cleared BEFORE the job is taken, never after — the beat stores the job and
    only then sets it, so clearing afterwards drops a job staged mid-pass.
  - `self._archive_pending` is beat-written and worker-read with no lock, which is safe ONLY because
    the beat REBINDS it and never mutates it in place; each pass snapshots it once.
  - **`queue_archive_sync` may not raise.** The beat loop is the agent's MAIN PROCESS
    (the native launcher runs it, with no retry loop of its own), so an exception on it is not a
    skipped cycle — it is the host and every session on it going down, and this is called outside
    any try. Work moved OFF the beat must not leave a raise where the try/except it replaced stood:
    `Thread.start()` at the `pids_limit` is the realistic one. `_start_limits_probe` still has that
    shape (XERK-402).
  - A pass whose cursors predate the previous pass's stores re-offers one chunk per transcript,
    which the hub rejects at `startOffset !== have` **before storing anything** and answers with its
    real cursor, which the pass jumps to. Wasted bytes, never a double-store. It needs a pass still
    running when the next manifest beat comes round, which a wedge does and so does an ordinary slow
    backfill — **a pass is bounded in BYTES, not in time** (`ARCHIVE_MANIFEST_MAX` transcripts, each
    at least one POST; one healthy pass measured at 690s). **A remembered cursor is NOT the fix**:
    one held across a hub whose archive was reset or evicted is ahead of the hub forever, and that
    transcript then never ships again — silence is worse than one discarded chunk.
  - **A wedged pass is otherwise SILENT** now that the beat no longer stalls behind it, and
    `urlopen`'s timeout is per SOCKET OPERATION, so a hub trickling bytes never trips it. The beat's
    `_warn_if_archive_pass_stalled` is the only signal there is, and it measures the LAST COMPLETED
    PUSH, never the pass's age — a naive version fired on a healthy host, claiming "no deltas are
    shipping" while 69 were.
  - Its reachability is as fragile as its logic: the worker stamping the pass, the push helpers
    stamping each completion, the seed at pass start, the throttle sentinel starting a full window
    in the past, and the beat calling the warn are all separate — dropping any one leaves a wedged
    host silent or a healthy one accused. Pin each END TO END through a real wedged pass, not by
    calling the warn with a hand-set stamp.
  - **It runs BEFORE the `archiveHave` gate**, because a wedged pass is the WORKER's state and not
    the reply's: behind that gate, a host whose manifest emptied mid-wedge was silent forever.
  - **A BLACKHOLED hub deliberately does not trip it**, and that is not a hole to close: every push
    still returns (at its own timeout) and logs its own failure, which is the operator's signal
    there. Only a peer that answers slowly enough to keep a socket alive is invisible otherwise.
    Tests: `TestArchiveSyncWorker`, `TestBeatLoopBudget`.
- **The manifest window is a QUEUE, not a cliff** (XERK-424). `_archive_window` splits
  `ARCHIVE_MANIFEST_MAX` into the newest `ARCHIVE_MANIFEST_RECENT` (so an ending session archives
  promptly), then what the hub is KNOWN to be short of, oldest first, then a **rotation** over
  everything else. Newest-by-mtime alone never re-offered what fell out: 10 transcripts and 51
  sessions' raw sidecars were unarchivable on the reference host while in-window coverage was
  perfect, and 115 of the 200 slots were sub-1KB records the hub already held, re-offered every
  beat. An already-complete transcript costs a pass nothing — `_archive_deltas` skips it on
  `have >= size` without a push — so rotating one back in is cheap and re-offering it is not a bug.
  - **`_archive_known` is what the hub SAID, and absent is not zero.** A reply only carries cursors
    for what was OFFERED, so an id that has never fit the window is missing from the map rather
    than zero, and the rotation exists precisely to reach those. A reported cursor REPLACES what we
    held, including downwards — a reset or evicted archive answers smaller, and a high-water mark
    would leave that transcript looking complete here and missing there for good.
    - **It may not raise either** (same beat-loop-is-main-process constraint as above).
      `int(float("inf"))` raises OverflowError — neither of the two obvious exceptions — and a bare
      `1e400` is valid RFC-8259 JSON, reachable from anything broken or hostile answering
      `TURMA_URL`. Keys are length-capped as well as counted: bounding ENTRIES bounds no bytes when
      one key may be a megabyte.
  - **Three ways this reverts to a cliff, each closed deliberately.** They all look like tidying.
    - **The rotation is keyed on the TRANSCRIPT, never on a position in the candidate list.**
      `_archive_offered` stamps what each beat offered and the pool is taken least-recently-offered
      first. An index cursor is index-SAFE but not starvation-safe: advanced against one pool and
      re-read modulo a differently sized one, it forms a limit cycle whenever the candidate count
      oscillates PERIODICALLY between two values — 700 of 1201 never offered in 400 beats on a
      period-2 toggle, both counts above the cap. A session going busy and idle on a regular cadence
      is exactly that, since candidates exclude whole slugs.
      - **Bounded against the high-water TRANSCRIPT UNIVERSE** (`_trim_archive_offered`) — every
        eligible slug's `.jsonl` count, **running slugs included**. An evicted stamp is
        indistinguishable from never-offered and whichever way that tie breaks it cycles, so the
        bound's only job is to never drop an id that can still be live. Three versions shipped
        and were wrong, each looking obviously right, and the pattern in all three is that the
        bound was derived from a number structurally smaller than the set it had to cover:
        - a flat 5,000 cannot cover the live set at all — the oldest `N - 5200` starved at any
          beat count;
        - `2 x this beat's CANDIDATE count` is computed against the TROUGH, since a slug going
          busy drops out — 201 of 1201 on a 201/1000 toggle, 2250 of 3250 on 250/3000;
        - no constant multiplier fixes that: the one needed tracks the peak/trough ratio, which is
          unbounded (k>=6 for 201/1000, k>=13 for 250/3000);
        - and the high-water CANDIDATE count is still too small: `_archive_manifest` drops a
          running slug **before** listing that slug's files, so the candidate count never sees it —
          three large slugs with one idle per beat hold the per-beat peak at one slug's worth while
          the union is three (600 of 3000 starved).
        The universe is the set that can be live rather than the subset offerable this beat, so
        there is no oscillation left for it to be smaller than. Costs one extra `os.listdir` per
        RUNNING slug, of which there are at most `MAX_SESSIONS`.
      - **The mark never decays**, so the map does not shrink after a delete — a roomier map than
        needed costs bytes and cannot cost correctness. `ARCHIVE_OFFERED_HARD_MAX` is where that
        trade stops (32.5 MB RSS measured at the 200k cap with real UUID keys, ~100k transcripts on
        one host). Past it the loss is a linear slope, roughly `universe - cap - MANIFEST_MAX`
        transcripts, so it is **logged once** rather than left silent.
      - **The two paths that can GROW the map both trim** — the normal window and the under-cap
        passthrough — because the passthrough runs every beat for a host below the cap and the hard
        cap must be enforceable there too. The two early returns that trim nothing also never stamp,
        so the map cannot grow through them either; a shrunk host's map does not come back down,
        since the mark never decays.
      - **The state is in MEMORY, so a restart LOOP starves the rotation** (XERK-430): a single
        restart is safe, but at a 2-4 beat restart period 900 of 1300 were never offered. The
        durable copy of "what the hub already has" lives on the hub, which is what XERK-431
        proposes moving the whole choice to.
      - Sharing `ARCHIVE_KNOWN_MAX` was also wrong — it coupled that map's off-switch to the
        rotation.
      - **Ties break oldest-first**, so what is closest to being lost wins, and eviction is
        least-recently-offered — which is why a re-stamp POPS before it re-inserts rather than
        assigning in place.
    - **The stamps are NEVER cleared**, including on the under-the-cap passthrough. A root slug
      holds every root session's transcript, so one session going busy swings the count by hundreds;
      clearing on each dip re-offered the same transcripts forever and never reached the rest
      (200 of 400 never offered in 200 beats).
    - **The known-short slice takes at most HALF the backlog slots.** Given all of them it starves
      the rotation to nothing once enough transcripts are known-short and cannot progress — a full
      store, a permanent per-transcript failure — and then nothing new is ever offered. It bites
      the RAW layer hardest: a session whose sidecars are missing but whose transcript is complete
      reads as known-COMPLETE, so only the rotation can ever reach it.
    - **`ARCHIVE_MANIFEST_RECENT` is clamped to three quarters of the window.** At `>= MAX` there
      is no backlog and no rotation at all, and both are env-settable.
  - **The backlog gets a reserved share of `ARCHIVE_RAW_MANIFEST_FILES_MAX`.** Spent in window
    order the recent slice exhausts it alone, and then the backlog's SIDECARS never ship however
    often its transcripts are offered — invisible to any coverage check on transcripts, since those
    sessions have rows and read back fine. It is a FLOOR under the backlog, not a ceiling on the
    recent slice: the backlog is served first at its floor, then a second pass hands whatever it
    left back to the newest, so the budget is never under-spent.
  - **`ARCHIVE_BEAT_BUDGET` deliberately has no such floor.** A manifest slot is re-contended every
    beat where those bytes are not: a transport failure, a 5xx, a `skip` and a `full` all cost
    zero budget (though a 200 whose cursor does not advance costs the full chunk — pre-existing,
    and only reachable from a hub that realigns persistently), and the hub REFUSES at
    `ARCHIVE_TOTAL_MAX` rather than evicting — so a cursor cannot regress in a loop and a
    transcript cannot re-consume budget indefinitely. A first sync costs the backlog some beats of
    delay, never starvation. Not because "running sessions are excluded so sizes are fixed":
    `_running_slugs` sees only this agent's OWN registry, and a real drive archived three
    transcripts that grew throughout it.
  - Tests: the `test_window_*`, `test_known_map_*`, `test_rotation_*`, `test_backlog_*`,
    `test_recent_slice_*` and `test_a_complete_transcript_*` cases in `TestArchiveSync`.
- Rows are dated by `_last_activity_ts` — the last message's own transcript timestamp, **NOT the
  file mtime** (XERK-73), which a synced `~/.claude` or backup restore inflates to copy-time. Falls
  back to mtime only when no entry is timestamped. Tests: `TestArchiveSync`, `TestLastActivityTs`,
  `TestResumableReport`.
- **The archive is the ONE place a SendUserFile preview is shed** (`_shed_block_payloads`,
  XERK-267): payloads are bounded per delivery but unbounded relative to the transcript, so a
  screenshot-heavy session archives orders of magnitude larger than what it records (measured:
  28 KB of transcript → 447 MB archived). Past `ARCHIVE_PAYLOAD_MAX` the rest of that transcript
  ships as name-only chips flagged `shed`. The live tail and `history` re-read previews from the
  transcript on demand, so they keep theirs at no durable cost.
- **The hub owns the ceiling, this is only an early stop.** `archiveShed`/`archiveFull` on the
  heartbeat reply are the hub's verdict (`turma/archive.js`), which the agent applies to keep the
  bytes off the wire and to skip a pass at a full store; the hub re-applies both itself, since an
  agent too old to read either flag pushes regardless. Counting differs on purpose: the hub spends
  STORED bytes and the agent only sheddable PAYLOAD bytes (charging a long but ordinary conversation
  for its prose would degrade it for nothing), and the agent's counter is **per sync pass**, since
  it restarts each beat — only the hub's verdict makes a shed stick across passes. Both read the
  same `ARCHIVE_TRANSCRIPT_MAX_BYTES`, so `_byte_ceiling` must agree with `byteCeiling` that 0
  disables and that a non-numeric value is a typo to reject. Tests: `TestArchivePayloadBudget`.
- A refused delta comes back as **the hub's real cursor plus a flag, never an error status** — the
  agent must read it as no forward progress and drop it, not as a chunk to re-send forever
  (XERK-255).
- **What is cut to the hub's ceiling is the delta's BODY, never the read window** (XERK-356).
  `ARCHIVE_CHUNK_BYTES` is only how far ahead `_archive_deltas` reads to find whole lines;
  `_archive_chunk_entries` then cuts at a LINE BOUNDARY so the measured body stays under
  `_archive_body_max()`. The two are not a ratio of each other — a SendUserFile turn is a short
  transcript line that renders to megabytes of preview read off DISK, so sizing the window bounds
  nothing. A chunk's byte range must contain exactly the entries it carries: an entry that does not
  fit opens the NEXT delta, and the cursor stops behind it.
  - **The number comes from the hub** (`archiveChunkMax` on the beat reply), like `bodyMax` and for
    the same reason. The default used before one arrives is deliberately under an OLD hub's 1 MiB
    route cap, which is what makes the archive work against a hub that has not been upgraded — the
    8-MiB-delta-into-a-1-MiB-route mismatch is what left the durable archive empty for every real
    session. A 413 forgets the learned number rather than re-sending the same delta every pass.
  - **A stated ceiling SMALLER than the default is obeyed**, floored only at `ARCHIVE_BODY_MIN`.
    Floored at the default instead, the fallback after a 413 landed on a number the hub still
    refused, so the same delta went up every pass forever. `ARCHIVE_BODY_MIN` exists only to reject a
    value no hub could mean — under it a delta cannot carry one ordinary turn.
  - **A failed push costs that TRANSCRIPT, not the pass.** A 4xx is permanent for that chunk and is
    skipped outright; anything else (a 5xx, a dead socket) also leaves that transcript but spends
    one of `ARCHIVE_FAILURES_MAX`, so a hub that is genuinely down still ends the pass. Conflated,
    one unpushable transcript starved every other transcript on the host, every beat — a 500 from a
    chunk the store cannot accept answers the same way however often it goes back up. Same line the
    raw layer already draws.
  - `TURMA_ARCHIVE_BODY_MAX` may only LOWER the default. Past the hub's cap plus its drain slack the
    socket is destroyed with no status, so neither the 413 fallback nor the skip can fire and the
    agent sees only a broken pipe.
  - An entry too big for a delta OF ITS OWN is degraded before it is dropped: file previews first
    (the chip the chat already renders), then the rich `blocks[]` (the flat `text` carries the same
    turn), and only then left out — with its byte range archived without it and **one log line per
    transcript per pass**, because a conversation with a turn silently missing is worse than one an
    operator knows has a hole.
  - A LINE longer than the read window is found with `_archive_line_end`, and past
    `ARCHIVE_LINE_SCAN_MAX` the scanned range is archived with nothing rendered from it. Resuming
    mid-line is safe — the leading fragment fails to parse and is skipped like any other unparseable
    line — where refusing to move parks that transcript at that offset for good.
  - **`meta` rides EVERY delta and is measured before any entry is fitted**, so `summary` is capped
    (`ARCHIVE_META_SUMMARY_MAX`). It comes from a session's name or label and the spawn route takes a
    100 KB label: uncapped it eats a whole delta, every entry is then dropped for "not fitting", and
    the transcript archives as empty ranges with a 200 on each.
- **Beside the rendered entries it ships the session's OWN FILES, byte for byte** (XERK-338):
  `_session_files()` enumerates `<id>.jsonl` plus everything under `<id>/` — `subagents/`,
  `workflows/`, `tool-results/`, and whatever Claude Code adds next — and `_archive_raw_deltas()`
  pushes each as gzipped, append-only ranges against a PER-FILE cursor (`archiveRawHave`).
  - **Deliberately not filtered to `*.jsonl`.** The point of the raw layer is that nobody has to have
    predicted what would be worth keeping, and the files that are not `.jsonl` are exactly the ones
    no other surface carries. `<slug>/memory/` is excluded — it belongs to the PROJECT, so one copy
    per conversation would be storage with no owner.
  - Only regular files, and **never through a symlink** (dir or file), the same hardening
    `_project_transcripts` applies: a link pointed at `PROJECTS_ROOT` drags every transcript on the
    host into one session's archive.
  - A source file SHORTER than the hub's cursor means the transcript was rewritten under us: it is
    logged and left alone. **Never truncate the archive to match** — the longer copy is the one with
    the history in it.
  - **A dsh session's native event log rides this layer at `<tid>/dsh/`** (`DSH_STORE_DIRNAME`,
    XERK-469). It is placed UNDER the project-slug session dir, not in the worktree, precisely so the
    raw walk carries it with no special case — the launcher (XERK-466) writes it there. The worktree
    is the wrong home: the raw layer excludes it on purpose (its contents are what prune/delete key
    on), so a native log there is D3's canonical record retained by NOTHING. This reconciles the
    `docs/dsh-session-lifecycle.md` design, which had proposed the worktree.
  - **A qwen session's native event log rides this layer at `<tid>/qwen/`** (`QWEN_STORE_DIRNAME`,
    XERK-512) the SAME way — a raw sidecar under the project-slug session dir. The difference is only
    WHO writes it there: dsh's driver writes its feed directly, but qwen owns its native log (it
    writes it under `~/.qwen/projects/`, which this walk does not reach), so the projection TAIL
    (`qwen_session.QwenProjectionTail`) MIRRORS its bytes into the store, append-only, on its own
    cursor (running-session carve-out below). Migration ([Qwen K], XERK-516) does NOT carry this
    `<tid>/qwen/` mirror: it is the display/metrics
    feed, and qwen resumes from its OWN native log under `~/.qwen/projects/` (the file the bundle
    carries under `.qwen-store/` instead). The target rebuilds this mirror from new events, exactly as
    dsh's `<tid>/dsh/` feed is rebuilt. Keep the resumable log and this feed straight.
  - **A RUNNING dsh session is NOT excluded from the manifest** (`_running_slugs` subtracts
    `_live_dsh_slugs`), and that exception is what makes the Trajectory work at all. **A running
    QWEN session gets NO such carve-out** (XERK-512): qwen has a real ttyd TUI and no Trajectory
    viewer, so its native log is retention/metrics only, archiving once the session ends like every
    other running session — dsh alone is the exception, because the in-dashboard Trajectory (XERK-498)
    is the ONLY viewer a headless dsh session has, and it reads the native log back through THIS raw
    layer — so a running dsh session that did not sync would 404 for its whole life, which is exactly
    when the operator needs it. So a running dsh session syncs live: its projected `<tid>.jsonl` and
    its `<tid>/dsh/` native log both ship every beat.
    - **The rendered layer MUST ship too, not just the raw one.** The raw layer is hung off the
      rendered `sessions` row: `rawCursors`/`ingestRaw` (`turma/archive.js`) `skip` any transcript
      with no `filePath`, i.e. one that has never had a rendered chunk. So a raw-only push for a
      running dsh session would be refused — the projection transcript has to create the row first.
      This is why the exception is at the SLUG level (both layers) rather than a raw-only carve-out.
    - **A dsh session's slug is unique to it** (its own worktree), so un-excluding it archives
      exactly that one session. A ROOT session (shared slug, no worktree) is never included —
      `_live_dsh_slugs` requires `worktreePath` — so the shared root slug's other transcripts are
      never dragged in.
    - Accepted minor effect: a running dsh session now has an archive row, so it can appear in the
      archive BROWSER (`GET /api/archive`) / hub search while still running. The Ended-sessions
      SIDEBAR does not show it (it dedupes against running `transcriptId`s), and Restore refuses a
      running conversation, so this is cosmetic. Tests:
      `test_manifest_keeps_a_running_dsh_session_so_its_trajectory_populates`.
  - **Only APPEND-ONLY bytes belong under `<tid>/dsh/`.** The per-file cursor ships bytes past an
    offset — correct for dsh's event-sourced JSONL log, wrong for a page-mutating SQLite (an in-place
    rewrite leaves the archived early bytes stale). dsh's SQLite is a derived index it rebuilds from
    the log, so it is not archived. This `<tid>/dsh/` log is the DISPLAY/metrics feed — and the hub's
    **Turma-native Trajectory viewer reads it back from THIS raw layer** (`archive.dshTrajectory`,
    `GET /api/dsh/<tid>/trajectory`, XERK-498), which is why it must land here in full. Migration
    ([K], XERK-475) does NOT carry it — dsh resumes from its OWN store under `DSH_SESSIONS_ROOT`
    (a separate file), which the bundle carries instead; the target rebuilds this feed from new
    events (the resumed dsh does not replay history). The earlier note that [K] would
    `tar.add(<tid>/dsh)` was based on a false premise (that this feed was resumable). Tests:
    `TestDshArchiveSync`.
  - The raw pass runs in its **own try/except** off the same reply: a raw failure must never cost the
    rendered transcript, which is what every other surface reads. Its read window must stay at or
    under the hub's `ARCHIVE_RAW_CHUNK_MAX`, which bounds its gunzip — a larger window is refused on
    every push, not truncated. Tests: the raw cases in `TestArchiveSync`.
