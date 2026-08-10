# OpenCode coding-agent model eval — August 2026

> **The coding-agent recommendation here is superseded by
> `docs/local-model-failover.md` (XERK-246).** This eval never varied the
> HARNESS — every model ran under OpenCode — and it ran OpenCode on the GPU box
> against `localhost:9402`, which no agent host can reach. Over the gateway a
> host must actually use, the config below fails outright: the address does not
> resolve, and `reasoningEffort` is a hard 400 from LiteLLM. A six-harness
> bake-off since found OpenCode cannot reliably reach that gateway at all, and
> that Claude Code pointed at the local model beats it and everything else.
> `opencode.json` and `OPENCODE_CONTRACT.md` have been deleted.
>
> **Everything else here still stands** — the cue/translation model choice, the
> serving architecture, the vLLM/CUTLASS findings and the Ollama concurrency
> numbers are unaffected.

Which local model should power OpenCode sessions for the Turma fleet on the
RTX 6000 Pro (96 GB) GPU box — **Qwen3.6-27B at BF16** or **poolside Laguna
XS 2.1 (33B-A3B MoE) at BF16** — and what happens to Tenir cue + translation
quality if that model displaces the resident cue model. Run 2026-08-03.

## Setup

- **Coding benchmark**: 8 SWE-bench-style tasks curated from real Turma/Tenir
  git history (revert a shipped fix, hand the agent the original user-voice
  problem statement, score with the repo's own regression tests overlaid
  post-hoc). Task mix mirrors the mined taxonomy of 212 real Turma sessions
  (94% of agent work is Turma+Tenir; ~28% bugfix, ~26% feature, ~20% UI tweak;
  84% of sessions end in branch+commit+PR): 4 bug fixes, 2 features, 1
  test-writing task (mutation-validated), 1 compose/YAML task. Agent harness:
  **OpenCode 1.18.11** against Ollama 0.32.5 (`/v1`), 25-min cap per task, one
  retry for stalled runs. The delivery contract (branch + commit, no push)
  mirrors real sessions.
- **Cue eval**: the frozen-replay harness from Tenir tag `v0.3.19`
  (`scripts/cue_eval/`, prompt v15.2), on a fresh export of the frozen
  6-conversation set **plus** the two bilingual real sessions (`dbc3080e`,
  `7ca38157`) as translation fixtures — 1105 attempts per model. Protocol
  validation: the frozen-6 subset reproduced the documented 795 attempts
  exactly, and the gpt-oss baseline re-scored within noise of the July numbers
  (145 cues vs 150 documented).
- **Judging**: all three replays judged by the same judge (gpt-oss:120b,
  reasoning low) — self-judge for the baseline, cross-family for both
  candidates; same caveat as July (treat scores comparatively).
- **Serving**: candidates + judge on an eval Ollama (hardlink clone of the
  prod volume). Qwen's cue replay ran on **vLLM** (`Qwen/Qwen3.6-27B`,
  `enable_thinking:false` via chat_template_kwargs) because Ollama's OpenAI
  surface ignores that kwarg and Qwen's thinking starves the 600-token cue
  budget (empty content on 100% of attempts). Laguna needed no workaround
  (thinking rides a separate channel).

## Coding-agent results

| task | Qwen3.6-27B BF16 | Laguna XS 2.1 BF16 | gpt-oss:120b (added 08-03) |
|---|---|---|---|
| turma-fix-01 (JS linkify bug) | **PASS** 6.6 min | **PASS** 6.2 min | **PASS** 1.5 min |
| turma-fix-02 (Py transcript slug) | fail ×2 (investigate-only stall) | fail ×3 (timeout) | fail ×2 (abandon; retry engaged, near miss) |
| tenir-fix-01 (Py resumed-session audio) | fail (wrong localization) | fail ×2 (stall) | fail (near miss)¹ |
| tenir-fix-02 (TS live-transcript drop) | fail ×2 (stall) | fail @64K → **PASS** @128K, 14 min | **PASS** 1.1 min |
| turma-feat-01 (JS kanban In Review) | fail ×2 (stall) | fail ×2 (near miss on retry) | fail ×2 (abandon; retry engaged, near miss) |
| tenir-feat-01 (Py music timeout) | fail (timeout; right files) | fail ×2 | fail (25 s near miss) |
| turma-testwrite-01 (JS regression tests) | **PASS** 4.6 min | **PASS** 2.3 min | **PASS** 0.9 min |
| bench-yaml-01 (compose parametrize) | **PASS** 4.1 min | **PASS** 1.0 min | fail (near miss ×2) |
| **Solved** | **3/8** (retries 0/3) | **3/8 first pass, 4/8 with 128K retry** | **3/8** (retries 0/2, both engaged) |

¹ gpt-oss solved tenir-fix-01 cleanly (35 s, validation green) in an aborted
warm-up pass and missed it in the official pass — real run-to-run variance in
both directions.

Process metrics: Qwen completed the branch+commit delivery contract on **3/3**
of its solves; Laguna on only **2/5** solve-or-near runs; **gpt-oss on 0/8**
(it repeatedly *claimed* the commit was made without doing it). Laguna is
2–4× faster per solved task than Qwen (MoE, 3B active); **gpt-oss is another
~4× faster still** — its whole 8-task pass took ~6 minutes of wall clock
versus multi-hour passes for both candidates.

gpt-oss's failure shape is unique: it makes one fast, surgical,
correctly-localized edit (right files on 7 of 8 tasks) and declares done
without running tests or iterating — so its misses are near-misses at speed,
where the candidates' misses are stalls and timeouts. Two harness notes:
its sessions initially died instantly (reasoning-only turns ending the
OpenCode loop) until `reasoningEffort` was set in the provider options, and
~25% of session starts still abandon instantly (a retry re-engages).

Failure modes, from the transcripts:

- **Qwen**: loses the agentic loop — reads files, then emits prose ("What
  would you like me to do with it?") with no tool call, which ends a
  non-interactive `opencode run`. Consistent across retries (0/3), not flaky.
- **Laguna**: explores aggressively and hits the context ceiling; at a 64K
  declared window OpenCode's auto-compaction collided with its tool calls
  ("Tool call not allowed while generating summary") and killed sessions. At
  128K (it supports 256K) one previously-failed task flipped to a clean pass.
  Its residual failures are fast wrong-conclusion stalls and one hard timeout.
- Neither model solved turma-fix-02 (cross-file Python state bug) in 6
  combined attempts — the ceiling for this class on both.

## Tenir cue + translation results (1105 attempts each, same judge)

| model | cues | emit% | novelty | relevance | accuracy | wrong | wrong-rate | judge dups | control cues | translation cues |
|---|---|---|---|---|---|---|---|---|---|---|
| **gpt-oss:120b @ medium (prod)** | **199** | 18% | 1.92 | 1.96 | **1.93** | 4 | **2.0%** | 3 | 20 | 1 explicit ES→EN |
| Qwen3.6-27B BF16 | 24 | 2% | 1.88 | 2.00 | 1.71 | 2 | 8.3% | 1 | 0 | **0** |
| Laguna XS 2.1 BF16 | 36 | 3% | 1.92 | 1.97 | 1.67 | 4 | 11.1% | 0 | 0 | **0** |

- Both candidates are near-mute (the July finding for Qwen, reproduced at
  BF16) and their few cues carry 4–5× the baseline wrong-rate — the
  knowledge-frontier confabulation class the July eval documented: Qwen
  falsely "corrects" that the Z Fold 8 doesn't exist; Laguna invents an
  "OverObjects" library, a Netflix/Hystrix "7-day timeout", 1:1 Apple camera
  sensors, and mis-attributes Fruity Pebbles to General Mills.
- **Translation cues are lost entirely under either candidate**: on the
  bilingual family session the baseline translates spoken Spanish
  ("Se te va a olvidar" → "you'll forget it"); both candidates produce zero
  translation cues on both bilingual fixtures.
- The candidates' control discipline is good (0 cues on all three controls) —
  they are precise but silent, which the July eval already established is not
  the product goal.

## Latency (warm, quiet GPU, cue-sized calls)

| model | serving | mean s/call |
|---|---|---|
| gpt-oss:120b @ medium | Ollama | 3.67 (probe; July prod measured 1.4–2.0 at 16K ctx) |
| Qwen3.6-27B BF16 (no thinking) | vLLM | 2.41 |
| Laguna XS 2.1 BF16 (native thinking) | Ollama | 7.47 (short prompt) — 32.7 on real cue prompts |

Laguna's full-replay mean was 32.7 s/call — it thinks ~2K characters before
every cue attempt, which is unusable for the serialized per-session cue loop
regardless of quality. Ollama does not honor think:false for Laguna (probe still produced 3,060 chars of reasoning and returned empty content) — the thinking cost is intrinsic to serving it on Ollama, and long thinking can starve the 600-token cue budget entirely.

## Recommendation (revised after the gpt-oss coding run)

1. **Leading option — one model for everything: gpt-oss:120b.** It equals
   both candidates' solve count (3/8), is ~4–25× faster per task, and is the
   only model on the box that also delivers cue + translation quality. It
   would serve coding and cues from the SAME resident instance — no VRAM
   conflict, no cue outages during coding sessions. Deployment change:
   raise `OLLAMA_CONTEXT_LENGTH` on `tenir-gpu.yaml` from 16384 to 65536
   (measured ~69 GB with the STT co-tenants still fitting; validate with a
   quick cue replay per the compose's own pinning policy). Required OpenCode
   config: `reasoningEffort` set in provider options (without it sessions die
   instantly), an instruction nudge to actually run tests and commit (it
   skipped the delivery contract on 8/8 runs and sometimes claims a commit it
   didn't make — the Turma wrapper should verify `git log` after each
   session), and a one-retry policy for instant-abandon session starts
   (~25% of starts).
2. **If a dedicated coding model is still wanted: Laguna XS 2.1 at ≥128K
   context** — matches Qwen's solves at much lower latency and its one extra
   solve came from a config fix, not luck. But it cannot co-reside with
   gpt-oss at BF16 (test nvfp4/19 GB first), and its slow, unstoppable
   thinking disqualifies it for cues.
3. **Neither candidate replaces gpt-oss for Tenir cues or translation.**
   Both are ~8× quieter with 4–5× the wrong-rate, and translation cues
   disappear entirely. Keep `Tenir-Ollama-Cue` on gpt-oss regardless of the
   coding choice.
4. Honest caveats: 8 tasks is a small n; solve rates near 3/8 have wide error
   bars — but the qualitative failure modes (Qwen's loop-loss, Laguna's
   context hunger) were consistent across retries, and the cue verdict
   replicates a prior independent eval.

## Artifacts

- Replays/judgments: `replay_{gptoss_medium,qwen,laguna}(.judged).json`
- Coding runs: `bench/runs/` (per-task transcripts, diffs, validation logs)
- Bench harness: `bench/run_bench.py`, `bench/tasks.json` (8 verified tasks),
  `bench/METHOD.md`
- Session-history taxonomy: mined 2026-08-03 from `~/.claude/projects`

## Serving architecture for the shared gpt-oss instance (added 2026-08-04)

Question: with cues, translation, and many concurrent coding agents on one
model, what should serve it — vLLM, Ollama, dedicated llama.cpp, or other?
(The STT models have moved off this host; the GPU is fully gpt-oss's.)

**vLLM: still cannot load this model on this card — re-verified today.**
vLLM 0.26.0 selects the `MARLIN` MXFP4 MoE backend for SM120 and the
load-time repack transiently OOMs the 96 GB card, exactly as in July
(DockerOps #104–#108). The community SM120 recipe
(`FLASHINFER_CUDA_ARCH_LIST=12.0f` + `--enforce-eager`) and the MoE-backend
override envs were both tried; the envs are unknown to this build and Marlin
is still chosen. Blocked upstream on vllm#31085 (SM120 native NVFP4 MoE
kernel selection). vLLM serves *non-MXFP4* models fine here (the Qwen cue
replay ran on it), so it stays the tool for other HF models.

**Ollama concurrency, measured** (eval instance, ctx 65536, 8 parallel
slots, 85 GB loaded — comfortable on the now-dedicated card):

| scenario | result |
|---|---|
| cue-sized call, idle | 4.6 s |
| 8 concurrent cue calls | p50 31.8 s |
| 6 concurrent coding streams | ~112 tok/s aggregate |
| cue latency under 6 active coders | p50 13.3 s (3× idle) |

Aggregate throughput is flat (~120 tok/s) regardless of concurrency —
llama.cpp gets no real batching gain on this MoE (decode is bound by
streaming 65 GB of weights), so every active coding agent directly taxes cue
latency. A dedicated llama.cpp (`llama-server`) container is the same engine
with the same ceiling; it buys slot metrics and finer knobs, not throughput,
and loses Ollama's operational fit (existing compose, LiteLLM alias, model
management). TRT-LLM/SGLang have the same SM120 kernel gap or a much heavier
bring-up on WSL2.

**Recommendation: keep Ollama, tuned for multi-tenant use.**

1. In `tenir-gpu.yaml`: `OLLAMA_CONTEXT_LENGTH=65536`,
   `OLLAMA_NUM_PARALLEL=8`, keep `OLLAMA_KEEP_ALIVE=-1` and the pinned image.
   Quality at this config is already validated — the August cue-replay
   baseline ran on 0.32.5 at 65536 ctx and reproduced the July scorecard.
2. Cap concurrently *generating* coding agents (Turma-side) at ~2–3 during
   active listening hours — measured cue p50 stays in the 6–8 s band there,
   vs 13 s at 6 coders. Agents idle between tool calls cost nothing; the cap
   only needs to bound simultaneous generations.
3. ~~Re-test vLLM when vllm#31085 lands~~ — corrected 2026-08-04: #31085 is
   a dead end (its companion PR #31089 was closed unmerged; maintainers treat
   Marlin as the intended SM120 path, so the actual stock-vLLM bug is the
   Marlin load-time OOM — the 96 GB/SM120 repro belongs on vllm#30135 or
   #33155, not #31085).

### The CUTLASS fork test (2026-08-04)

The community workaround — `christopherowen/spark-vllm-mxfp4-docker` rebuilt
with `FLASHINFER_CUDA_ARCH_LIST="12.0f"` (single arch, the make-or-break
detail), served with `--mxfp4-backend CUTLASS --mxfp4-layers moe,qkv,o,lm_head
--attention-backend FLASHINFER --kv-cache-dtype fp8 --enforce-eager` — **does
load and serve gpt-oss-120b on this card**: first vLLM to do so here. 90 GB
at 64K ctx / 32 seqs; harmony parsing correct (valid JSON cues, reasoning in
its own channel); survived the whole benchmark, no illegal-memory-access
crashes. Same workload-shaped scenarios as the Ollama run:

| scenario | Ollama (0.32.5) | vLLM fork (CUTLASS) |
|---|---|---|
| cue call, idle | **4.6 s** | 8.4 s |
| 4 concurrent cues (p50) | 25.5 s | **8.5 s** |
| 8 concurrent cues (p50) | 31.8 s | **6–8 s** |
| 6 coding streams, aggregate | 112 tok/s | **304 tok/s** |
| cue p50 under 6 coders | 13.3 s | **8.6 s** |

Reading: the fork's continuous batching scales (~flat latency to 8 streams,
3× aggregate throughput) where llama.cpp collapses — but eager-mode
single-stream decode is ~2× slower than Ollama, and cues run alone most of
the day. At the current fleet scale (≤3 concurrent coding generations) the
two are roughly a wash, so **Ollama stays the shipped stack** (official
image, pinned, zero build maintenance). The fork is the validated escape
hatch: flip to it when the coding fleet regularly runs >3–4 simultaneous
generations. It is a locally-built dev-branch image (v0.1.dev12770) — pin
the built image by digest and re-run the cue replay before ever shipping it.

## Optimization iteration (2026-08-04)

A second pass over the shipped stack (Ollama 0.32.5, one resident
gpt-oss:120b serving cues + translation + OpenCode) asking: what makes the
coding agent better *without* taxing cue latency? Findings, in decreasing
order of consequence.

### What OpenCode requests actually run with (sampler audit)

Reading the runner's per-request sampler dumps in the container logs:

- Ollama's `/v1` surface honors the OpenAI sampling fields (`temperature`,
  `top_p`, `frequency_penalty`, `presence_penalty`) but **silently ignores
  Ollama-native ones** (`repeat_penalty`, `top_k`, `min_p`). Every `/v1`
  request — cues, translations, coding — runs with the model defaults
  `repeat_penalty=1.1, top_k=40` baked in, non-overridable per request.
- OpenCode sends `temperature: 0` by default, so the whole August bench ran
  greedy + repeat-penalty — not the gpt-oss model-card recipe (temp 1.0).
- **Tested: the model-card recipe does NOT transfer to this stack.** With
  `"agent": {"build": {"temperature": 1.0}}`, the agent degraded sharply:
  hallucinated tool names, a malformed diff-literal edit (wrote `+`-prefixed
  patch lines into a file), 15–30 s rush-sessions, 0/4 tasks solved vs 2/4
  for the same tasks at temp 0. Plausible mechanism: the non-removable
  repeat_penalty distorts logits; greedy argmax usually still lands on the
  right token, but temp-1.0 sampling turns the distortion into errors.
  **Keep OpenCode's temp-0 default when serving through Ollama `/v1`.**

### Declared-context mismatch (bug, fixed)

The eval config declared `"limit": {"context": 131072}` while the server
runs 65536. OpenCode triggers compaction off the *declared* limit, so a
session crossing 64K would be silently truncated server-side instead of
compacted. Fixed to 65536 in the shipped config. Compaction is affordable:
prefill measures ~6,100 tok/s, so a worst-case 60K re-prefill costs ~10 s.

### Prefix caching: already solved, nothing to tune

Ollama 0.32.5's runner does LCP slot selection with idle-slot state
save/restore. Measured on prod: a growing agent conversation pays
~0.6–1.0 s/turn out to 21K tokens (only the newest chunk prefills), and
four interleaved sessions don't thrash each other's slots. Agent loops are
cheap on this stack.

### Serving variants tested and rejected (eval window; prod restored after)

- **`OLLAMA_KV_CACHE_TYPE=q8_0` + ctx 131072 × 8 slots**: fits (87.2 GB —
  q8 halves per-token KV, so double context costs the same ~19 GB), loads,
  cue JSON + ES→EN translation sanity pass, idle cue latency identical
  (4.6 s). But it taxes the guardrail metric: worst-case cue latency under
  6 coding streams 21–23 s across 3 reps vs ≤16.7 s on f16, and coding
  aggregate 97–132 vs 154–168 tok/s. **Not shipped.** Revisit only if
  coding sessions regularly hit the 64K ceiling — and gate on a full cue
  replay (numerics change).
- **`num_batch` 2048**: prefill 5,700–5,800 tok/s vs ~6,100 at the default
  512. Dead end.
- DockerOps PR #132 records both rejections next to the knobs they concern.

### Why gpt-oss never committed (transcript forensics)

Baseline transcripts show the delivery-contract failures are not
disobedience: sessions die on hallucinated tool calls (`search`, `node`,
`git`) — the model invents a tool, gets an invalid-tool error, then emits a
reasoning-only turn, which ends a non-interactive `opencode run`. Two
mitigations were built and measured:

1. an instructions file (`OPENCODE_CONTRACT.md`) that enumerates the exact
   tool set and routes every command through bash, plus the delivery
   contract;
2. an orchestrator-style **delivery nudge**: if the session ends without a
   commit, `opencode run --continue "finish the delivery contract"` once.

### Bench: optimized configs vs baseline (same 8 tasks, attempt-level)

| config | attempts | solved | committed | instant abandons |
|---|---|---|---|---|
| baseline (temp 0, no contract) | 14 | 4 (29%) | **0** | 4 |
| temp 1.0 (model-card recipe) | 4 | 0 | 0 | 1 |
| contract v1 (prose only) | 8 | 1 | 0 | 2 |
| **contract v2 (tool list) + nudge** | 16 | 5 (31%) | **8 (50%)** | 2 |

Solve rate is model-capability-bound (~30% however configured — per-attempt
variance is high; the same task flips between solve/fail/abandon across
identical runs). What the optimization actually buys: **delivery-contract
compliance 0% → 50%**, fewer instant abandons, and no cue-latency cost
(bench load is the production coding load the concurrency section already
budgets for). Even nudged sessions still sometimes die one step short
(observed: branch created, then a hallucinated `git` tool call kills the
session before commit) — so the Turma orchestrator should loop the nudge
until delivered or N attempts, not fire it once.

### Shipped configuration

Committed at the repo root:

- `opencode.json` — provider `local` → `http://localhost:9402/v1`,
  gpt-oss:120b with `reasoningEffort: medium`, declared context 65536
  (matching the server), no temperature override, instructions
  `["CLAUDE.md", "OPENCODE_CONTRACT.md"]`.
- `OPENCODE_CONTRACT.md` — unattended-run contract: exact tool list, every
  command via bash, always end with branch + commit, never end a turn with
  a question.

Orchestrator guidance for the build-out: cap concurrently *generating*
coding sessions at ~2–3 (per the concurrency physics above), and after each
`opencode run`, verify delivery (`git log base..HEAD`) and `--continue`-nudge
until the commit exists (bounded retries).
