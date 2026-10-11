---
paths:
  - turma/server.js
  - turma/archive.js
  - turma/tests/index-mirror-refill.test.js
  - turma/tests/index-mirror-order.test.js
---

# The archive index mirror's refill (XERK-1834)

`IndexMirror` (server.js) drains archive index writes to Postgres under HA. Its queue is bounded
(`INDEX_MIRROR_QUEUE_MAX`, drop-oldest). The rest of the mirror: `turma-ha-archive.md`.

- **A dropped op does NOT self-heal on the next write.** Appends land at their own seqs, so a
  dropped append left a permanent seq hole in Postgres. A dropped (or retry-exhausted) op owes its
  transcript a REFILL: row + a replace of every entry in the local `.jsonl` (`archive.mirrorRefillOf`).
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
- Known limits (rollup XERK-1701): the owed set is capped at the queue size, and a refill dropped
  at a deposition is not re-owed.
- Tests: `index-mirror-refill.test.js` (real `archive.ingestChunk` + a fake slow store).
