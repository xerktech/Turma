---
paths:
  - "turma/server.js"
  - "agent/hub-agent.py"
  - "turma/public/sessions.html"
  - "agent/tests/test_hub_agent.py"
  - "turma/tests/server.test.js"
  - "turma/tests/sessions.test.js"
  - "android/app/src/main/java/com/xerktech/turma/core/Sessions.kt"
  - "android/app/src/main/java/com/xerktech/turma/ui/SessionsScreen.kt"
  - "android/app/src/test/java/com/xerktech/turma/core/SessionsTest.kt"
---

# Migrating a session, and reporting a refused start

Split out of `CLAUDE.md` to keep that file under its size ceiling. The blocks span
`turma/server.js` + `agent/hub-agent.py` + the Sessions page, and the migration's move-target parity
reaches android (`eligibleMoveTargets`/`SessionsTest`), so the scope lists every side — a
`paths:`-scoped file does not load on the other side of the contract it carries. The transcript-identity
contract migration preserves is in `.claude/rules/session-transcript.md`.

## Migrating a session to another agent (XERK-101)

- **Moves a running session to another agent in the SAME org — conversation AND worktree.** The
  source stays on disk (KILLED, so resumable) as the fallback.
- **The worktree's git state rides the bundle under `.worktree/`** (`_capture_worktree_state`, only
  for a `WORKTREES_ROOT/<repo>/<dir>` cwd): `state.json` {head, branch}, `commits.bundle` (HEAD
  `--not --remotes`, only when ahead), `changes.patch` (binary diff vs HEAD via a THROWAWAY
  `GIT_INDEX_FILE`: untracked files ride, ignored don't, the real index is untouched).
  - **What it cannot carry, it REFUSES — never ships the move without it**: Git LFS content (only
    pointers would arrive; judged by `git check-attr filter` on the changed paths, plus pointer text
    in the patch and `git log -G` over unpushed commits — never by patch text alone, which
    `diff.context`/`GIT_DIFF_OPTS` reshape), a nested repo / dirty submodule, untracked bytes over
    `MIGRATION_BLOB_MAX` (checked BEFORE `git add -A` writes them to `.git/objects`).
- **The patch is untrusted: any copy/rename header or gitlink is refused before anything is
  touched** (`_unsafe_patch_reason`). `git apply` reads a `copy from` path as-is, absolute included
  — an arbitrary-file read (QA-proven). Capture uses `--no-renames`, so a real patch never has one.
  `_read_worktree_members` bounds every member (gzip bomb); `_unpack_transcript` never extracts them.
- **Every bundle read goes through `_open_bundle`**, whose DECOMPRESSED stream stops at
  `MIGRATION_UNPACK_MAX` (`_BoundedGzip`): the beat's `_unpack_transcript` decompresses through every
  member, `.worktree/` ones included, at ~0.5 s/GiB, so the import thread refuses a bomb first.
  - Never bound it from tar headers' `size`: a sparse member's is its attacker-chosen original size.
  - `_BundleTarInfo` refuses from the header, before tarfile reads the body: every sparse member
    (GNU `S` and pax `GNU.sparse.*` — its extracted bytes come from the map, which no stream bound
    sees; a 131 B bundle wrote 3 GiB), any global pax header (`g`: tarfile copies it into every
    member), pax/long-name headers past `MIGRATION_EXT_HEADER_MAX` in TOTAL (each read whole into
    RAM), and over `MIGRATION_MEMBERS_MAX` (5000) REAL members — extended headers don't count
    (real bundles hold ≤ ~160; 120k empty dirs held the beat 23 s, 19999 still ~6 s). The import
    thread walks every header first, so the beat only meets them as a backstop.
    `_unpack_transcript` also counts bytes WRITTEN.
- **Import is STAGE / WORK / FINISH** (XERK-395): `import_session` (beat) validates and reserves a
  slot + shields the cwd from prune (`_imports_inflight`); an import thread downloads and runs
  `_restore_worktree_state`; `_apply_imports_landed` (full beats only) unpacks the transcript,
  records usage and `_resume_at_cwd(worktree_ready=True)`. Never put the git back on the beat —
  worktree add/remove/apply are disk-bound and blew the 75s budget.
  - **While an import is in flight its cwd is held** (`_import_holds`): `start`, `resume`,
    `_resume_at_cwd`, a second import and a sleeper job refuse that path, and `delete` drops the
    record but KEEPS the tree (also when another record shares the path) — the thread may be
    removing an old copy there (QA: a resume launched into a worktree the thread then deleted).
  - A dir at the cwd with no `.git` of its own is kept aside UNTOUCHED: git there walks up to an
    enclosing repo (a REPOS_ROOT that is a repo) and detached it (QA).
  - Branch: checked out only when absent here (created) or behind (fast-forwarded), else DETACHED.
    Any failure undoes what restore did (worktree, created branch, older copy moved aside).
  - A move BACK finds the old copy at the same path. Export writes the state's digest into the
    source's gitdir (`MIGRATION_EXPORT_MARK`); an old copy still matching it (or clean at an ancestor)
    is removed, anything else detached and renamed to `<cwd>.pre-migration-<ts>`, never deleted.
  - Ignored files never ride the bundle and neither the digest nor `status` sees them, so the old
    copy holds the ONLY one: it is kept aside unless every `--ignored=matching` entry is itself an
    ignored `MIGRATION_REGENERABLE_DIRS` dir (`!! a/node_modules/`) or a `.pyc`/`.pyo` directly in
    `__pycache__/` (`_holds_unregenerable_ignored`; git failing reads "keep").
    - Never by an ancestor's name (`!! dist/prod.key` with dist/ not ignored was deleted, QA), never
      by mtime (pre-export files, mtime-preserving edits), never a walk. Keep the allowlist narrow.
    - Accepted gap: what sits INSIDE an ignored regenerable dir (`dist/.env.production` under an
      ignored `dist/`) is one collapsed entry, so it goes with the copy.
  - A bundle without `.worktree/` (older source, hub restore-pack) forks fresh from the default.
    Residual: an OLDER target extracts `.worktree/` into its slug dir and drops the work (source
    keeps it). Tests: `TestMigrateWorktreeState` (real git, two clones).
- The hub can't touch a worktree and agents are outbound-only, so a migration is composed hub-side
  from agent commands + a hub-brokered relay of the **RAW transcript bytes** (what `claude --resume`
  needs and the archive lacks): `exportSession` packs the transcript (+ `subagents/`, truncated to its
  last complete line) and POSTs the gzip-tar to `POST /api/agents/<host>/migrations/<id>/blob`,
  queueing `importSession` on the target (recording `importCmdId`); the target reporting up
  (`spawnCmdId` == `importCmdId`) makes `advanceMigrations` KILL the source and finish.
- **Hosts may mount `REPOS_ROOT` at DIFFERENT paths**, so `import_session` first
  `_localize_migrated_cwd`s the source's worktree path onto THIS host's `REPOS_ROOT` (the
  `.turma/worktrees/<repo>/<dir>` tail is mount-independent). Without the remap a cross-mount move
  wedges in `importing` forever.
- The tar extract guards against `..`/absolute members — untrusted, it crosses a host boundary.
- **A migrated session keeps its PR chips**, re-derived from the transcript rather than carried in the
  command: the per-beat scan PRIMES a resumed transcript's byte offset to EOF, so `gh pr create`
  events sit past it. `_resume_at_cwd` calls `_seed_prs` once at launch to scan the whole transcript,
  keyed by the PRESERVED transcript id. Idempotent.
- **A moved session's record carries `migratedFrom` {host, sessionId, at[, fromArchive]} on the
  wire** (XERK-2109): stamped by the hub's `importSession` / archive restore, kept on the agent's
  record, sent by `_session_payload`, rebuilt by the hub's `coerceMigratedFrom` (whitelisted leaves).
  - It is the ONLY proof a new (host, id) is the old conversation — the glasses move a stashed
    draft by it. Android does not type it; typing it there needs no new coercion.
  - An archive restore's `sessionId` is null: it names no live session, so nothing follows it.
  - Tests: `test_migrated_from_rides_the_payload_and_is_none_without_one`, server.test.js
    "XERK-2109: a session's migratedFrom ...".
- Blob relay is agent-authed; `POST .../sessions/<id>/migrate {host}` validates same-org + online +
  repo-cloned + running/non-root/has-conversation, single-flight per session. State is in-memory; a
  hub restart mid-move aborts it, leaving the source intact. **The target must already have the repo
  cloned** (v1).
- **The bundle NEVER rides in the hub's heap** (XERK-263): the relay spools it to `MIGRATE_SPOOL_DIR`
  (`/data/migrations`) and streams it out; the record keeps only path/size. Every settle, timeout and
  failure unlinks it, and boot sweeps the dir. `MIGRATE_INFLIGHT_MAX` bounds that burst — refused
  where a move STARTS, since the agent's upload is best-effort with no retry.
- Tests: `TestMigrateSession`, `server.test.js`, the Move cases in `sessions.test.js`,
  `eligibleMoveTargets` in android `SessionsTest`.

## Sharing the record + spool across HA replicas (XERK-761, epic XERK-751)

Migration assumed ONE hub. Under HA the hub is N replicas and a single move's source-upload,
target-pull and `advanceMigrations` can land on DIFFERENT replicas across a RollingUpdate leader
failover. Read `.claude/rules/turma-ha-store.md` for the `LiveStore` seam this plugs into.

- **The in-memory `migrations` Map stays the LEADER's working copy.** *(As of XERK-761 this rode the
  Option-2 assumption that only the leader served traffic; XERK-778 then made the request path
  resolvable on any replica via a hot cross-replica mirror, and XERK-782 flipped `/readyz` to
  active-active and closed the mutation flow — see those two sections below. `advanceMigrations` stays
  leader-only regardless.)* The leader runs `advanceMigrations`, so its SYNCHRONOUS reads across the
  request path and the beat are left as-is — NOT rewritten to async. The store is the
  cross-replica-durable MIRROR + hydration source on top of the Map, not a replacement for it.
- **In HA every record is mirrored to the shared `LiveStore` keyed `migration/<id>`** with a TTL past
  the whole in-flight window (`MIGRATE_RECORD_TTL_MS` = `MIGRATE_TIMEOUT_MS` + 2m), refreshed on every
  mutation via `publishMigrations` (the one funnel every mutation hits — so no site is missed) and
  DELETED by `retireMigration` on every eviction/retire. `uploading`/`refusal` are LEADER-LOCAL and
  reset in the mirrored copy, so a promoted leader neither blocks a fresh upload nor inherits a
  half-applied refusal.
- **`hydrateMigrations()` rebuilds the Map from the store** — the seam the (not-yet-landed) `leader`
  child calls ON PROMOTION, also run at boot. Never overwrites a record this leader already holds.
- **The spool stays a PER-POD `emptyDir`; the bytes are RELAYED cross-replica, never shared on disk**
  (XERK-785, superseding the XERK-761 "SHARED volume / `MIGRATE_SPOOL_DIR` must be RWX" note). The
  upload spools locally on whichever replica the source's POST landed on and records `blobReplica`
  (that replica's `SSE_REPLICA_ID`) on the record; the RECORD is already hot-mirrored cross-replica
  (XERK-778), so a pull that lands elsewhere reads `blobReplica` and relay-fetches the bundle from the
  owning replica over the SAME byte-plane transport `/term`/`/live` use (`relay.js`, XERK-777/781) —
  the store stays byte-free (the byte-plane vs record-plane split the epic established). So **no RWX
  mount is needed**, and the prod manifest's `emptyDir` is correct. See the XERK-785 section below.
- **The boot sweep is record-aware under HA** (`sweepMigrationSpoolShared`): it KEEPS any bundle whose
  record still exists in the store, and of the rest deletes only orphans older than
  `MIGRATE_SPOOL_ORPHAN_MS` (10m) — so a bundle another replica is mid-writing, whose record has not
  yet mirrored, is never mistaken for garbage. The single-process `sweepMigrationSpool` (delete-all)
  runs at module load ONLY when HA is off (`MIGRATE_HA_ON`, resolved once); the HA path defers to the
  shared sweep run once the store is wired.
- **`advanceMigrations` composes with the leader gate unchanged** — the gate is the leader child's;
  this ticket only makes the record/spool resolvable so a newly-promoted leader can advance a move the
  old leader started. **The 503-holds-in-`exporting` + `_migration_upload` retry and the
  refused-start-is-reported contracts are untouched** — they operate on the leader's Map record, and
  mirroring/hydration are additive.
- **HA OFF is byte-identical**: `migrationStoreShared` is false, so mirror/hydrate/shared-sweep are
  all no-ops and the single-process path is exactly as before.
- Tests: the `XERK-761:` cases in `server.test.js` (mirror-then-forget, hydrate on promotion, the
  record-aware sweep keeping live/fresh bundles and deleting only a stale orphan).

## Serving the request path from the shared record on any replica (XERK-778, epic XERK-775)

XERK-761 mirrored the record + hydrated the Map ON PROMOTION, but between promotions a NON-leader's
`migrations` Map was a stale boot snapshot — so under active-active (Option 3, XERK-775) a migration
status read (`migrationList` on `/api/agents`), an attachment/import blob request, or a refusal
ingest that the LB landed on a non-owning replica saw NO record. This makes the request path
resolvable on any replica, while migration ADVANCE stays a leader-only sweep (XERK-763, unchanged).

- **A standing WATCH keeps `migrations` a HOT cross-replica mirror on EVERY replica**
  (`watchMigrations`, the MAP-channel pattern the registry — XERK-756 — and tunnel directory —
  XERK-764 — use). So the SYNCHRONOUS request-path reads (`migrationList`, the blob `GET`/`POST`,
  `ingestSpawnFailures`) resolve on any replica with NO async hop and NO change to those call sites —
  the Map they already read is simply kept fresh. Installed at boot BEFORE `hydrateMigrations` (so no
  change is missed during the scan) and left standing regardless of leadership.
- **The LEADER is the SOLE WRITER; only NON-leaders APPLY the watch** — the split that makes this
  correct without an echo-dedup. `publishMigrations`'s mirror loop is gated on `isLeader()` (a
  non-leader learns records via the watch and must never re-mirror one, or a stale copy still in its
  Map when the leader retires a move would RESURRECT the record), and `applyRemoteMigration`/
  `applyRemoteMigrationRemoval` early-return on `isLeader()` (the leader's Map is its authoritative
  working set; it never learns a record from the store). So no replica ever both writes AND applies —
  a self-echo (even one racing the pub/sub round trip and thus not byte-equal to what we wrote) is
  never applied over the leader's live `uploading`/`refusal`, and no `lastStoreWritten`-style memo is
  needed. `isLeader()` is trivially true with no elector, so HA-off is byte-identical.
- **The apply is otherwise like `applyRemoteAgent`**: it updates the Map and drops the agents cache
  (migrations ride `/api/agents`), but never `sseBroadcast`s — the owning replica's
  `publishMigrations` already published the `migrations` frame to the XERK-762 bus, which every
  replica re-emits to its own clients. Leader-local transients are reset in the applied copy, as on
  hydrate. On promotion `hydrateMigrations` re-syncs the new leader's Map before it starts writing.
- **Scope boundary (XERK-778):** this only makes the record RESOLVABLE. A follower does NOT advance a
  move (`migrationAdvanceTick` is leader-gated). At the time of XERK-778, request-path MUTATIONS were
  not mirrored to the leader — mutations flowed to it under the Option-2 topology where `/readyz`
  routed all traffic to the leader — and closing that was named as the remaining Option-2→Option-3
  requirement.
- **The mutation flow is now CLOSED (XERK-782), and `/readyz` is active-active.** A migration START /
  blob-upload / restore-pack landing on a NON-leader write-throughs (a follower mirrors ONLY records
  it itself mutated — `publishMigrations(id)` / `migrationsDirty` — never its whole Map, or it
  resurrects a settled move), and the LEADER FORWARD-LEARNS them (`applyRemoteMigration`: adopt-if-
  absent, forward-merge phase + progress fields, never regress, never touch leader-local
  `uploading`/`refusal`, `migrationsRetired` anti-resurrection). The inline heartbeat-handler
  `advanceMigrations()` is now `isLeader()`-gated too (a host beats to any replica once all are Ready).
  So the sole advancer finishes a move started on any replica. Residual (LOW): a follower-ingested
  `refusal` still doesn't travel (mirror strips it), so that case TIMES OUT rather than fast-failing —
  source intact, no loss. Full rationale + the `/readyz` gate lift: `.claude/rules/turma-ha-leader.md`.
- **Accepted residual (LOW, Valkey-only):** a leader crashing mid-move can leave a store key that
  TTL-EXPIRES, and Valkey fires no watch event on a PX expiry (like XERK-764's tunnel directory), so
  the record lingers in a non-promoted follower's Map. It is harmless — a follower serves no traffic
  under Option 2, the Map is bounded (`MIGRATIONS_MAX`), and it self-heals on promotion (the new
  leader's `advanceMigrations` times the record out and `del`s it). No sweep is added for it (unlike
  the tunnel directory, whose entries a live path reads); documented, not fixed.
- Tests: the `XERK-778:` cases in `server.test.js` (a follower serving a status read + attachment
  fetch off the hot mirror; a follower never re-mirroring — no resurrection; the leader's own echo
  not clobbering its live leader-local flags).

## Relaying the bundle BYTES cross-replica (XERK-785, epic XERK-775)

XERK-778/782 made the migration RECORD resolvable on any replica, but the bundle BYTES were not: the
spool is a per-pod `emptyDir`, so under active-active a target's blob pull that lands on a replica
which never received the source's upload read an empty spool and 404'd — the move wedged in
`importing` until `MIGRATE_TIMEOUT_MS` (SAFE: the source is left intact/resumable, no data loss). The
fix RELAYS the bytes like every other data-plane byte (the chosen option; the rejected alternative
was an RWX spool PVC — a Longhorn share-manager pod, a new failure point for a rare feature).

- **The upload records WHICH replica spooled the bytes.** `POST .../migrations/<id>/blob` spools
  locally on whichever replica the LB routed the source's POST to, then stamps
  `m.blobReplica = SSE_REPLICA_ID`. It rides the record's OWN cross-replica mirror — `mirrorMigration`
  copies the whole record, followers apply it whole (XERK-778), and the leader FORWARD-LEARNS it
  (added to `applyRemoteMigration`'s merge whitelist beside `blobPath`/`blobSize`). `dropMigrationBlob`
  clears it with the path/size. It is INTERNAL — `serializeMigration` omits it, so it never rides the
  wire to clients.
- **The pull relay-fetches from the owner when it lands elsewhere.** `GET .../migrations/<id>/blob`,
  when `blobReplica` is set and is NOT this replica (and HA is on), calls `relay.connectMigration(
  blobReplica, id)` — a REPLICA-ADDRESSED channel (`kind:"migration"`, XERK-785), distinct from the
  host-tunnel-owner-addressed `/term`/`/live` channels: the migration blob's owner is "whichever
  replica the POST landed on", unrelated to any host's tunnel. The owner replica (`accept`, via the
  `openBlob` dep = `openMigrationBlobForRelay`) streams the spool file back, prefixed by a
  `{t:"blob",size}` CTRL frame; the origin writes the 200 + `Content-Length` on that frame and pipes
  the bytes to the agent. Same pod-to-pod TCP transport, auth token, framing and backpressure as
  XERK-777/781 — **the store carries no bundle byte** (the byte-plane vs record-plane split).
- **Failure is SAFE and self-healing.** A `no-bundle` hint (owner dropped it since the record was
  read), a dial failure (unreachable/unresolved-endpoint replica), or `connectMigration` returning
  null (owner is us, or — for a record predating `blobReplica` — no owner recorded) all fall to a 404
  / the local read; the move times out with the source intact, exactly the pre-fix SAFE failure, and
  a fresh attempt succeeds once the transient clears.
- **HA OFF / single-process is byte-identical**: `relay` is null and `migrationStoreShared` false, so
  the GET's relay branch is never entered and the local spool read is exactly as before; `blobReplica`
  is set but unused.
- Tests: the `XERK-785:` cases in `tunnel-relay.test.js` (the `connectMigration` bundle bridge
  end-to-end, `no-bundle`/`relay-error`/`unauthorized` hints, self→null, dial-failure reject) and in
  `server.test.js` (`openMigrationBlobForRelay` serving/absent + clearing on drop; the leader
  forward-learning `blobReplica`). The HTTP-route wiring end-to-end is QA'd on a live active-active
  fleet.

## Relaying MESSAGE ATTACHMENT bytes cross-replica (XERK-787, epic XERK-775)

The XERK-785 sibling for operator attachments (XERK-234): a file attached to a session message is
staged by `POST /api/agents/<host>/uploads`, which holds the BYTES in memory in the per-replica
`uploads` Map — NOT on the hot-mirrored migration record, and never spooled. Under active-active the
agent's later blob pull (`GET .../uploads/<id>/blob`) can land on a replica whose Map never received
the bytes → it 404'd "no such upload" and the attachment silently dropped (SAFE — no data loss, the
send just fails/retries; only bites cross-replica). Fixed the same way: relay the bytes.

- **A BYTE-FREE directory names the owner.** On stage, `publishUploadDir` writes `upload/<id> →
  {replica: SSE_REPLICA_ID, host, sessionId, name, size, at}` to the shared store with a TTL matching
  `UPLOAD_TTL_MS` (so it expires WITH the in-memory bytes). `sessionId`+`name` are for the input-consume
  sibling below — the blob GET reads only `replica`/`host`/`size`. Unlike migrations (whose record is
  already hot-mirrored),
  uploads had NO cross-replica channel, so this is a small dedicated directory — but it needs no hot
  MIRROR/watch: the GET reads it with a single lazy `await uploadStore.get()` only on a LOCAL MISS
  (the cross-replica path), never on the hot local-hit path.
- **The pull relay-fetches on a local miss.** The GET serves a local hit as before (a wrong-host
  local hit stays a scoping 404, never relays); on a miss it reads the directory and, if
  `dir.host === host` (XERK-268 scoping preserved cross-replica) and `dir.replica` is another replica,
  calls `relay.connectUpload(dir.replica, id)` — the `kind:"upload"` twin of the migration channel
  (shared `connectBlobKind` transport, `openUpload` owner bridge reading the `uploads` Map). Same
  `{t:"blob",size}` ack → 200 + Content-Length → pipe; `no-bundle`/dial-failure/null → 404. **The
  store carries no attachment byte.**
- **Attachment bytes are CHUNKED for the relay** (`bufferReadable`, 1 MiB slices): the bytes are an
  in-memory Buffer, and a single `Readable.from([buf])` would frame the WHOLE attachment as ONE frame,
  which the peer deframer refuses (goes dead) once it exceeds the relay's 16 MiB ceiling. The migration
  path never hit this (it streams off disk in 64 KiB chunks).
- **HA OFF / single-process is byte-identical** — `uploadStoreShared` false, `relay` null, so
  `publishUploadDir` is inert and the GET's relay branch is never entered; the local-hit `res.end(u.bytes)`
  is exactly as before.
- **The OPERATOR's input-consume is the sibling gap XERK-787 left open (XERK-874).** XERK-787 relayed
  the AGENT's blob PULL cross-replica but `POST .../sessions/<id>/input`'s uploadId validation still did
  a bare LOCAL `uploads.get(id)`, so under active-active a staging POST and its input POST landing on
  different replicas 404'd "an attachment expired before it was sent" on a file just attached (the
  Android/web symptom — OkHttp readily splits the small input POST onto a fresh connection after the
  large upload POST). The input route now falls to the SAME directory on a LOCAL MISS
  (`uploadStoreShared` only): it needs only `name`+`size` to build the command (hence those fields on
  the entry), validates `dir.host`/`dir.sessionId` for the same scoping the local hit enforces, and the
  agent still fetches the bytes via the relayed blob GET. It does NOT relay bytes itself. HA off is
  byte-identical (fallback never entered → plain 404). Tests: the `XERK-874:` cases in `server.test.js`.
- Tests: the `XERK-787:` cases in `tunnel-relay.test.js` (`connectUpload` bridge end-to-end,
  `no-bundle`/`relay-error`, and that an upload channel uses `openUpload` not the migration `openBlob`)
  and `server.test.js` (`openUploadBlobForRelay` chunked byte-identical stream under the frame ceiling;
  `publishUploadDir` byte-free + inert with HA off). The HTTP-route wiring end-to-end is QA'd on a live
  fleet.

## A refused session start is REPORTED, never just logged (XERK-265)

- **A command is ACKed whether the agent ran it or declined it**, so a refusal the agent only `log()`s
  is indistinguishable from a slow spawn — the move sits in `importing` until `MIGRATE_TIMEOUT_MS`
  with no reason.
- Every refusal in `_resume_at_cwd`, `import_session` and `export_session` goes through
  **`_refuse_start`**, staging `{cmdId, migrationId, error}` onto the beat's **`spawnFailures`**. The
  `error` is operator-facing — it is what the UI and the migration record show.
- Hub-side `ingestSpawnFailures` caches it per cmdId as **`spawnRefusals`** (served with the record,
  NOT stripped like the other caches) and stamps `m.refusal`, which `advanceMigrations` applies
  **after** its handoff check, so a success always wins the tie. Absent = "that agent can't tell",
  i.e. the old timeout wait. The Sessions page mirrors that order: the session lookup runs first and
  clears `pendingSpawn`.
- **Both handles are checked against what the HUB knows, never taken on the agent's word** — the
  migrationId against that move's own src/target, the cmdId against the queue that host was given.
  All agents share one token, so unchecked either one lets any host fail another host's move.
- **The reason is length-capped at both ends** (`SPAWN_FAILURE_REASON_MAX`, `SPAWN_FAILURE_ERROR_MAX`).
  It interpolates exception text, and `spawnRefusals` is counted by `agentRecordSize` while the
  ceiling check runs BEFORE the ingest: one unbounded reason lands, pushes the record past
  `AGENT_RECORD_MAX`, then 413s every later beat from that host — including the sweeps.
- A refusal with neither handle stays a log line: the id being rejected IS the correlation.
- **Every refusal on a session-creating path must go through it**, including `resume()`'s — the prune
  handshake (`_claim_worktree`, XERK-256) is ordinary timing, not operator error.
