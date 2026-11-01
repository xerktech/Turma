---
paths:
  - turma/tenant-migration.js
  - turma/server.js
  - turma/tenancy.js
  - turma/archive.js
  - turma/usage-ledger.js
  - turma/permission-ledger.js
  - turma/outcome-ledger.js
  - turma/tests/tenant-migration.test.js
  - turma/tests/tenant-migration-runner.test.js
description: Moving the pre-tenancy deployment into its owner's tenant (XERK-2554).
---

# The pre-tenancy migration (XERK-2554)

Decision, upgrade + rollback notes: `docs/multi-tenant-adr.md` ("Moving the pre-tenancy deployment").

- **Every partitioned store needs a migration step** (`registerTenantMigration`, server.js): a store
  that registers a tenant purge and moves no untenanted data into the owner's tenant strands it with
  the operators. `meetingTokens` is the one exemption (tenant-only). Tests pin the parity.
- **A step is idempotent**: `count` reads 0 after `apply`, and a second `apply` moves nothing. The
  runner (`tenant-migration.js`) resumes at the first step the marker lacks, so a step must survive
  being re-run after a kill mid-step.
- **A step takes `(t, scope)`**: `scope` null = the first run (everything untenanted); else the
  marker's `hosts`/`sites` only (the leftover sweep, a bind beat). Devices and the routing policy
  return 0 under a scope; hosts/identities bind only a recorded host whose identity predates the
  run, so an operator's later untenanted host — even under a recorded name — is never taken.
- **Under a scope an org moves only while no unrecorded untenanted host works in it**
  (`siteMovable`): an operator host enrolled in that org after the move makes its plain settings and
  queue the operators' again (QA: the sweep took them). A recorded host counts as the tenant's only
  while its record carries the bound identity (`migratingRecord`) — never by its name alone (an
  operator can re-use a recorded name), and never only within a bind beat's one-host scope (the
  other hosts still beating plain then read as operators' and the outcome rows split).
- **A recorded name's plain rows stop moving once its migrated agent beat as `<name>@<t>`**
  (`migratedHostArrived`, plus the marker's `arrived` list so a later revoke cannot undo it), except
  at that bind beat itself: later plain rows are a name re-used by an operator.
- **A bound host still beating plain with no `setToken` queued is handed it again**
  (`boundHostsAwaitingToken`): a record pruned while offline loses its queued command. Its record is
  stamped with the identity first, or the bind beat leaves a plain ghost and splits its rows.
- **`uidHostRefusal` judges a tenant bind BEFORE the usage-ledger name check**: the migration may
  already hold the host's rows under its tenant key, which read as "belonged to another host" (QA).
- **An outcome row's site moves with its host** — never a live plain host's row early; a row already
  on the tenant's host but a plain site is healed.
- **Each step is flushed to disk before the marker records it** (`flushMigratedStores`): the file
  stores and state.json debounce, and a kill right after "done" booted a completed marker over
  unmoved data (QA).
- **The moved archive rows count toward the owner's `ARCHIVE_TENANT_MAX_BYTES`** (XERK-2618
  charges by row host): the run and the dry run warn when they would exceed it.
- **A dry run creates no owner and closes no route**; a refused/failed run keeps the gate closed and
  logs on change or hourly, never every tick.
- **A host's rows move only once no plain record is live** (`hostMovable`): a live host moves at its
  bind beat (`tenantMigrationOnBind`), never before, so its rows never split across two keys.
- **Re-key, never copy**: each ledger's `rekeyHost`/`rekey` merges into an existing tenant row by its
  own rule (usage high-water, permission progress, outcome newer) and deletes the old key in Postgres.
- **The gate**: `tenantMigrationGateClosed` 503s a `user` principal on every data route class and
  `/api/ws-token`, and its `/term` upgrade, until `completedAt`. Operators are never gated.
- Tests: `tenant-migration.test.js` (own process: every store, the gate, the bind beat, rerun,
  leftovers), `tenant-migration-runner.test.js`; the `XERK-2554:` cases in the three ledger suites.
