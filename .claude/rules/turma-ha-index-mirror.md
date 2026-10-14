---
paths:
  - turma/server.js
  - turma/archive.js
  - turma/tests/index-mirror-refill.test.js
  - turma/tests/index-mirror-order.test.js
  - turma/index-store.js
---

# The archive index mirror's refill (XERK-1834)

`IndexMirror` (server.js) drains archive index writes to Postgres under HA. Its queue is bounded
(`INDEX_MIRROR_QUEUE_MAX`). The rest of the mirror: `turma-ha-archive.md`.

- **Overflow drops the oldest op that is NOT a reconcile refill**; a queue of nothing but refills
  drops the incoming op. Dropping the head refill sent it to the owed set, which drains only on an
  empty queue and so starved under the backlog the head placement exists for (QA).

- **A dropped op does NOT self-heal on the next write.** Appends land at their own seqs, so a
  dropped append left a permanent seq hole in Postgres. A dropped (or retry-exhausted) op owes its
  transcript a REFILL: row + a replace of every entry in the local `.jsonl` (`archive.mirrorRefillOf`).
  - **First copies only** (`dedupLines`), as msgCount counts them: an unrepaired duplicate line
    sent as an extra row put maxSeq past msgCount, where the reconcile's behind guard never fixes it.
  - Not for a dropped `remove`, nor the duplicate `repair` (XERK-1450: its sidecar stays pending).
- **A refill runs only on an EMPTY queue** and reads the file when APPLIED, so every op queued
  before it has landed and a retry never replaces with a stale snapshot.
- **Only while leading under the term it was owed in** (`isLeader` + `leaderTerm`, the XERK-1450
  gate); else dropped. A deposed or re-promoted replica's local copy may be behind what another
  leader appended (QA reproduced the clobber on real Postgres).
  - A new drop always re-stamps the owed entry with the CURRENT term — an entry left from an
    earlier term would otherwise be skipped as stale, taking this leader's own drop with it (QA).
    An exhausted refill re-owes itself only if nothing newer is owed, for the same reason.
- **The boot backfill's `replace` ops stay ungated** (only heal replaces are, XERK-1836): it queues
  them before the elector runs, and skipping one left a row with no entries (QA).
- **A failed refill stays owed**, retried every `INDEX_MIRROR_REFILL_RETRY_MS` (30s) by an unref'd
  timer, so an outage that drops ops is refilled once it ends. One Postgres refuses outright (SQLSTATE
  class 22/23/42, `indexMirrorPermanent`) is given up — retrying re-sent the whole transcript forever.
- **An unreadable or missing file is skipped**, never replaced with empty (that would wipe the
  of-record for a copy that just isn't here).
- **Mirrored rows and entries drop NUL** (`mirrorRow`/`mirrorEntry`): Postgres refuses it in text.
- The owed set is capped at the queue size (an exhausted refill re-owed included), a refill dropped
  at a deposition is not re-owed, and a skipped gated replace is not owed at all. The periodic
  reconcile below closes all three.

## The periodic reconcile (XERK-1701)

- `IndexMirror.reconcile` runs every `INDEX_RECONCILE_INTERVAL_MS` (5 min) from an unref'd timer
  `setIndexMirror` starts only with HA on — HA off has no timer and `reconcileCandidates` is `[]`.
- **Bounded per tick:** `INDEX_RECONCILE_BATCH` ids per Postgres round trip
  (`PgIndexStore.transcriptCounts`), until `INDEX_RECONCILE_BUDGET_MS`, resuming from a cursor
  over the sorted local ids. Single-flight; skipped mid-hydrate.
  - The batch is clamped to 10000: it is bound as one statement's parameters (int16 count).
  - **At most one batch of refills queued at once** (earlier ticks' included), so the queue
    overshoots `INDEX_MIRROR_QUEUE_MAX` by one batch at most; the cursor stops before the first id
    with no room. Uncapped, one tick queued every damaged id it compared.
- **Leader only, under ONE term**, re-checked after every round trip; each refill it queues carries
  that term, so the drain drops it once this replica is deposed.
- Compares Postgres (row msg_count, entry rows n, max seq) against the LOCAL msgCount — no file read.
  - A seq hole (n < maxSeq + 1) is healed even with writes for it queued: only a drop leaves one.
  - Fewer rows, or a lower or missing row count, is healed only with NOTHING queued for that id —
    otherwise it is an append still in flight, not damage.
  - **Never when the local copy is behind** (maxSeq >= local msgCount): another leader appended past
    it, and the refill's replace would trim their rows.
  - **Not again when Postgres holds exactly what its last refill sent** and the local msgCount has
    not moved (`_refilled`, bounded like the owed set). A torn final line counts in msgCount but
    parses to no entry, so that transcript otherwise looked short and was re-sent every tick.
- **Its refill goes to the queue HEAD**, not the owed set: a refill waiting for an empty queue
  starves under sustained overflow. Safe out of order because it reads the file when applied, and
  ops behind it for that id re-write rows it already sent (appends are DO NOTHING).
- Tests: `index-mirror-refill.test.js` (real `archive.ingestChunk` + a fake slow store; the
  `reconcile: ...` cases), `index-store.test.js` (`PgIndexStore.transcriptCounts`).
