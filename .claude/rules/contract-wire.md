---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
  - "turma/server.js"
  - "turma/public/**"
  - "android/app/src/**"
  - "turma/tests/**"
---

# Hub ⇄ agent ⇄ client wire contracts

The heartbeat payload and what `/api/agents` serves to every client. Spans `hub-agent.py`,
`server.js` and all three clients, so it lives here rather than in one component's file.

- **The heartbeat is the wire contract** between `hub-agent.py` and `turma/server.js` (and through it
  every client). A field older agents don't send must degrade, never break: clients gate on the
  capability flag the agent reports (`inputMaxChars`, `uploadMaxBytes`, `github.available`,
  `capacity`), and an absent flag means "that agent can't do it", not "unlimited".
  - **A full `/api/agents` decode is ATOMIC on Android**, so one host's wrong-typed field throws for
    the whole array — the poll fails silently while the app keeps its last snapshot and the tile still
    says "N / N online". Per-agent SSE events decode individually, so the bad host is simply missing
    while SSE is healthy; with SSE down too, the decoder exception replaces the screen. **Most of the
    payload is served raw**, so this is a live hazard: grep `normalize`/`sanitize` in `server.js` for
    what is actually covered rather than trusting a list here, which has been wrong repeatedly.
  - **A field becomes decode-fatal the moment a client TYPES it** — until then `ignoreUnknownKeys`
    skips it. `normalizeRecord` is where a coercion goes, and it runs on both the heartbeat ingest and
    the `state.json` restore (a restart is when a coercion ships, and the restore is the first thing
    it serves). Coerce to the "can't tell you" value every client already handles, never to a
    plausible default. **A `normalize*` is a WHITELIST** — a sub-key a newer agent adds is dropped
    fleet-wide unless added there too.
- **Token usage OUTLIVES the host that spent it** (XERK-338). The hub keeps a durable per-host ledger
  on `/data` — a per-UTC-day high-water mark, since a report can only under-state a past day — and
  serves a removed host's spend as top-level **`retiredUsage`** on `/api/agents`; a live host that
  lost transcripts is served its recorded history raised by its own report.
  - **`retired` is HUB-OWNED and coerced off every heartbeat** (`normalizeRetired`). Android TYPES it
    and a full `/api/agents` decode is atomic there, so an agent asserting `retired:"yes"` empties
    every OTHER host from every phone's fleet list, and it persists into `state.json`. **Typing a
    field on `AgentInfo` and adding its hub-side coercion are the SAME change.**
  - **`retiredUsage` is read by the surfaces that COUNT SPEND and no other** — the Usage page/screen
    and the dashboard's three TOKEN TILES (`fleetSummary(agents, retired)`), which say
    `incl. removed hosts` when they do. Entries are agent-SHAPED so those surfaces chart them with
    existing code, but they carry no sessions, repos or commands — anything treating one as a HOST
    (cards, online count, session ceiling) invents a host that does not exist.
  - **Retired spend is org-scoped off the LIVE fleet's orgs**, on every surface: org.js builds its key
    set from `data.agents` and applies it to whatever list it is handed; android's
    `scopedRetired(retired, live, stored)` mirrors that. **Never scope the retired list against
    ITSELF** (`scopedAgents(retiredUsage, org)`) — that adds other orgs' removed spend to a scoped
    total, and nothing in the types catches it (both sides are `List<AgentInfo>`).
  - **Removing a host is not a purge**: `DELETE /api/agents/<host>` keeps the spend; `?usage=purge` is
    the deliberate second step. Never make a removal imply one.
  - The archive does NOT already hold this — it stores displayable entries, no token counts, never
    sees a live session, and excludes background-agent transcripts. Mechanics: `turma-usage.md`.
- **A background-agent row's `subagentHistory` reply means "a list" by the PRESENCE of `agents`, the
  empty list included** (XERK-304). A `Workflow` row is N agents with no conversation of its own, so
  it answers with that run's agent picker; a second request naming one of those ids returns a
  transcript. Empty = "started nothing yet"; **absent = the row did not resolve** — word those
  differently, never collapse them. Spans `hub-agent.py`, `server.js`, `sessions.html`, `android/`.
- **`readyForReview` has THREE mirrors that must agree**: `turma/public/sessions.html`,
  `turma/server.js`, `android/…/core/Sessions.kt`. Changing the rule means changing all three.
- **`gitProblem` says why git facts are absent when that is not "not read yet"** (XERK-1887): on a
  session (`git` null) and a `repos[]` entry (`dirtyFiles` null), `{missing:true}` or
  `{unreadable:"<git's reason>"}`. Absent keeps the old "not read yet" meaning (`…` / `–`).
  - Agent: `_cheap_job_value`; hub: `coerceGitProblem` (rebuilt or deleted, Android TYPES it);
    clients: web `gitProblemText`, Android `gitProblemText`.
  - Unreadable never claims "clean": the repo's `dirtyFiles` stays null and delete still warns.
- **`dailyBriefs` / `dailyBriefSchedules` are TYPED on Android** (XERK-2397); their hub-side
  coercion is the stores' whitelists (`sanitizeDailyBrief`/`dailyBriefWire`,
  `validateDailyBriefSchedule`), so a field added there needs a defaulted field on
  `DailyBrief`/`DailyBriefSchedule`. Android also decodes them per org, so a bad entry drops alone.
- **`GET /api/me` is TYPED on Android** (`model.Me`, XERK-2553): the hub's `meView` builds it field
  by field from the principal (strings, a `user`/`admin` role list, two booleans) and never serves
  the tenant or user id. A field added there needs a defaulted field on `Me`.
