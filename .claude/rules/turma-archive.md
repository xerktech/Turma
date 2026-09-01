---
paths:
  - "turma/archive.js"
  - "turma/tar.js"
  - "turma/tests/archive*.test.js"
  - "turma/tests/restore.test.js"
  - "turma/tests/tar.test.js"
---

# The hub's durable archive (`turma/archive.js`)

Split out of `.claude/rules/turma.md`. `CLAUDE.md` has the `/data` volume and what else shares it.
The agent half (what it ships, delta bounds, when it sheds) is in `.claude/rules/agent-archive.md`.

- The hub hosts a **durable, searchable archive of ended sessions**: agents push each inactive
  transcript in, landing as organized files on `/data`
  (`/data/archive/<repo>/<YYYY-MM-DD>__<summary>__<host>__<shortId>.jsonl` + `.meta` sidecar),
  indexed in a **`node:sqlite` FTS5** DB (`/data/archive/index.db`, rebuildable from the files).
- **A second, RAW layer sits beside the rendered one** (XERK-338): a byte-for-byte copy of the
  session's own files under `<that .jsonl>.raw/`. Layer 1 is a PROJECTION (one rendered line per
  displayable entry) — everything else Claude Code wrote (model, token counts, tool-call ids, hook
  records, overflow files) is kept here whether or not anything reads it yet, since it cannot be
  recovered after the fact.
  - **The cursor is the stored file's OWN SIZE**, not a number kept beside it — agrees with what an
    append does, and a deleted raw file just gets re-synced. ENOENT means genuinely absent; any other
    stat failure reads "cannot tell" and is skipped (never treated as 0, which would re-ship the
    whole file onto what's still there).
  - Append-only and forward-only PER FILE — the resumed-session and migrated-session answer: same
    transcript id → same file → only new bytes ship, byte-identical prefix either way.
  - Chunks are **NOT line-aligned** (unlike the rendered layer) — it's a byte copy, and half of what
    it carries (`tool-results/*.txt`, workflow records) isn't line-oriented.
  - **Gzipped on the wire, bounded** (`ARCHIVE_RAW_CHUNK_MAX`) — raw bytes are 3-14x rendered and
    compress ~5-8x, so uncompressed would cost more than everything else an agent sends, and a body
    cap alone bounds only the compressed side (a zip-bomb vector). Stored UNCOMPRESSED on disk.
  - **A path is allowlisted component-by-component** (`safeRawRel`), never `..`-searched; the joined
    result is re-checked against the raw dir as proof.
  - **`ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES`** (128 MiB) bounds ONE session's raw copy. **No separate
    store-wide raw ceiling** — `ARCHIVE_TOTAL_MAX_BYTES` covers the whole store, and two independent
    budgets both passing can still fill the disk together. Past the per-session cap that session's
    raw sync stops; the rendered transcript stays readable.
  - **The per-beat cursor loop is bounded by the HUB** (`ARCHIVE_RAW_CURSOR_MAX`, 2000), charged for
    EVERY offer BEFORE validation — charging only survivors lets a caller walk around the cap with
    ids the allowlist would reject. **The budget bounds the WORK, and every offer costs work.** The
    agent's own `ARCHIVE_RAW_MANIFEST_FILES_MAX` is NOT this bound — a bound the receiving path
    doesn't enforce is not a bound (XERK-235). Past it a file gets no cursor and the agent re-pushes
    from 0 (safe, just wasteful — logged, throttled).
  - **The raw directory is keyed on the FULL transcript id**, not the canonical filename (which
    truncates to 8 chars and can collide) — a shared raw directory would leak one transcript's files
    through another's read-back route. Belt-and-braces since XERK-277 also disambiguates the RENDERED
    filename (below), but keep it: the full-id keying is the guarantee, the rendered fix is a second.
  - **A new transcript's RENDERED canonical filename is disambiguated on first sight**
    (`resolveNewRelPath`, XERK-277) — `archiveRelPath` keys the name on only the first 8 alnum chars
    of the id (an id with <8 alnum chars collapses to the literal `unknown`), so two transcripts
    agreeing on repo/date/summary/host + that prefix computed ONE `.jsonl`; ingest APPENDS, so each
    read-back served the other's entries. `transcriptId` is agent-chosen under one shared token, so
    it's forceable, not just an accident. On a collision with a DIFFERENT transcript the suffix gets
    a `-2`/`-3`/… (an id-seeded suffix past `RELPATH_PROBE_MAX`) until unowned. **Every candidate,
    the id-seeded fallback included, is re-checked against `relPathOwner`** — `slugify` is not
    injective, so returning the id-seeded name unchecked reopened the same leak (QA). The **sessions
    table is
    authoritative** for ownership (it survives a deleted `.jsonl` whose row keeps its `filePath`,
    XERK-280 — a disk-only check would re-hand that path and interleave onto the gap); the `.meta`
    sidecar is the backstop for a not-yet-rebuilt index. Additive on collision — the result is baked
    into `filePath` + the sidecar, so `ingestChunk` reuses it and `rebuildIndex` re-derives it from
    the on-disk name; existing files are never renamed.
  - **Only the session's OWN host may write its raw files** — the credential (XERK-268) proves WHO is
    calling, not whose session they may write into. (`ingestChunk` has no such check yet —
    pre-existing, XERK-344.)
  - **The agent never OFFERS a file the hub cannot name** (`_archivable_rel` mirrors `safeRawRel`) —
    an unnameable offer 400s FOREVER and isn't distinguishable from transient failure, so it can
    starve every other transcript on the host. **The two allowlists must agree.** The agent uses
    `re.fullmatch`, never `match(...$)` — Python's `$` matches before a trailing newline,
    JavaScript's doesn't, so identical-looking regexes disagree on a legal filename ending in `\n`.
  - **The wire cap CLEARS the worst case of gzipping a chunk, never equals it** — gzip expands
    incompressible input, so an equal cap makes some files unpushable, and a failed push must skip
    only that FILE, not abort the whole pass (`ARCHIVE_RAW_FAILURES_MAX` still ends a pass against a
    genuinely dead hub).
  - **The decompressed buffer is NOT a concurrent term** — `gunzipSync` is synchronous, so at most one
    exists; the peak is `ARCHIVE_RAW_CHUNK_MAX` flat. If this ever becomes async, that charge has to
    come back for real.
  - `transcriptId` is length-bounded at the route (the raw directory is keyed on it; past the
    filesystem's 255-byte name limit every push for that session fails at the syscall).
  - `GET /api/archive/<id>/raw` lists it, `GET /api/archive/<id>/raw/<file>` streams one file
    (user-authed, `attachment` + `nosniff` — a transcript can hold pasted content, so inline
    rendering behind the login is stored XSS).
- **A delta arrives at the size the ROUTE takes**, not `readBody`'s default (`ARCHIVE_CHUNK_BODY_MAX`
  in `turma/server.js`, XERK-356) — archival excludes RUNNING sessions, so an ended session's FIRST
  delta is its whole transcript.
- **A transcript missing because a push was REFUSED says so** (`archiveRefusals`) — `getTranscript`
  answering null is served as a 404 carrying `refused`, worded differently from "not here yet".
  Keyed on HOST + transcript, evicted within-a-host-first so one host can't crowd out every other
  host's diagnostic. The reason is a fixed set of HUB-authored strings, never an exception's text.
- **`meta` is COERCED before it is bound** (`normalizeMeta`) — every field is agent-supplied and goes
  straight into sqlite (scalars only); a non-scalar stores as nothing rather than poisoning every
  later beat with a 500. The length cap is the receiving half of the same XERK-235 rule as above.
- The Sessions page gains a search box (`GET /api/search?q=`, hub-local FTS, ranked, highlighted,
  grouped by `remoteKey`) and an "Ended sessions" browser (`GET /api/archive` /
  `GET /api/archive/<transcriptId>`). Ingest is agent-token-authed.
- **Two size ceilings, both enforced in `ingestChunk` whatever an agent sends** (XERK-267):
  - `ARCHIVE_TRANSCRIPT_MAX_BYTES` (16 MiB) per transcript. A SendUserFile block carries the
    delivered file INLINE, so an archived session can dwarf the conversation it records. Past it,
    file payloads shed to a name-only chip, STICKY for the rest of the transcript.
  - `ARCHIVE_TOTAL_MAX_BYTES` (64 GiB) for the store (`ARCHIVE_DIR` shares its volume with
    `state.json`).
  - **Both refuse by handing back the real cursor plus a flag, never an error** — an error status
    gets re-sent forever (XERK-255); `archiveShed`/`archiveFull` on the heartbeat let an agent shed
    before the bytes reach the wire (an optimisation the hub never relies on).
  - **The store total is WALKED off the files, never summed from the index** (`totalArchiveBytes`) —
    the index is disposable and would drift. Counts every regular file in a raw directory whatever
    its extension (most raw-layer files aren't `.jsonl`). Deleting archives is the only way out of a
    full store, and it works because the walk sees the bytes gone.
    - **The walk is the BASELINE only**; `writtenSinceWalk` adds every byte appended since, so growth
      is exact (overshoot ≤ one chunk) and only DELETION is stale — `TOTAL_CACHE_MS` can be minutes.
    - **Deliberately excludes `index.db`** (~2.4x the archive's own size and growing unbounded across
      fill/wipe cycles, XERK-332) — a ceiling enforced by refusing INGEST can only bound what
      refusing can reclaim, and refusing can't shrink a database (nothing VACUUMs). Size the volume
      for the index too.
    - **A walk that THROWS is not a measurement of zero** — only ENOENT on `ARCHIVE_DIR` itself is
      (the store genuinely absent). Any other error (EMFILE, EACCES, EIO) keeps the last baseline AND
      stamps the cache so it isn't retried per call — treating a blip as zero hands out a fresh
      ceiling every time it recurs. An unreadable SUBDIRECTORY is skipped and costs only its subtree
      (an under-measure, erring the safe way); propagating that error instead freezes the baseline
      permanently.
    - Once full, re-measures on `FULL_RECHECK_MS` — precision matters most exactly then, since ingest
      is refusing anyway.
    - **Synchronous on the heartbeat path** (a hub-wide stall) — keep it that way; if the store ever
      reaches tens of thousands of files, walk only when near the ceiling rather than making it async.
    - **Do not "improve" this into an indexed column reconciled against disk** — a failed stat can't
      tell "deleted" from "unmounted/renamed/ESTALE", and guessing wrong either duplicates a
      re-pushed conversation or latches the ceiling shut forever. Both were built and reproduced.
  - **A deleted `.jsonl` whose index row survives leaves the cursor alone** and the next delta appends
    onto the gap — pre-existing, XERK-280.
- **`manifestCursors` is bounded too** (`ARCHIVE_MANIFEST_CURSOR_MAX`, 2000) — the costlier of the two
  (a SELECT + INSERT per entry); uncapped it also makes the raw cursor cap pointless (same caller
  sends manifest entries instead, for a much bigger stall).
- `rebuildIndex` derives `rawBytes`/`archiveBytes` from the files, never a sidecar, and **skips a raw
  directory whole** during its file walk (its contents carry no `.meta` and would be skipped as rows
  anyway, but only after being read into memory first).
- Tests: `archive.test.js`, `archive-budget.test.js`, `server.test.js`.

## Restoring an archived session onto another agent (XERK-441)

`POST /api/archive/<transcriptId>/restore {host}` resumes an ENDED session on a live host — the
reason the raw layer exists in a form nothing else reads (the rendered entries are a display copy;
`claude --resume` cannot read them).

- **The agent side is UNCHANGED, and must stay that way** — the hub writes the bundle
  `_pack_transcript` would have, queuing the same `importSession`, so a restore rides the exact code
  path that already moves a LIVE session.
- **The layout is the contract**: members are session-relative (`<id>.jsonl`, `<id>/subagents/…`,
  `<id>/workflows/…`) because the target unpacks straight into `PROJECTS_ROOT/<slug>/` — a restore is
  a copy, not a conversion.
- **A restore IS a migration record with no `srcHost`** — starts in `exporting` ("the hub is
  packing"), flips to `importing` when the spool file is written; every phase/timeout/refusal/
  follow-the-spawn path then works unchanged. `restore: true` on the wire is what a client words
  differently.
- **Packing is async, off the request** — a bundle is tens of MiB read off `/data`; the completion
  re-checks the phase before queueing (the record may be failed/swept mid-pack).
- **`turma/tar.js` streams; it must never buffer a bundle** (`mem_limit: 256m`). Plain ustar,
  deliberately NOT the GNU/PAX long-name extension — REPORTS what it can't name/read in full rather
  than truncating (which would misfile bytes) or silently shipping short.
- **`packGzipTar` creates the spool dir itself** — `MIGRATE_SPOOL_DIR` is otherwise made only on the
  migration-upload path, so a hub that has never relayed a live move fails EVERY restore with an
  ENOENT the operator sees as a corrupt archive. `restore.test.js` names a path that doesn't exist to
  keep this honest — don't let a test pre-create the directory.
- **Refusals are the product here**: no raw copy, no recorded worktree, a worktree not shaped like
  one, target offline, target lacking the repo, and the conversation already running somewhere (the
  transcript-id-preservation invariant — two live sessions on one transcript is two claudes appending
  to one file).
  - **Re-checked EVERY TICK, not just at admission** — the importing window (up to
    `MIGRATE_TIMEOUT_MS`) is long enough for the archived host to come back beating that conversation
    as running. The TARGET is skipped in this
    check (its own imported session is the success case).
  - **Only ONLINE hosts get a veto, at BOTH admission and the tick** — a dead host keeps
    `status:"running"` for `PRUNE_AFTER_MS` (7 days), so gating on it refuses restores naming a host
    the operator can't kill it on. Fixing only admission is worse than not fixing it (spends a slot
    and a pack, then dies a tick later).
  - The re-check skips **the migration's own session**, never the whole target host — a local resume
    on the target between admission and its next beat must not get archived bytes written over it.
- **The recorded worktree is checked against the ROW, never guessed from the path** — the hub doesn't
  know a target's REPOS_ROOT (hosts mount it differently). Accepts a `.turma/worktrees/<repo>/<dir>`
  tail (the only mount-independent shape), a ROOT session (`repo === "(root)"`), or a matching repo
  dir.
  - **`repo == "(root)"` does NOT mean "root session"** — it's also the agent's catch-all for any cwd
    it couldn't attribute to a repo, so most such rows are transcript stores, not resumable sessions,
    and are refused explicitly. Don't conflate admitted count with recoverable count.
  - **The page hides the control on a row the route would refuse** (`restorableRow`, mirroring the
    first two checks) — a picker that always 409s is worse than no picker.
  - A `..` component is pinned on its own (every other case in the shape matrix fails for a different
    reason).
- **An INCOMPLETE bundle is on the record, never only in the log** (`m.incomplete`, capped at
  `INCOMPLETE_NAMES_MAX` names since it rides `/api/agents`) — ustar's 100+155
  name limit is shorter than the archive's own 255-byte allowance, so a long basename can be
  nameable in the archive and not in the tar. **The conversation itself is never merely reported
  incomplete**: `<id>.jsonl` skipped or short FAILS the restore outright.
- **Not org-scoped, unlike a move** — `/migrate` compares two agents' orgs; an archived session has
  no agent left to compare against, and the archive is hub-wide and already gated by login. Don't
  invent an org for the archive row.
- Tests: `restore.test.js` (route + refusals + bundle bytes), `tar.test.js` (format, read back with
  python's `tarfile`), the Restore cases in `sessions.test.js`.
