---
paths:
  - turma/server.js
  - turma/tenancy.js
  - turma/tenant-scope.js
  - turma/public/admin.html
  - turma/public/nav.js
  - turma/tests/admin.test.js
description: The admin panel (XERK-2552) — users, local groups/roles, deleting a user and its tenant, the audit log.
---

# The admin panel (`/admin`, `/api/admin/*`, XERK-2552)

Tenancy model: `turma-tenancy.md`. Decision: `docs/multi-tenant-adr.md` ("an admin manages identities only").

## Access

- **Route class `admin`** (`tenant-scope.js`): the tenant gate 404s any principal without the admin
  role (`principalIsAdmin`) before a route runs — OIDC admin group, local `turma-admins`, break-glass,
  or an open hub. 404, never 403, like every refusal there.
- **Identities only.** `adminUserView` is the ONE shape served: name, source, roles, groups, disabled,
  created, last sign-in, host COUNT, an OIDC user's `idpRoles` (read-only). Never the tenant id,
  user's hosts, password hash, OIDC subject, or anything from inside a tenant.
  - Never add a route that switches into, or acts as, a user. No impersonation, by design.
- The handler block is `url.pathname.startsWith("/api/admin/")`, not a `parts[...]` test: the
  route-table test scans those and would read the block itself as a route.

## Writes are same-origin JSON, and never from an open hub

- A write (POST/PUT/PATCH/DELETE) is refused cross-site (`sameOriginUpgrade`, 403) and needs
  `content-type: application/json` (415): the hub parses any body as JSON, and a cross-site form
  rides the Lax cookie on a top-level POST.
- **An open hub (no login configured) refuses every admin write (409)**: its principal is an admin
  for EVERY caller, and creating a local account closes the hub — an anonymous caller (or any web
  page, by CSRF) took the hub over that way (QA).

## Self-protection

- An admin cannot disable or delete its OWN account (409).
- A change that leaves no enabled admin AND no break-glass is refused (`adminWayInRemains`, 409):
  disable, regroup, delete and the group map all check it. An SSO admin counts only while OIDC is
  configured (with it off nobody signs in that way). Tests: `admin-nopassword.test.js`.
- SSO users: no password reset, no rename (the IdP owns both); their local groups ARE editable.

## Deleting a user deletes its tenant (`deleteUserAndTenant`), in this order

1. Close every way in: disable the user, delete its enrollment codes, and run the purges that
   dispatch new work (`ADMIN_DELETE_EARLY_PURGES`: ticket queue, auto-start, epic runs/builders).
   While it runs the tenant is in `tenantsBeingDeleted`: a re-enable is 409 and no code of it
   redeems. A code also never redeems once its owner is disabled or lost the user role.
2. Queue a `kill` for each live session on its hosts, RE-SCANNED until the wait ends (bounded,
   `ADMIN_DELETE_KILL_WAIT_MS`, 20s), so a session or host appearing meanwhile is killed too. Kills
   ride the next beat, which a revoked token can no longer make, so they always go BEFORE the revoke.
3. Revoke every agent identity of the tenant, read AFTER the wait (a roll-bound one becomes a
   tombstone at its plain origin, the XERK-2383 rule) and bump that origin's name-token generation;
   cut their tunnels; drop their registry records.
4. `purgeTenantData` (ledgers, archive, org stores — every registered purge). 5. Drop the user record.
- A store that holds a tenant's data registers a purge (`registerTenantPurge`); never special-case
  it here.
- Single-flight per user (`adminDeletesInFlight`).

## Audit log

- `/data/admin-audit.json` (`ADMIN_AUDIT_FILE`), `registerExternalStore`, `debounceMs: 0`, 0600, the
  newest 1000 rows `{at, actor, action, target?, detail?}`; `coerceAdminAudit` is the whitelist.
- Every admin write records one row; `detail` is built from fixed fields — never a password.

## Clients

- `nav.js` shows an Admin tab only for an admin-role principal, remembered in `turma-admin`
  (localStorage) so the header keeps its shape on load (XERK-2432); the admin-only note links to it.
- Web only: `android/PARITY.md`.
- Tests: `turma/tests/admin.test.js` (authz 404s, metadata-only list, create/regroup/reset/disable,
  self-protection, group map, delete-user end to end).
