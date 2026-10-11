---
paths:
  - "turma/outcome-ledger.js"
  - "turma/tests/outcome-ledger.test.js"
  - "turma/server.js"
  - "docs/model-quality-adr.md"
---

# Model quality loop — the outcome ledger (XERK-1839, epic XERK-1844)

Decisions + the full plan (signals, attribution, shadow runs, routing): `docs/model-quality-adr.md`.
This file is the operative rules for what has shipped.

- **Model provenance is hub-owned, never written into git.** Some orgs require user-authored
  commits with no model attribution; never add a model trailer/author/PR-body line for this.
- **Evidence is FLEET-WIDE.** `aggregate()` groups per (work class, model) across every org —
  "sonnet is good at bug work" is learned and applied everywhere. Per-session ROWS are served only
  for an org the caller names (`/api/model-quality?org=<site>&rows=1`). Never org-scope the groups.
- **The hub observes; nothing is agent-sent.** `outcomeLedgerSweep` (leader, on
  `masterOrchestrationTick`) folds `sessions` + `closedSessions` + `fleetTicketRows()` into rows
  keyed by the JSON tuple `[site, issue, host, sid]`, so a session the agent's closed cache
  evicts is not lost. **Never a `/`-joined key**: an ADO site key is `dev.azure.com/<org>`.
  - Only a host DECIDED into the session's `ticket.siteKey` (`decidedOrgOf`) contributes — the
    siteKey is agent-asserted.
  - A paused sleeper is skipped (waiting, not ended); a `queued` record has no work yet.
- **Work class = the tracker's issue type**, lowercased (`workClass`), "other" when unknown. Coarse
  on purpose so each (class, model) collects enough tickets to compare.
- **Model = the family that ANSWERED** (`modelActual`), else the spawn alias, else "default"
  (`modelFamily`). Once a real model is seen (`modelKnown`) an alias never overwrites it.
- **Outcome is DERIVED at read time** (`outcomeOf`), never stored: reopened → bad; merged →
  pending until `MODEL_QUALITY_WINDOW_DAYS` (90) passes, then good; every PR closed unmerged → bad;
  a stale close (not-reproducible / already-fixed) → no-change; ended with nothing → undelivered.
  - **MERGED is terminal** in `mergePrs`: a stale later read never moves it back.
  - **Reopen marks only rows that started BEFORE the Done** — a later session is the reopened work.
    `doneAt` is the tracker's `resolved` time when the board row has one, else the sighting —
    sighting-time alone marked a session begun while the board lagged as the cause.
  - Known over-count: a migration's killed source record reads undelivered (same as the ladder).
- **Persistence = the permission ledger's two backends**: `/data/outcome-ledger.json` (non-HA),
  Postgres `outcome_session` (HA, upsert monotone on `updated_at`, rescanned on the ready edge and
  in `onLeaderPromoted`). Never `registerExternalStore` (whole-value writes). Flushed on drain.
- **Bounded against one host or org churning session ids**: a host keeps at most
  `OUTCOME_LEDGER_HOST_MAX_ROWS` (a quarter), and past `MAX_ROWS` the org holding the most rows
  loses its oldest first — plain oldest-first let one host evict every other org's evidence.
  Evicted keys are DELETEd from Postgres too, so the table is as bounded as the model.
- **Under HA a sweep folds nothing until a rescan loaded the table** (`backend.loaded`): a
  promoted leader's stale snapshot would otherwise win the newer-wins upsert.
- **`/metrics` carries per (class, model, outcome) gauges only** — no host, ticket or session.
  Labels are BOUNDED: a model outside opus/sonnet/haiku/default reads `other`, and only the 20
  largest classes keep their name (both are agent/tracker strings on an unauthenticated route).
- The module must be in `turma/Dockerfile`'s `COPY` line (pinned by the image-copy test).
- Tests: `turma/tests/outcome-ledger.test.js`; the `XERK-1839:` cases in `server.test.js`.
