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
  - **`queue_archive_sync` may not raise.** The beat loop is the container's MAIN PROCESS
    (`entrypoint.sh` `exec`s it, with no retry loop of its own), so an exception on it is not a
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
    `urlopen`'s timeout is per SOCKET OPERATION, so a hub trickling bytes never trips it. The beat
    reports it (`_warn_if_archive_pass_stalled`) and that line is the only signal there is — so it
    measures the LAST COMPLETED PUSH, never the pass's age. Timing the pass fired on exactly the
    healthy host this ticket is about, saying "no deltas are shipping" while 69 were.
  - Its reachability is as fragile as its logic: the worker stamping the pass, the push helpers
    stamping each completion, and the beat calling the warn are three separate things, and dropping
    any one leaves a wedged host permanently silent. All three are pinned END TO END, through a real
    wedged pass, not by calling the warn with a hand-set stamp. Tests: `TestArchiveSyncWorker`,
    `TestBeatLoopBudget`.
- Rows are dated by `_last_activity_ts` — the last message's own transcript timestamp, **NOT the
  file mtime** (XERK-73), which a synced `~/.claude` or backup restore inflates to copy-time. Falls
  back to mtime only when no entry is timestamped. Tests: `TestArchiveSync`, `TestLastActivityTs`,
  `TestResumableReport`.
- **The archive is the ONE place a SendUserFile preview is shed** (`_shed_block_payloads`,
  XERK-267): the payloads are bounded per delivery but unbounded relative to the transcript, so a
  screenshot-heavy session archives orders of magnitude larger than what it records (measured:
  28 KB of transcript → 447 MB archived). Past `ARCHIVE_PAYLOAD_MAX` the rest of that transcript
  ships as name-only chips flagged `shed`. The live tail and `history` keep their previews — those
  are re-read from the transcript on demand and cost nothing durable.
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
  - The raw pass runs in its **own try/except** off the same reply: a raw failure must never cost the
    rendered transcript, which is what every other surface reads. Its read window must stay at or
    under the hub's `ARCHIVE_RAW_CHUNK_MAX`, which bounds its gunzip — a larger window is refused on
    every push, not truncated. Tests: the raw cases in `TestArchiveSync`.
