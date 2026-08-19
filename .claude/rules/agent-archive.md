---
paths:
  - "agent/hub-agent.py"
---

# Archive sync (`agent/hub-agent.py`)

Split out of `.claude/rules/agent.md` to keep that file under its size ceiling; the rest of the
agent's process model is there. The HUB half — the store's layout, its two size ceilings, the raw
layer's read-back routes — is in `.claude/rules/turma-archive.md`.

- The agent **ships every INACTIVE session's transcript to the hub's durable archive** so history
  survives this host being wiped/offline. `_archive_manifest()` enumerates ended transcripts (every
  ledger slug's `*.jsonl`, minus any backing a running session); the hub replies with per-transcript
  byte cursors (`archiveHave`), and `_archive_deltas()` POSTs the missing append-only deltas
  (pre-parsed through `_entry_text`), bounded per chunk/beat.
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
- **What is cut to the hub's ceiling is the delta's BODY, never the read window** (XERK-356).
  `ARCHIVE_CHUNK_BYTES` is only how far ahead `_archive_deltas` reads to find whole lines;
  `_archive_chunk_entries` then cuts at a LINE BOUNDARY so the measured body stays under
  `_archive_body_max()`. The two are not a ratio of each other — a SendUserFile turn is a short
  transcript line that renders to megabytes of preview the agent reads off DISK — so sizing the
  window bounds nothing. A chunk's byte range must contain exactly the entries it carries: an entry
  that does not fit opens the NEXT delta, and the cursor stops behind it.
  - **The number comes from the hub** (`archiveChunkMax` on the beat reply), like `bodyMax` and for
    the same reason. The default used before one arrives is deliberately under an OLD hub's 1 MiB
    route cap, which is what makes the archive work against a hub that has not been upgraded — the
    8-MiB-delta-into-a-1-MiB-route mismatch is what left the durable archive empty for every real
    session. A 413 forgets the learned number rather than re-sending the same delta every pass.
  - **A stated ceiling SMALLER than the default is obeyed**, floored only at `ARCHIVE_BODY_MIN`.
    Floored at the default instead, the fallback after a 413 landed on a number the hub still
    refused, so the same delta went up every pass forever. `ARCHIVE_BODY_MIN` exists only to reject a
    value no hub could mean — under it a delta cannot carry one ordinary turn.
  - **A 4xx skips that TRANSCRIPT; only a transport failure ends the pass.** Conflated, one
    unpushable transcript starved every other transcript on the host, every beat — the same line the
    raw layer already draws.
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
  - The raw pass runs in its **own try/except** off the same reply: a raw failure must never cost the
    rendered transcript, which is what every other surface reads. Its read window must stay at or
    under the hub's `ARCHIVE_RAW_CHUNK_MAX`, which bounds its gunzip — a larger window is refused on
    every push, not truncated. Tests: the raw cases in `TestArchiveSync`.
