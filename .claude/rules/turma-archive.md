---
paths:
  - "turma/archive.js"
  - "turma/tests/archive*.test.js"
---

# The hub's durable archive (`turma/archive.js`)

Split out of `.claude/rules/turma.md` to keep that file under its size ceiling. The rest of the
dashboard is there; `CLAUDE.md` has the `/data` volume and what else shares it. The agent half —
what it ships and when it sheds — is in `.claude/rules/agent.md` under "Archive sync".

- The hub hosts a **durable, searchable archive of ended sessions** (`turma/archive.js`): agents
  push each inactive transcript in, landing as **organized files on `/data`** — one folder per repo,
  each renamed + dated `/data/archive/<repo>/<YYYY-MM-DD>__<summary>__<host>__<shortId>.jsonl` (+ a
  `.meta` sidecar), indexed in a **`node:sqlite` FTS5** DB (`/data/archive/index.db`, Node-core, no
  npm), rebuildable from the files.
- The Sessions page gains a search box (`GET /api/search?q=` — hub-local full-text search, ranked,
  `<mark>`-highlighted, grouped by `remoteKey`, working for offline hosts) and an "Ended sessions"
  browser (`GET /api/archive`); a result opens read-only (`GET /api/archive/<transcriptId>`). Ingest
  is agent-token-authed; the manifest cursors ride the heartbeat reply.
- **Two size ceilings, both enforced in `ingestChunk` whatever an agent sends** (XERK-267):
  - `ARCHIVE_TRANSCRIPT_MAX_BYTES` (16 MiB) per transcript. What lands here is the agent's
    pre-parsed entries, and a SendUserFile block carries the delivered file INLINE, so an archived
    session can dwarf the conversation it records (measured: 28 KB of transcript → 447 MB stored).
    Past it, that transcript's file payloads shed to the name-only chip the chat already renders
    for an unpreviewable delivery — **sticky for the rest of the transcript**, so a reader sees one
    clean cutover rather than a flicker. Ordinary sessions are untouched; the largest real archived
    file measured 1.2 MB.
  - `ARCHIVE_TOTAL_MAX_BYTES` (64 GiB) for the store. `ARCHIVE_DIR` shares its volume with
    `state.json`, so a blow-up takes the hub's own state down with it.
  - **Both refuse by handing back the real cursor plus a flag, never an error** — an agent reads
    that as no forward progress and drops the chunk, where an error status is re-sent forever
    (XERK-255). `archiveLimits` puts the same verdict on the heartbeat reply
    (`archiveShed`/`archiveFull`) so an agent sheds before the bytes reach the wire; that is an
    optimisation, and the hub never relies on it.
  - Budget spend is the `archiveBytes` column, **re-derived from the files by `rebuildIndex`** —
    the index is disposable, so reading it from a sidecar would drift (and every pre-XERK-267
    sidecar has no such field).
  - **The store total is WALKED off the files, never summed from the index** (`totalArchiveBytes`).
    Deleting archives is the operator's way out of a full store, and it works here because the
    bytes are simply gone — nothing has to notice a deletion.
    - The walk is the **baseline only**; `writtenSinceWalk` adds every byte appended since, and the
      walk zeroes it. A cached total on its own leaves ingest **unmetered between refreshes** —
      measured 4.85 GiB written past a 4 MiB ceiling in one window. Growth is therefore exact
      (overshoot ≤ one chunk) and only DELETION is stale, which is why `TOTAL_CACHE_MS` can be
      minutes: waiting one window to notice an operator freeing space costs nothing.
    - It counts the **`.jsonl` files only — deliberately NOT `index.db`**, even though the index
      sits in the same directory and is ~2.4× their size. A ceiling enforced by REFUSING INGEST may
      only bound what refusing can reclaim, and refusing does not shrink a database: nothing reaps
      its rows for a deleted file and nothing VACUUMs, so counted, an operator who deleted every
      transcript stayed full forever (measured: still refusing after 84 attempts / 421 s, capacity
      per fill-delete cycle ratcheting 429 transcripts down to 4). The index and the `.meta`
      sidecars are **overhead to size the volume for, not budget** — and that overhead is **at least 3×
      the ceiling and unbounded across fill/wipe cycles** (measured 3.0–3.2× at first fill, then
      ~13 MB of index per cycle to 61× by cycle 38, unreclaimed by a restart; XERK-332 tracks
      reclaiming it). Size the volume for the churn, not for one fill.
    - **A walk that THROWS is not a measurement of zero** — only ENOENT on `ARCHIVE_DIR` is (that
      is the store genuinely absent, and what lets a removed directory be recreated instead of
      latching full). Anything else — EMFILE from fd exhaustion, EACCES, EIO — keeps the last
      baseline **and stamps the cache** so it isn't retried per call, because recording the failure
      re-baselines to nothing AND zeroes the charge, so each blip hands out a whole fresh ceiling:
      measured amplifying to 6.2× over five blips, silently, with the store reading full throughout.
    - That applies to **`ARCHIVE_DIR` itself only**. An unreadable SUBDIRECTORY is skipped and costs
      its subtree — an under-measure, which this errs toward anyway. Propagating it froze the
      baseline permanently, so no deletion was ever seen again and the store latched full with no
      exit; one root-owned directory (an expected state per the run-as-identity rules) or one
      over-long path was enough. The subtree's cost is one-time only while it is also UNWRITABLE,
      which is the realistic shape; unreadable-but-writable under-measures without bound.
    - Once it reads full it re-measures on `FULL_RECHECK_MS` instead — precision is worth most
      exactly then, ingest is refusing anyway so a walk costs no throughput, and this is what
      bounds how long an operator waits after freeing space.
    - It is **synchronous on the heartbeat path** and the hub is one event loop, so the walk's cost
      is a hub-wide stall: 14 ms at the reference ~1,300 files, ~7 µs/file warm, ~18× cold. Keep it
      synchronous — that is *why* the charge cannot be interleaved with a walk. If the store ever
      reaches tens of thousands of files, walk only when near the ceiling rather than making it
      async or shortening the window.
    - **Do not "improve" this into an indexed column that reconciles against disk.** That means
      inferring "deleted" from a failed stat, which is not knowable: an unmounted volume, a renamed
      parent and a real delete all report ENOENT, while EACCES/EIO/ESTALE report neither. Guessing
      "deleted" drops the row and resets the cursor, and since ingest APPENDS, the re-push writes a
      SECOND copy of the conversation into a file that was there all along; guessing "present"
      latches the ceiling shut with no exit. Both were built and both were reproduced.
  - **A deleted `.jsonl` whose index row survives leaves the cursor alone** and the next delta
    appends onto the gap — pre-existing, tracked as XERK-280. Repairing it needs a reliable answer
    to "was this deleted", which is the thing above that cannot be had cheaply.
- Tests: `archive.test.js`, `archive-budget.test.js`, `server.test.js`.
