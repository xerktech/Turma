---
paths:
  - "turma/server.js"
  - "turma/tests/server.test.js"
  - "turma/outcome-ledger.js"
  - "agent/hub-agent.py"
  - "turma/public/board.js"
  - "turma/public/board.html"
  - "android/app/src/main/java/com/xerktech/turma/core/Board.kt"
  - "android/app/src/main/java/com/xerktech/turma/ui/BoardScreen.kt"
---

# Model routing policy (XERK-1848, epic XERK-1844)

Decision + rationale: `docs/model-quality-adr.md` ("Routing policy"). Evidence it reads: the outcome
ledger and shadow pairs (`model-quality.md`). It REPLACED the XERK-1827 delivery-only ladder,
which escalated only on "delivered nothing" and so never caught a plausible-but-wrong cheap PR.
Never restore a ladder or route from bench solve rates (`bench/run_policy.py` is an experiment).

- **`MODEL_POLICY=off|observe|on`** (hub env, default `observe`). observe records promotions
  (and runs shadows) but routes nothing; only `on` changes a spawn and runs the tripwire.
- **Promotion is fleet-wide per (work class, model)** (`modelPolicySweep`, leader, after
  `modelShadowSweep`): `MODEL_PROMOTE_MIN_PAIRS` (40) graded pairs, candidate-only failures
  ≤ 5% AND 95% Wilson upper ≤ 10% (`outcomeLedger.promotionPasses`). At 40 pairs that means 0
  failures; ~70 allow one.
- **Several promoted models for a class → the cheapest routes** (`MODEL_COST_ORDER`, haiku first).
- **Routing is read at DISPATCH** (`ticketSpawnModelFields` → `modelPolicyPick`, both spawn sites).
  The operator's model pin always wins; a dsh/qwen runtime pin, or an unpinned ticket routed to a
  host whose `defaultRuntime` isn't claude, carries no model (a qwen host would send the alias to
  its OpenAI endpoint). The class is the board row's `type` through `workClass`.
- **Tripwire**: a promoted (class, M) whose live bad rate SINCE ITS PROMOTION (`liveRate`, rows
  started strictly after `at`; never in the sweep that promoted it) has a Wilson LOWER bound
  above the Opus baseline for the class is demoted, logged, and the operator notified
  (`model-demoted:<class>/<model>`). Same-millisecond work was not routed by the promotion; the
  release gate caught a test that re-demoted in the promoting sweep on a fast runner.
  - The rate's denominator is bad + good + merged-still-in-window, on BOTH sides: `good` needs the
    90-day window, so bad ÷ (good + bad) would read every new model as all-bad and trip at once.
  - No Opus evidence for the class → baseline 0, so one bad demotes. Conservative on purpose:
    a wrong demotion costs money, a missed one costs quality.
- **A demotion is sticky until NEW shadow evidence**: re-promotion judges only pairs graded since
  the demotion's `at` (`pairEvidence`). Never count deltas: `graded` falls on eviction and
  `mOnlyFail` falls when an old live row later goes bad, so a delta over/under-counts (QA).
- **Only a cheaper Claude family (`MODEL_COST_ORDER`: haiku, sonnet) is ever promoted** — a shadow's
  model is `modelFamily(modelActual)`, and a non-alias family would be refused at spawn.
- **State is hub-owned durable** (`/data/model-policy.json`, `registerExternalStore` `modelPolicy`
  — low churn), `"<class>/<model>" → {state, at, graded, mOnlyFail, bad?, n?, baseline?}`,
  coerced field by field (`modelPolicyCoerce`; an Opus key is dropped — Opus is the baseline).
- **Served** as top-level `modelPolicy: {mode, promoted: {class: model}}` on `/api/agents` + its own
  `modelPolicy` SSE frame; Android TYPES it (`ModelPolicy`, defaulted). `/api/model-quality` stamps
  each group's `promotion` (`promoted` / `promoted (observe)` / `promoted (unused)` / `demoted`),
  which the XERK-1849 card shows verbatim.
- **The board Model row names the policy's pick** (`board.js` `modelPickOf` + `workClassOf`,
  ports in `Board.kt`): "Auto (Sonnet) — promoted for bug work on shadow-run evidence"; any mode
  but `on` → the old "Default (<probed>)" row. `workClassOf` must equal `outcome-ledger.js`
  `workClass` (pinned by a `board.test.js` case).
  - Client-side over the served map + the ticket's `type`, so an SSE `modelPolicy` frame moves the
    row live; `modelPickSig` keys on model, class and `elsewhere`.
  - **The row hedges when Start could land on a non-claude-default host** (XERK-1840): with no
    agent/runtime pin, online in-org non-claude hosts go in `elsewhere` → "Auto (Sonnet on Claude
    hosts)". Routing is unchanged on purpose: requiring claude hosts would starve a qwen-default host.
- **The Opus review gate is agent-side** (`TICKET_OPUS_REVIEW_DIRECTIVE`): a claude ticket session
  spawned on a sonnet/haiku alias (policy pick OR pin) is told to pass the `qa` agent AND an Opus
  code review of its diff before its PR, both verdicts in the PR summary. Keyed on the model, not
  the policy, so a pinned cheap session is gated too; shadow runs never take this path. It is
  judged on the runtime the session RUNS (`resolve_agent_type(..., apply_default=True)`), so a
  qwen-default host with a pinned alias gets no gate.
- **Per session, never per turn** — a mid-conversation model switch re-caches every missed turn.
- `TURMA_TICKET_SUBAGENT_MODEL` (agent env, default off) sets ticket sessions' sub-agent default;
  QA/review sub-agents stay pinned to Opus (`hooks/subagent_model.py`, XERK-1851).
- Tests: the `XERK-1848:` cases in `server.test.js`, `board.test.js`, `BoardTest.kt`;
  `test_a_cheaper_model_is_told_*`/`test_opus_the_default_*` in `TestSpawnTicket`.
