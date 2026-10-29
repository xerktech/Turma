---
paths:
  - "agent/hub-agent.py"
  - "agent/tunnel-agent.js"
  - "agent/native/**"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/tunnel-agent.test.js"
  - "turma/server.js"
  - "turma/public/org.js"
  - "turma/tests/**"
---

# Agent ⇄ hub contracts

Rules whose two halves live in the agent and the hub, so neither side's own file sees both.

- **The peer roster IS the org boundary for cross-session messaging** (XERK-348). Claude Code's own
  control is per-MACHINE and a Turma org spans hosts, so the agent denies `ListAgents` (removing the
  tool, so a session cannot ENUMERATE anyone) and the hub's **`orgPeers`** puts same-org sessions on
  every heartbeat reply, which the agent renders to `~/.turma/peers.tsv`.
  - **The roster removes DISCOVERY, not delivery.** `SendMessage` resolves any string and an `rcName`
    is `<host>-<repo>-<TICKET-KEY>`, so a session can still guess one. Never write this up as "a
    session can only name what the hub sent" — it hides the residual risk.
  - **The org is the one the hub BOUND the host to, never the one the host claims** (`orgBound`,
    trust-on-first-use). `jira.siteKey` is agent-asserted, so gating on it lets any host's token join
    any org and read its roster. The binding is hub-owned; mechanics in `turma.md`.
  - **Drift is declaring a DIFFERENT org, never failing to declare one** — a host whose tracker goes
    quiet keeps its binding and its peers.
  - **The hub SERVES its decided org as `org`, and the migrate route + every Move menu key on it**
    (XERK-349). `decidedOrgOf` = the bound org, or "" for a drifted or never-bound host; a migration
    needs a shared NON-EMPTY decided org on BOTH sides (`sameDecidedOrg`). Clients mirror the served
    `org` (older-hub fallback to `jira.siteKey`). Drift quarantine heals in one beat, and a no-Jira
    fleet cannot migrate. **Do not re-key this on the claimed `jira.siteKey`** — that reopens the
    holes. What it closes and fixes: `turma.md`.
  - **Every roster cell is capped on the wire** (`PEER_CELL_MAX`), not just the free-text one —
    nothing else bounds `rcName`, and the spawn route takes a 100k `label`.
  - **Both sides fail NARROW.** No `peers` on a reply forgets the roster; a silent hub expires it;
    either way the agent falls back to its OWN host's sessions, same-org by construction. Never add a
    path that keeps a wide roster nothing vouches for.
  - **It is a strong soft boundary, not an airtight one.** `crossSessionInbound` has no per-sender
    filter, so an off-org session sharing the Claude login can still DELIVER into a session — it just
    can't discover one. **One Claude login per org is the only hard boundary**, a per-host deployment
    decision. Don't describe this contract as sealing it.
- **Nothing on the agent's BEAT LOOP may have a worst case at or above the hub's `OFFLINE_AFTER_MS`**
  (XERK-395). The hub calls a host offline after 75s of silence; what sets the gap between beats is
  the AGENT's own timeouts and retry counts, so it lives here, where both halves load.
  - **A try/except does not satisfy this** — it catches exceptions, never TIME. Nor does a deadline
    alone, while one in-flight push can overshoot it by a full timeout.
  - Inline may cost `INTERVAL` plus the beat's own POSTs (`HEARTBEAT_TIMEOUT_SEC`, twice on a cycle
    that executed commands) — 40s of the 75s. Anything else with a network or disk worst case belongs
    on a worker, as archive sync and `prune` (XERK-256) were moved.
  - The slow-cadence cache refreshes are OFF the beat too (XERK-397): `refresh_github`,
    `refresh_jira`, `refresh_pr_status` run on ONE shared **slow-refresh worker** — the beat only
    STAGES which are due (`_stage_slow_refresh`) and reads the caches it publishes. That worker is the
    SINGLE writer of `self.github`/`self.git_sources`/`self.jira`/`self.pr_status_cache`, which is
    what keeps the beat's reads of them lock-free: each refresh REBINDS its top-level cache object, or
    key-mutates `pr_status_cache` in a way a beat `.get()` tolerates, and the beat never ITERATES a
    dict the worker grows or shrinks. The manual `refreshJira` command stages the same worker, never
    polls inline. A migration `export_session` (with its ≈96s `_migration_upload` retry) runs on its
    OWN thread (`_export_session_async`); its refusal still reaches the hub because the
    `spawn_failures` append is lock-guarded and `post()` clears only the entries THIS payload
    delivered, by identity, so a refusal appended mid-beat is never lost.
  - **The PR-COMMENT poller is a FETCH/DELIVER SPLIT** (XERK-543): its network fetch runs on its OWN
    worker, the beat only drains + delivers (delivery mutates session records, the beat's to own).
    Mechanics: `agent-prs.md`.
  - **The operator `input` command is a STAGE/DELIVER/RECORD split too** (XERK-867):
    `handle_commands` only stages it, a worker delivers (its Windows worst case ate the budget inline),
    and the beat records the `pendingInputs` outbox. Mechanics: `.claude/rules/agent-input.md`.
  - Tests: `TestBeatLoopBudget`, `TestSlowRefreshWorker`, `TestPrCommentFetchWorker`,
    `TestArchiveSyncWorker`, `TestOffBeatInputDelivery`.
- **An agent's HOST is proved by its credential, never by what it types** (XERK-268). Every
  agent-authed surface names the host it acts as — the `<host>` segment, the heartbeat's `device`, the
  tunnel's `?name=` — and each agent runs on its OWN token,
  `<base64url(device)>.<HMAC(TURMA_AGENT_TOKEN, device)>`, which the hub re-derives against the host
  that was named. **The token NAMES its host on purpose**: an HMAC can't be inverted, so a bare digest
  could only be checked once the host was known, and `/api/heartbeat` — whose host is buried in a
  32 MiB body — would have had to admit any bearer before reading it.
  - **Scoping a route to a host is not a security check on its own.** Under one fleet-shared token
    `<host>` was self-asserted, so `m.srcHost !== host` refused a caller naming ITSELF and passed one
    naming the victim. Both halves — the scope AND the binding — or neither is worth stating. Never
    write a comment claiming a `<host>` compare keeps one agent out of another's data without
    checking the credential is bound.
  - That is also why a **per-relay one-time secret is not the fix** and must not be re-proposed: it
    would ride on exactly the commands an impersonated heartbeat hands out.
  - The master still authenticates as `legacy` so a fleet mid-rollover keeps beating;
    **`TURMA_AGENT_STRICT` retires it**, and the hub warns at boot until it is set. Detail in
    `turma.md`; the agent needs no code change, only the right `TURMA_TOKEN`.
  - **A host RENAME keeps the agent via its IDENTITY token** (XERK-2381): roll/enroll hand out
    `<base64url("uid:"+id)>.<HMAC>` over a hub-minted id. The token proves the AGENT; the durable
    `agentIdentities` store (`/data/agent-identities.json`, uid → origin/home/names/used) binds it
    to a host name, mirrored as `agentUid` on the record. `uidHostRefusal` is the one rule.
    - **One name mints ONE id, ever** (`identityByOrigin`): re-enrolling returns it, so a name token
      cannot mint a stream of identities and flood the registry (QA reproduced that under strict).
    - **Once the id has beaten, its name token is RETIRED** (`nameTokenRefusal`), so an old name
      token can neither open a second record beside a renamed agent nor fetch the id again.
    - **A rename takes only a name nobody else holds or held**: no record, no other id's home, no
      live case twin, no usage-ledger history (a removed host's name) — unless this id went by it.
      Loosening any of these lets a compromised agent squat a name and drain its queued commands.
    - **No rename while the home record is still beating and not restarting** (`updating`): a real
      rename restarts the agent, so that is two machines on one cloned token, refused with 403.
    - **Removing a host (`DELETE /api/agents/<host>`) RELEASES its name, revoking nothing**
      (`releaseHostIdentities`): ids minted for it lose `origin` (name token un-retired, enroll mints
      afresh) and the id living there is marked `released`. It still returns if it beats first (Remove
      host is offered on any briefly-offline host); a reinstall that registers first wins. Revoking
      instead locked a blipped host out for good; never releasing locked a reinstall out on strict.
    - **A released id may ONLY return home**, never rename: once a reinstall takes the name it is
      dead, so Remove host + reinstall also retires a lost or stolen machine's token.
    - **`?identity=revoke` on that DELETE REVOKES** (XERK-2383, `revokeHostIdentities`): it deletes
      every id whose home is the host, so its token is refused everywhere at once (heartbeat,
      tunnel, enroll; `agentPresented` too, so no 32 MiB read) and its live tunnel is dropped. The
      host returns only re-provisioned (`--agent-token`, then enroll mints a fresh id).
      - 409, removing nothing, when no id lives there: a name or master token cannot be revoked
        per host, and a Remove that left it working would read as done. 404 for no such host,
        400 for any other `identity=` value (a typo must not quietly do a plain Remove).
      - **A renamed agent's id becomes a `revoked` TOMBSTONE, never deleted, while its origin name
        is retired**: `identityOf` ignores it, `nameTokenRefusal` still sees it. Deleting it
        un-retired the OLD name's token, so revoking the new name re-opened the old one (QA).
        A plain Remove of the origin name drops the tombstone, as it releases any name.
      - The revoked host's OWN name token is un-retired on purpose (it is the re-provision path).
        Name tokens are deterministic, so one the machine ever held works again: residual.
      - Written through to disk before the 200 (the file store debounces 5s; a kill lost it).
      - `identityBound` (hub-derived, only `true` sent, forged copy stripped) gates the button.
      - Never make it Remove's default: it locks a briefly offline host out (the XERK-2381 bug).
    - An id the hub does not know is told to re-provision (`--agent-token`), never re-issued.
    - A beat that renames carries the old record over (commands, org binding, alerts), drops every
      other record bound to the id (HA ghosts too), re-points ticket pins, appends `formerNames`.
    - Hub-owned, never served: `agentUid`, `uidBound` (ttydAuth's which-token), `formerNames`;
      a `setToken` command's token is stripped from the served `commands` (`servedCommands`).
    - `hostAgentToken` refuses the `uid:` namespace so a host name never collides with an id.
    - Tests: the `XERK-2381:`/`XERK-2383:` cases in `server.test.js` + `usage-ledger.test.js`,
      `TestSetToken`, `XERK-2383` in `dashboard-tiles.test.js`.
  - **Onboarding onto that derived token is ONE action, not a per-host ritual** (XERK-578): the
    hub roll route + agent enroll endpoint, spanning hub + agent + native. Never re-key the enroll
    endpoint on a caller-named device for a PROVED caller. Mechanics: `agent-token-onboarding.md`.
- **The hub's memory ceilings are FRACTIONS OF ITS CONTAINER LIMIT, never fixed numbers** (XERK-258,
  XERK-273). It runs at `mem_limit: 512m`, so a flat constant larger than that can never refuse
  anything before the OOM killer fires. `containerMemoryLimit()` reads the cgroup; everything derives
  from it and is logged at boot. Raising `mem_limit` widens them with no code change. Mechanics:
  `turma-limits.md`. What spans components:
  - **413 and 503 mean opposite things and must not be collapsed**: 413 is "your body is too big,
    send less", 503 is "the hub is momentarily full, send it again". Every `readRawBody` caller must
    draw the distinction itself. On a 503 the migration relay HOLDS the migration in `exporting` and
    `_migration_upload` retries (5xx only, never 4xx); nothing else would, and a lost bundle strands
    the move.
  - **An OVERSIZE body is deliberately NOT refused on its declaration.** Refusing early makes Node
    close the connection under a request still being written, and a client that writes before reading
    — python urllib, which is what `hub-agent.py` posts with — loses the response and sees a socket
    error (XERK-235's offline loop). **Test agent refusals with urllib, never with fetch.**
  - **XERK-287 (closed by the raise)**: uploads are a budget SEPARATE from the in-flight ceiling, so
    worst-case heap is `in-flight + uploads` = ¾ of the container; hence `mem_limit: 512m`. The nginx
    ingress buffers bodies and forwards them declared-length, so oversize always gets a readable 413.
    Co-peak margin, findings 2/3 and the in-cluster residual: `turma-limits.md`.

