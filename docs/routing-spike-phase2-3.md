# Routing spike — local serving and the model matrix

XERK-445 Phases 2 and 3, run as a spike on 2026-08-22. Phase 0 (the eval set)
and Phase 1 (prior art) are in `docs/routing-eval-phase0.md` and
`docs/routing-prior-art.md`.

Everything here was measured on `maxai` (RTX PRO 6000 Blackwell, 97,887 MiB)
against the `lite.xerktech.com` gateway.

## What the gateway actually serves

The endpoint was converted from `bedrock-mantle` to plain `bedrock` mid-spike,
which changed the answer completely: **19 models became 270**, 266 of them
`bedrock/*`.

**Reachable and used here:** `us.anthropic.claude-opus-4-6-v1`,
`claude-opus-4-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`,
`claude-haiku-4-5`, `qwen.qwen3-coder-next`, `qwen.qwen3-next-80b-a3b`,
`nvidia.nemotron-nano-3-30b`, `nvidia.nemotron-super-3-120b`, `zai.glm-5`,
`moonshotai.kimi-k2.5`, `deepseek.v3.2`, `mistral.devstral-2-123b`,
`openai.gpt-oss-120b`.

**Still entitlement-blocked** (`access_denied` / `not_found`): every
`openai.gpt-5.x`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`,
`claude-sonnet-5`, `claude-fable-5`, `xai.grok-4.6`.

**`claude-sonnet-4-6` answers a smoke test and then 403s under real use** —
*"Model access is denied due to IAM user or service role is not authorized to
perform the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions,
aws-marketplace:Subscribe)"*. All five of its benchmark tasks failed in 6-9
seconds. **A trivial probe succeeding is not evidence a model is usable**; the
availability table above is only as good as the load it was checked under.

So **opus-4-6 is our frontier ceiling**, and it is enough to run the benchmark.
XERK-447 tracks the entitlement gap; the earlier finding that no Claude model
was reachable at all is superseded.

Claude Code drives any of these unchanged: the gateway serves `/v1/messages`,
so the CLI, its transcript format and the safety guard all stay as they are.
This is the `claude-local` shape `docs/local-model-failover.md` already proved,
pointed at a different model.

## Local serving: Nemotron 3.5 Lightning

Deployed to replace the resident Qwen3.6-27B (which freed 90,751 MiB → 7,222):

```
vllm/vllm-openai:nightly
  --model nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4
  --max-model-len 131072
  --reasoning-parser qwen3
  --enable-auto-tool-choice --tool-call-parser qwen3_coder
  --enable-prefix-caching --gpu-memory-utilization 0.85
```

Three configuration traps, each of which looked like a model failure:

- **The tool-call parser is `qwen3_coder`, not `hermes`.** Nemotron emits
  `<tool_call> <function=bash> <parameter=command> ls /tmp </parameter> ...`,
  which is the Qwen3-Coder convention, not hermes' JSON. Under `hermes` the
  model returns **zero tool calls** and reads exactly like a model that refuses
  to use tools. Nothing in the error output points at the parser.
- **Reasoning is on by default and costs ~60x on trivial turns.** Answering
  "Reply with the single word OK" takes **132 output tokens** with thinking on
  and **2** with `chat_template_kwargs: {enable_thinking: false}`. On the tier
  meant to serve ~87% of turns that multiplier decides whether routing pays at
  all. The ticket flags this for Qwen3.8; it applies here too.
- **Claude Code reserves 32,000 tokens for output.** A 131,072-window model
  therefore has ~99k for input, and a real task prompt overflowed on its first
  request (`99,073 in + 32,000 out = 131,073`). Set
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` down and declare the window minus what is
  left, or every task dies before it starts.

**Side effect to be aware of:** the gateway's `qwen3.6-27b` model group routes
to `maxai:8000` and names the checkpoint `nvidia/Qwen3.6-27B-NVFP4`. That port
now serves Nemotron, so the group fails with *"The model
`nvidia/Qwen3.6-27B-NVFP4` does not exist"*. Either restore the Qwen container,
repoint that group, or add the old id to `--served-model-name` — the last is
cheapest but makes the gateway answer Nemotron under a Qwen name, which is worse
than a clean failure.

vLLM speaks OpenAI Chat only, so Claude Code needs an Anthropic-Messages
translation in front of it. Switchyard is the intended answer (see the prior-art
doc) but ships no prebuilt binary and there is no Rust toolchain on the box, so
a local LiteLLM instance was used as the shim. **Standing Switchyard up is the
obvious next step** — it replaces the shim and adds the routing.

## Benchmark: same harness, same tasks, model as the variable

`bench/run_bench.py` now takes `TURMA_LOCAL_MODEL`, which inverts what this
directory was built for: the bake-off held the model fixed and varied the
harness, and Phase 3 needs the opposite.

Tasks are the 25 validated tasks in `bench/archive/tasks-validated.json`, Claude
Code as the harness, 1500s cap, scored only by the repo's own tests.
`bench/run_matrix.sh` wraps the run for each cloud model.

**Run the cloud models one at a time (`jobs=1`).** Twelve concurrent sessions
took a hard `429` from the gateway and scored every model 0/8 — throttling, not
capability, and indistinguishable from a real result in the summary table.

### Results — full 25-task matrix

| model | solved | avg TPS | avg time | avg output tok | avg total tok/task |
|---|---|---|---|---|---|
| haiku-4-5 | **18/25 (72%)** | 58.4 | 447s | 26,080 | 9,697,080 |
| sonnet-4-5 | **18/25 (72%)** | 83.8 | 320s | 26,811 | 7,864,476 |
| opus-4-5 | *in progress* | — | — | — | — |
| opus-4-6 | 2/2 valid | — | 439s | — | — |
| deepseek-v4-flash | **2/25 (8%)** | 67.4 | 90s | 6,100 | 498,079 |
| qwen-3.8-27b | *in progress* | — | — | — | — |

`sonnet-4-6` is not usable at all (AWS Marketplace subscription error).
`sonnet-4-5` is what "sonnet" means here. TPS is output tokens / wall-clock
seconds (includes tool execution and network, not just generation).

**Token accounting note.** Anthropic models report most input as
`cache_read_input_tokens` (haiku: 9.49M avg, sonnet: 7.61M avg), so the raw
`input_tokens` field (~400–1,400) is only the uncached delta. DeepSeek reports
all input as `input_tokens` (101K avg) with some `cache_read` (390K from vLLM
prefix caching). The "avg total tok/task" column sums all four fields.

**Opus-4-6 was gated by a daily token quota on the LiteLLM/Bedrock gateway**,
not by capability. The infra-failure detector now catches this, but only 2 tasks
ran validly. **Opus-4-5 has better quota limits** and is running the full 25-task
set via Bedrock — results pending.

**DeepSeek V4 Flash solved 2/25.** Running locally via LiteLLM at
`10.10.10.36:8888`, it is fast (67 TPS, 90s avg) but solves almost nothing on
this task set. Most tasks fail in under 60s with no commits — the model abandons
rather than attempting a fix. The two solves (xerk-186, xerk-250) both took ~170s
and are tasks haiku/sonnet also solve.

**Qwen 3.8-27B** required a custom vLLM chat template to work with Claude Code.
Claude Code interleaves `system` messages throughout the conversation
(`<system-reminder>` blocks), and Qwen3's default template rejects any system
message after the first user turn. The fix renders non-initial system messages as
user messages (`qwen3-allow-system.jinja2`, passed via `--chat-template`). The
`TURMA_LOCAL_EFFORT=medium` env var is also required because Qwen rejects Claude
Code's default `reasoning_effort: high`. Running via LiteLLM on maxai — results
pending.

**The n=5 result was misleading.** At n=5, sonnet appeared dominated (1/5 vs
haiku's 2/5). At n=25, they are **identical in solve rate (72%)** but solve
**different tasks**:

| set | count | tasks |
|---|---|---|
| Both solved | 15 | xerk-{33, 98, 101, 130, 145, 151, 153, 155, 162, 186, 223, 235, 250, 251, 296} |
| Only haiku | 3 | xerk-{147, 227, 246} |
| Only sonnet | 3 | xerk-{73, 226, 241} |
| Neither | 4 | xerk-{122, 218, 222, 254} |
| **Union (either solves)** | **21** | |

Sonnet is ~30% faster per task (avg 320s vs 447s) and 43% higher TPS (83.8 vs
58.4). Every task both solved, sonnet finished first on 14 of 15.

**The "neither" set is small (4/25) and opus cracked one of them.** xerk-122 is
the hardest task in the set — both cheaper models failed it, opus-4-6 solved it
in 722s. The other three (xerk-218, 222, 254) remain unsolved by any model.

n=25 on one repo. This settles the haiku-vs-sonnet ranking (they are tied) but
not the opus question (n=2 for 4-6, in progress for 4-5).

### Cost per completed task, measured (n=5 pilot)

Token counts come from the n=5 pilot's bench sessions' own transcripts
(deduplicated by `requestId`, the unit `bench/archive/classify.py` established),
priced at the Bedrock rates above.

| model | turns | cache_read | output | $ total | **$ per solved task** |
|---|---|---|---|---|---|
| opus-4-6 | 475 | 40.9M | 195k | $47.20 | **$15.73** (3 solved) |
| haiku-4-5 | 513 | 47.4M | 155k | $8.34 | **$8.34** (1 solved, run incomplete) |
| nemotron-3.5-lightning (local) | 583 | 49.0M | 140k | **$0** | **$0** (2 solved) |

Two things stand out. **Cache reads are ~86k tokens per turn** — the archive's
97.9% figure, confirmed live on a different workload. And the self-hosted tier's
bill is GPU time, not dollars, which is why "is the local model good enough"
dominates every routing question: at $0 it does not need to win, only to be
adequate.

The n=5 pilot's per-model costs are superseded by the n=25 solve rates above for
ranking purposes, but the token structure (cache reads dominating) generalises.

Two caveats from the pilot that held at n=25:

- **The window, not the model, was the binding constraint.** At a 96k declared
  window Nemotron scored **0/5**, every run dying with *"Autocompact is
  thrashing: the context refilled to the limit within 3 turns of the previous
  compact"*. Raising it to 120k by cutting the output reservation took it to
  **2/5** with no other change. A local model's apparent incompetence is worth
  suspecting as a context-budget artifact before it is believed.
- **The delivery contract is now fixed at n=25.** At n=5,
  `committed=False` on almost every solve. At n=25, haiku committed every solve
  (18/18) and sonnet committed every solve (18/18) — the 1500s cap and the
  prompt's delivery contract are sufficient.

## What routing actually costs

The Phase 0 doc predicted from archived token counts that per-turn routing
could not pay. That prediction was measured directly here, and the mechanism it
assumed turned out to be wrong while the conclusion survived. Full working is in
that doc's "Why per-turn routing loses"; the short version:

- Prompt caches are **per-model and independent**. Switching away does not
  invalidate the origin's cache, and returning within the TTL costs nothing.
- Each turn of a growing conversation creates cache for the **delta** only.
- The real penalty is that **a model which skipped turns must cache the turns it
  missed**, so alternating makes both tiers pay for the gaps.

Six turns of growing context, salted per scenario, priced at real Bedrock rates:

| policy | tier split | cache_create | vs always-frontier |
|---|---|---|---|
| always frontier (opus-4-6) | 100/0 | 40,657 | — |
| **per-turn alternating** opus/haiku | 50/50 | 74,538 (**1.83x**) | **-8.2%** |
| **phase routing** — 3 opus then 3 haiku | 50/50 | 60,449 | **-36.3%** |
| all-cheap (haiku-4-5) | 0/100 | 40,657 | **-80.0%** |

haiku-4-5 is exactly 5x cheaper per token than opus-4-6, so moving half the
turns onto it should save on the order of 40%.

**Both middle rows move exactly half the turns. One saves 8.2% and the other
36.3% — a 4.4x difference decided entirely by how OFTEN the tier changes, not by
which turns went where.** Per-turn alternation pays a catch-up cache on nearly
every turn; phase routing pays one, of 30,225 tokens ($41.71 per 1k sessions),
and then runs cheap.

That reframes the ticket's open question — *"is `stage_router` good enough on
its own, or do we need `llm_classifier`?"*. Neither, on this evidence. **Routing
ACCURACY is worth far less than routing STABILITY**, and both algorithms are
per-turn decisions. The cheap win is a coarse, sticky policy; a smarter
per-turn classifier optimises the term that barely matters and adds a model call
to do it.

## Recommendation

1. **Do not build per-turn routing.** It is the one shape the economics refuse,
   and it is what the ticket's framing assumes.
2. **Route per session, or per phase within a session.** One switch amortised
   over many turns keeps the cache penalty to a single catch-up.
3. **Default ticket sessions to haiku-4-5.** It solves 72% of tasks at 1/5 the
   cost of opus and commits every solve. Sonnet solves the same rate but costs
   3x more per token and does not solve a SUPERSET — each model cracks 3 tasks
   the other misses.
4. **Retry the 7 failures on the other cheap model.** Haiku and sonnet each
   solve 3 tasks the other cannot. A "try haiku, retry on sonnet" policy would
   hit 21/25 (84%) for ~1.4x the cost of haiku-only — far cheaper than running
   opus on everything. This is the cheapest way to close the gap.
5. **Reserve opus for the "neither" set.** It cracked xerk-122 which no cheaper
   model could. The daily quota on the gateway limits it to ~2 tasks/day; that
   scarcity makes it a last-resort escalation, not a default.
6. **Route subagents to the cheap tier first.** A subagent carries its own
   context, so delegating creates no gap in the parent's cache at all — the only
   split that is free by construction. 26% of turns in the archive.
7. **Run execution sessions on the local model outright.** Nemotron matched
   opus-4-6 on this subset at 4-5x the speed and zero marginal cost.
8. **Fix the delivery-contract gap before any of this ships.** Both tiers solve
   tasks and fail to commit them.

## Rollback

Unset `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` and
Claude Code returns to the subscription unchanged — the same path
`docs/local-model-failover.md` already ships as `modelSource`. No proxy is on
the critical path, because none was adopted.

## Acceptance criteria, honestly

The ticket lists nine. Where they stand after the spike:

| criterion | status |
|---|---|
| Hub session store inventoried | **done** — `docs/routing-eval-phase0.md` §1 |
| Sanitized replay set of 30-50 tasks, documented grading, local-only subset | **partial** — 25 validated tasks, under target; the local-only subset does not exist because no `local-only` task survived curation |
| Turn-type classification showing the real weak/strong split | **done** — 52,391 turns; 86.7% execution-shaped |
| `docs/routing-prior-art.md` with a build-vs-adopt call | **done** |
| Benchmark table for every model on the endpoint, by turn type, cost per task | **partial** — 5 models on 25 tasks (haiku, sonnet, dsv4 complete; opus-4-5 and qwen-3.8 in progress); not broken down by turn type |
| A local model serving behind an OpenAI-compatible endpoint via the `ai-windows` YAML | **partial** — Qwen3.8-27B on `maxai:8000` via vLLM, DeepSeek V4 Flash on `10.10.10.36:8888`; both deployed by hand |
| Working end-to-end routed session mixing local and cloud turns | **not done** — no router was ever run |
| Measured cost delta vs always-frontier, with a quality comparison | **done for cost** (the table above), **solid on quality** (n=25 for haiku/sonnet, n=2 for opus) |
| Rollback path documented | **done** — see below |

The two that matter for a decision — what routing costs, and whether a cheap
tier can do the work — are answered. The build-out ones are not, and the
recommendation is that most of them should not be built as specified.

## What this spike did not settle

- **Opus at scale.** Opus-4-6 was gated by a daily token quota (n=2). Opus-4-5
  is running the full 25-task set via Bedrock with better quotas — results
  pending. Whether opus hits 80%+ or 90%+ is unknown until this completes.
- **Cross-model retry.** The "try haiku, retry on sonnet" policy would reach
  21/25 in theory; whether the second model solves reliably on a retry (not just
  on a fresh attempt) is untested.
- **Switchyard was never run.** No prebuilt binary, no Rust toolchain on the
  box; a LiteLLM shim stood in for the translation and nothing exercised the
  routing algorithms themselves.
- **No sensitive/local-only subset was exercised** — no `local-only` task has
  survived curation, so the on-prem argument for local serving is still
  untested in practice.
- **DeepSeek V4 Flash is fast but nearly useless on this task set** (2/25).
  Whether this is fundamental to the model or a configuration/prompt issue is
  not investigated.
- **Qwen 3.8-27B is running** but needed two workarounds to function with Claude
  Code: a custom chat template for interleaved system messages and an effort
  override. Results pending.

## Where the spend actually is, and what to do about it

Measured over the 695-session archive, priced at opus-4-6 rates: **$8,505, or
$12.24 per session.** `cache_read` is **70.3%** of that; output is 14.2%.

That reframes the whole ticket. Cache reads are `turns x context`, and both
factors are independent of which model you pick — so **the model you run
multiplies the dominant term**, while a routing policy only re-allocates it.

Levers, ranked by measured saving:

| lever | saving | basis |
|---|---|---|
| Everything on haiku-4-5 | **80%** | measured on the cache probe; haiku is exactly 5x cheaper |
| Execution sessions on local Nemotron | up to **87%** of turns at $0 | 86.7% of turns are execution-shaped |
| Phase routing, one switch per session | **36%** | measured |
| Halve the fixed per-turn overhead | **12%** | 34,453 tokens x 61 turns/session, zero quality risk |
| QA subagents to haiku | **6.3%** | 9% of sessions, 4/5 recall at 1/5 cost |
| **Per-turn routing (what the ticket specifies)** | **8.2%** | measured; the cache penalty eats four fifths of it |

**The router is the smallest lever on the list and the most complex to build.**

### The overhead lever is free money

**34% of every turn's context is fixed** — system prompt, tool definitions and
instruction files — and it is re-read on all 61 turns of a median session:
2.1M cache-read tokens per session, $1.16 at opus rates, before any work
happens. Halving it costs nothing in quality, needs no routing, and applies to
every model at once. `CLAUDE.md` alone is 38,581 characters, 96% of the ceiling
this repo sets for itself.

### Recommended order

1. **Default sessions to haiku-4-5, retry failures on sonnet-4-5.** The actuator
   already exists (`modelSource`); only `spawn_ticket` needs it plumbed. haiku
   solved 18/25 and committed 18/25. Sonnet as retry catches 3 more tasks haiku
   misses (and vice versa), reaching 21/25 (84%) at ~1.4x haiku-only cost.
2. **Send QA subagents to haiku.** No classifier needed, no cache gap, 4/5
   recall.
3. **Trim the fixed overhead.** Pure housekeeping, ~12%, no risk.
4. **Reserve opus for tasks both cheaper models fail.** The gateway's daily token
   quota limits it to ~2 tasks/day; that makes it an escalation, not a default.
   It cracked the hardest task (xerk-122) at n=2.
5. **Local Nemotron for well-scoped execution work**, where failure is cheap and
   mechanically detectable.
6. **Do not build per-turn routing.**
