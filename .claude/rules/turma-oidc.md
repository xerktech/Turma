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

## Native-app SSO handoff (XERK-591, Android)

The Android app can't run a browser-cookie flow: after the callback sets `hub_session` in the Custom
Tab's browser, the app's own HTTP client can't read that cookie. So a MOBILE-initiated OIDC flow ends
by handing the token back over an app deep link, PKCE-protected. The hub stays the SOLE Authentik RP.

- **The `turma://` redirect is hub↔app ONLY — it is NEVER sent to the IdP** (the IdP's registered
  `redirect_uri` stays `OIDC_REDIRECT_URI`, the hub callback), so this adds NO Authentik config.
  `TURMA_OIDC_MOBILE_REDIRECT` (default `turma://oidc-callback`) is the app deep link.
- **The flow reuses `/auth/oidc/login` + `/auth/oidc/callback` unchanged** — the app just sends
  `mobile=<code_challenge>` (SHA-256 of a secret verifier it keeps). It rides the tx to the callback;
  a callback whose tx carries `mobile` deep-links every outcome (`oidcMobileRedirect`) instead of the
  hub's HTML `/login` page — a browser page would strand the user in the Custom Tab. Length-capped
  (`OIDC_CHALLENGE_MAX`); an over-long one is dropped (treated as non-mobile).
- **On success the callback mints a single-use handoff `code`** bound to `{token, challenge}`
  (`oidcPutHandoff`, bounded `OIDC_HANDOFF_MAX`, TTL `OIDC_HANDOFF_TTL_MS`) and redirects to
  `<redirect>?code=<code>`. It sets NO session/sid cookie (the Custom Tab is throwaway).
- **`POST /api/oidc/mobile/exchange {code, verifier}`** releases the token ONLY if
  `SHA-256(verifier) === challenge` (`oidcTakeHandoff`, `timingSafeEqual`). **The code is single-use
  and burned on ANY exchange attempt** — a wrong verifier deletes it too, so there is no oracle to
  brute-force against, and a deep link intercepted by another app is useless without the verifier.
  The token returned IS the same opaque `hub_session` value, so it rides `userAuthorized` unchanged.
- **Both new routes are in `isLoginRoute`** (the app has no session yet): `/api/oidc/config` (public
  probe — `{enabled}` only, tells the app whether to offer the SSO button) and the exchange
  (self-authenticating on the code+verifier). Do NOT gate them behind `userAuthorized`.
- **A dead/forged tx does NOT deep-link** — the state-CSRF 400 and the exchange 400 fall through, and
  the app treats a non-deep-link outcome as a failed sign-in. Do not add a mobile deep-link to the
  invalid-state branch (an untrusted redirect must not carry a token).
- Android side (Custom Tab, `Cookie` auth, 401-drop) is in `android/PARITY.md` + `android.md`; the
  client PKCE mirrors `pkceChallenge` byte-for-byte (`core/Oidc.kt`).
- Tests: the `XERK-591:` cases in `oidc.test.js` (config probe, challenge carried into the tx,
  over-long dropped, deep-link + single-use exchange + token authorises, wrong-verifier burns the
  code, IdP-error deep-linked).

## Group-based access from the `groups` claim (XERK-594, epic XERK-591)

XERK-592 requested `groups` but neither read nor enforced it; **XERK-594 is the enforcement**. It
consumes the shared `groups` claim (XERK-582) as the authorization — the AD group IS the access.
(XERK-593 decides WHERE an unauthenticated human is sent; XERK-594 decides WHICH groups may enter —
and a group-denied user lands on `/login?error=forbidden`, which the XERK-593 gate treats as a failed
flow and renders the local form for, never re-bouncing to the IdP.)

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

## Gating human routes only — agents stay on token auth (XERK-593)

The core design constraint of the epic (XERK-591): the hub serves TWO audiences on one host/port, and
OIDC gates ONLY the humans. This is the app-side fix for the XERK-585 regression, where a forward-auth
outpost in front of the WHOLE host answered the agents' persistent WebSocket tunnels with an interactive
redirect they cannot complete, and the fleet went dead.

- **When `OIDC_ENABLED`, the human gate bounces an unauthenticated BROWSER to the IdP; agents are
  NEVER redirected.** `humanLoginRedirect(next)` is the ONE place the human gate picks its target
  (`/auth/oidc/login` when OIDC is on, `/login` otherwise). It is called ONLY on the human branch of
  the request handler — the `else if (!userAuthorized(req))` HTML redirect — which is reached AFTER
  every agent-token route has already been resolved, so it can never intercept an agent.
- **The exclusion is STRUCTURAL, not a per-route allowlist.** The agent-transport routes are decided
  in the `else if` chain BEFORE the human gate: `/api/heartbeat` (`agentPresentedRefusal`), the
  archive/updating/migration/upload blobs and `/api/agent/token` (`agentHostRefusal` /
  `resolveEnrollToken`), and — in the `upgrade` handler — `/agent/control` + `/agent/data`
  (`agentWsAuthorized`). None of them ever reaches `humanLoginRedirect`. **Do not move the OIDC
  redirect earlier in the chain, and do not add an "OIDC middleware" wrapping the whole handler** —
  that is precisely the XERK-585 shape.
- **A non-browser HUMAN caller (glasses, curl) still gets a plain 401, never a redirect** — the
  redirect is gated on `Accept: text/html` + GET. A WebSocket upgrade that fails auth is dropped at
  the socket (no HTTP body), so it is never an "interactive challenge" either.
- **Break-glass is exempt and stays reachable with OIDC on** (XERK-595, `turma-break-glass.md`):
  `/api/login` + Basic auth are in `isLoginRoute`, and `/login?breakglass=1` ALWAYS renders the local
  form — a bare `/login` bounces to the IdP, but the `breakglass` param never does. `oidcSafeNext`
  guards the `next` carried through the bounce.
- **RBAC is still separate** (XERK-594): this ticket decides only WHERE an unauthenticated human is
  sent, not WHICH `groups` may enter. Authorization stays the single `userAuthorized` decision.
- Acceptance bar (XERK-591): an agent tunnel establishes with NO interactive challenge — pinned by
  the `XERK-593:` tunnel-establishes case, and verified against a real agent in XERK-600.

## Tests

- `turma/tests/oidc-groups.test.js` (own process — group + OIDC env read at require time): the two
  pure helpers (claim-shape normalization, allow/role incl. admin-outranks-user), and the callback
  driven for a user-group / admin-group / neither-group / no-claim token (admit-with-role vs
  302→`/login?error=forbidden` with no session/record), plus the shorter session-cookie Max-Age.
- The `XERK-593:` cases in `oidc.test.js` (OIDC ON): the IdP bounce for a browser page + bare `/login`
  carrying `next`, `?breakglass=1` never bounced, break-glass cookie + Basic auth still authorise, the
  API-401-not-redirect rule, the heartbeat / self-enroll / `/agent/control` tunnel establishing on
  token auth with no redirect, and an unauthenticated tunnel dropped (not redirected). The OIDC-OFF
  branch (`humanLoginRedirect` → local form, no `/auth/oidc` bounce) is pinned by the `XERK-593:` cases
  in `server.test.js`, since that module runs with OIDC unset.
- `turma/tests/oidc.test.js` (own process — OIDC env read at require time). It **opts OUT of group
  enforcement** (both group names empty) so its flow cases run on claims with no `groups`, doubling as
  the XERK-594 opt-out coverage; it also holds the `XERK-593:` cases above. Covers the RFC 7636 PKCE
  vector, signature verify (valid/tampered/`alg:none`/wrong-key/unknown-kid), claim validation
  (iss/aud/exp/iat/nonce/azp + array aud), end-to-end verify with seeded discovery/JWKS, the
  kid-miss→refetch rotation path, `oidcSafeNext`, and the three routes driven against the real server
  (login redirect + stored tx, callback code-exchange→cookies with the token endpoint stubbed on
  `global.fetch`, logout end-session, public-gate reachability).
- `__setOidcCaches(discovery, jwks)` seeds the discovery/JWKS caches so a route/verify test runs with
  no live IdP.
