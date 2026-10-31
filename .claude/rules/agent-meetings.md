---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/meeting_transcript.json"
  - "bench/meeting-items/**"
  - "docs/meeting-items-adr.md"
---

# Meetings — the agent-side work-item extractor (XERK-2509, epic XERK-2503)

Wire: `contract-meetings.md`. Model decision and eval: `docs/meeting-items-adr.md`.
`extractMeeting` → `_stage_meeting` (beat: validate + queue only) → ONE worker
(`_meeting_worker_loop`) → `_run_meeting` → `meetingResults` outbox. The daily brief's shape.

- **Everything but staging is on the worker** (XERK-395): the transcript GET, the `claude -p`,
  the retry sleep and the duplicate search. `_meeting_tick` re-arms a dead worker every full beat.
- **The transcript is untrusted** (anyone in the meeting can say anything):
  - It goes to the model as ONE JSON object (`meeting_input`), so a speaker's words cannot pose
    as structure, under `ATTENTION_HINT_LOCKDOWN` (`_run_lockdown_oneshot`), cwd `REGISTRY_DIR`.
  - **The prompt rides STDIN, never argv** (`stdin_text`): Linux caps one argv string at 128 KiB,
    under a long meeting. Its opening is in `INTERNAL_TOOL_PROMPT_SIGS`.
  - Past `MEETING_INPUT_MAX` the LAST segments are dropped and `truncated` says so.
- **`parse_meeting_items` rejects, never repairs** (`meeting_items_problems`; the eval scores
  with the same function, so tightening one re-runs `bench/meeting-items/run_eval.py`):
  - every quote must be found in ONE segment with that speaker and that `at` (`atMs`), compared
    NFKC + case-folded + punctuation as spaces (`_meeting_norm`) — an invented quote fails;
  - a quote is `MEETING_QUOTE_MIN_WORDS`+ WHOLE words of it, or the whole segment ("okay"):
    a bare substring let "the" or "dem" (from "idempotency") pass as evidence (XERK-2509 QA);
  - `suggestedAssignee` must be a participant or a speaker; `repoGuess` a name from `repos`;
  - unknown/missing keys, an unknown kind, over-long fields or >30 items fail the reply.
  - `[]` is a real answer ("nothing to propose") and ships as `ok, items: []`.
- **The model never writes `duplicateKeys`**: a model-named key is a guess. The agent fills it
  from a READ-ONLY search (`meeting_duplicate_keys`: a Jira JQL `summary ~` / an ADO WIQL
  `CONTAINS` over OPEN issues of the org's projects, any assignee), ranked client-side by shared
  title words (`_meeting_dup_rank`: ≥2 shared, covering half the title's). Never a tracker write.
  - A word is letters, digits and combining marks (any script, ≥3 chars; `_meeting_words`), so
    nothing quotes out of JQL/WIQL and a Hindi word stays whole (QA: it fell into letters); keys pass
    `_DAILY_BRIEF_PROJECT_RE`, ADO names are `'`-escaped.
  - Best-effort: a search error, or `MEETING_DUP_BUDGET_SEC` spent, leaves `[]`; the items ship.
  - A `decision` files nothing, so is not searched.
- **`repoGuess` reuses the triage candidates** (`self.triage_cands`, `_triage_candidates`): the
  same allowlist a ticket's repoGuess is checked against.
- **Only `claude` is offered** (`meeting_runtimes` = `daily_brief_runtimes`), and only with a
  board (`meetings.available`); the siteKey must be this host's board, else `failed`.
- The transcript GET has a HARD deadline over the whole read (`read1` chunks), not just a
  per-socket timeout: a trickling peer otherwise held the one worker for minutes.
- The worker sweeps `meeting-*.in/.out` at start: a killed manager left a whole meeting there.
- A re-delivered runId runs once (`_meeting_seen`); an unusable command that names a run is
  answered `failed`. The outbox is cleared BY IDENTITY once a beat carried it.
- Tests: `TestMeetingItems`, `TestMeetingDuplicates`, `TestMeetingWorker` (the fixture
  `meeting_transcript.json` = `bench/meeting-items/corpus/sprint-planning.json`),
  `TestMeetingFetchAndScratch`, `TestLockdownOneshotStdin`.
