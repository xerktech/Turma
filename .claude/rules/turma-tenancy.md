---
paths:
  - turma/server.js
  - turma/tenancy.js
  - turma/tests/tenancy.test.js
  - turma/tests/oidc-groups.test.js
  - turma/tests/oidc.test.js
  - turma/tests/server.test.js
  - turma/public/login.html
description: Hub users + tenants (XERK-2530, epic XERK-2529) — the principal every route keys on, and the invariants a tenancy change must keep.
---

# Hub users, tenants and the request principal (XERK-2530)

Decisions + rationale: `docs/multi-tenant-adr.md`. Pure half `turma/tenancy.js`; wiring in
`server.js` (`requestPrincipal`, `localLogin`, `oidcPrincipal`, the `tenancy` store).

## The principal

- **`requestPrincipal(req)` is the ONLY way a route learns who is calling** —
  `{kind, userId, tenantId, roles}`. Never re-derive identity from a cookie, header or body.
  `userAuthorized(req)` = "some principal"; a tenancy check reads `tenantId`, an admin check `roles`.
- Kinds: `user` (own tenant), `breakglass` (admin, NO tenant), `legacy` (pre-tenancy cookie:
  signed in, no tenant, no role), `open` (no login configured at all).
- **Break-glass never gets a tenant.** It may reach the admin surface, never tenant data. Do not
  give it a tenant to make a route "just work".
- **An admin role grants no tenant data.** Admin = identities only; an admin's own data comes via
  its `user` role and its own `tenantId`. `userPrincipal` serves `tenantId` ONLY with the `user`
  role (XERK-2532); the record keeps its tenant either way, and the token's `t` is the RECORD's.
- **Roles and existence are read from the STORE every request** (`principalFromToken`), never trusted
  from the cookie's claims: disabling a user or dropping its group ends its sessions at once.
  A principal with no role is not signed in.
- A token's `t` must equal the user's stored `tenantId`, or it names nobody.
- `authEnabled()` = break-glass password OR bootstrap env OR any LOCAL user. OIDC users never count:
  a passwordless OIDC hub was open before tenancy and its first SSO login must not flip it closed. It replaced every
  `!!TURMA_PASSWORD` auth check; a new one must use it, or a passwordless hub with local users
  reads as open.

## Records

- One user = one tenant. `tenantId` is random 32-hex, immutable (`updateUser` pins it), distinct from
  `userId`, and NEVER derived from a username, display name or email.
- OIDC identity is `(oidcIss, oidcSub)`, never the email or name (the IdP lets those change).
- `disabledBy:"idp"` (OIDC only) marks a disable the IdP's groups caused; a login lifts only that
  kind. `updateUser` setting `disabled` drops it, so an operator's call is never lifted (XERK-2532).
- `coerceTenancy` is the ONE whitelist (boot, remote watch); it is a coerce fixed point, null-prototype
  maps, and drops duplicate logins (case-folded username / iss+sub) and reused tenants.
  - An unset group map is OMITTED (not `{}`), so the shipped defaults keep applying after a re-coerce.
- Store: `/data/users.json` (`TENANCY_FILE`), `registerExternalStore` with `debounceMs: 0` and
  `mode: 0o600` (password hashes; store.js creates the temp file with it before the rename). Never
  `state.json`. Tests must set `TENANCY_FILE` (an unset one writes the host's real `/data`).

## Passwords + login

- scrypt via stdlib only; `scrypt$N$r$p$salt$key`. Plaintext is never stored or logged.
- **At most `LOGIN_SCRYPT_INFLIGHT_MAX` (2) scrypt verifications at once per hub process** (each HA
  replica has its own). Each costs
  16 MiB inside the XERK-287 margin (`turma-limits.md`) — never raise N or the cap without re-measuring.
- **Sign-in is fair per client (XERK-2568)**, the client being `loginClientKey`: CF-Connecting-IP
  AND the LAST X-Forwarded-For hop (the ingress's view) AND the socket. Fairness only, never auth.
  - **All three, never CF-Connecting-IP alone**: the LAN reaches the ingress without Cloudflare, so
    that header is forgeable there; alone, a LAN caller could back a chosen victim's key off.
  - `loginFailures` keys are a sha256 of client + username — the username is unbounded (1 MiB body),
    and a raw key let one client heap-OOM the hub in ~35 s.
  - One sign-in queued-or-running per client; its extras get 503 + `Retry-After` at once, no scrypt.
  - A request finding both slots busy waits in a bounded FIFO (`LOGIN_QUEUE_MAX`,
    `LOGIN_QUEUE_WAIT_MS`), 503 only past that — a single flooding client can no longer 503 everyone.
  - Failures back off exponentially per (client, username) after `LOGIN_FAIL_FREE`: 429 +
    `Retry-After`, answered before any scrypt.
  - **Never add a per-USERNAME in-flight cap or a username-only backoff** — either lets an anonymous
    client lock a known account out for everyone, the exact failure this replaced.
  - Residual: a caller reaching the hub without Cloudflare can rotate its CF-Connecting-IP; that
    buys it queue places (bounded by `LOGIN_QUEUE_MAX`, so ~18 keys 503 others), not more scrypt.
- `parseHash` refuses a stored cost past `SCRYPT_MAXMEM`: a hand-edited store must not OOM a login.
- **`/api/login` checks break-glass FIRST, scrypt-free**, so a flood cannot lock break-glass out.
- An unknown username verifies against a dummy hash (same cost, no timing oracle); every failure is
  the same 401 `invalid credentials` (no enumeration of disabled/role-less users).
- Basic auth is break-glass ONLY — never check a local password per request.

## Tokens

- `hub_session` is `u2.<expiry>.<b64url claims>.<hmac>`: `{u,t,r}` for a user, `{bg:1,r:["admin"]}`
  for break-glass. OIDC and local logins issue the same shape (one principal).
- Signed with `SESSION_SIGN_KEY`: `SESSION_KEY` when it is secret (`TURMA_SESSION_SECRET` or the
  break-glass password), else a per-process random key. Never sign browser credentials with the
  public-string default. Relay/forward auth keep `SESSION_KEY` (must match across replicas).

## Bootstrap

- `TURMA_BOOTSTRAP_ADMIN_USER`/`_PASSWORD` create one local admin ONLY when no LOCAL account exists
  (OIDC users don't count — the pair is how an operator closes a passwordless OIDC hub, and skipping
  it there admitted nobody). Boot ERRORs when no break-glass and no usable local account remain.
  Never reuse `TURMA_USER` for it (break-glass has no tenant by design).

## Hosts belong to tenants (XERK-2533)

- **The tenant is a property of the agent IDENTITY**, set only by the hub: `consumeEnrollCode`
  mints into the code owner's tenant; a tenant user's `roll-token` on an UNTENANTED host binds it
  (`bindIdentityTenant`, reply `tenantBound:true`). A bound identity never moves tenant.
- **Registry key = `<device>@<32-hex tenantId>`** (`TENANT_KEY_RE`, `tenantHostKey`); untenanted keys
  stay plain. Full id on purpose: a shortened one could collide and share a host across tenants.
  - No plain name may END in that shape (`hostAgentToken`/`hostKeyUsable` refuse it), or an
    untenanted host could equal a tenant key. Clients display `device`, the plain name.
  - Everything keyed by host (HA store, tunnel directory, SSE, ttyd routing, usage ledger) is
    namespaced by the key with no change of its own.
  - The first beat of a just-bound identity is a TENANT BIND, not a rename: `uidHostRefusal` lets
    `<home>` move to `<home>@<t>` even while the old record is live, and the record is carried over.
- **`principalMayDriveHost(p, key)` gates every operator `/api/agents/<host>/…` route** (404, never
  403): a tenant host only for a `user` principal of that tenant (no admin role, no break-glass); an
  untenanted host only for the hub's operators (admin role, break-glass, legacy cookie, open hub),
  never a plain tenant user — until the migration (XERK-2554) binds it.
  - Listing/SSE/terminal scoping is XERK-2534's; this gate covers the per-host command routes.
  - **A route that takes its host from the BODY runs the same check**: `/api/trigger` (the shared
    `TURMA_TRIGGER_TOKEN` proves no tenant, so it reaches untenanted hosts only) and
    `POST /api/archive/<tid>/restore`'s target. A new body-host route must too (QA found both).
- **Enrollment codes are their tenant's** (`enrollCodeVisible`): list + revoke see only codes minting
  into the caller's tenant; an untenanted code is the operators', like an untenanted host.
- **The bind roll's `setToken` crosses the bind** (hub-only `bindTenant`): delivered on the old plain
  key or the new one, so the agent restarts. The bind beat also closes the plain-named tunnel, so it
  re-dials onto the namespaced key (left open, terminals read offline). That close is replica-local,
  which holds because the HA leader serves beats AND tunnels (XERK-919); under active-active it would
  need the control bus.
- **A tenant host's queued command carries `tenant`** (hub-only, an `INTERNAL_COMMAND_FIELDS` member)
  and is dropped at delivery unless it matches the key's tenant — a command queued before a bind is
  never run inside the tenant. Untenanted hosts' commands carry no stamp (byte-identical).
- `coerceAgentIdentities` drops an entry whose home is a tenant key with a missing/different tenant.

## Tests

- The `XERK-2533:` cases in `server.test.js` (cross-tenant beat/tunnel/route/enroll/migrate forges,
  the roll bind, the identity coerce).
- `turma/tests/tenancy.test.js` (own process, break-glass set); `tenancy-nopassword.test.js` (own
  process, bootstrap admin ONLY — the forgery / empty-Basic / dummy-hash / mid-verify-disable guards);
  `XERK-2530:` in `oidc-groups.test.js` and `server.test.js` (an OIDC user leaves an open hub open).
- Fair sign-in: the `XERK-2568:` cases in `tenancy-nopassword.test.js`.
- Android signs in through `POST /api/login` and rides `hub_session` (XERK-2569), so local accounts
  work there too; Basic stays its break-glass fallback (`android/PARITY.md`).
