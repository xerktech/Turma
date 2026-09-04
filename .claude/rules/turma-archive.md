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
  - **The per-beat cursor loop is bounded by the HUB**, charged for EVERY offer BEFORE validation —
    charging only survivors lets a caller walk around the cap with ids the allowlist would reject.
    **The budget bounds the WORK, and every offer costs work** — both the per-FILE stat AND the
    per-manifest-ENTRY row lookup (the lookup is real work; charging only files just moved the stall,
    QA F4). So it has TWO terms: `ARCHIVE_RAW_CURSOR_MAX` (2000, mirrors the agent's
    `ARCHIVE_RAW_MANIFEST_FILES_MAX` files) + `ARCHIVE_RAW_CURSOR_LOOKUP_MAX` (200, mirrors its
    `ARCHIVE_MANIFEST_MAX` entries). **The budget is their SUM** so an in-cap agent is never
    truncated (XERK-427: charging the N lookups against the file cap alone truncated a well-behaved
    agent by exactly its transcript count N — silently dropping the backlog slice XERK-424 reserves).
    The agent's own caps are NOT this bound — a bound the receiving path doesn't enforce is not a
    bound (XERK-235). Past the SUM a file gets no cursor and the agent re-pushes from 0 (safe, just
    wasteful — logged, throttled).
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
    calling, not whose session they may write into. The raw layer requires `row.host === host`
    EXACTLY, which works because `ingestChunk` re-points the row on a migration FIRST (below).
  - **A host RE-POINT in `ingestChunk` is gated on the owner's DECIDED ORG** (XERK-344, moved to the
    decided org by XERK-573) — else any host with its own token could append arbitrary entries to
    another host's archived transcript AND re-attribute the row to itself (`host=excluded.host`),
    served back through `GET /api/archive` as that host's history. A same-host append never re-points,
    so it is never gated. A host CHANGE is a migration (XERK-101, same-org), allowed exactly when the
    pushing host and the current owner share a **NON-EMPTY decided org** — the SAME rule
    `POST .../migrate` uses (`sameDecidedOrg`, XERK-349). The route passes `decidedOrgOf(agents[key])`
    (and `manifestCursors` the beat's decided org); the archive stores/compares/re-stamps/rebuilds all
    on that basis, kept internally consistent end to end.
    - **XERK-573 closed the org-less residual the CLAIMED-org compare left**: two hosts that both read
      "" — a genuinely org-less pair, OR a bound host momentarily omitting its `jira` block so
      `siteKeyOf` coerced to "" — used to satisfy the gate for each other. Keyed on the decided org, a
      bound-but-quiet host reads its bound org (not ""), and a genuinely org-less re-point is refused
      (no shared non-empty org), exactly as an org-less migration is. **Cost, deliberate and mirroring
      the migrate route: a no-Jira fleet's cross-host archive re-points are all refused** — which is
      why the RESTORE path re-points the HOST (below), the one legitimate org-less cross-host case.
    - The owner's decided org is STORED on the row (schema v5, hub-supplied — never agent-`meta`), so
      the check survives the owner going offline. **Do not re-key this on the CLAIMED `siteKeyOf`** —
      that reopens the org-less hole (the same objection XERK-349 makes to the migrate route).
    - **Accepted LOW residual on an ORG-LESS fleet** (QA): a rogue org-less host that knows a victim's
      uuid4 `transcriptId` can list it in its heartbeat manifest, creating the 0-byte placeholder row
      as its own — after which the real org-less owner's first push is refused as a cross-host
      re-point (both read "", so no shared non-empty org). Availability-only: `manifestCursors` only
      INSERTs, so the rogue injects NOTHING and reads nothing; it just squats the id, and the owner
      re-pushes from 0 while the read-back 404s "still syncing". It needs the unguessable id (never
      exposed cross-host) and only bites a no-Jira fleet — and it makes the org-less case behave like
      every other org, where a cross-org squat was already denied. No signal distinguishes owner
      reclaim from rogue squat (both org-less), so there is no cheap fix; documented, not closed.
    - **`manifestCursors` stamps the org on the placeholder row it creates**, or a cross-org first
      chunk would hijack a not-yet-filled transcript via the legacy escape below.
    - **A row whose `siteKey` is NULL (rebuilt from a pre-XERK-344 sidecar, which has no field) admits
      the first writer once and stamps it** — trust-on-first-sight, since it cannot be proven
      cross-org. `rebuildIndex` uses `meta.siteKey ?? null` so a recorded `""` (a real no-org owner,
      still gated) is kept distinct from a legacy NULL.
    - **A cross-org RESTORE (XERK-441) re-points the row to the target** (`restampOrg(tid, decidedOrg,
      host)`, called by `startArchiveRestore`) — a restore is deliberately not org-scoped, and the
      resumed session keeps the same transcript id, so without the re-point its later archival is
      exactly the cross-host re-point this gate refuses, silently dropping the restored session's new
      turns. **It re-points the HOST as well as the decided org** (XERK-573): the strict gate needs a
      shared non-empty org for a cross-host re-point, which an ORG-LESS target has not — so re-pointing
      the host makes the target's first push a same-host append the gate never touches, the only way an
      org-less restore continues. The sidecar is updated (host + org) so a rebuild preserves both. This
      also removes the old rendered-before-raw ordering dependency: the row is already the target's, so
      its raw push (`row.host === host`) passes whatever the push order.
    - Refused like an offset mismatch: store nothing, return the real cursor — never an error status
      (XERK-255). Tests: the `XERK-344:` cases in `archive.test.js` + `restore.test.js`.
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
- **A transcript that rendered ZERO entries reads back 200-with-`entries:[]`, never 404** (XERK-422)
  — a conversation of only non-renderable records (mode/permission-mode/system/last-prompt, no
  user/assistant turn) projects to nothing, so `ingestChunk` advances the cursor to size but appends
  no line and the `.jsonl` is never created, while the row (with a `filePath`) IS upserted. So it
  lists but `getTranscript` used to 404 forever. `getTranscript` now returns null ONLY for an absent
  row or a NULL-`filePath` placeholder (a manifest row still awaiting its owner's first chunk — "still
  syncing" is the honest 404); a filePath'd row whose file is ENOENT reads back empty. Distinguishes
  "recorded no conversation" from "never heard of", and keeps the RAW layer (which may hold real
  material) reachable. Any OTHER read error stays null — a transient EIO must not read as empty.
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
    - **Deliberately excludes `index.db`** (~2.4x the archive's own size) — a ceiling enforced by
      refusing INGEST can only bound what refusing can reclaim, and refusing can't shrink a database.
      Size the volume for that ~3x-first-fill overhead too.
    - **`maybeReclaimIndex` reaps the index across fill/wipe cycles** (XERK-332) — nothing reaps a
      `sessions`/`entries_fts` row when a `.jsonl` is DELETED and openDb rebuilds only on a schema
      bump or an empty table, so a repeatedly-wiped store grew the index without bound (61x the
      ceiling after 38 cycles, a restart not helping). Off the SAME store walk (near-free — it already
      enumerated every file), when the walk finds FAR fewer files than the index has FILED
      (`filePath IS NOT NULL`) rows it runs `rebuildIndex()` + `VACUUM`. Guards, each load-bearing:
      excluding NULL-`filePath` placeholder rows keeps an initial bulk sync from reading as a wipe; a
      `partial` walk (any unreadable dir, or the root gone) NEVER reclaims (an under-count would drop
      live rows and, since ingest appends, duplicate on re-push — XERK-280); "far fewer" bounds the
      reindex cost (it re-reads only surviving files, ~0 after a wipe) and the absolute floor
      (`ARCHIVE_INDEX_RECLAIM_MIN_GAP`, 64) leaves a tiny store's noise alone. Accepted residual (the
      same ENOENT ambiguity the walk lives with): a lazy unmount leaving ARCHIVE_DIR present-but-empty
      reads as a wipe — safe unless a deployment makes ARCHIVE_DIR the exact mountpoint AND puts
      ARCHIVE_DB on a separate surviving filesystem (the default co-locates them). Tests:
      `archive-reclaim.test.js`.
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
  - **A deleted/truncated `.jsonl` under a surviving row is HEALED ON READ, never on write** (XERK-280).
    `getTranscript` and `listArchive` compare the row's cached `msgCount`/`archiveBytes` (and the
    `entries_fts` rows) against the file and re-derive them from it when they disagree — so the index
    stops lying after an operator hand-deletes a `.jsonl`. The write path is UNTOUCHED on purpose: a
    failed stat can't tell a deletion from a mount blip/ESTALE, and guessing there duplicates or bricks
    (the two XERK-267 attempts). A read heals only on POSITIVE PROOF — a file it read IN FULL (its
    successful-read count equals `archiveBytes`; `listArchive` stats first and reads only a proven
    mismatch), never on an ENOENT/EIO absence, so a transient unmount mutates nothing.
    - **`bytesStored` (the agent cursor) is LEFT ALONE** — the deleted prefix is gone and not re-fetched
      (the accepted consequence: a truncated view of one ended session, matching disk). The heal only
      makes the count/search honest and repairs `archiveBytes`'s relationship to the file going forward.
    - **Residual, deliberate:** a file fully deleted and NEVER re-pushed stays ENOENT — indistinguishable
      from a blip — so its browse `msgCount` is left stale (its transcript view still reads honestly
      empty, XERK-422). Only a file we can positively read (recreated/truncated) is healed. Tests: the
      `XERK-280:` cases in `archive.test.js`.
- **`manifestCursors` is bounded too** (`ARCHIVE_MANIFEST_CURSOR_MAX`, 2000) — the costlier of the two
  (a SELECT + INSERT per entry); uncapped it also makes the raw cursor cap pointless (same caller
  sends manifest entries instead, for a much bigger stall).
- **The hub CHOOSES what to offer (XERK-431), the inverted path.** A NEW agent ships a cheap INVENTORY
  `archiveInventory: [{i, s, r}]` (id, current rendered size, current raw total) instead of guessing a
  manifest; `inventoryCursors` names back EVERY short entry in the window (`bytesStored < s` OR
  `rawBytes < r`) as the SAME `archiveHave` map. So the agent's delta push is unchanged — only the
  SELECTION moved server-side, deleting the agent's whole in-RAM offer-rotation. Why + rollover:
  `docs/archive-offer-inversion-adr.md`.
  - **NO smaller want-cap** — the window is already bounded by the agent (`ARCHIVE_INVENTORY_MAX`) and,
    against a hostile oversize, by `ARCHIVE_MANIFEST_CURSOR_MAX`; the push is byte-bounded regardless.
    A prefix-cap under the window size would take the SAME prefix every beat and STARVE the tail — the
    XERK-424 cliff one layer up.
  - **No schema change:** `s`/`r` are compared against the `bytesStored`/`rawBytes` already stored and
    NEVER persisted. Completeness over the universe is carried by the agent ROTATING its bounded
    inventory window; the hub's durable cursors re-identify a short transcript in every window.
  - **Same INSERT-only + decided-org discipline as `manifestCursors`**: a placeholder row is created
    for a wanted NEW id (so the ingestChunk gate XERK-344/573 and the raw-owner check XERK-338 hold),
    and an id another host owns is IGNORED — never re-pointed, never wanted for the caller (squat
    protection). Capped by `ARCHIVE_MANIFEST_CURSOR_MAX` like `manifestCursors`.
  - **Raw cursors come from OUR OWN store** (`rawCursorsForIds` -> `listRawFiles`), since the inventory
    carried no per-file list, only the total `r`. Bounded by the wanted (short) set, itself bounded by
    the agent's inventory window.
  - **`archiveOffer:"hub"` rides EVERY reply** (both branches, even with no `archiveHave`) so a fresh
    agent learns to send an inventory before its first archive beat. `manifestCursors`/`rawCursors`
    are kept for an older agent; the two paths are mutually exclusive per beat. Tests: the `XERK-431`
    cases in `archive.test.js`/`server.test.js`.
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
  - **But it DOES re-point the row (host + decided org) to the target** (`restampOrg`) so the resumed
    session can archive back across orgs — see the XERK-344/573 ownership gate above. This is a
    re-point for a later write, not an admission gate: restore itself stays org-agnostic, and
    re-pointing the host is what keeps an org-less restore's turns reachable under the strict gate.
- **A cross-org restore is ALLOWED BY DESIGN, warned but never refused (XERK-453).** The decision
  raised by XERK-441's QA (finding D5): a restore writes org A's conversation bytes onto org B's host
  filesystem, where a different Claude login can read them — crossing the "one Claude login per org"
  soft boundary (XERK-348). It is left open, deliberately, not by omission:
  - **Refusing it fails closed for exactly the population the feature serves** — a host whose org
    binding was reset by `DELETE /api/agents/<host>` is the archetypal restore target, and a hard
    org gate would refuse it. It would also contradict XERK-573, which re-points a restore's row
    specifically to keep an org-less restore's turns reachable.
  - **The operator login is already hub-wide** — the archive is readable by whoever is logged in, so
    the restore crosses no new READ boundary; what it adds is a WRITE of those bytes onto the other
    org's disk. That is the operator's call to make, so the picker WARNS (a `⚠ <org>` badge on a
    cross-org target, a `confirm()` before the POST) and never blocks.
  - **The warning compares the SERVED `org` (decidedOrgOf) on both sides**, never the client-stripped
    `orgBound` (the trap this ticket flags, and the reason the two XERK-348/349 client mirrors were
    reverted): the target's org is the served `org`, the origin's is the archive row's stored
    `siteKey` (schema v5, hub-decided at archive time), now surfaced on `getTranscript`. A legacy/
    org-less row (`siteKey` "") or an org-less target reads "no org to compare" and never warns.
  - Web-only, like the restore control itself (`android/PARITY.md`'s P1 restore gap). Tests: the
    XERK-453 cross-org cases in `restore.test.js` (served `siteKey`) and `sessions.test.js`
    (`restoreCrossOrg` + the picker badge).
- Tests: `restore.test.js` (route + refusals + bundle bytes), `tar.test.js` (format, read back with
  python's `tarfile`), the Restore cases in `sessions.test.js`.
