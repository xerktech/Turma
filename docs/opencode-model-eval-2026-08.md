# OpenCode coding-agent model eval — August 2026

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

| task | Qwen3.6-27B BF16 | Laguna XS 2.1 BF16 |
|---|---|---|
| turma-fix-01 (JS linkify bug) | **PASS** 6.6 min | **PASS** 6.2 min |
| turma-fix-02 (Py transcript slug) | fail ×2 (investigate-only stall) | fail ×3 (timeout) |
| tenir-fix-01 (Py resumed-session audio) | fail (wrong localization) | fail ×2 (stall) |
| tenir-fix-02 (TS live-transcript drop) | fail ×2 (stall) | fail @64K → **PASS** @128K, 14 min |
| turma-feat-01 (JS kanban In Review) | fail ×2 (stall) | fail ×2 (near miss on retry) |
| tenir-feat-01 (Py music timeout) | fail (timeout; right files) | fail ×2 |
| turma-testwrite-01 (JS regression tests) | **PASS** 4.6 min | **PASS** 2.3 min |
| bench-yaml-01 (compose parametrize) | **PASS** 4.1 min | **PASS** 1.0 min |
| **Solved** | **3/8** (retries 0/3) | **3/8 first pass, 4/8 with 128K retry** |

Process metrics: Qwen completed the branch+commit delivery contract on **3/3**
of its solves; Laguna on only **2/5** solve-or-near runs (it routinely skips
the commit step). Laguna is 2–4× faster per solved task (MoE, 3B active).

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

## Recommendation

1. **Coding agent for the Turma OpenCode build-out: Laguna XS 2.1**, served
   with a ≥128K context window. It matches Qwen's solve count at a fraction
   of the latency, wins the only retry-recoverable task, and is the only
   candidate whose failures improved with a config change rather than a
   capability wall. Two required harness settings: declare the full context in
   the OpenCode model config (compaction collisions killed sessions at 64K),
   and add an instruction nudge to always finish with branch+commit (it skips
   the delivery contract that Qwen reliably honors).
2. **Neither candidate should replace gpt-oss:120b for Tenir cues or
   translation.** Both are ~8× quieter with 4–5× the wrong-rate, and
   translation cues disappear entirely. Keep `Tenir-Ollama-Cue` as-is.
3. **They can't co-reside**: gpt-oss (65 GB resident) + either candidate
   (55–67 GB) exceeds the 96 GB card. Options, in order of preference:
   (a) run the coding model on-demand with Ollama keep-alive unpinned and
   accept a ~60 s cold-load when a coding session starts while cues idle;
   (b) run Laguna at a smaller quant (q8_0 is 36 GB — would co-reside with
   gpt-oss at ~101 GB… still over; nvfp4 at 19 GB fits with ~12 GB headroom)
   and re-run this benchmark at that quant before committing; (c) a second
   GPU. Note 3(a) means cue outages during long coding sessions — the same
   trade this eval measured.
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
