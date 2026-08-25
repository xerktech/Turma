---
paths:
  - "poc/turma-2.0-poc/**"
  - "agent/**"
---

# dsh integration — architecture decisions (ADR)

Gate for XERK-460 (integrate DeepSeek Harness, `dsh`, as a first-class agent runtime **alongside**
Claude Code). This file records the five G0 decisions with rationale so the parallel children build
against one shape. It is a decision record, not a how-to — mechanics land in the component rules
files as each child ships, and this file's `paths:` widens then.

- **Background.** Two design docs frame dsh differently, and the difference is the whole point of
  this gate. `docs/turma-2.0-design.md` + `poc/turma-2.0-poc/` describe a **full rewrite** of Turma
  on dsh: a NEW separate "Fleet Hub" service, dsh running the web UI, every Turma concern
  reimplemented as a dsh plugin. `docs/deepseek-harness-integration.md` (Option A) describes an
  **incremental** path: dsh added as a selectable per-session runtime under the EXISTING agent and
  the EXISTING hub. **XERK-460's title says "alongside Claude Code" — so the epic is the incremental
  path, and these decisions choose it over the rewrite wherever the two conflict.**
- **No production code touches dsh yet.** Every `agentType`/`agent_type` in `hub-agent.py` and
  `server.js` is about Task-tool SUBAGENTS, unrelated to dsh. dsh lives only in `poc/` and `docs/`.
  These decisions are greenfield, not a description of scaffolding.

## D1 — Where dsh runs: inside the existing agent container

- **Decision: dsh runs as an additional per-session LAUNCHER inside the existing agent container,
  not in its own container.** A dsh session is launched the way a `claude --remote-control` session
  is — its own tmux, its own worktree, counting against `MAX_SESSIONS` — dispatched on a validated
  `agentType` spawn option (`{'claude','dsh'}`, allowlisted agent-side like every other spawn enum).
- **Why not its own container.** The fleet's whole model is one-container-per-host, and a host's
  identity is singular: one XERK-268 credential, one heartbeat, one org binding, one peer roster,
  one worktree pool under `.turma/worktrees`. A second container would be a second "host" to the
  hub — doubling the online count, the credential, and the roster for one physical machine, and
  forcing every cross-cutting contract to learn a split identity. Keeping dsh in-container means the
  runtime choice is per-session and invisible to the hub's host model.
- **Cost this accepts, and the follow-up it needs.** The image already carries a large toolchain;
  adding dsh (node + its npm tree — the PoC's `test-real-dsh.sh` installs ~460 packages) grows it
  further, and a live dsh session (node runtime + a model client) is not free on `mem_limit` /
  `pids_limit`, which DockerOps sizes against `MAX_SESSIONS`. Whether those ceilings need raising
  before dsh sessions run beside Claude sessions is a **DockerOps sizing follow-up** (child of this
  epic), not a code change here — flagged to Malcolm below (Q1).
- **`k8x` is the exception, as always.** Its agent is a StatefulSet in xerktech/ArgoCD
  (`ai/turma-agent/`), image pinned by tag with no Watchtower — so a dsh-carrying image reaches it
  only when someone deletes the pod. Image CONTENT edits still land in this repo.

## D2 — Coordinator: reuse the existing Turma hub; the PoC Fleet Hub is redundant for this epic

- **Decision: dsh reports through the EXISTING Turma hub via the existing `hub-agent.py`, not
  through a new hub or a dsh-plugin-to-hub link. The PoC's separate Fleet Hub
  (`poc/turma-2.0-poc/fleet-hub/`) and `@turma/dsh-fleet-agent` plugin are the FULL-REWRITE path and
  are out of scope for XERK-460.**
- **Why.** The existing hub already owns agent registry, org isolation (`orgBound`, trust-on-first-
  use), the ticket queue, the peer roster, the archive, usage aggregation, migration, and the mobile
  API. The PoC Fleet Hub reinvents all of it and is, by its own README, unauthenticated and bound to
  all interfaces. Standing up a second control plane would fork every cross-cutting contract in
  CLAUDE.md (the heartbeat wire contract, XERK-268 host proof, XERK-264 refusal semantics, XERK-258
  memory ceilings, XERK-348 peer boundary). Reusing the one hub keeps one set of those invariants.
- **What this means concretely.** `hub-agent.py` launches dsh as a child process, reads its session
  state (see D3), and surfaces it on the SAME heartbeat every Claude session rides. The hub does not
  learn a new protocol; a dsh session is just a session whose `agentType` is `dsh`. The heartbeat's
  degrade rule applies: older hubs/clients that don't know `agentType` treat the field as absent and
  render the session as they would any other — never break.
- **This does not delete the PoC.** It stays as validated evidence for the rewrite direction, which
  remains a SEPARATE future question (Q3 below). This decision only says the rewrite is not how
  XERK-460 ships.

## D3 — Transcript format: translate dsh events to Claude JSONL at the agent

- **Decision: the agent translates dsh's event log into Claude-Code JSONL, written to the same
  `<claudeSessionId>.jsonl` path under the cwd's project slug that a Claude session uses. Every
  downstream surface keeps reading ONE transcript shape.** Feeds S1.
- **Why.** Turma's read side is a web of parity contracts that already cost five-way edits:
  `readyForReview` (five mirrors), "Working" = paneBusy OR live agents (six mirrors), the board
  column rule (`categoryOf`, five mirrors), and the whole `hub-agent.py` ↔ `tunnel-agent.js` py/js
  parity set. Teaching the archive and every client (hub, android, glasses, veiller) a SECOND
  transcript shape multiplies each of those. Translating once, at the agent, means five mirrors stay
  five, not ten — the exact reason the ticket names.
- **Session identity is preserved by construction.** The agent still pins a session id at launch and
  names the translated JSONL by it, so `_session_transcript_path()` resolves a dsh session with no
  new resolver and no newest-mtime fallback (the XERK-6 trap). dsh's own internal session id is an
  implementation detail the agent maps to the pinned id.
- **The raw dsh log is NOT thrown away — it rides the archive's raw layer.** XERK-338's raw archive
  layer already stores each session's own files byte-for-byte; dsh's SQLite / telemetry JSONL belongs
  there. So the translation is lossy for DISPLAY (dsh's per-token chunks, step boundaries, and
  structured telemetry flatten into JSONL turns) but nothing is lost from the record — the rich
  analytics the integration doc wants (per-turn tokens, tool success rates, timings) are a LATER
  child built over the preserved raw layer, not a reason to widen the display shape now.
- **Parity obligation.** The dsh→JSONL translator is itself a py/js parity surface if any of it runs
  in `tunnel-agent.js` for live tail; keep the mapping in one place and mirror it under test, the way
  `_entry_blocks`/`entryBlocks` are. The `corpus-eval` skill is the tool for proving old-vs-new here.

## D4 — Auth / session identity: dsh inherits the host credential; no new identity (XERK-268)

- **Decision: a dsh session has NO credential or fleet identity of its own. It runs under the host
  agent, which authenticates to the hub with its per-host token
  `<base64url(device)>.<HMAC(TURMA_AGENT_TOKEN, device)>` exactly as today.** dsh never talks to the
  hub directly (that follows from D2), so there is nothing new to authenticate.
- **Tracker / PR attribution rides the translated JSONL (D3), unchanged.** `_scan_pr_line` /
  `_seed_prs` detect `gh pr create` from transcript tool events; because dsh's shell/tool calls are
  translated into the same `tool_use`/`tool_result` JSONL shape, PR chips work with no new code —
  **provided the translator represents the tool call that runs `gh pr create` as a tool event, not
  as opaque assistant text.** That is a translator requirement, called out for S1. Git authorship is
  the host's git user on a worktree, unchanged.
- **Usage accounting rides the same JSONL, with one real new requirement.** Usage is counted
  per-MODEL from the transcript and kept in XERK-338's durable per-host ledger. dsh spend counts
  against the SAME host. The translator MUST populate the JSONL token-usage fields AND a real model
  id from dsh's `assistant/message` events — otherwise a dsh session spends tokens the ledger cannot
  attribute to a model. New (local / DeepSeek) model ids simply appear in the per-model breakdown;
  the ledger needs no schema change, only correct input.
- **Consequence for the credential-binding contract.** Nothing in XERK-268 changes: the host is
  still proved by its token, not by what it types, and a dsh session cannot assert a different host
  or org. The `agentType` on a session is presentational, like a label — it grants nothing.
- **Left open (Q2 below):** whether PR/commit attribution should visibly DISTINGUISH dsh-authored
  from Claude-authored work (e.g. carrying `agentType` onto the PR chip). Not required for
  correctness; a product call.

## D5 — Models: dsh selects its own; Claude-Code local-model failover is NOT extended to it

- **Decision: local-model failover stays a CLAUDE-CODE-runtime feature, unchanged, for Claude
  sessions. It is NOT extended to dsh and dsh is NOT folded into it. dsh selects models through its
  own `@deepseek-ai/dsh-llm-pi-ai` adapter (YAML provider config: DeepSeek API natively, plus any
  OpenAI-compatible local endpoint — LiteLLM / Ollama / vLLM).** The two runtimes have parallel,
  independent model-selection mechanisms; G0 does not try to unify them.
- **Why not unify.** Claude's failover is subscription-limit-driven and specific to the Claude
  runtime (`LOCAL_MODEL_*` env, `localModel.available` capability flag). dsh has no subscription
  limit and no such concept — it just points its adapter at whichever providers are configured, and
  can run local models as PRIMARY (the rewrite doc's "local-first"). Merging the two would couple two
  runtimes at exactly the seam QA is told never to stub. Keep them parallel.
- **Model set to start.** dsh with (a) local models via the existing LiteLLM/Ollama infra and (b)
  DeepSeek API where a key is provisioned, model chosen per session like the Claude model enum. Both
  are validated agent-side against a fixed enum, same as every spawn option.
- **Provisioning is a product/cost call (Q1/Q4 below):** whether a `DEEPSEEK_API_KEY` is provided at
  all, or dsh runs local-only first; and whether dsh defaults local-first. Neither blocks the code
  shape decided here.

## Open questions flagged to Malcolm (recorded on XERK-462)

1. **Image + resource sizing.** Is growing the agent image with dsh's node/npm tree acceptable, and
   do `mem_limit` / `pids_limit` need raising in DockerOps before dsh sessions run beside Claude
   sessions? A DockerOps sizing follow-up, not code here.
2. **Attribution granularity.** Should PR/commit attribution visibly distinguish dsh-authored from
   Claude-authored work, or is host-level attribution enough? Not needed for correctness.
3. **Fate of the full rewrite.** These decisions treat the PoC Fleet Hub + dsh-plugin rewrite as out
   of scope for XERK-460. Confirm the "alongside" integration SUPERSEDES the Turma-2.0 rewrite (or is
   a deliberate stepping stone toward it), so `docs/turma-2.0-design.md` can be marked accordingly.
4. **DeepSeek API vs local-only, and default.** Provision a `DEEPSEEK_API_KEY` and accept DeepSeek-API
   spend, or start dsh local-only? And should dsh default to local-first?
