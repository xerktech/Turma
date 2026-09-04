---
paths:
  - "turma/server.js"
  - "turma/tests/oidc.test.js"
  - "turma/tests/oidc-groups.test.js"
  - "turma/public/login.html"
---

# OIDC relying-party in the hub (XERK-592, epic XERK-591)

The hub can be a native OIDC relying-party against Authentik. XERK-592 is the RP **core** only.
Read `.claude/rules/turma.md` "Auth and the glasses surface" for the auth model this plugs into.

## What XERK-592 is, and is NOT

- **It is the FLOW MECHANISM**: Authorization Code + PKCE, OIDC discovery, RS256 ID-token validation
  via JWKS, a browser session cookie, RP-initiated logout. Env-gated, stdlib-only (Node 24 global
  `fetch` + `crypto`).
- **It is NOT the human-only route gating, group RBAC, or break-glass** — those are separate epic
  tasks (XERK-591 scope, break-glass is XERK-595). Do not add route-gating middleware here.
- **The flow issues the EXISTING `hub_session` cookie** (`issueSessionToken`/`sessionSetCookie`), so
  OIDC slots in behind the one `userAuthorized` gate with no new authorization decision. The
  password login (`credentialsMatch`, `/api/login`) stays fully intact and IdP-independent.

## Enabling + config (env only, no secrets in git)

- **`OIDC_ENABLED` is the AND of all four**: `TURMA_OIDC_ISSUER`, `TURMA_OIDC_CLIENT_ID`,
  `TURMA_OIDC_CLIENT_SECRET`, `TURMA_OIDC_REDIRECT_URI`. Any missing → disabled, routes 404, password
  login unaffected. A PARTIAL set warns at boot (a misconfig is visible, not a silent 404).
- Optional: `TURMA_OIDC_SCOPES` (default `openid profile email groups` — `groups` requested for the
  follow-on RBAC task, the core neither reads nor enforces it), `TURMA_OIDC_POST_LOGOUT_REDIRECT_URI`
  (default `<redirect origin>/login`), `TURMA_OIDC_TIMEOUT_MS` (10s).

## Load-bearing invariants

- **The configured issuer only LOCATES discovery; `discovery.issuer` is authoritative for `iss`.**
  `OIDC_ISSUER` is the slash-stripped copy used to build `<issuer>/.well-known/openid-configuration`
  and to sanity-check the doc; tokens are validated against `discovery.issuer` VERBATIM (Authentik's
  issuer keeps its trailing slash, which is part of the `iss` claim). Do not normalize `iss`.
- **RS256 ONLY.** `oidcVerifySignature` rejects any `alg` but RS256 (closes `alg:none` /
  algorithm-confusion) and never trusts the token's own algorithm choice. Non-RSA/`use!="sig"`/
  non-RS256 JWKS entries are skipped at load.
- **A `kid` in the header MUST match a JWKS entry exactly** — a miss triggers ONE JWKS refetch
  (`oidcJwks(disco, true)`, key rotation) then rejection, never a fall-through to another key. Only a
  KEYLESS token falls back to the sole key, and only when there is exactly one.
- **Claim checks** (`oidcValidateClaims`): `iss`/`aud`/`exp`/`iat`(future)/`nonce`, ±120s skew; a
  multi-valued `aud` requires `azp == client_id`, and any `azp` present must equal `client_id`.
- **State + PKCE verifier live in an in-memory `oidcTx` map, single-use, 10-min TTL** — the hub is
  single-instance, so a login interrupted by a restart just retries. The callback consumes the tx
  (deletes it) whatever happens next. Bounded (`OIDC_TX_MAX`) so a `/login` flood can't grow it.
- **The flow is BOUND to the browser (login-CSRF defence).** Login sets a `hub_oidc_state` cookie to
  the `state`; the callback rejects (400) unless the cookie equals the returned `state`. Without it,
  an attacker who finished their OWN IdP auth could deliver their `code`+`state` to a victim and plant
  a session in the victim's browser — harmless while the session is the generic single-user one, but
  a real hole once the epic adds identity-based authz, so it is closed at the foundation. The cookie
  is cleared on every callback outcome.
- **The `next` param is open-redirect-guarded** (`oidcSafeNext`): only local same-origin paths
  (rejects `//`, `https://…`, `/\`); anything else → `/`.
- **Logout keeps the ID token OFF the session cookie.** A separate small `hub_oidc` sid cookie names
  an in-memory `oidcSessions` record holding the last ID token, used ONLY as the `id_token_hint` on
  RP-initiated logout (so a token with a big `groups` claim never has to fit in a cookie). Losing it
  on restart only means a hintless end-session — logout still clears the local session. Logout clears
  BOTH cookies and redirects to `end_session_endpoint` (falls back to `/login` if OIDC is off or the
  issuer advertises none).
- **Token exchange authenticates client_secret_basic** (Authentik confidential-provider default) —
  the secret rides the `Authorization: Basic` header, never the body.
- **Routes are `/auth/oidc/{login,callback,logout}`, added to the `isLoginRoute` EXEMPT set** so they
  bypass `userAuthorized` (a browser starting the flow has no session; the callback lands with the
  IdP's code before one exists). They authenticate themselves.

## Group-based access from the `groups` claim (XERK-594, epic XERK-591)

XERK-592 requested `groups` but neither read nor enforced it; **XERK-594 is the enforcement**. It
consumes the shared `groups` claim (XERK-582) as the authorization — the AD group IS the access.

- **The decision is at the CALLBACK, the one point a fresh token is read** — so removal from the AD
  group takes effect on the user's NEXT login (after the Authentik sync), which is the app-side half
  of "loses access on the next sync" (the end-to-end is verified IdP-side in task I). Enforced AFTER
  `oidcVerifyIdToken`, BEFORE any session is issued.
- **Two pure helpers, unit-tested offline**: `oidcGroupsFromClaims` normalizes the claim (array /
  bare single string / absent → `string[]`, dropping non-string members so a forged number can't
  match a name); `oidcAccessDecision(groups)` → `{allowed, role}`. `role` is `"admin"` for
  `OIDC_ADMIN_GROUP` (which OUTRANKS user — a user in both is admin), `"user"` for `OIDC_USER_GROUP`,
  else denied. **A denied user gets NO session and no `oidcSessions` record** — a 302 to
  `/login?error=forbidden` (which `login.html` surfaces, pointing them at the break-glass local
  credential). The tx is still consumed (single use).
- **Config, env only**: `TURMA_OIDC_USER_GROUP` (default `k8x-ai`), `TURMA_OIDC_ADMIN_GROUP` (default
  `k8x-admins`). The defaults ARE the real groups, so **enforcement is ON by default whenever OIDC is
  on**. Setting BOTH to empty is the deliberate opt-out (`OIDC_GROUPS_ENFORCED` false → any
  authenticated OIDC user admitted as a plain `user`); `?? default` leaves an explicit `""` untouched
  so unset ≠ empty. Boot logs which (a warn on the opt-out).
- **`role`/`groups` are recorded on the `oidcSessions` record for a future admin-only surface; NO
  route is gated on `admin` yet** (Turma has one `userAuthorized` level — admin currently grants the
  same access as user). The session cookie stays opaque (no identity on the wire); admin gating, when
  it comes, reads the record via the `hub_oidc` sid cookie. Do NOT put the role on the `hub_session`
  cookie.
- **OIDC-issued sessions are SHORTER-lived** so a revoked user re-authenticates (and is re-checked
  against current groups) within a bounded window: `issueSessionToken(ttlMs)` +
  `sessionSetCookie(req, token, ttlMs)` take `OIDC_SESSION_TTL_MS` (`TURMA_OIDC_SESSION_TTL_MS`,
  default 8h) on the OIDC path; **password/break-glass logins keep the 30-day `SESSION_TTL_MS`** (the
  IdP-outage path must not force re-login every few hours). The cookie Max-Age matches the token's
  own HMAC expiry.
- **Break-glass is untouched** (`turma-break-glass.md`): a denied OIDC user can still reach the local
  login if they hold the credential; group enforcement never gates `/api/login`, Basic auth, or
  `userAuthorized`. This is additive, exactly as XERK-592 was.

## Tests

- `turma/tests/oidc-groups.test.js` (own process — group + OIDC env read at require time): the two
  pure helpers (claim-shape normalization, allow/role incl. admin-outranks-user), and the callback
  driven for a user-group / admin-group / neither-group / no-claim token (admit-with-role vs
  302→`/login?error=forbidden` with no session/record), plus the shorter session-cookie Max-Age.
- `turma/tests/oidc.test.js` (own process — OIDC env read at require time). It **opts OUT of group
  enforcement** (both group names empty) so the flow tests run on claims with no `groups`; that
  doubles as the opt-out coverage. Covers the RFC 7636 PKCE
  vector, signature verify (valid/tampered/`alg:none`/wrong-key/unknown-kid), claim validation
  (iss/aud/exp/iat/nonce/azp + array aud), end-to-end verify with seeded discovery/JWKS, the
  kid-miss→refetch rotation path, `oidcSafeNext`, and the three routes driven against the real server
  (login redirect + stored tx, callback code-exchange→cookies with the token endpoint stubbed on
  `global.fetch`, logout end-session, public-gate reachability).
- `__setOidcCaches(discovery, jwks)` seeds the discovery/JWKS caches so a route/verify test runs with
  no live IdP.
