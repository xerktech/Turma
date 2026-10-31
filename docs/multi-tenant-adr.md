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
