---
paths:
  - turma/server.js
  - turma/public/login.html
description: Turma's break-glass local login (XERK-595) — the IdP-independent way into the hub, and the invariants a future mandatory-OIDC change must never break.
---

# Turma break-glass local login (XERK-595, epic XERK-591)

The hub's `TURMA_USER`/`TURMA_PASSWORD` login is Turma's **break-glass**: a LOCAL credential that
does not depend on the IdP, so it keeps the hub reachable when Authentik/OIDC is down. It is the
same role Argo CD's local `admin` and Grafana's built-in `admin` play — see the ArgoCD repo's
`.claude/rules/break-glass.md` for the fleet-wide pattern this follows.

Native OIDC (XERK-592, `.claude/rules/turma-oidc.md`) is **purely additive**: the Authorization-Code
+ PKCE flow issues the SAME `hub_session` cookie `POST /api/login` issues, and authorization stays
the single `userAuthorized` decision. OIDC never replaces or gates the local login. **Making OIDC
the mandatory human login is a SEPARATE, later task** — this ticket exists so that task cannot lock
everyone out.

## The invariant (what a mandatory-OIDC change must never break)

A future change that makes OIDC the required human login MUST preserve all of:

- **`userAuthorized` keeps accepting the local break-glass credential** — the `hub_session` cookie
  from `POST /api/login`, AND the Basic-auth header (`TURMA_USER:TURMA_PASSWORD`). Basic is the
  headless/`curl` break-glass channel (the analogue of Argo's API path); do not remove it.
- **`/login` and `/api/login` stay in the `isLoginRoute` exempt set** (server.js) — the same seam
  OIDC extends for `/auth/oidc/*`. They must never sit behind an OIDC redirect, or the local form is
  unreachable exactly when the IdP is down.
- **`/login?breakglass=1` is never redirected to the IdP.** It is the deliberate, bookmarkable
  break-glass entry (the analogue of Argo CD's temporary `admin.enabled: true`): it always renders
  the local form and shows the break-glass banner (`login.html`). A mandatory-OIDC gate may bounce a
  bare `/login` to the IdP, but must honour this parameter.

If OIDC is made mandatory while `TURMA_PASSWORD` is UNSET, there is no break-glass and the IdP going
down IS a total lockout — which is the failure this whole ticket guards. So:

- `breakGlassEnabled()` (`= !!TURMA_PASSWORD`) reports whether a break-glass credential exists.
- **Boot logs it** (server.js startup): `ENABLED …` when set, a `WARNING: no break-glass login …`
  when not — so the lockout risk is visible before OIDC is made mandatory, not discovered mid-outage.

## Reaching break-glass when the IdP is down

- **Browser:** `https://<hub>/login?breakglass=1` → sign in with `TURMA_USER` / `TURMA_PASSWORD`.
- **Headless:** any authenticated call with `Authorization: Basic base64(TURMA_USER:TURMA_PASSWORD)`
  (e.g. `curl -u "$TURMA_USER:$TURMA_PASSWORD" https://<hub>/api/agents`).
- The credential lives only in the hub's own env (ArgoCD deployment), never in Authentik, so an IdP
  or AD outage cannot touch it.

## Tests

- `server.test.js`, the `XERK-595:` cases: local login works with NO OIDC configured (the
  IdP-unreachable baseline) — `POST /api/login` → 200 + `hub_session`, and that cookie authorises the
  browser API; Basic-auth break-glass authorises headless; `/login` and `/login?breakglass=1` are
  reachable with no session and the break-glass variant carries the banner markup;
  `breakGlassEnabled()` true with the password set and false when unset (`freshServerModule`).
- These cases are the regression guard the mandatory-OIDC task must keep green.
