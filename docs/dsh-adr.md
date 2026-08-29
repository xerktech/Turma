# dsh integration — architecture decision record (XERK-460)

The G0 decision record for integrating DeepSeek Harness (`dsh`) as a first-class agent runtime
**alongside** Claude Code, with the rationale behind each decision.

**This is history and reasoning, not an instruction file.** The operative invariants a change must
not undo live in `.claude/rules/dsh.md` (and, per subsystem, in `dsh-input.md`, `dsh-delegation.md`,
`dsh-guard.md`, `agent-usage.md`, `agent-prs.md`, `turma-board.md`). Read this when you need to know
*why* a decision was made or want the full alternatives-considered; read the rules files when you
need the rule.

## Background — why this gate existed

Two design docs framed dsh differently, and the difference is the whole point of the gate.

- `docs/turma-2.0-design.md` + `poc/turma-2.0-poc/` describe a **full rewrite** of Turma on dsh: a
  NEW separate "Fleet Hub" service, dsh running the web UI, every Turma concern reimplemented as a
  dsh plugin.
- `docs/deepseek-harness-integration.md` (Option A) describes an **incremental** path: dsh added as
  a selectable per-session runtime under the EXISTING agent and the EXISTING hub.

**XERK-460's title says "alongside Claude Code" — so the epic is the incremental path, and these
decisions choose it over the rewrite wherever the two conflict.**

Naming trap carried forward into the rules files: `agentType`/`agent_type` in
`hub-agent.py`/`server.js` ALSO names Task-tool SUBAGENTS, an older unrelated concept. The dsh
runtime is the per-session `agentType` field plus the `agent/dsh_*` modules; do not conflate them.

## G1 (XERK-463) go/no-go = GO

All four operations proven end-to-end against real dsh 0.1.1-rc.2, no mock, via
`poc/turma-2.0-poc/test-real-dsh.sh --drive`. The go/no-go corrected the PoC plugin, which had
spawn/input/kill written against a *guessed* `ctx.agents` API the mock never checked. Real dsh is:

- `agents.create({sessionId, meta:{cwd}, agentOptions})` → handle (not `resume`),
- `agent.followup(msg)` (not `inbox.append`, which never wakes the driver),
- `handle.dispose()` (not arg-less `cancel`).

The model rides a hand-declared OpenAI-compatible `dsh-llm-pi-ai` route (D5). Detail + recorded run
in `poc/turma-2.0-poc/README.md`. **This is the origin of the "verify against real dsh, never a
mock" rule** that every later child's tests follow.

## D1 — dsh runs inside the existing agent, not as a separate agent

**Decision:** dsh runs as an additional per-session LAUNCHER inside the existing agent. A dsh session
launches the way a `claude --remote-control` session does — its own tmux, its own worktree, counting
against `MAX_SESSIONS` — dispatched on a validated `agentType` spawn option.

**Why not a separate agent.** The fleet's whole model is one-agent-per-host, and a host's identity is
singular: one XERK-268 credential, one heartbeat, one org binding, one peer roster, one worktree pool
under `.turma/worktrees`. A second agent would be a second "host" to the hub — doubling the online
count, the credential and the roster for one physical machine, and forcing every cross-cutting
contract to learn a split identity. Keeping dsh in the same agent makes the runtime choice
per-session and invisible to the hub's host model.

**Cost accepted.** dsh (node + its npm tree — the PoC's `test-real-dsh.sh` installs ~460 packages)
adds a native prerequisite, and a live dsh session (node runtime + a model client) is not free on a
host's memory/process budget, sized per host against `MAX_SESSIONS`. Whether those ceilings need
raising is a host sizing follow-up (Q1), not a code change.

## D2 — Coordinator: reuse the existing Turma hub

**Decision:** dsh reports through the EXISTING Turma hub via the existing `hub-agent.py`, not through
a new hub or a dsh-plugin-to-hub link. The PoC's separate Fleet Hub (`poc/turma-2.0-poc/fleet-hub/`)
and `@turma/dsh-fleet-agent` plugin are the FULL-REWRITE path and are out of scope for XERK-460.

**Why.** The existing hub already owns agent registry, org isolation (`orgBound`,
trust-on-first-use), the ticket queue, the peer roster, the archive, usage aggregation, migration and
the mobile API. The PoC Fleet Hub reinvents all of it and is, by its own README, unauthenticated and
bound to all interfaces. Standing up a second control plane would fork every cross-cutting contract
in CLAUDE.md (the heartbeat wire contract, XERK-268 host proof, XERK-264 refusal semantics, XERK-258
memory ceilings, XERK-348 peer boundary). Reusing the one hub keeps one set of those invariants.

**Concretely.** `hub-agent.py` launches dsh as a child process, reads its session state (D3), and
surfaces it on the SAME heartbeat every Claude session rides. The hub learns no new protocol; a dsh
session is just a session whose `agentType` is `dsh`. The heartbeat's degrade rule applies: older
hubs/clients that don't know `agentType` treat the field as absent and render the session as any
other.

**This does not delete the PoC.** It stays as validated evidence for the rewrite direction, which
remains a separate future question (Q3).

## D3 — dsh's native event log is CANONICAL; Claude JSONL is a display projection

**Decision:** dsh's native event-sourced log is the CANONICAL session record, retained in full
fidelity — the better representation and the one metrics come from. The agent ALSO emits a derived
Claude-Code JSONL PROJECTION, purely so existing display surfaces keep reading one shape. The
projection is lossy and is NOT the source of truth; the native log is never down-sampled to feed it.

**Why keep dsh's format.** dsh manages session data far better than Claude Code's transcript: its
Trajectory view breaks out every input, output and tool call with the time each arrived, because a
session is an append-only log of typed events (`turn/*`, `step/*`, `tool/call`, `tool/result`,
`assistant/message` with token usage). That granularity is exactly what later metrics want — per-turn
tokens, tool success rates, step timings, error rates — and flattening it into Claude JSONL turns
would throw it away.

**Why derive the JSONL at all.** Turma's read side is a web of parity contracts that already cost
N-way edits: `readyForReview` (four mirrors), "Working" = paneBusy OR live agents (five mirrors), the
board column rule (four mirrors), and the whole `hub-agent.py` ↔ `tunnel-agent.js` py/js parity set.
Teaching the archive and every client a SECOND transcript shape multiplies each of those (N → 2N). A
single agent-side projection into the shape they already read keeps the mirrors at N — WITHOUT making
that projection the record. Display reads the projection; metrics read the native log. Neither
impersonates the other.

This "keeps the mirrors at N" argument is the reason every later child ([D] liveness, [G] usage,
[H] PRs, [I] board, [J] delegation) added no reader and no `agentType` branch.

## D4 — dsh inherits the host credential; no new identity (XERK-268)

**Decision:** a dsh session has NO credential or fleet identity of its own. It runs under the host
agent, which authenticates to the hub with its per-host token exactly as today. dsh never talks to
the hub directly (follows from D2), so there is nothing new to authenticate.

**Consequence for the credential-binding contract.** Nothing in XERK-268 changes: the host is still
proved by its token, not by what it types, and a dsh session cannot assert a different host or org.
The `agentType` on a session is presentational, like a label — it grants nothing.

**Obligations this placed on the projection**, both since discharged and now pinned as invariants in
the rules files: the translator must represent the tool call running `gh pr create` as a real tool
event (not opaque assistant text) or PR chips break; and it must populate JSONL token-usage fields
AND a real model id from `assistant/message` events, or a dsh session spends tokens the ledger cannot
attribute to a model. New (local/DeepSeek) model ids simply appear in the per-model breakdown; the
ledger needed no schema change, only correct input.

## D5 — the runtime picks the model mechanism; a dsh session has NO Claude failover

**Decision:** model selection is PER SESSION and follows the session's runtime. If `agentType` is
`dsh`, there is NO Claude-Code local-model failover in play at all — the dsh model selector
(`@deepseek-ai/dsh-llm-pi-ai`, YAML provider config: DeepSeek API natively, plus any
OpenAI-compatible local endpoint — LiteLLM / Ollama / vLLM) is the WHOLE story for that session. If
`agentType` is `claude`, its existing local-model failover stays exactly as today. The two mechanisms
never coexist within one session.

**Why not unify.** Claude's failover is subscription-limit-driven and specific to the Claude runtime
(`LOCAL_MODEL_*` env, `localModel.available` capability flag). dsh has no subscription limit and no
such concept — it points its adapter at whichever providers are configured, and can run local models
as PRIMARY. Merging the two would couple two runtimes at exactly the seam QA is told never to stub.

**Model set to start.** dsh with (a) local models via the existing LiteLLM/Ollama infra and (b)
DeepSeek API where a key is provisioned, model chosen per session like the Claude model enum, both
validated agent-side against a fixed enum.

## Open questions flagged to Malcolm (recorded on XERK-462)

1. **Resource + retention sizing.** Does a host's memory/process budget need raising before dsh
   sessions run beside Claude sessions (D1)? Does the archive raw-layer ceiling
   (`ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES`) fit real dsh session sizes so the canonical native log kept
   for metrics (D3) is not silently truncated? A host / archive sizing follow-up, not code.
2. **Attribution granularity.** Should PR/commit attribution visibly distinguish dsh-authored from
   Claude-authored work, or is host-level attribution enough? Not needed for correctness.
3. **Fate of the full rewrite.** These decisions treat the PoC Fleet Hub + dsh-plugin rewrite as out
   of scope for XERK-460. Confirm the "alongside" integration SUPERSEDES the Turma-2.0 rewrite (or is
   a deliberate stepping stone toward it), so `docs/turma-2.0-design.md` can be marked accordingly.
4. **DeepSeek API vs local-only, and default.** Provision a `DEEPSEEK_API_KEY` and accept
   DeepSeek-API spend, or start dsh local-only? And should dsh default to local-first?
