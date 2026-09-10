---
paths:
  - agent/hub-agent.py
  - agent/tests/test_hub_agent.py
  - turma/epic-plan.js
  - turma/tests/epic-plan.test.js
---

# Epic Builder — the plan model + agent-side builder/materializer (epic XERK-721)

The operator hands the hub an **idea** (title + free-text); a builder SESSION on a capable host
researches the repo, expands the idea into a plan, and WRITES a live, Auto-Epic-ready Jira epic.
This file is the AGENT + PURE-PLAN half:

- **A (XERK-722)** `turma/epic-plan.js` — the EpicPlan data model + wire contract + waves.
- **B (XERK-723)** the `createEpicChild`/`createBlocksLink` Jira write primitives in `hub-agent.py`.
- **C (XERK-724)** `build_epic_builder_prompt` + the directive, `validate_epic_plan` (a Python mirror
  of A), `materialize_epic_plan`, `spawn_epic_builder`, `_advance_epic_builders`, `epic_builder_status`.

The HUB half — the `epic-builder` route, the durable `epicBuilders` store, `epicBuilderDriveSweep`
dispatch, the `epicBuilderStatus` ingest, and the board composer + progress strip (D/E, XERK-725/726)
— is `.claude/rules/turma-epic-builder.md`. The Auto-Epic RUN that later EXECUTES the produced epic
is `.claude/rules/turma-epic-run.md`.

## The EpicPlan (`turma/epic-plan.js`, A) — one shape three stages agree on

`{ epic:{summary,description}, children:[{localId, summary, description, issueType, blockedBy:[localId]}] }`

- **Pure, stdlib-only** — no network, no tracker write, no server state — so the builder session and
  the hub validate/preview a plan the SAME way before any ticket exists.
- **`localId` is a BUILDER-LOCAL handle**; real Jira keys are assigned only at materialization, and
  `blockedBy` names other children by localId. The whole plan is expressible before a single ticket.
- **`validateEpicPlan` returns every problem, never throws** (`assertValidEpicPlan` is the throwing
  form). What the Auto-Epic run needs, each its own error code: exactly one epic with a non-empty
  summary; unique non-empty localIds; every `issueType` is **Task or Story** (case-insensitive), never
  Epic or Subtask (an Epic-typed child is caught HERE, not by a "second epic" field); `blockedBy`
  names only in-plan localIds (no dangling, no self); an **acyclic** DAG (a cycle is REPORTED in
  `cycle`, never silently dropped); and the **final-child-blocked-by-all** rule below.

### plan-waves == buildEpicWaves parity — THREE mirrors that must agree

- `layerWaves(childRows)` in epic-plan.js is a **BYTE-FOR-BYTE mirror of `buildEpicWaves` in
  `turma/server.js`** (XERK-635). `waves(plan)` runs the plan's children through it (localId IS the
  key), so **a plan previews as the EXACT waves the Auto-Epic run will execute** — pinned by the
  shared-fixture test `turma/tests/epic-plan.test.js` (`waves(plan)` deep-equals `buildEpicWaves(rows)`,
  including a staggered chain and a cycle). server.js's copy is documented in `turma-epic-run.md`.
- **The Python `_epic_plan_cycle` (Kahn layering in `hub-agent.py`) is a THIRD mirror** — same
  in-plan-edges-only, self-edges-dropped shape — so a plan that validates AGENT-SIDE arms identically
  to what the hub's DAG would lay out. Change the layering and all three move together.
- **`_eb_blocked_by` must use an `isinstance(..., list)` check, NOT `bs or []`** — a bare string is a
  falsy-guard trap: `... or []` would iterate its CHARACTERS, so a plan JS rejects (blockedBy a
  string) would validate in Python. The JS side is `Array.isArray(...) ? ... : []`; keep them in step.

### final-child-blocked-by-all — POSITIONAL, no flag

- The designated final child is the **LAST element of `children`** — a positional designation, so
  there is no `final` flag on the wire to forge or drop, and validation can report "the last child is
  the final child but is NOT blocked by every other" rather than losing which one it meant.
- The epic converges to one wrap-up sink. Only checked when there is more than one child (a
  single-child plan is trivially blocked-by-all-zero-others). The directive tells the builder to make
  the last child a QA-and-enable step blocked by every other.

## The verified Blocks POST direction — do not flip it

- A Jira Blocks link is `POST /rest/api/3/issueLink` with **`inwardIssue` = the BLOCKER,
  `outwardIssue` = the BLOCKED issue**, `type.name = "Blocks"` (`JIRA_BLOCKS_LINK_TYPE`).
- **Verified against the real XERK-634 → XERK-635 link**: with this direction a re-read via
  `_shape_issue` lists the blocker in the blocked child's `blockedBy` and the child in the blocker's
  `blocks` — the exact shape XERK-634's collector and the Auto-Epic orchestration consume. Reversing
  inward/outward inverts every dependency the run then executes.
- Used in BOTH places that write a Blocks link: `create_blocks_link` (B) and `materialize_epic_plan`
  (C's inline path). `epic_plan_link_edges(plan)` yields the `(blocker, blocked)` pairs in a
  DETERMINISTIC order (child order, then each child's blockedBy order), de-duplicated, self-edges and
  out-of-plan refs dropped — the edges the links reproduce.

## "Emit isEpic/epicKey/blocks so Auto Epic needs no change" — the whole design

`materialize_epic_plan(plan, project)` produces a plain Jira epic that the EXISTING collector and run
already understand, so nothing downstream changes:

- Creates the **epic with issueType Epic** → XERK-634's `_shape_issue` re-reads `isEpic:true`.
- Creates each **child with `parent` = the epic key** (`createEpicChild`'s parenting) → re-reads
  `epicKey` set on every child.
- Creates the **Blocks links** (the verified direction) → re-reads `blocks`/`blockedBy`.
- So the Auto-Epic RUN (`turma-epic-run.md`) consumes the produced epic with **no new code** — it
  reads existing membership + links and NEVER recomputes the DAG. Generating the links at
  materialization (rather than relying on the run to infer edges) is deliberate: the epic is a
  COMPLETE, standalone Auto-Epic input that also works if opened by hand.

### Materialization safety (C) — no silent half-epic, off the beat

- Order: epic first, then children in **array order** (each parented to the epic), then Blocks links.
  A per-name `type_id` resolves each issueType against `jira_issue_types(project)`.
- **`EpicBuilderError` carries exactly what WAS created** (`{epicKey, children, links}`) on ANY
  failure — the operator sees a PARTIAL epic (epicKey carried even on a mid-way failure), never a
  silent half-write. `_materialize_epic_builder` sets the run `failed` with that `epicKey`.
- **Runs OFF the beat on a worker thread** — N+M Jira calls must not sit on the heartbeat (XERK-395).
- `_epic_builder_project` picks `epic.project` if the builder chose one, else the **modal project key**
  across this host's board tickets (`XERK-724` → `XERK`). Jira-only throughout (an Azure host refuses).

## B's primitives are agent-side, and the SHIPPED builder does not queue them

- **`createEpicChild`/`createBlocksLink` (XERK-723) are `handle_commands` primitives built for a
  HUB-DRIVEN materializer that was SUPERSEDED** by the agent-side seam (XERK-724 dropped the hub-side
  materializer, `turma/epic-materialize.js` is gone). **Nothing queues those commands in the shipped
  path** — `materialize_epic_plan` inlines `create_jira_issue(parent=…)` + `jira_post(issueLink)`
  directly. They are kept as tested primitives; don't assume the builder calls them.
- **What C REUSES from B**: the verified Blocks direction, the `JIRA_BLOCKS_LINK_TYPE` constant, and
  the never-raise / staged-result-in-the-same-`handle_commands`-call discipline.
- **The idempotency discipline (`create_blocks_link`, mirroring `create_duplicate_link` XERK-484)** is
  layered and lives in the PRIMITIVE, not the inline materializer: (1) a live read of the blocker's
  issuelinks scanned **UNCAPPED** (`_issue_already_blocks`) is the source of truth → already-linked is
  `no-op`, no POST; (2) a durable ledger (`~/.turma/jira-blocks-links.json`, keyed
  `<siteKey>/<blocker>-><blocked>`) makes a **human removal STICKY** → a pair this host linked that
  Jira no longer shows is `skipped`, never re-linked; (3) success → ledger + `linked`. The inline
  materializer instead relies on "no silent half-epic" — it is single-shot per builder, not retried,
  so it needs no idempotent replay.

## The builder session (C) — a real RC session, not a `claude -p` one-shot

- `spawn_epic_builder` spawns a **real Remote-Control session** (`spawn()`), NOT a `claude -p`: the
  builder must RESEARCH a real worktree (Read/Grep/Glob over the repo across many turns), which
  print-mode cannot do, and its plan-file write needs the session lifecycle (acceptEdits, timeout,
  reap). It is **ticket-less** — the hub keys it by a minted `builderId`, not a Jira key, because
  there is no epic yet (it PRODUCES one).
- **`permission_mode="acceptEdits"`** so the session's WRITE of `TURMA_EPIC_PLAN.json` in its own cwd
  auto-approves and it runs UNATTENDED — research never prompts, and the directive forbids it from
  creating any Jira ticket itself (writing the file is its whole job). No repo → researches from the
  repos-root (it can read every repo there).
- Every refusal in `spawn_epic_builder` is **REPORTED** via a `failed` builder record (the
  `epicBuilderStatus` analogue of `_refuse_start`, XERK-265), so the hub's run never sits `queued`
  forever.

## The beat sweep (C) — `_advance_epic_builders` / `_advance_researching_builder`

- **The plan file is SESSION-written, so untrusted from the beat**: read via `_read_untrusted_json`
  (`O_NONBLOCK|O_NOFOLLOW` + regular-file + bounded by `EPIC_BUILDER_PLAN_MAX_BYTES`). A plain
  `open()` would let a session swap the file for a FIFO between beats and WEDGE the heartbeat with no
  exception to catch (the session-inbox/limits-read hardening).
- `None` = not a complete valid JSON object yet (mid-write / absent / oversized / not an object) —
  keep waiting. Session gone without a plan → `failed`. Invalid plan → `failed` naming the errors.
  Past `EPIC_BUILDER_TIMEOUT_SEC` (45m) → `failed`, so a builder that never writes a valid plan frees
  its slot rather than holding it forever. A valid plan → `creating`, then materialize off the beat.
- **The terminal builder's session is reaped ON THE BEAT** (`_advance_epic_builders`), **never from
  the materialization worker** — `kill()` REBINDS `self.registry`, so reaping from the worker thread
  would race the beat's registry access. One reap per builder (`sessionKilled`). The worker only sets
  the terminal state; the beat both reaps and advances.
- `epic_builder_status()` rides the heartbeat as `[{id, state, epicKey?, error?}]` (a
  `HEARTBEAT_KNOWN_KEYS` member): `epicKey` whenever we have it (done OR a partial-failure epic),
  `error` only while `failed`. The hub advances only a builder DISPATCHED to this host
  (`turma-epic-builder.md`).

## Tests

- `turma/tests/epic-plan.test.js` — every rejection code; `waves(plan)` == `buildEpicWaves(rows)` over
  a shared fixture (diamond, staggered chain, cycle); the wire round-trip.
- `agent/tests/test_hub_agent.py` — `TestCreateEpicChild`, `TestCreateBlocksLink` (the verified
  direction, the layered idempotency, never-raise); `TestEpicPlanValidation` (the Python mirror incl.
  the `_eb_blocked_by` non-list trap); `TestMaterializeEpicPlan` (order, no-silent-half-epic, project
  derivation); `TestEpicBuilderRun` (spawn records `researching`, azure/unknown-repo refusals REPORT a
  `failed` record, advance materializes a valid plan / fails an invalid one / fails when the session
  ends with no plan, a partial failure reports the `epicKey` + error). The timeout, the
  `_read_untrusted_json` plan read and the on-beat reap are code-level invariants, not each pinned by
  their own case.
