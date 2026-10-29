---
paths:
  - "turma/server.js"
  - "turma/tests/server.test.js"
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
  - "agent/native/**"
---

# Per-host agent token onboarding (XERK-578)

Split out of `CLAUDE.md`, which keeps the per-host credential contract (XERK-268) this builds on.

- **Onboarding onto that derived token is ONE action, not a per-host ritual** (XERK-578), spanning
  hub + agent + native. The hub re-derives `hostAgentToken(host)` and delivers it two ways:
  - **Roll (design A):** `POST /api/agents/<host>/roll-token` (operator-authed) queues a `setToken`
    command over the existing tunnel; the agent (`set_token`) writes it to its env file atomically
    and does a session-preserving restart. Deterministic, so a re-roll is idempotent.
  - **Enroll (design B):** `GET /api/agent/token` (AGENT-authed) returns ONLY the token for the
    identity the request proved — a derived-token caller gets its own (never another host's); a
    MASTER caller names its own `?device=` and gets that, which is exactly master-mintable. Driven
    by `turma-agentctl enroll` or opt-in `TURMA_AGENT_SELF_ENROLL=1` on start.
  - **`resolveEnrollToken` is the endpoint's decision** (exported, unit-tested strict + non-strict).
    Both self-close under `TURMA_AGENT_STRICT` — the master is no longer a credential, so neither
    can be driven by a master holder; during rollover they hand out only what a master holder could
    already mint, so no new exposure. **Never re-key the endpoint on a caller-named device for a
    PROVED caller** — that reopens the cross-host escalation the whole thing guards.
  - **Both now mint the IDENTITY token** (XERK-2381, `contract-agent-hub.md`): the host's bound
    `agentUid`, minted + stamped on first use, so a re-roll/re-enroll stays idempotent. The CLI
    `--agent-token <host>` still prints a NAME token (bootstrap only; roll/enroll upgrade it).
  - **DEVICE_NAME mismatch is impossible-by-construction AND checked**: the hub mints for the name
    the agent beats as, and the agent (`token_device_name`) refuses to persist a token whose name
    half isn't its own `DEVICE_NAME` — never a silent invalidation. An identity token (`uid:`
    name half, `token_is_identity`) names no host, so it is accepted. Env write is a single-key atomic
    rewrite (`rewrite_env_var`, preserves operator edits); the launcher exports `TURMA_AGENT_ENV` so
    the manager knows which file to roll.
  - **`tokenBound` is now SERVED** (was stripped) as the onboarding signal, replacing the "curl
    twice to verify" step. The dashboard flags ONLY a host still on the master (`⚠ shared token`);
    a bound host shows no chip (a positive chip on every host is noise). Still HUB-DERIVED
    (forge-proof, re-stamped in `serializeAgent`), and served ONLY when the hub has a master
    (absent = no per-host tokens here). `tokenRoll` is the agent capability that gates the Roll
    button. Android types NEITHER yet (`ignoreUnknownKeys` skips them — safe); web-only, in
    `PARITY.md`. Native/agent detail in `agent-native.md`.
