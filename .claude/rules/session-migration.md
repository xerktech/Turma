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

- **Moves a running session to another agent in the SAME org.** The conversation moves; committed
  work rides git; uncommitted work stays on the source (KILLED, so resumable).
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
- **The spool sits on the SHARED volume** under its deterministic per-id name (`migrationSpoolPath`),
  so upload and pull resolve the same bytes on any replica. Deployment: `MIGRATE_SPOOL_DIR` must be an
  RWX mount in HA (the ArgoCD concern).
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
