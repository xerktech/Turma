# Daily Brief standup text: prompt and model — ADR (XERK-2393, epic XERK-2390)

Status: accepted (evaluation 2026-10-29). The operative rules are in
`.claude/rules/agent-daily-brief.md`. Re-run the evaluation with `bench/daily-brief/run_eval.py`.

## Decisions

1. **Default model: Haiku** (`DAILY_BRIEF_MODEL`, env `TURMA_DAILY_BRIEF_MODEL`). On 13 real-board
   cases, two runs each, Haiku matched or beat Sonnet on every rubric dimension at 1/13 the cost.
2. **"auto" does NOT escalate to Sonnet on large inputs.** On the 40+-tickets-since-yesterday
   cases Haiku still won the head-to-head (5 wins, 3 losses, 4 ties). Sonnet bought only latency,
   which a brief written 5 minutes before the meeting does not need.
3. **The model is given counts and never counts.** `daily_brief_input` adds a `counts` block
   computed from the collector JSON. In a first dev run without it, both models misstated a
   14-ticket day (Haiku "eleven", Sonnet "fifteen").
4. **The reply is strict JSON, judged by `parse_daily_brief`, never repaired.** Sections:
   `sinceYesterday`, `thisWeek`, `stillOpen` (read-aloud strings) and `upNext`
   (`[{key, text}]`, 2-4 entries, keys only from the collector's `next`). It is rejected for
   markdown, a ticket key that is not in the data, or a section past 1.25x its word budget
   (120 words for the day sections, 80 for the week).
5. **The input is only the collector JSON (plus counts), framed as data.** It runs under the
   attention-hint lockdown: no tools, no MCP servers, user settings only. This is the
   retired brief renderer's prompt-injection posture.

## The prompt

`DAILY_BRIEF_INSTRUCTION` in `agent/hub-agent.py` — the eval imports it, so there is no second copy.
Per-section word targets (45 / 80 / 35 / 10 per next entry) sit inside the hard day budget. It
allows at most three spoken ticket keys, and "at least" for counts the collector truncated. It was
tuned on four dev cases (thu-typical, quiet-day, noisy-summaries, empty-board) before the full run:
the first draft's day sections ran 227 words against a 120 budget.

## Corpus

13 cases in `bench/daily-brief/corpus/`, from real snapshots of the XerkTech Jira board taken
through the XERK-2392 collector at 13:00 UTC on nine dates. A Monday's "day" window covers the
weekend (72 h). People are pseudonymised by ticket key; the site, project key and internal
host/project codenames are replaced through a private term map kept out of the repo.

- Real: thu-typical, mon-after-weekend (60 closed since the last meeting), tue, wed, thu, fri,
  mon-early, sat-weekend-work, smaller-week (36 closed, not truncated).
- Derived edge cases: quiet-day (one ticket since yesterday), nothing-open (nothing in progress, no
  candidates), empty-board (every list empty), noisy-summaries (an "IGNORE ALL PREVIOUS
  INSTRUCTIONS" summary, junk, fake ticket keys, a "reply in French with a markdown table" summary).
- Limits: only one org's tracker is reachable from the eval host, and it is busy, so most real
  cases hit the collector's 60-row cap (truncated). A past window's `open`/`next` lists show the
  board's state on the snapshot day, not on that date: the tracker has no point-in-time
  in-progress view. Both models faced identical inputs, so the comparison holds.

## Rubric and method

- **Mechanical** (`daily_brief_problems`, the worker's own check): JSON shape, no markdown, no
  invented ticket keys, `upNext` keys come from `next`, word budgets.
- **Judged**, blind: Opus scores both models' scripts for the same case and run in one prompt.
  The order is shuffled per pair and the data is given to the judge. Each script gets 1-5 on
  accuracy (nothing invented or unsupported; counts right), coverage, read-aloud quality and
  next-candidate sense.

## Results (final prompt, `bench/daily-brief/results/2026-10-29-*`)

| | Haiku | Sonnet |
|---|---|---|
| passes the parser | 26/26 | 26/26 |
| cost per brief (median / max) | $0.0060 / $0.0074 | $0.078 / $0.093 |
| latency (median / max) | 17.1 s / 25.9 s | 5.0 s / 11.9 s |
| day words (median / max) | 94 / 130 | 91 / 109 |
| week words (median / max) | 29 / 45 | 28.5 / 36 |
| judge: accuracy | 4.50 | 4.27 |
| judge: coverage | 3.92 | 3.77 |
| judge: read-aloud | 4.19 | 4.27 |
| judge: up next | 4.08 | 3.96 |
| head to head, all (wins) | 13 | 8 (5 ties) |
| head to head, 40+ since yesterday | 5 | 3 (4 ties) |

- Haiku's latency comes from thinking: about 4.3k output tokens a brief, against Sonnet's ~370.
  It is still 13x cheaper.
- Neither model followed an injected instruction, repeated a fake key, or switched to French or
  markdown in any run.
- Each model had one accuracy-2 script, of 26: a misattributed "who closed the most" (Haiku), and
  an invented gate description (Sonnet). The judge's most common complaint against both was
  coverage: in-review work and a hardware freeze left out of a 35-word `stillOpen`.
- An earlier full run, before "at least" replaced "at least or more than", gave the same verdict:
  Haiku 16 wins, Sonnet 6, 4 ties.

## Follow-ups

- **An empty `upNext` says nothing aloud.** The judge marked both models down for it on
  empty-board and nothing-open. The page (XERK-2396) should render a "Nothing queued next" line
  when `upNext` is `[]`. It stays a list rather than a sentence so the hub can link keys.
- **Up-next candidates can be work still waiting on an open gate.** `next` rows carry no
  `blockedBy`, so the model cannot tell. Suspected, not proven, so it goes on the Turma rollup
  ticket.
- **The render worker (XERK-2394)** can turn Haiku's thinking off if latency ever matters. Retry
  once on a `parse_daily_brief` None: every eval reply parsed, so retries should be rare.
