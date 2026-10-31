---
paths:
  - "turma/server.js"
  - "turma/tests/server.test.js"
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
  - "agent/native/**"
  - "turma/public/index.html"
  - "turma/tests/dashboard-addhost.test.js"
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
- **A NEW host enrolls with a one-time CODE, not a token** (XERK-2531): it has no credential for the
  two paths above, and minting one (`--agent-token`) needs a shell in the hub pod.
  - `POST /api/enroll-codes {device?}` (operator-authed) mints `te-<32 hex>` (128 bits), 15 min
    (`ENROLL_CODE_TTL_MS`), single-use; `GET` lists, `DELETE /api/enroll-codes/<id>` revokes. The
    dashboard's "+ Add host" dialog drives them and shows the install commands.
  - **Stored only as its SHA-256** in `enrollCodes` (`/data/enroll-codes.json`, a
    `registerExternalStore` with `debounceMs: 0`, HA-shared). The plain code is in the mint reply
    once and never served again. Never store or log it.
  - `POST /api/agent/enroll {code, device}` is exempt from the login gate — the code IS the
    credential (`consumeEnrollCode`). Lookup → state check → name check → used-stamp in ONE
    synchronous turn, so two racing redemptions cannot both win (the leader is the single writer).
  - It returns the host's IDENTITY token (`issueAgentUid`), and works under `TURMA_AGENT_STRICT`.
  - **A code never takes a name another agent holds** (`enrollNameRefusal`, case-folded) — that
    would hand the code holder that host's token and queued commands. An identity minted for the
    name that never beat is SUPERSEDED, so two machines never share one id.
  - A refusal that is the caller's mistake (wrong device for a device-bound code, a taken or
    unusable name) does NOT burn the code. Used/expired/revoked → 410 in the hub's words.
  - **Only UNKNOWN codes are rate-limited, fleet-wide** (`enrollFailLimited`, 30/min → 429); a
    live code always redeems. Never key it per client: behind Cloudflare + the ingress every public
    caller shares one forwarding hop, so a per-client bucket let anyone lock out all enrollment.
  - **A name any beaten identity answers to is refused** — its home, its ORIGIN (a renamed host
    keeps the id minted for its old name, and `issueAgentUid` would hand that id back) or a former
    name — and so is a revoked tombstone's origin (minting there deleted it, un-retiring the old
    name token, XERK-2383). Only Remove host's `released` frees a name.
  - **A code always mints a FRESH identity** — never one that has beaten. A released identity keeps
    an `origin` that differs from its last home (renamed, then removed), so `identityByOrigin` would
    hand the old machine's live id to the new one; redemption strips that origin first, and refuses
    if `issueAgentUid` still returns a used id.
  - **Redemption revokes the name's old NAME token FIRST** (`redeemEnrollCode`, XERK-2572): a
    check-only pass, then `bumpNameTokenGen`, then the real redemption. Remove host un-retires the
    token, so its holder could beat before the new host and have its record adopted. Redeeming only
    after the bump lands means a beat inside the store round trip takes the name and the code is
    refused (409, not burned). A redemption refused at the check pass never bumps (else any code
    holder could revoke a live host's token); a code revoked or expired DURING the bump still bumps
    that released name (accepted). A failed bump still redeems, logged.
    Tests: `XERK-2572:` cases (the slow-store case pins the await).
  - **Redemption REVOKES the released identity still living under the name** (XERK-2573): left
    released it may come home if it beats first, so the old machine won the window before the new
    host's first beat and the new identity was refused. Minting a code for the name is the
    operator choosing the new machine; the cost is that a blipped host whose operator Removed it
    AND minted a code is locked out (intended). Like `revokeHostIdentities`, except a renamed
    agent's tombstone moves `home` to its origin and drops its `names`: a tombstone holds every
    name it lists and only the ORIGIN's release drops it, so a kept middle name of a rename chain
    refused codes with no DELETE that freed it. A live tunnel under the name (any casing) is cut.
    The origin name itself stays refused for codes until it is released (the XERK-2383 rule).
  - **Every 200 redemption writes the identities through before answering**: the code is burned at
    once (no debounce), so an identity left on the 5s debounce was a spent code plus a token the
    hub did not know after a hard kill. Tests: `XERK-2573:` cases (the on-disk checks).
  - `owner` records the minting principal (`oidc:<sub>` or `local:<user>`) for the tenancy epic
    (XERK-2529) to bind the host to a tenant. **Recorded, not enforced.**
  - Agent: `hub-agent.py --enroll` with `TURMA_ENROLL_CODE` in the ENV (never argv) runs
    `enroll_with_code`, which writes only an identity token. Front ends: `turma-agentctl enroll
    --code`, `turma-agentctl.ps1 enroll -Code`, `install.sh --url --enroll-code`, `install.ps1 -Url
    -EnrollCode` (the installers call the manager directly, before the service starts). Those front
    ends take the code on their OWN argv (single-use, so accepted); only the manager's is clean.
  - The installers' URL check is a character WHITELIST over the whole value (a line-wise grep let
    a newline add lines to the sourced env file).
  - `--agent-token <host>` stays the break-glass path; master bootstrap still works until strict.
  - Tests: the `XERK-2531:` cases in `server.test.js` and `dashboard-addhost.test.js`; the
    `enroll_with_code` cases in `TestSetToken`; the enroll cases in `test_turma_agentctl.sh`,
    `test_turma_agentctl_ps1.ps1`, `test_install_ps1.ps1`.
