# ADR: Multi-tenant Turma — tenant = user (epic XERK-2529)

Status: accepted (foundation landed in XERK-2530). Operative rules: `.claude/rules/turma-tenancy.md`.

## Context

The hub was single-user: one `TURMA_USER`/`TURMA_PASSWORD` break-glass login plus optional OIDC
(XERK-592/594), and the `hub_session` cookie said only "signed in" — no identity. Every signed-in
human saw and drove every agent, session and board. The epic turns the hub into per-user isolated
tenants, run by an admin panel.

## Decisions

### A tenant IS a user (1:1)

- Every user owns exactly one tenant; nothing is shared between tenants (agents, sessions, boards,
  stores, usage). There are no team tenants and no sharing. A later need for teams is a new decision,
  not a widening of this one.
- `tenantId` is minted with the user (`crypto.randomBytes`, 32 hex) and never changes. It is opaque:
  never the display name, username or email, which a user or the IdP can change. A rename never moves
  a tenant, and no tenant id can be guessed from who owns it.
- `userId` and `tenantId` are distinct values on purpose, so code that confuses them fails loudly.

### The isolation guarantee

- A tenant's data is reachable only by a principal carrying that `tenantId`. Zero shared data, zero
  shared agents.
- An **admin manages identities only**: create/disable users, reset passwords, edit group membership.
  The admin role grants no read of any tenant's data. An admin who is also a user (an OIDC admin, the
  bootstrap admin) reaches their OWN tenant through their user role, never anyone else's.
- Enforcement on each route is the later tickets of the epic; XERK-2530 lands the identity they key on.
  Until those land every signed-in principal still has today's full access — which exposes nothing
  new, because the only principals that can exist are the bootstrap admin, break-glass, and OIDC users
  who already had full access.

### A host belongs to one tenant (XERK-2533)

- The tenant is recorded on the agent's IDENTITY by the hub — from the enrollment code's owner, or
  the tenant user who rolls an untenanted host — never taken from anything the agent sends.
- The registry key is `<device>@<tenantId>`, so two tenants can each have a "laptop"; the agent
  keeps its plain `DEVICE_NAME` and the hub namespaces it from the credential.
- Rejected: a separate tenant field beside a shared device-name key. Every surface already keys on
  the host key (HA store, tunnel directory, SSE, ttyd, usage ledger), so namespacing the key isolates
  them all at once; a field would need a check at each one, and one missed is a cross-tenant leak.
- An untenanted host (all of today's fleet) is reachable only by the hub's operators — an admin,
  break-glass, a pre-tenancy cookie, an open hub — never by a plain tenant user, until the
  migration (XERK-2554) binds it. An admin who rolls such a host with their own tenant binds it there.

### Usage, ledgers and insights belong to the tenant (XERK-2550)

- A ledger row (usage, permission prompt, outcome) carries its tenant as the registry key of the
  host that produced it, `<device>@<tenantId>`. No separate `tenantId` column: the key is set by the
  hub from the credential and never moves tenant, so a second field could only disagree with it.
- **No aggregate spans two tenants — none.** Every served view reads ONE scope: a tenant user its
  own tenant's hosts (also when it holds the admin role — its admin role adds no data); a
  tenant-less operator (break-glass, admin-only) the untenanted ones. And every
  hub decision computed from ledgers is computed per tenant:
  - the routing policy (XERK-1848): promotions, the tripwire's Opus baseline, shadow pairs and the
    shadow daily cap are each one tenant's. A shadow re-runs a ticket only on a host of its tenant.
  - the subscription pause (XERK-544/548): one Claude account shared by two tenants is two pools.
  - defect attribution marks only the reporting host's tenant's rows.
  - eviction budgets rank by (tenant, org) or host, so one tenant's churn cannot crowd another out
    of a shared ceiling's ranking, and the retired-usage serve budget is the scope's own.
  - `/metrics` (unauthenticated) counts the untenanted fleet only.
- Rejected: shared "routing-quality priors" pooled across tenants. More evidence would promote a
  cheaper model sooner, but it lets one tenant's work steer another's model choice and its counts
  reveal another's activity — the overlap the epic forbids. A tenant with little evidence simply
  stays on Opus longer.
- Rejected: a `tenant` label on `/metrics`. The route is unauthenticated; a label would publish
  tenant ids and per-tenant activity.
- A host's spend stays with the key it was spent under. Binding an untenanted host into a tenant
  (XERK-2533) does NOT carry its pre-bind usage into the tenant; the usage-ledger alias groups never
  join two tenants. Moving today's fleet into a tenant is the migration's job (XERK-2554).
- Tenant purge: `purgeTenantData(tenantId)` (server.js) runs every store's registered purge
  (`registerTenantPurge`), each in its own try/catch; the ledgers drop their hot rows and delete
  them in Postgres (usage by host, permission by `@<tenantId>` suffix, outcome by key).

### Shared ledger ceilings, fair per tenant (XERK-2591)

- The permission, usage and outcome ledgers keep ONE store-wide ceiling each, and evict from the
  tenant holding the most (rows, bytes or hosts, by whichever ceiling is over) first; oldest/biggest
  within it as before. A row's tenant is its host key's suffix (`tenancy.tenantOfHostKey`); an untenanted
  host is one more tenant.
- So a tenant at or under its even share never loses data while another is over it, and a lone
  tenant can still use the whole store.
- Rejected: a hard per-tenant quota (ceiling / tenants). It strands capacity whenever few tenants are
  busy, and the count of tenants changes at runtime, so every quota would shift on each signup.

### The durable archive is partitioned per tenant (XERK-2549)

- A tenant host's archived transcripts live under `ARCHIVE_DIR/@<tenantId>/` (the bucket keys under
  HA follow, since keys are relative paths). `@` can never start a repo folder, so the partition
  cannot collide with the untenanted tree. The row's tenant is still its host key; no tenant column.
- Every by-id read (`getTranscript`, `sessionRow`, the raw files, the trajectories) takes the
  caller's scope at the store, as list/search already did (XERK-2534). The live `/history` path
  scopes to the HOST's tenant: the session's transcript id is agent-asserted.
- A row never moves between tenants: an ingest re-point and a restore target are refused across
  tenants, the legacy NULL-org escape included.
- **Quota, not shared-ceiling eviction.** The archive never evicts: it is the only copy of a
  conversation, so eviction would be data loss (unlike a ledger's derived rows, XERK-2591). With only
  the shared ceiling, one tenant filling it refuses every other tenant's ingest. So each tenant's
  partition has its own quota, `ARCHIVE_TENANT_MAX_BYTES` (default an eighth of
  `ARCHIVE_TOTAL_MAX_BYTES`, `0` = off), refused like the shared ceiling (cursor + `full`). The
  untenanted fleet keeps only the shared ceiling.
  - A FIXED quota, never ceiling / tenants: it does not shift on each signup. The cost is stranded
    capacity when few tenants are busy, and eight full tenants can still fill the shared ceiling
    together; both are the operator's to tune.
  - A tenant transcript archived before the partition sits in the untenanted tree and counts toward
    the shared ceiling only. Files are never renamed; the purge still finds it by its row.
- **Purge** (`registerTenantPurge("archive")`): tombstone the tenant in the HA-shared
  `archivePurgedTenants` store FIRST, then delete its rows (Postgres via the mirror's `remove` op),
  files, raw directories, partition and bucket objects. The tombstone is what stops a follower's
  stale local copy being re-indexed by the boot backfill or a rebuild; the store walk reaps it.
  Every hydrate re-issues any delete that did not land (Postgres rows, bucket objects), so a purge
  converges even when its own best-effort deletes were lost.

### Moving the pre-tenancy deployment into a tenant (XERK-2554)

- **One owner takes everything untenanted**, named by `TURMA_MIGRATE_OWNER`: `local:<username>`,
  `oidc:<sub>`, or a bare value matched as a local username, then as one OIDC subject. A bare value
  that names nobody is refused (a typo must not mint an account); a prefixed one is created — a
  local owner with an unusable random password (set it in the admin panel), an OIDC owner keyed on
  the IdP's discovery issuer.
- **A one-shot, resumable boot step on the leader** (`masterOrchestrationTick`): each store moves in
  its own idempotent step, and the marker (`/data/tenant-migration.json`, HA-shared) records each
  step as it lands (after flushing what the step wrote), so a killed hub resumes at the step it was
  in. `TURMA_MIGRATE_DRY_RUN=1` logs the count per store and changes nothing: no owner is created and
  the tenant routes stay open.
- **Until it completes, no tenant user is served tenant data** (503 + `Retry-After`; `/api/me` and
  sign-in still answer); operators keep the still-untenanted fleet. A failed step, or an owner that
  cannot be resolved (a typo), keeps it closed until fixed — the safe default for a misconfigured
  upgrade; it is logged on change and hourly.
- Completion opens the gate before every host has re-beaten: each host appears in the owner's view
  on its bind beat (seconds for an online host; an offline one when it returns).
- **Hosts keep their tokens.** Each untenanted identity is bound to the owner's tenant exactly as a
  `roll-token?bind=1` binds one; a host still on a name or master token is handed its identity token
  (`setToken` + `bindTenant`). Its record moves on its next beat (the XERK-2533 bind beat). A released
  or revoked identity is left alone.
- **Rows are re-keyed, never copied**: org-keyed stores to `<site>@<t>`, the ledgers, the archive's
  rows (host + decided org; files stay in the untenanted tree, as XERK-2549 accepts) and the routing
  policy to the tenant's keys, untenanted push devices to the tenant. A LIVE host's ledger and
  archive rows move at its bind beat, so its rows never split across two keys.
- **Later leftovers follow**: the marker keeps the untenanted host and org keys found at the start;
  for `TURMA_MIGRATE_SETTLE_MS` (14 days) the leader re-keys those keys' late rows (a record pruned
  after a week offline, a Postgres rescan). A host enrolled untenanted after the move stays the
  operators', and so does an org it works in (its settings and queue are no longer moved), even
  when it re-uses a migrated host's name.
- Residual: a host whose record was already pruned when the run started (offline over a week) has
  its rows moved but is bound only if it held an identity; one on a name token comes back
  untenanted, and an operator binds it with `roll-token?bind=1`.
- **The fleet-wide shared tokens follow the owner**: after the move `TURMA_MEETINGS_TOKEN` posts for
  the owner's orgs and `TURMA_TRIGGER_TOKEN` names the owner's hosts by device name (an operator
  host the owner does not hold stays reachable by its plain name), so Tenir and CI need no change.
- A marker for a different tenant is refused: changing the owner after a move needs the rollback.

- **Size the owner's archive quota first**: the moved rows count toward the owner's
  `ARCHIVE_TENANT_MAX_BYTES` (default an eighth of the ceiling; their files stay in the untenanted
  tree but are charged by row, XERK-2618). A whole fleet's history can exceed it, and the owner's
  new transcripts would then be refused. The run (and the dry run) warns when it would; raise the
  quota or set it to `0` before migrating.

#### Rollback

- Take a snapshot first: stop the hub (or scale to 0 under HA) and copy `/data` (every `*.json` store,
  `users.json`, the archive). Under HA also dump the Postgres ledger + archive-index tables
  (`usage_*`, `permission_event`, `outcome_session`, the archive index) and the shared store's keys.
- To roll back: stop the hub, restore that snapshot (and the Postgres dump under HA), and unset
  `TURMA_MIGRATE_OWNER`. Agent env files need no change: a host's identity token stays valid; its
  identity is untenanted again in the restored `agent-identities.json`.
- A host the migration moved off a NAME or master token onto a freshly minted identity token has
  that identity only in the post-migration store: after a rollback its token names nobody, so give
  it a fresh enrollment code (or `--agent-token`) once. A host already on its identity token before
  the snapshot needs nothing.

### Admin without a tenant: break-glass

- The `TURMA_USER`/`TURMA_PASSWORD` break-glass login (XERK-595) stays, IdP-independent, and maps to
  an ADMIN-only principal with NO tenant. It can reach the admin panel to repair identities when the
  IdP or every admin account is broken; it can never read tenant data.
- It is checked before any local account and costs no scrypt, so a login flood cannot lock it out.

### One principal, whatever the login

- `requestPrincipal(req)` is the single way a route learns who is calling:
  `{kind, userId, tenantId, roles}`. Kinds: `user`, `breakglass`, `legacy` (a pre-tenancy cookie:
  signed in, no tenant, no role), `open` (a hub with no login configured).
- **Local and OIDC converge on one user record.** A local account signs in with a username + password
  checked against an scrypt hash. An OIDC login upserts a user keyed on the IdP's `(issuer, sub)`
  (never the email); its first login mints the user and tenant. Both produce the same `hub_session`
  token naming `{u: userId, t: tenantId, r: roles}`.
- The cookie's claims are signed, but each request re-reads the user from the store: disabling a user
  or removing its access group ends its live sessions at once, and roles come from the store, never
  the cookie.

### When the login turns on

- A login is required once a LOCAL credential exists: `TURMA_PASSWORD`, the bootstrap pair, or a local
  account. An OIDC user alone does not turn it on: a passwordless OIDC hub was open before tenancy, and
  closing it on its first SSO login would be a silent behaviour change. Closing it is the operator's
  call (set `TURMA_PASSWORD` or the bootstrap pair).

### Roles from groups

- Two roles: `user` (owns a tenant) and `admin` (manages identities).
- Local groups map to roles: `turma-users` → user, `turma-admins` → admin by default, editable by the
  admin panel. Orgs without Authentik manage membership by hand here.
- OIDC users take roles from the IdP's `groups` claim at each login, plus any local group the operator
  adds them to. Each group maps to one role (XERK-2532): `TURMA_OIDC_USER_GROUP` (`k8x-ai`) → user,
  `TURMA_OIDC_ADMIN_GROUP` (`k8x-admins`) → admin. An admin-only user gets the admin panel and no
  tenant; XERK-594's "admin implies user" was dropped so administering identities never grants data.
- An OIDC identity is provisioned (user + tenant) only on a login that grants a role. A known user
  whose login grants none is disabled by the IdP; the tenant is kept until an admin deletes the user,
  and re-joining a group lifts that disable (never an operator's). Removal takes effect at the next
  login, at most `TURMA_OIDC_SESSION_TTL_MS` (24h) after the group change.
- A principal with no role is not signed in.

### Storage

- One durable store, `/data/users.json` (`TENANCY_FILE`), externalized like the other operator stores
  (`registerExternalStore`, so HA shares it through the LiveStore). Never `state.json`, which is
  best-effort.
- Passwords are scrypt hashes (`scrypt$N$r$p$salt$key`, stdlib `crypto`); the plaintext is never stored
  or logged. N=2^14, r=8 costs 16 MiB a call, so the hub caps concurrent verifications (2) inside the
  XERK-287 memory margin rather than raising N.

### Bootstrap

- First run with no local account and `TURMA_BOOTSTRAP_ADMIN_USER` + `TURMA_BOOTSTRAP_ADMIN_PASSWORD`
  set creates one local admin (groups `turma-users` + `turma-admins`), so a fresh install is
  administrable from a browser. It never runs again once any user exists.
- **Not** a reuse of `TURMA_USER`: that is the break-glass credential, which deliberately has no
  tenant. Folding the two would give break-glass a tenant or the first admin none.

### Session signing

- Session cookies and ws-tokens are signed with `TURMA_SESSION_SECRET` (or the break-glass password's
  hash, as before). With neither set the old key was a hash of a public string — harmless on an open
  hub, forgeable once local accounts turn the login on — so that case now signs with a per-process
  random key and warns at boot. HA needs `TURMA_SESSION_SECRET`.

## Alternatives rejected

- **Tenant = org (siteKey).** Orgs are a tracker grouping, and one person can work several; per-user
  isolation is what was asked for.
- **Roles on the cookie only.** Stale until the cookie expires (30 days for a local login), so
  revocation would lag. The cookie carries them for the record; the store decides.
- **Local passwords over Basic auth.** A scrypt per request is a CPU/memory DoS on an unauthenticated
  path; Basic stays the break-glass channel only.
