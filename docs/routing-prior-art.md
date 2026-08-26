# Cost-aware model routing — prior art review

XERK-445 Phase 1. Three candidate projects, read against their primary sources
on 2026-08-22, with what each would actually give us and what we would still
have to build. **Every figure the ticket quoted was re-checked; two were wrong
and are corrected below.**

Read `docs/routing-eval-phase0.md` first if you have not. Its measurement of our
own workload — in particular that 97.9% of our tokens are cache reads — decides
which of these designs can pay for itself, and it rules out the per-turn routing
that the ticket's framing assumes.

## Verification status

| Repo | Exists | License | Ticket's claim |
|---|---|---|---|
| `NVIDIA-NeMo/Switchyard` | yes | **Apache 2.0** | license unstated; pre-alpha warning **confirmed** |
| `NousResearch/hermes-agent` | yes | MIT | **confirmed** |
| `turnstonelabs/turnstone` | yes | **Apache 2.0 (v1.6.0+)** | ticket says BSL 1.1 — **stale** |

The turnstone license concern the ticket asks us to "flag" no longer applies:
BSL 1.1 covered 1.5.x and earlier, and current releases are Apache 2.0. Nothing
about our use needed the exception anyway.

## Switchyard

A Rust proxy and library for LLM traffic. Four crates matter to us:
`switchyard-server` (standalone proxy), `switchyard-libsy` (embed routing in our
own code), `switchyard-protocol` (provider-neutral types) and
`switchyard-translation` (format conversion).

**The translation layer is the reusable piece**, and it is the reason to care
about this project at all. It converts between OpenAI Chat Completions,
Anthropic Messages, and OpenAI Responses. That is exactly the seam we already
depend on: `docs/local-model-failover.md` ships Claude Code speaking
`/v1/messages` to a LiteLLM gateway that re-serves it elsewhere. Switchyard
generalises that seam and adds routing to it, so Claude Code keeps its
transcript format, `--resume`, Remote Control and the `--settings` safety guard
— everything the failover write-up warns a second harness would forfeit.

### Routing algorithms

The ticket lists four. The source has more, and two it omits are the ones that
matter most to us (`crates/libsy/src/algorithms/`):

| Algorithm | How it decides | Relevance |
|---|---|---|
| `stage_router` | `FallThrough` + a tool-signal processor onto "capable/efficient" tiers; an under-threshold turn **abstains** to an optional LLM classifier, then to a default | closest to our own turn taxonomy |
| `llm_classifier` | a cheap model reads the request and picks a tier; `mode="escalation"` runs weak first with a judge | costs a call per decision |
| `subagent` | **routes delegated work independently while preserving the parent algorithm for everything else**; `fixed_target` pins all delegated work to one model | **the cache-safe split — see below** |
| `advisor_gate` | a gate around turn/transcript advisors | unassessed |
| `random` / `passthrough` / `fall_through` / `noop` | fixed split, single target, cascade, disabled | baselines and plumbing |

`util/tool_signals.rs` is what `stage_router` reads: it walks normalized
messages, finds tool calls and results, and pattern-matches their text against a
curated error table, purely and deterministically. That is the same signal our
Phase 0 classifier uses to label `error_recovery`, which is a genuine
convergence — **their signal rules and our measured turn split agree**, which is
the sanity check the ticket asks for in Phase 0 step 2.

### What its own calibration says

`benchmark/routing-profiles/tau2-telecom-custom-opus-qwen-balanced.toml` is a
measured two-tier profile with Claude Opus 4.7 strong and Qwen3.6-35B-A3B weak
— structurally our exact pair. Reported: **0.903 ± 0.071 solve rate with 45% of
turns on the weak tier**, on tau2-bench telecom. The file is explicit that the
model wiring shown is a public stand-in for NVIDIA-internal endpoints, and that
the thresholds do not transfer: *"recalibrate rather than assuming the
thresholds transfer."* Treat 45%/0.903 as an existence proof for the shape, not
a prediction for us.

The same profile carries the finding that Phase 0 arrived at independently:

```toml
classify_trigger = "user_turn"
# Re-classify when the user speaks again, and hold that target across the tool calls
# in between, so a tool chain never switches tier mid-task.
```

NVIDIA's own calibrated configuration **refuses to switch tier mid-tool-chain.**
Phase 0 explains why in money: at our median context a single tier switch costs
about 45x an average turn's entire output. `classify_trigger = "new_session"`
(one decision per session) also exists, and `subagent` routing sidesteps the
problem altogether because delegated work carries its own context.

### Churn risk

Real. The README carries `> [!WARNING] Experimental software. Not for
production use.` and says the API and algorithms are expected to change
significantly before 1.0. Mitigation is to depend on the **server** across a
config file, not on `libsy` as a linked crate: `routes.toml` is a much smaller
surface to re-learn than a Rust API, and the proxy is replaceable by our
existing LiteLLM path if the project stalls.

## hermes-agent

MIT, Python, provider-agnostic, with a TUI, subagent spawning, MCP, a cron
scheduler, seven terminal backends (local, Docker, SSH, Singularity, Modal,
Daytona, Vercel Sandbox), and FTS5 session search with LLM summarization.

**Assessment: do not adopt as the front end.** Not on quality — it is a capable
project — but because the ticket's own question is whether its subagent/toolset
model gives us "a clean place to attach per-role model selection", and the
answer does not justify the cost. `hermes model` switches providers globally;
the documentation does not establish independent per-subagent model selection,
which is the specific hook we would be adopting it for. Against that we would
lose what `docs/local-model-failover.md` already paid for and measured: the
transcript format the whole Turma chat/usage/PR-chip stack parses, `--resume`,
Remote Control, the AskUserQuestion bridge, and the PreToolUse safety guard.
Its FTS5 session search and skills/memory also duplicate the hub archive and
`.claude/` skills we already run.

The overlap the ticket asks about is real and it cuts against adoption: we would
be rebuilding our dispatcher, not reusing theirs.

## turnstone

Self-hosted, local-first orchestration for tool-using agents. Apache 2.0.
Backends: OpenAI-compatible (vLLM, llama.cpp, NIM), Anthropic Messages, and
Gemini, "mixed freely per role". Multi-node clusters route each workstream via
rendezvous (HRW) hashing over a live registry — a pure function of
`(ws_id, live_nodes)`, so joins and departures only re-key the highest-scoring
entries. An LLM judge grades every tool call with a risk assessment and evidence
before it runs.

Two things worth taking, as the ticket predicts:

- **Per-role model assignment.** The pattern, not the code: assign a model to a
  role rather than to a turn. This is the cache-preserving shape, and it is what
  our Phase 0 numbers argue for.
- **`turnstone-eval`.** Headless measurement that "scores tool-use against
  expected actions". **It does not fit our replay set** and we should not bend
  ours to it: our grading is the repo's own regression tests going red-then-green
  (`bench/METHOD.md`), which is an outcome check. Scoring tool-use against
  expected actions is a trajectory check, and the ticket explicitly warns off
  trajectory matching because the transcript contains the answer. Ours is the
  stricter and more honest gate; keep it.

The LLM-judge-per-tool-call layer is interesting but orthogonal to routing, and
we already have a deterministic PreToolUse safety guard that costs no tokens.
Adding a model call in front of every tool call cuts directly against a cost
ticket.

## Recommendation: adopt Switchyard's server, build the policy ourselves

1. **Adopt** `switchyard-server` as the routing proxy, configured by
   `routes.toml`, sitting where our LiteLLM gateway sits today. We get the
   Anthropic-Messages translation and the algorithms without linking a pre-alpha
   Rust API into anything of ours.
2. **Keep Claude Code as the front end.** The failover work already proved it
   wins on harness quality and that a second harness forfeits the safety guard
   and the whole transcript-parsing stack. Nothing in hermes or turnstone
   outweighs that.
3. **Build the policy from our own numbers, not from their thresholds.** Both
   projects say their calibration does not transfer, and ours cannot look like
   theirs: 97.9% cache reads means our cheapest routing decision is the one made
   **least often**.
4. **Start with `subagent` routing, not `stage_router`.** This is the one
   substantive departure from the ticket's plan and Phase 0 is the argument for
   it: 26% of our turns are subagent turns, a subagent carries its own context,
   and pinning delegated work to the local tier therefore breaks no cache in the
   parent conversation. It is the only split we found that is cheap by
   construction rather than by calibration.
5. **Do not adopt** hermes-agent or turnstone wholesale; take turnstone's
   per-role pattern and leave its eval harness.

## What we would still have to build

- The routing policy itself, calibrated on `bench/archive/tasks-archive.json`.
- Cost accounting per tier. Switchyard exposes Prometheus metrics for requests,
  errors, latency, tokens and routing overhead, but **our token ledger does not
  yet know a session's model source** — `docs/local-model-failover.md` records
  that gap, and a routed session makes it worse by mixing tiers inside one
  session.
- A cache-aware cost model. None of the three projects price cache reads
  separately, and for us that is 70% of the bill price-weighted.
- The rollback path (an acceptance criterion): unset the proxy and Claude Code
  goes back to the subscription unchanged.
