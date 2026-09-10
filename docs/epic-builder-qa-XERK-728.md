# Epic Builder — final QA end-to-end + prod-enable record (XERK-728)

Closing record for epic **XERK-721** (Epic Builder: expand an idea into an Auto-Epic-ready Jira
epic). Subtask F, XERK-728: adversarial end-to-end verification, then confirm the feature is enabled
and serving in production. Verified against `main` @ `68742a8` (all of A–E merged: XERK-722/723/724/
725/726 + docs 727).

## The feature is always-on — there is NO enable flag

Epic Builder ships **unconditionally**. There is no `EPIC_BUILDER_ENABLE` env, no capability gate,
and nothing epic-builder-shaped in `ArgoCD/ai/turma/deployment.yaml`:

- The board's "✨ New epic" button is static HTML (`turma/public/board.html`).
- The hub route (`POST /api/jira/<siteKey>/epic-builder`), `epicBuilderDriveSweep`, and
  `ingestEpicBuilderStatus` are unconditional (`turma/server.js`).
- The agent's `spawnEpicBuilder` command handler and `materialize_epic_plan` are unconditional
  (`agent/hub-agent.py`).

So **"enable in prod" was accomplished by the standard auto-deploy** as each subtask merged — there
was never a flag to flip. Do not re-add one: a future change that gates the composer must gate the
route, the agent handler, and every board mirror together, or it will half-enable.

## Prod is serving the feature — confirmed

- turma ArgoCD Application is `automated`+`selfHeal` on `ai/turma`@`main`, so the pinned manifest is
  the running state. Prod hub image = `ghcr.io/xerktech/turma:1.4.12`.
- `1.4.12` contains all hub-side code: A `epic-plan.js` (v1.4.2), B primitives (v1.4.3), D
  route/dispatch (v1.4.5), E board composer/progress (v1.4.8).
- **Live proof:** `https://turma.xerktech.com/board.js` (served, HTTP 200) contains
  `epicBuilderComposerHtml`, `epicBuilderProgressHtml`, and the `epic-builder` route call. Root is
  401 (OIDC), as expected.
- The agent-side builder session (C, XERK-724) shipped in `agent-native-v1.4.14`; hosts self-update.
  **Caveat:** end-to-end operation needs each host on agent-native ≥ v1.4.14 (older agents ignore
  `spawnEpicBuilder`, so the run degrades to a timeout `failed` rather than a crash). Per-host agent
  version needs authenticated `/api/agents` to confirm; it converges as hosts self-update.

## QA verdict: PARTIAL (zero defects) — real-Jira writes deliberately out of scope

QA was run adversarially by the `qa` agent (first pass): the real hub was booted (HMAC agent tokens,
two hosts, :8731) and the real `hub-agent.py` / `epic-plan.js` / `server.js` code paths were driven
with a **mocked Jira layer** and synthetic plans/payloads. No production Jira tickets were created —
the operator explicitly scoped out real Jira writes (no staging Jira exists). Suites floor:
`server.test.js` 851, `epic-plan.test.js` 17, `board.test.js`, `pytest -k Epic` 30 — all green.

Every claim in the ticket was **CONFIRMED by driving** (not reading):

1. **Produced epic is Auto-Epic-ready.** `materialize_epic_plan` → re-shaped via `_shape_issue`:
   epic `isEpic:true`; every child `epicKey` set; each child's `blockedBy` matches the DAG; the last
   child blocked by all others. Children parented explicitly (`parent=epicKey`); injected
   `parent`/`__proto__` ignored.
2. **Three-mirror wave parity.** On a diamond+staggered DAG, `waves(plan)` (epic-plan.js) ==
   `buildEpicWaves(rows)` (server.js) byte-identical; Python `_epic_plan_cycle` reports the same
   cycle. Reversing wave order in `buildEpicWaves` breaks the XERK-722 parity test → the guard is
   load-bearing.
3. **Verified Blocks POST direction — confirmed by bytes.** Every link POST is
   `inwardIssue=BLOCKER, outwardIssue=BLOCKED, type.name="Blocks"`, in `epic_plan_link_edges` order;
   a re-read lists the blocker in the blocked child's `blockedBy`.
4. **Auto-Epic run drives the produced epic, no manual fixup.** `armEpicRun` over the materialized
   rows releases wave-by-wave via `epicChildBlockersDone`; the final child becomes ready only after
   all others are Done; the run reads the materialized `blockedBy` directly.
5. **Failure modes handled** (both JS and Python): cyclic, dangling-blockedBy, self-edge, Epic-typed
   child, Subtask child, missing epic, duplicate localId, blockedBy-as-string (`_eb_blocked_by`
   non-list trap), final-not-blocked-by-all. Missing "Epic" issue type → refused with **zero**
   creates. Partial failure mid-create → `EpicBuilderError.created` carries `{epicKey, children,
   links}` actually written — no silent half-epic. Route refusals create nothing.
6. **Untrusted plan-file read** (`_read_untrusted_json`, bounded 256 KiB): FIFO / symlink /
   directory / oversize all return `None` non-blocking; the 45-min timeout gate frees the slot.
7. **Wire/degrade & security** (real hub over HTTP): validation order 400 → 413 → 404, nothing
   created by a refusal; a host may only advance a builder dispatched to it (`run.host===hostKey`);
   `normalizeEpicBuilderStatus` drops wrong-typed subfields (never stringifies);
   `sanitizeEpicBuilderRecord` drops id/siteKey/title-less at boot; DELETE cancel → 200 then 404.

**No defects — no feature bug, no security finding, in or out of scope.**

### The one residual (why PARTIAL, not PASS)

The PARTIAL is *entirely* the operator's zero-side-effects scope, not a defect:

- **A live builder Claude session** researching a worktree and writing `TURMA_EPIC_PLAN.json` was
  not spawned. Everything downstream of that file (untrusted read → validate → materialize) was
  fully driven with synthetic plans.
- **Real Jira accepting the write shapes.** The materialize POST bodies are byte-correct *as this
  codebase constructs them*, but whether the live XERK Jira project accepts that exact
  `issuetype` / `parent` / `issueLink` shape (team- vs company-managed nesting; the "Blocks"
  link-type name on the site) can only be proven against a real project. **Low residual risk:** the
  Blocks link direction was verified against the real XERK-634→635 link (see
  `.claude/rules/epic-builder.md`), `create_duplicate_link` was fixed against real Jira Cloud
  (XERK-729), and epic/child creation uses the same `create_jira_issue` primitive as all normal
  ticket creation. The only unproven-against-real-Jira piece is the epic-child `parent=` shape +
  issuetype resolution in the live project.

To turn this PARTIAL into a literal PASS, run one real end-to-end (a live builder session producing
a throwaway epic in XERK, then deleting it) with prod-Jira writes explicitly authorized.
