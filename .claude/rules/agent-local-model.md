---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Local-model failover (XERK-246)

Split out of `agent-sessions.md` (size ceiling). The `setModelSource` command is in `agent.md`.

- **Running out of Claude usage stops every session on a host at once** — what this exists to stop.
  `modelSource` is `subscription` (mounted `~/.claude` login) or `local` (host's self-hosted model),
  settable at spawn and switchable live.
- `local` is the **same `claude` binary** with `ANTHROPIC_BASE_URL` repointed at a gateway serving the
  Anthropic Messages API — never a second coding agent, which loses the transcript format every
  surface parses, `--resume`, Remote Control, the AskUserQuestion bridge and the `--settings` safety
  guard. Bake-off: `docs/local-model-failover.md`.
- The switch **relaunches with `--resume <transcript id>`, never `restart`** — failing over is the
  moment you least want to clear context. Rewrites `local-model.env` (`ANTHROPIC_MODEL` +
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`). Read off the record on EVERY launch, so a resume/restart
  stays failed over.
- `LOCAL_MODEL_CONTEXT` must match what the server really serves: Claude Code assumes 200k for an
  unrecognised model, and an overstated `CLAUDE_CODE_MAX_CONTEXT_TOKENS` compacts too late,
  truncating server-side. Sized per host in `turma-agent.env`.
- **A fallback, not a peer** — solved 4/8 of the bench Claude would clear. The UI marks a `local`
  session so nobody wonders which model wrote a turn.
- **Automatic delegation to the local model is deliberately NOT shipped** — the token arithmetic
  doesn't obviously work (diagnosis dominates). See the doc before building it.

### Endpoint model discovery + live per-session model (XERK-489)

- **`LOCAL_MODEL_NAME`/`LOCAL_MODEL_CONTEXT` are OPTIONAL** — with only base+key set, the endpoint's
  model list is DISCOVERED and the first id is the default; a configured name still wins.
  `local_model_configured` now also requires a usable model (discovered OR configured), so a base+key
  host stays hidden until discovery lands (silent — "not ready", not an error).
- **Discovery runs on a WORKER THREAD, never the beat** (`start_local_model_discovery`) — a
  blackholed endpoint must not stall the heartbeat past `OFFLINE_AFTER_MS` (XERK-395). It polls
  `{root}/v1/models` for ids and LiteLLM's `{root}/model/info` for per-model `max_input_tokens` (a
  bare OpenAI endpoint has no such route → null window → fallback applies). The beat only reads the
  cache (`discovered_local_models`, lock-guarded); a failed pass KEEPS the last good list. Heartbeat
  `localModel` gains `models:[{id, contextTokens|null}]` + `defaultModel`.
- **A local session's MODEL is per-session, live-switchable** (`localModelName`/`localModelContext`):
  the switch rewrites `local-model.env` and relaunches via `--resume` (`_switch_local_model`).
  `set_model` for a local session routes here instead of refusing; the `/model` TUI picker stays
  refused (its rows all 403 the gateway).
- **Membership is validated before the gateway sees it** (`local_model_member`), on top of the
  charset gate — an EMPTY discovered set can't DISPROVE membership, so it accepts charset-valid and
  the launch demotes cleanly if the endpoint lacks it. The window only ever SHRINKS to the served
  figure.
- **The choice rides every rebuild** beside `modelSource`; migration RE-VALIDATES against the
  target's own discovered set. Tests: `TestLocalModelConfig`, `TestLocalModelFailover`.
