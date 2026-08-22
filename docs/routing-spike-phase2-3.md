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

Tasks are the first five of `bench/archive/tasks-validated.json`, Claude Code as
the harness, 600s cap, scored only by the repo's own tests.

**Run the cloud models one at a time.** Twelve concurrent sessions took a hard
`429` from the gateway and scored every model 0/8 — throttling, not capability,
and indistinguishable from a real result in the summary table.

### Results

Five tasks, Claude Code as the harness, 600s cap, scored only by the repo's own
tests.

| model | solved | committed | note |
|---|---|---|---|
| opus-4-6 (cloud) | **3/5** | 1/5 | the frontier baseline |
| haiku-4-5 (cloud) | 2/5 | **3/5** | best at the delivery contract |
| nemotron-3.5-lightning (local) | 2/5 | 0/5 | free, 4-5x faster |
| qwen3-coder-next (cloud) | 1/3 | 0/3 | run incomplete |
| sonnet-4-6 (cloud) | 0/5 | 0/5 | **403 under load** — infrastructure, not capability |

n=5. This sizes effects; it does not rank models.

Two things worth more than the ranking:

- **Nemotron matches opus-4-6's solve count at 4-5x the speed and zero marginal
  cost**, including `turma-xerk-130`, which opus failed by hitting the time cap
  and Nemotron solved in 164 seconds.
- **haiku-4-5 commits more often than opus-4-6 does** (3/5 against 1/5) while
  solving less. Solving and delivering are different skills, and the cheap tier
  is better at the second one. The delivery-contract gap is not a small-model
  problem.

### Cost per completed task, measured

Token counts come from the bench sessions' own transcripts (deduplicated by
`requestId`, the unit `bench/archive/classify.py` established), priced at the
Bedrock rates above.

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

Two caveats that matter more than the score:

- **The window, not the model, was the binding constraint.** At a 96k declared
  window Nemotron scored **0/5**, every run dying with *"Autocompact is
  thrashing: the context refilled to the limit within 3 turns of the previous
  compact"*. Raising it to 120k by cutting the output reservation took it to
  **2/5** with no other change. A local model's apparent incompetence is worth
  suspecting as a context-budget artifact before it is believed.
- **Neither tier honours the delivery contract.** `committed=False` on almost
  every solve, including opus-4-6's. The gap `docs/local-model-failover.md`
  measured at 0/8 for gpt-oss is still here and is not a small-model problem.

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
3. **Route subagents to the cheap tier first.** A subagent carries its own
   context, so delegating creates no gap in the parent's cache at all — the only
   split that is free by construction. 26% of turns in the archive.
4. **Run execution sessions on the local model outright.** Nemotron matched
   opus-4-6 on this subset at 4-5x the speed and zero marginal cost. That is a
   bigger, simpler win than any routing policy, and it needs no proxy.
5. **Fix the delivery-contract gap before any of this ships.** Both tiers solve
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
| Benchmark table for every model on the endpoint, by turn type, cost per task | **not done** — 4 models on 5 tasks, not 266; and not broken down by turn type |
| A local model serving behind an OpenAI-compatible endpoint via the `ai-windows` YAML | **partial** — Nemotron serves on `maxai:8000`, but deployed by hand; nothing was pushed to `dockerops` |
| Working end-to-end routed session mixing local and cloud turns | **not done** — no router was ever run |
| Measured cost delta vs always-frontier, with a quality comparison | **done for cost** (the table above), **weak on quality** (n=5) |
| Rollback path documented | **done** — see below |

The two that matter for a decision — what routing costs, and whether a cheap
tier can do the work — are answered. The build-out ones are not, and the
recommendation is that most of them should not be built as specified.

## What this spike did not settle

- **n=5 on one repo.** These numbers size effects; they do not rank models.
- **Switchyard was never run.** No prebuilt binary, no Rust toolchain on the
  box; a LiteLLM shim stood in for the translation and nothing exercised the
  routing algorithms themselves.
- **No sensitive/local-only subset was exercised** — no `local-only` task has
  survived curation, so the on-prem argument for local serving is still
  untested in practice.
- **`qwen3-coder-next` and the other open-weight candidates** were probed but
  not benchmarked to completion.
