# Routing eval, Phase 0 — the session archive, and what it says about routing

XERK-445 Phase 0. What is in the Turma hub's session store, what our own agent
traffic actually looks like when you classify every turn in it, and a replay
task set built from that history.

**The headline is not the turn split. It is that 97.9% of our tokens are cache
reads, which makes per-turn model routing — the thing the ticket sets out to
build — cost more than it saves.** That finding is below, with the arithmetic.

Tooling lives in `bench/archive/`; it is re-runnable and committed.

## 1. Inventory of the session store

Measured 2026-08-22 against the live hub (`turma-*` pod, namespace `ai`,
`/data/archive`). Layout and invariants are documented in
`.claude/rules/turma-archive.md`; this is the volume.

| | |
|---|---|
| Store size | **862 MB** (+ 60 MB `index.db`, which is outside the archive ceiling) |
| Indexed sessions | **2,519** rows |
| Rendered transcripts on disk | 1,635 `.jsonl` |
| Raw session directories | 1,378 `.jsonl.raw/` |
| Raw session JSONL | 1,628 files, **565.8 MB** |
| Other raw files (tool results, workflows) | 451 files, 15.3 MB |
| Repo folders | 105 |
| Retention | no expiry; oldest content is from the store's creation |

Rows exceed files because a transcript that never received a rendered chunk is
indexed with no `filePath` — expected, per the archive rules.

**By repo** (index rows): `(root)` 1,207, Turma 330, `.turma` 325, Tenir 133,
`?` 127, DockerOps 115, ArgoCD 27, Foverlay 23, tesoro 20, AgentHub 17.

**By host**: truenas 1,378, MaxAI 596, MAXAI 421 (the same host under two
casings — worth normalising), TXP-ENG-9558 47, MXH-T16 34, k8x 15.

### Two layers, and which one to use

The rendered layer is a projection — `{uuid, role, ts, text, blocks[]}` — and
**carries no token counts and no model**. Any cost analysis must use the raw
layer, which is the untouched Claude Code JSONL: `message.model`,
`message.usage`, `requestId`, `cwd`, `gitBranch`, `isSidechain`. XERK-338's
decision to keep raw bytes "whether or not anything reads it yet" is what made
this phase possible at all.

### Only 695 transcripts are substantive

Of 1,628 raw transcripts, **933 contain no assistant turn at all** — 60% have a
single line. These are sessions that were created and never ran a turn. The
usable corpus is **695 transcripts**. Any per-session statistic taken over the
file count rather than this number is understated by more than half.

## 2. Turn classification

`bench/archive/classify.py`, over all 695 substantive transcripts.

### The unit is a requestId, not a transcript entry

Claude Code writes **one entry per content block**, so one assistant message
arrives as 2–3 entries sharing a `requestId`. Measured over the corpus, the
three input-side counters repeat the *same* value on every entry of a group
while `output_tokens` grows to a final cumulative figure. Summing entries
therefore triple-counts the prompt: the first run of this analysis reported
**21.1 billion** tokens and 102,582 "turns" against the true 11.1 billion and
52,391. It also mislabeled 39% of the corpus as "summarization", because the
text half of a split turn looks like prose with no tools.

A `requestId` group is one API call, one billed unit, and one routing decision.
That is the unit here.

### The split

52,391 turns across 695 transcripts:

| category | turns | turn% | output tokens | out% |
|---|---|---|---|---|
| `tool_exec` | 36,396 | 69.5% | 28,062,095 | 63.7% |
| `code_edit` | 5,433 | 10.4% | 6,800,448 | 15.4% |
| `error_recovery` | 5,071 | 9.7% | 3,913,905 | 8.9% |
| `file_read_search` | 2,290 | 4.4% | 1,218,337 | 2.8% |
| `planning` | 1,670 | 3.2% | 2,161,557 | 4.9% |
| `narration` | 722 | 1.4% | 185,606 | 0.4% |
| `summarization` | 562 | 1.1% | 1,253,282 | 2.8% |
| `delegation` | 247 | 0.5% | 439,499 | 1.0% |

**The ticket's premise holds.** Execution-shaped turns (`tool_exec`,
`code_edit`, `file_read_search`, `narration`, `summarization`) are **86.7% of
turns and 85.2% of output tokens**. Planning, error recovery and delegation —
the turns that plausibly need a frontier model — are 13.3% of turns and 14.8% of
output. `Bash` accounts for 44,804 of the corpus's 56,053 tool calls (79.9%), and 40,594 of the 52,391 turns call it at least once.

Sidechain (subagent) turns are **26.0%** of the corpus. Models seen:
`claude-opus-5` 39,359, `claude-fable-5` 7,140, `claude-opus-4-8` 4,016, plus
~1,455 turns already served through Bedrock via the gateway.

`narration` is not one of the ticket's six categories. It had to be added: short
prose between tool calls ("Now the payload generator:") is execution glue, and
filing it under "formatting/summarization" is what produced the false 39%.

## 3. The finding that changes the design

Token composition across the corpus:

| | tokens | share |
|---|---|---|
| `cache_read` | 10,874,301,521 | **97.9%** |
| `cache_creation` | 190,840,882 | 1.7% |
| `output` | 44,034,729 | 0.4% |
| `input` (uncached) | 809,819 | 0.007% |

Price-weighted at Anthropic's published ratios (cache read 0.1x base input,
cache write 1.25x, output 5x), cache reads are still **70.3%** of the bill;
output is 14.2%.

Per-turn input-side context: p50 **163,030**, p90 416,631, max 999,888 —
consistent with `claude-opus-5[1m]`. 39.8% of turns carry over 200k tokens of
context.

### Why per-turn routing loses

**This section was derived from archived token counts and then measured
directly against the gateway. The conclusion held; the mechanism did not.**

The original reasoning was that routing turn *N* to a different model leaves it
with no prompt cache, so it re-ingests the whole conversation at cache-creation
price — putting break-even at tens of turns. **That is wrong.** Measured:

- **Prompt caches are per-model and independent.** Switching away does not
  invalidate the origin model's cache. Coming back to it within the TTL reads
  from a still-warm cache and is charged nothing extra (`cache_creation=0`,
  `cache_read=30,615` on the return turn).
- **In a growing conversation each turn creates cache for the DELTA only**, not
  for the whole context — 6,776 tokens per turn in the probe, against a context
  that reached 40k.

The real penalty is narrower and still decisive: **a model that skipped a turn
must create cache for the turns it missed.** Alternating two tiers therefore
makes *both* of them pay for the gaps, and cache-creation volume goes up.

Six turns of growing context, `bench/archive/` probe, salted so no scenario
reads another's warm cache:

| scenario | tier split | cache_create | vs always-frontier |
|---|---|---|---|
| A — always frontier (opus-4-6) | 100/0 | 40,657 | — |
| B — per-turn alternating opus/haiku | 50/50 | **74,538** | **-8.2%** |
| D — phase routing, 3 opus then 3 haiku | 50/50 | 60,449 | **-36.3%** |
| C — all-cheap (haiku-4-5) | 0/100 | 40,657 | **-80.0%** |

**B and D move the same half of the turns to the same cheap model.** The only
difference is how often the tier changes, and it is worth 4.4x.

Alternating raises cache creation **1.83x**. haiku-4-5 is exactly **5x** cheaper
per token than opus-4-6 ($1.10/$5.50 in, $5.50/$27.50 out), so moving half the
turns onto it should save something like 40%.

**It saves 8.2%.** The cache-creation penalty eats four fifths of the benefit —
while the same split applied as one phase switch saves **36.3%**. Simply
*staying* on the cheap tier saves **80%**.

So the ticket's instinct — push execution turns down — is right, and the
turn-by-turn way of doing it is the one shape that cannot pay. What saves money
is committing to a tier and staying there:

- **Route per session or per phase**, so a switch is amortised over many turns.
  NVIDIA's own calibrated profile does this (`classify_trigger = "user_turn"`,
  holding the target across the tool calls between); `new_session` classifies
  once. See `docs/routing-prior-art.md`.
- **Subagent routing is still the cache-safe split**, and for a stronger reason
  than first stated: a subagent has its own context, so pinning delegated work
  to a cheap tier creates no gap in the parent's cache at all. 26% of turns.
- **`llm_classifier` per turn is the worst shape available** — it adds a model
  call *and* maximises the number of gaps.

Caveat: the local tier is self-hosted, so its own re-ingestion costs GPU time
rather than money, and vLLM runs with `--enable-prefix-caching`. The figures
above are the cost on the **cloud** side, which is the side with a bill.

## 4. The replay task set

`bench/archive/curate.py` -> `bench/archive/tasks-archive.json`.

### Construction, and how it avoids leaking the answer

The ticket's hard problem is that a transcript contains its own answer. The two
halves of each task therefore come from different places:

- **Intent** — the session's *first user message*, scrubbed. The real ask, in
  the user's words, before any work happened. Nothing from the body of the
  transcript is included.
- **Grade** — the repo's own regression tests at the merge commit that session
  produced. Check out the merge, revert only the implementation files to its
  parent, and the tests must go **red then green**.

This reuses the mechanical contract in `bench/METHOD.md`, so the new set is a
drop-in for the committed `run_bench.py`. No model judges anything.

A session qualifies only if it **landed**: a merge commit touching both
implementation and test files. That is what "known-good outcome" means here.

### The leak gate, and why the construction alone was not enough

The argument above is sound in principle and **was not sufficient in practice**.
It assumes the first user message is a user's ask. In this corpus it frequently
is not: many sessions are started with a Jira ticket pasted in whole — often
carrying an implementation spec, function signatures and constant names — and
many others are QA invocations that name the files under test.

It took two goes to close. A first cut shipped 30 validated tasks of which **14
named a file they reverted and 11 named the test that graded them**. A second
cut still shipped two, because the QA pattern anchored on `QA the|this` and so
missed `QA branch X` and `Final QA pass on X` — and a QA invocation is not a
task in either direction, since an agent replayed on "QA branch X" never writes
the change the suite grades.

`_leaks_answer()` is therefore a hard gate, rejecting on evidence rather than on
wording. A prompt is dropped if it contains any path in `revert_paths` or a
distinctive basename of one, names a grading test file, **echoes two or more
identifiers the merge itself adds** (which is what a ticket carrying an
implementation spec looks like), or matches a QA-invocation or research-ask
shape. `bench/tasks.json`'s own contract already required most of this: the
prompt carries "no file paths, no solution sketch, and no hint that regression
tests for it already exist".

It cost 51 candidates and it is not optional. A benchmark that hands over the
answer reports a cheap model doing well at reading.

### Yield

From 1,628 transcripts: **57 curated tasks** (Turma 27, Tenir 29, Veiller 1).
Drops, in order: 288 repo not cloned locally, 149 no merge commit for the ticket
key, 114 no ticket key, **51 answer leak**, 17 no impl+test pair, 7 no derivable
test command, 6 no usable intent, 6 duplicate sessions.

### Validation — the set that actually grades

Curated is not validated. Every task is gated by `bench/validate_tasks.py`,
which proves red-with-fix-reverted and green-with-fix:

| repo | validated | of curated |
|---|---|---|
| Turma | **25** | 27 |
| Tenir | 0 | 29 — blocked on XERK-449, see Limitations |
| Veiller | 0 | 1 — suite exceeded the cap |
| **total** | **25** | 57 |

**`bench/archive/tasks-validated.json` is the eval set** — 25 tasks, each proven
to go red then green, and each past the answer-leak gate. `tasks-archive.json`
keeps the full curated pool, and the `--report` ledger records every rejection
and its reason, so the gate's decisions stay auditable.

Mix: 16 change, 6 feature, 3 bugfix; Python 9, Kotlin 8, JS 2, TS 2, other 4.

**This is short of the ticket's 30–50 target, and the shortfall is real.** The
leak gate cost 51 candidates and the Tenir bootstrap costs 29 more; neither is a
corner to cut, since a leaking task and an ungradeable task both measure
nothing. The route to the target is XERK-449 rather than a looser gate: Tenir's
29 candidates are already mined and would roughly double the set.

Both Turma rejections are suites that fail even with the real fix applied — a
derived `test_cmd` that does not match the change (see Limitations).

**A red must be confirmed by re-running that task alone** (XERK-450). The repo
has a genuinely flaky test — `control WS: a channel that pongs is kept past the
dead-after window` in `turma/tests/server.test.js`, measured at **1 failure in
10 runs standalone on an idle box**. Nine of the 25 validated tasks grade on
that suite and `validate_tasks.py` runs it twice per task, so a full pass has
roughly a **70% chance of at least one spurious failure**. A spurious failure
prints as "tests FAIL even with the real fix applied", which is exactly what a
genuinely broken task prints.

This has already produced two wrong results here: a pass taken while other work
ran showed four failures rather than two, and the two extra passed on their own —
which I first wrote up as resource contention. It is not. Contention makes it
likelier, but the flake fires on an idle machine too, so *"validate serially"*
is not the remedy and was wrong to state as one. **Re-run any failing task by
itself before believing it**, and treat XERK-450 as a prerequisite for trusting
an unattended benchmark run at all.

This answers the ticket's open question *"how much of the session archive is
replayable at all"*: **25 gradeable, non-leaking tasks from 1,628 transcripts —
under 2%**. The binding constraints are not the transcripts. They are whether
the repo is present, whether its suite runs without a bootstrap, and whether the
session's opening message was a user's ask rather than a spec.

### Sanitization

`bench/archive/scrub.py` redacts API keys (OpenAI, Slack, Google, npm), the
whole GitHub token family (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`),
AWS access keys **and secret keys**, JWTs, bearer tokens, private-key blocks
(including PGP variants and output truncated before its `-----END-----`),
`*.xerktech.com`, `xerktech.atlassian.net`, all RFC1918 ranges, host names,
emails, Jira `Assignee:`/`Reporter:` lines, and `/home` and `/mnt` paths.

Three properties are load-bearing and are pinned by `test_scrub.py`. The email
rule runs **before** the host rules, or `ops@mail.xerktech.com` keeps its local
part. Every quantifier is bounded — the unbounded version was quadratic, 14s on
80KB, i.e. a hang on the path everything leaving the box takes. And no rule may
fire on text holding no secret: `apiKey: process.env.ANTHROPIC_API_KEY` is not a
credential, and redacting it silently rewrites a benchmark prompt.

Both committed task files carry no credentials, no internal hosts or IPs, no
`atlassian.net`, no internal paths and no personal names. `sensitivity()` marks a task
`local-only` if it touches NCHFA, YPrime or Tesoro work — checked on the raw
text *before* scrubbing, since redaction would hide the fact that the task
concerns that work at all.

**No `local-only` task survived curation** (all 57 are `shareable`): the tesoro
sessions in the archive are not in locally cloned repos, so they never reached
the task stage. The mechanism is in place and untested against real sensitive
content — treat it as unproven until a sensitive repo is cloned and run.

## 5. Limitations

- **The eval set is Turma-only**, and at 25 tasks is under the ticket's 30–50
  target. Tenir is an npm-workspaces monorepo with no `node_modules`, so the
  derived `npx vitest` commands fail before reaching the code; its 29 candidates
  are real work, are kept in `tasks-archive.json`, and are unusable until
  **XERK-449** adds a bootstrap step.
- **`test_cmd` is derived from file extensions**, which is why Tenir failed and
  why some Turma tasks carry a suite that does not match their language (a
  Kotlin change graded by a JS suite). The validator rejects those rather than
  shipping them.
- **A merge commit is a coarse unit.** Some bundle unrelated files, so
  `revert_paths` can be broader than the fix. Files *added* by the merge are
  excluded from the revert set — `git checkout <parent> -- <added file>` errors
  — and a fix that is pure addition cannot be expressed as a red baseline at all.
- **Turn classification is heuristic**, from tools called and whether the prior
  tool result looked bad. It is deliberately the same information a signal-based
  router sees at decision time, so it measures what such a router could know,
  not ground truth about intent.
- **`cwd`/`gitBranch` come from the agent**, so a session that changed branch
  mid-run maps to whichever ticket key appeared first.
- The break-even figure uses Anthropic's published price *ratios*, not our
  invoice. The ratios are what the conclusion rests on and they are stable; the
  absolute numbers are not claimed.

## 6. What this phase does not do

Phase 3's benchmark table is not here — it needs a cloud tier to compare
against, and there currently is not one. Of 14 `bedrock-mantle/*` models on the
gateway, 9 answer and **the five `openai.gpt-5.x` entries return
`access_denied`** while `xai.grok-4.6` returns `not_found_error`. The gateway's
`claude-opus-4.5` / `claude-opus-4.6` groups report **no healthy deployments**,
and `gpt-oss:120b` cannot reach its backend. Details and the live-issue
consequences are in the XERK-445 findings; the routed-vs-frontier cost
comparison the ticket asks for cannot be measured until a frontier tier answers.
