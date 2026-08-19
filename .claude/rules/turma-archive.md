---
paths:
  - "turma/archive.js"
  - "turma/tests/archive*.test.js"
---

# The hub's durable archive (`turma/archive.js`)

Split out of `.claude/rules/turma.md` to keep that file under its size ceiling. The rest of the
dashboard is there; `CLAUDE.md` has the `/data` volume and what else shares it. The agent half —
what it ships, what bounds one delta, and when it sheds — is in `.claude/rules/agent-archive.md`.

- The hub hosts a **durable, searchable archive of ended sessions** (`turma/archive.js`): agents
  push each inactive transcript in, landing as **organized files on `/data`** — one folder per repo,
  each renamed + dated `/data/archive/<repo>/<YYYY-MM-DD>__<summary>__<host>__<shortId>.jsonl` (+ a
  `.meta` sidecar), indexed in a **`node:sqlite` FTS5** DB (`/data/archive/index.db`, Node-core, no
  npm), rebuildable from the files.
- **A second, RAW layer sits beside the rendered one** (XERK-338): a byte-for-byte copy of the
  session's own files, under `<that .jsonl>.raw/`, laid out as the host had them —
  `<id>.jsonl`, `<id>/subagents/…`, `<id>/workflows/…`, `<id>/tool-results/…`. Layer 1 is a
  PROJECTION (one rendered line per displayable entry), so everything Claude Code wrote that Turma
  does not render today — the model, token counts, tool-call ids, hook records, the overflow files —
  died with the host. That material cannot be recovered after the fact, so it is kept whether or not
  anything reads it yet.
  - **The cursor is the STORED FILE'S OWN SIZE**, not a number kept beside it, so it agrees with what
    an append will do and an operator deleting a raw file simply gets it re-synced — where the
    rendered layer's indexed cursor appends onto the gap (XERK-280). A stat that fails with anything
    but ENOENT reads as **"cannot tell"** and the file is skipped: read as 0 it would re-ship the
    whole thing onto the copy still there, which is the duplication this layer exists to avoid.
  - Append-only and forward-only per FILE, which is the whole **resumed-session** answer: a resume
    appends to the same file under the same transcript id, so only the new bytes ever ship. It is
    also what makes a MIGRATED session safe — the target carries the same id and a byte-identical
    prefix, so its pushes continue the same file instead of starting a second copy.
  - Chunks are **NOT line-aligned**, unlike the rendered layer's: this is a byte copy and half of
    what it carries (`tool-results/*.txt`, the workflow records) is not line-oriented at all.
  - The wire is **gzipped and the decompression is BOUNDED** (`ARCHIVE_RAW_CHUNK_MAX` via
    `maxOutputLength`). Raw bytes are 3–14x the rendered entries and JSONL compresses ~5–8x, so
    uncompressed this layer would cost more on the wire than everything else an agent sends; and a
    body cap alone bounds only the COMPRESSED side, which is exactly what a zip bomb exploits.
    On disk it is stored UNCOMPRESSED — greppable, and countable by the same walk.
  - A path from an agent is **allowlisted component by component** (`safeRawRel`: `[A-Za-z0-9._-]+`,
    never `.`/`..`, depth and length capped), not searched for `..`. The joined result is re-checked
    against the raw directory; the allowlist is the guarantee, that check is the proof.
  - `ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES` (128 MiB) bounds ONE session's raw copy — its whole directory
    together. There is deliberately **no separate store-wide raw ceiling**: `ARCHIVE_TOTAL_MAX_BYTES`
    exists to keep the volume writable for `state.json`, and two budgets that each pass individually
    still fill the disk together. Past the per-session one that session's raw sync stops and the
    rendered transcript carries on, so it stays readable and searchable.
  - **The per-beat cursor loop is bounded by the HUB** (`ARCHIVE_RAW_CURSOR_MAX`, 2000), and the
    budget is charged for the manifest ENTRY's row lookup as well as each file's stat, BEFORE either
    happens. Charging only what survives validation — or only what resolves to a row — left the OUTER
    loop free, so a manifest of unknown ids (or of ids whose row has no `filePath`, which is every
    transcript that has never had a rendered chunk) did a SELECT apiece and simply moved the stall:
    2,985 ms for 470,051 entries, against 4.2 ms for the same entries with `rawFiles` omitted. Validation is not free — a max-length
    depth-10 path failing on its last character measured 700 ms per 780k entries against 30 ms for
    valid ones — so charging only the survivors let a caller walk straight around the cap by offering
    paths the allowlist rejects. **The budget bounds the WORK, and every offer costs work.**
    `rawCursors` stats one file per offer, synchronously, on the heartbeat path — the same hub-wide
    stall budget the store-total walk is sized against. Measured ~5.6 µs per stat: the 40,000 files an
    agent may offer under its OWN caps cost 223 ms, and the ~780,000 that fit in a 32 MiB
    `HEARTBEAT_MAX` cost ~4.4 SECONDS, per beat, per host, with every dashboard, SSE tail and other
    host's beat queued behind it. The agent's `ARCHIVE_RAW_MANIFEST_FILES_MAX` is **not** this bound —
    a bound the receiving path does not enforce is not a bound (XERK-235). Past it a file gets no
    cursor, the agent pushes from 0, and `ingestRaw`'s offset check refuses: the stored data is safe
    and the cost is one wasted small POST, only ever for an agent already over its own cap. Logged,
    throttled, because silence reads as "the hub holds nothing" and provokes a re-ship.
  - **The raw directory is keyed on the FULL transcript id** (`<file>.jsonl.raw/<id>/…`), not on the
    canonical file name — that name carries only the first 8 alnum characters of the id, so two
    transcripts agreeing on repo/date/summary/host and that prefix share one `.jsonl`, and sharing a
    raw directory too made each one's `/raw` listing return the OTHER's files through the read-back
    route. `transcriptId` is agent-chosen, so it can be forced.
  - **Only the session's OWN host may write its raw files.** `<host>` being proved by the credential
    (XERK-268) says who is calling, not whose session they may write into: with a properly bound
    token any agent could otherwise create arbitrary named files inside another host's archived
    session and have them served back as part of that host's record. A migration still works, because
    the rendered delta re-points `sessions.host` and the beat pushes the rendered layer first.
    (`ingestChunk` has no such check — pre-existing, XERK-344.)
  - **The agent never OFFERS a file the hub cannot name** (`_archivable_rel` mirrors `safeRawRel`),
    and a permanent 4xx does not spend the pass's failure budget. Offering one is not harmless: the
    hub answers 400 forever, the agent cannot tell that from a transient failure, and three such
    files ended the pass on every beat — starving every other transcript on the host. Reachable with
    no malice: a workflow's script is named after the workflow, and a name with a space or an accent
    is ordinary. **The two allowlists must agree** — widening the hub's without widening the agent's
    silently keeps files out, and a file the agent wrongly believes is nameable is left out of the
    "cannot be named" log too, which is the one thing making it visible. The agent uses
    `re.fullmatch`, never `match(...$)`: **Python's `$` matches before a trailing newline and
    JavaScript's does not**, so two identical-looking regexes disagreed on `"a.jsonl\n"` — a legal
    Linux filename. Any agent/hub regex pair has this trap; there is a differential test.
  - **The wire cap CLEARS the worst case of gzipping a chunk, never equals it.** gzip expands
    incompressible input (~+0.03%), so an equal cap made any session file holding 4 MiB of
    already-compressed bytes unpushable — and, since a failed push aborted the whole pass, it stopped
    the raw sync for every OTHER transcript on that host, every beat, forever. A failed push now skips
    that FILE (`ARCHIVE_RAW_FAILURES_MAX` still ends a pass against a hub that is genuinely down).
  - **The decompressed buffer is NOT a concurrent term.** `gunzipSync` is synchronous, so at most one
    exists at a time and the peak it adds is `ARCHIVE_RAW_CHUNK_MAX`, flat. An earlier version
    charged it to the in-flight body budget to bound "N concurrent gunzips"; that was inert (charge
    and release sit in one synchronous run — 64 concurrent pushes saw an empty budget and not one
    503) and the comment asserted a guarantee that did not exist. **If this ever becomes async, the
    charge has to come back for real.**
  - The `transcriptId` is length-bounded at the route, not just allowlisted: since the raw directory
    is keyed on it, an id past the filesystem's 255-byte name limit made every push for that session
    fail at the syscall and report `skip` with no diagnostic.
  - `GET /api/archive/<id>/raw` lists it and `GET /api/archive/<id>/raw/<file>` streams one file
    (user-authed, `attachment` + `nosniff` — a transcript holds whatever was pasted into it, and
    rendering that inline behind the hub's login is stored XSS). Bytes nothing can read back are not
    archived, so both ship with the ingest.
  - Sizing: measured on the reference host at 336 transcripts + their nested files = 53 MB, largest
    single session directory 7.6 MB — roughly 5–10x the rendered layer.
- **A delta arrives at the size the ROUTE takes, which is not `readBody`'s default**
  (`ARCHIVE_CHUNK_BODY_MAX` in `turma/server.js`, XERK-356 — mechanics in
  `.claude/rules/turma-limits.md`). Archival excludes RUNNING sessions, so an ended session's FIRST
  delta is its whole transcript; at the old 1 MiB default every real one was refused and this store
  held nothing but trivially small conversations. Anything reasoning about chunk sizes here has to
  read that ceiling, not `ingestChunk`'s per-entry budget.
- **A transcript missing because a push was REFUSED says so** (`archiveRefusals`): `getTranscript`
  answering null is served as a 404 carrying `refused`, and the clients word that differently from
  "not here yet". Without it the operator is told the conversation "syncs within a few minutes of
  ending", which a refusal makes untrue forever.
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
  - **The store total is WALKED off the files, never summed from the index** (`totalArchiveBytes`),
    and inside a raw directory it counts **every regular file whatever its extension** — most of the
    raw layer is not named `.jsonl`, and counting only those would leave most of its bytes outside
    the ceiling. A raw directory is recognised as `<name>.jsonl.raw` at depth > 0 only, so a repo
    literally named `x.jsonl.raw` cannot have its archive mis-measured (or skipped by the rebuild).
    Deleting archives is the operator's way out of a full store, and it works here because the
    bytes are simply gone — nothing has to notice a deletion.
    - The walk is the **baseline only**; `writtenSinceWalk` adds every byte appended since, and the
      walk zeroes it. A cached total on its own leaves ingest **unmetered between refreshes** —
      measured 4.85 GiB written past a 4 MiB ceiling in one window. Growth is therefore exact
      (overshoot ≤ one chunk) and only DELETION is stale, which is why `TOTAL_CACHE_MS` can be
      minutes: waiting one window to notice an operator freeing space costs nothing.
    - It counts the archive's own content — the rendered `.jsonl` files and everything inside a raw
      directory — but **deliberately NOT `index.db`**, even though the index
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
- **`manifestCursors` is bounded too** (`ARCHIVE_MANIFEST_CURSOR_MAX`, 2000). Pre-existing, and the
  costlier of the two (a SELECT + an INSERT per entry against one stat): 973,677 new ids in one
  26.9 MiB beat measured **6.9 SECONDS** of blocked event loop and wrote 973,682 rows, growing
  `index.db` + WAL to 161 MB — every beat, and `index.db` sits outside `ARCHIVE_TOTAL_MAX`
  (XERK-332). Uncapped it also made the raw cursor cap nearly pointless, since the same caller could
  send manifest entries instead for 20x the stall.
- `rebuildIndex` derives `rawBytes` by walking the raw directory, exactly as it derives
  `archiveBytes` from the file — never read back from a sidecar — and its file walk **skips a raw
  directory whole**. Its contents carry no `.meta` so they would be skipped as rows anyway, but only
  after a rebuild had read every one of them into memory. Tests: `__walkJsonl` is exported so the
  SKIP is pinned rather than that backstop.
- Tests: `archive.test.js`, `archive-budget.test.js`, `server.test.js`.
