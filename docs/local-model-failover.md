# Local-model failover — the harness bake-off and what we shipped

**The problem (XERK-246): running out of Claude usage stops every session on a
host at once, and work halts.** This is what we did about it, and why the answer
turned out not to be the one the ticket assumed.

Supersedes the coding-agent half of `docs/opencode-model-eval-2026-08.md`. That
eval's *model* findings (gpt-oss:120b for cues and translation, the serving
architecture, the Ollama concurrency numbers) still stand — its **OpenCode
recommendation does not**, for the reasons below.

## What the earlier eval could not have seen

It compared **models** — Qwen3.6-27B, Laguna XS 2.1, gpt-oss:120b — but always
ran them under OpenCode, so the harness itself was never a variable. And it ran
OpenCode **on the GPU box against `localhost:9402`**, which is not how any agent
host reaches the model. Two things followed from that:

- The shipped `opencode.json` pointed at `http://localhost:9402/v1`, an address
  that resolves on exactly one machine in the fleet and on no agent host.
- Through the LiteLLM gateway an agent host must actually use, its
  `reasoningEffort: medium` is a **hard 400** — LiteLLM refuses `reasoning_effort`
  for this model group. Every session would have died on its first request.

Its bench was also never committed, so none of it could be re-run. `bench/` is
the re-runnable replacement; see `bench/METHOD.md`.

## The bake-off

Six harnesses, 8 tasks mined from this repo's own merged history, one model
(`gpt-oss:120b` via the gateway), identical prompts, identical 720 s cap,
pristine worktree per run, scored only by the repo's own regression tests. Run
against the then-current **65536** per-slot window; DockerOps has since raised it
to 81920, which should if anything help the harnesses that lost on context.

| harness | solved | committed | median s | |
|---|---|---|---|---|
| **claude-local** | **4/8** | **4/8** | 582 | |
| crush | 3/8 | 3/8 | 451 | |
| codex | 2/8 | 3/8 | 424 | |
| aider | 1/8 | 3/8* | 210 | 3 abandons; needed ripgrep installed |
| goose | 0/8 | 0/8 | 46 | gives up fast |
| opencode | 0/8 | — | 720 | **all 8 infrastructure, never reached the model** |

\* Aider commits its own edits by default, so its `committed` count is a tool
capability rather than the model honoring the delivery contract.

**OpenCode could not reliably reach the gateway at all** — 28 consecutive
connection errors per run, zero tool calls, across three independent conditions
including serial runs with retries. It works fine invoked by hand, so this is
transport fragility under sustained load, not coding ability; its coding ability
went unmeasured. When it did connect, it hit the hallucinated-tool failure
(`Model tried to call unavailable tool 'apply_patch'`) that `OPENCODE_CONTRACT.md`
existed to suppress. Both `opencode.json` and that contract are deleted here.

Two methodology bugs were found and fixed mid-run; both are documented in
`bench/METHOD.md` because either would have produced a confident wrong table:

- Tasks check out historical commits, where this repo's `CLAUDE.md` was a single
  **160–175k-character** file that every harness auto-loads — ~40k tokens before
  any work starts, which a 64k model simply refuses, and whose delivery rules
  told agents to open PRs and watch CI instead of doing the task. XERK-244 cut it
  to 22k. The bench now strips instruction files identically for every harness.
- The infrastructure-failure detector matched the bare word `shell` inside
  OpenCode's own startup log line, so a run that did nothing looked like a run
  that did work. Diagnostics are now stripped before testing for tool activity.

## What won, and why it is not what it sounds like

**`claude-local` is the stock `claude` binary with four environment variables.**
Not a fork, not a second application. Claude Code speaks the Anthropic Messages
API; the LiteLLM gateway serves `/v1/messages` against our own Ollama box and
translates. The binary, the tools, and the transcript format are unchanged — only
the endpoint moves.

**You keep Claude Code; you do not keep Claude.** The intelligence behind those
4/8 solves is gpt-oss 120b. It won because the *harness* is better, not the
model. Treat it as a fallback that keeps work moving, never as a peer to Claude:

- 4/8 on tasks Claude would be expected to clear.
- It hit the 720 s cap on 3 of 8.
- One solved task was never committed — the delivery-contract gap the earlier
  eval measured at 0/8 is still present, just smaller.

What that buys, and what no separate harness could: the transcript format the
whole chat/usage/PR-chip stack parses, `--resume`, Remote Control, the
AskUserQuestion bridge, and **the `--settings` PreToolUse safety guard**. A second
coding agent loses all of it and would need the destructive/policy/attribution
denials re-implemented in a weaker permission system.

## What shipped

- `modelSource` on a session: `"subscription"` (the mounted `~/.claude` login) or
  `"local"`. Set at spawn or switched on a running session.
- `setModelSource` relaunches with **`--resume <this session's transcript id>`**,
  so the session carries on in the same conversation, worktree and branch.
  Deliberately not `restart` (which clears context): failing over is the moment
  you least want to lose what the session worked out.
- `localModel` on the heartbeat is the **capability flag** (same contract as
  `inputMaxChars`/`uploadMaxBytes`): an agent that reports nothing cannot do it,
  and the hub 409s rather than queueing a command that host would ack and drop.
- Configured per host by `LOCAL_MODEL_BASE_URL` / `LOCAL_MODEL_API_KEY` /
  `LOCAL_MODEL_NAME` / `LOCAL_MODEL_CONTEXT` (DockerOps compose).

`CLAUDE_CODE_MAX_CONTEXT_TOKENS` must match what the server really serves.
Claude Code assumes 200k for a model it does not recognise and would compact far
too late, and the tail then truncates server-side instead. `LOCAL_MODEL_CONTEXT`
defaults to the cue LLM's current per-slot window (**81920**, sized in
`docs/opencode-model-eval-2026-08.md`); when DockerOps changes that window this
default has to follow, or a session forfeits the extra room or overruns it.

**Every path that creates or rebuilds a session record keeps its model source**
— spawn, provision, queue drain, start, restart, resume of an ended session,
resume-any-transcript (the dashboard's Resume picker), migration in, and
resume-on-boot. Four successive QA passes each found this false on a *different*
one of those routes, every time silently returning a failed-over session to the
exhausted subscription and restoring its `--model` alias with it. Three rules
keep it honest:

- the closed record carries the source, so a resume can recover it;
- resume-any matches that record by transcript id **and then by worktree** —
  "Restart (clear context)" moves a session's transcript id, so its earlier
  conversations stay resumable while matching nothing by id;
- a migration RE-VALIDATES against the target's own configuration, so moving
  onto a host with no local model falls back rather than launching at an
  endpoint that is not there.

A transcript with no closed record at all (foreign or pruned) has no answer and
correctly defaults to the subscription. `--model` is suppressed for a local
session at the single launch choke point, so it cannot diverge per route.

### What the credential protection is, and is not

The gateway key goes to a 0600 file the launch line sources, never into any
argv — `/proc/<pid>/cmdline` is world-readable, so a command-line prefix (or
`tmux -e`) hands the key to every uid on the host. That is the threat this
closes, and it is closed: verified by scanning every process on the host.

`_GUARD_DENY_PATH_RULES` also denies `Read` on the file, which stops a casual
`cat` and holds even under `bypassPermissions`. **It is not containment.** A
local session necessarily holds the same secret in its own environment as
`ANTHROPIC_AUTH_TOKEN` — that is how it authenticates — so `echo
$ANTHROPIC_AUTH_TOKEN` reads it in one call, and QA confirmed several ordinary
shell forms (`sh -c`, a relative path, a symlink, `python3 -c`) reach the file
itself. Do not rely on the deny as a boundary. Keeping the token out of child
environments would need Claude Code's `apiKeyHelper`; that is a follow-up.

The key is scoped to one model group on the gateway, so its blast radius is the
self-hosted model, not the Claude subscription.

## Known limitations (found by the QA pass, accepted for this change)

- **Ticket sessions are subscription-only.** `spawn_ticket` doesn't take a model
  source, so board-started and auto-started ticket sessions can't begin on the
  local model. Explicit "+ New session" spawns can. Failing an already-running
  ticket session over works.
- **Self-hosted tokens are counted in the usage totals**, split out only per
  model. The usage page is how you judge remaining *subscription* headroom, so a
  host with busy local sessions overstates what it has spent against the
  subscription. Fixing it means teaching the ledger which model source a
  transcript came from — a wider change than this one.
- **The switch discards a turn in flight.** It does not defer on a busy pane the
  way `set_model` does: the turn in flight is usually the one erroring on
  exhausted usage, and waiting would withhold the switch exactly when it is
  needed. The conversation survives, so the work is re-askable.
- **Rapid toggling isn't single-flighted.** Two clicks queue two commands; unlike
  migration there is no per-session in-flight lock, so a sub→local→sub burst can
  produce back-to-back relaunches.
- **The spawn composer's "Run against" select has no Android counterpart** yet;
  `android/PARITY.md` records the chat-bar control and the mark, and this adds a
  third gap on the same screen.
- **Real-model behaviour is unexercised.** No key available during development
  could reach `gpt-oss:120b` (the one on the host is scoped to `parakeet`), so
  what six QA passes proved is the *wiring*: the real `claude` binary, launched
  in the real local-session shape, authenticates against a non-Anthropic
  `/v1/messages` endpoint and completes multi-turn tool-using conversations with
  the safety guard intact. What is untested is the *model* — genuine refusals,
  malformed or fenced tool JSON, truncation at the declared window, latency, long-context
  compaction. Exercise those the first time `LOCAL_MODEL_*` is set on a real
  host.
- **A local session's model can't be changed from the chip** — by design, since
  every row the picker offers is a Claude alias the gateway refuses. The chip
  states the fixed model instead. Switch back to the subscription to choose one.

## Deliberately not shipped: automatic delegation

The ticket also asks Claude to hand work to the local model automatically, to
save tokens. **The arithmetic does not obviously work, so it is not shipped.**

The expensive part of Claude's work is diagnosis, not the edit. Reading
`chat.js` to locate a bug costs ~9,500 tokens; the resulting edit costs ~150. To
write a delegation instruction narrow enough for a 64k model to execute, Claude
must *already* have done the diagnosis — so delegation saves the ~150 and then
spends ~250 reading the result back. It loses.

Delegation only pays when specification is cheap and independent of execution
(codemods across many sites, generating tests against an existing spec), and
only if the result is machine-checked rather than read back by Claude.

A working prototype exists and was measured: a narrow, well-scoped task passed
its verification and was accepted; a broad one failed and was correctly
discarded. The gate works. The economics are the open question, and the way to
settle it is an A/B — Claude alone versus Claude with the tool — comparing
**subscription tokens per solved task**, using this bench for the tasks and the
existing usage ledger for the counts. Until that shows a win, delegation stays
out.
