---
paths:
  - "turma/archive.js"
  - "turma/tar.js"
  - "turma/tests/restore.test.js"
  - "turma/tests/tar.test.js"
---

# Restoring an archived session onto another agent (XERK-441)

Split out of `turma-archive.md` (size ceiling).

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
