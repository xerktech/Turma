---
paths:
  - "turma/server.js"
  - "turma/tests/server.test.js"
  - "agent/hub-agent.py"
  - "bench/run_policy.py"
  - "bench/run_bench.py"
  - "bench/tests/test_policy.py"
---

# Ticket model ladder (XERK-1827)

An UNPINNED claude ticket session starts on haiku; each start after a session of that ticket ENDED
UNDELIVERED runs one tier up (haiku → sonnet → opus, capped). Evidence: `docs/routing-spike-phase2-3.md`.

- **Per session, never per turn.** A mid-conversation switch makes the new model re-cache every
  turn it missed (the spike's -8.2% vs -36.3%). Never route inside a session from this.
- **The ladder is DERIVED, not stored** (`ticketLadderPick`): a ticket session no longer running,
  with no PR (`prs`/`prUrls`) and no close-ticket `outcome`, is a failed attempt on its `model`.
  - A paused sleeper is waiting, not failed. Only ladder aliases count: a model-less session (an
    older agent, a pre-ladder login-default session) is no evidence, so forgotten closed history
    only ever costs a cheaper retry.
  - Read only on hosts BOUND to the ticket's org (`boundOrgOf`), the `startedTicketKeys` rule.
  - Needs the agent's `closedSessions[].model` (added for this); `normalizeClosedSessions` keeps it
    only as a plain alias.
- **Read at DISPATCH by both spawn sites** (`ticketSpawnModelFields`: Start route + queue drain).
  The operator's model pin wins; a dsh/qwen runtime pin gets nothing (no Claude alias there).
- **A retry carries `escalatedFrom`**; the agent appends `TICKET_RETRY_DIRECTIVE` to the prompt
  (charset-checked like a model alias). The bench's `RETRY_PREAMBLE` mirrors it minus the branch
  sentence.
- **Escalation happens on the NEXT start only.** Auto-start never re-dispatches a ticket that has
  any session (`startedTicketKeys`), so a failed ticket is retried by an operator Start or the
  queue — nothing auto-restarts it, and nothing kills a running session for it.
- `TICKET_MODEL_LADDER` (hub env, comma aliases) replaces the ladder; `off` restores the login
  default for unpinned tickets — the rollback lever.
- **Ticket sessions' sub-agents default to haiku** (`CLAUDE_CODE_SUBAGENT_MODEL`,
  `TURMA_TICKET_SUBAGENT_MODEL`, "" = off) — never for a local-model session or over an operator's
  own setting; an agent definition naming its own model still wins.
- **The replay gate**: `bench/run_policy.py` runs `ladder` and `always-opus` over the 25 `turma-*`
  tasks and prints solve rate + dollar cost side by side. Its `ladder` must equal
  `TICKET_MODEL_LADDER_DEFAULT` (`TestPolicyMatchesHub`). Re-run it for any ladder change.
  - Delivered = tests green AND committed. An infra/setup failure ends the walk unscored.
  - Usage is reduced per `requestId` to the max of each counter (output is cumulative on the last
    line) — summing lines over-counts.
  - Needs a gateway key (`TURMA_LOCAL_API_KEY`); run the cloud models `--jobs 1` (429s otherwise).
- Tests: `XERK-1827:` in `server.test.js`; `test_a_ladder_retry_*`/`test_*subagent*`/
  `test_an_ended_ticket_session_reports_its_model` in `TestSpawnTicket`; `bench/tests/test_policy.py`.
