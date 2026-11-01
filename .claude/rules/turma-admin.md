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

## Self-protection

- An admin cannot disable or delete its OWN account (409).
- A change that leaves no enabled admin AND no break-glass is refused (`adminWayInRemains`, 409):
  disable, regroup, delete and the group map all check it.
- SSO users: no password reset, no rename (the IdP owns both); their local groups ARE editable.

## Deleting a user deletes its tenant (`deleteUserAndTenant`), in this order

1. Disable the user (every cookie stops naming anybody).
2. Queue a `kill` for each running/queued session on its hosts and wait (bounded,
   `ADMIN_DELETE_KILL_WAIT_MS`, 20s) for each online host to TAKE it — kills ride the next beat,
   which a revoked token can no longer make, so kills always go BEFORE the revoke.
3. Revoke every agent identity of the tenant (a roll-bound one becomes a tombstone at its plain
   origin, the XERK-2383 rule) and bump that origin's name-token generation; cut their tunnels;
   drop their registry records.
4. Delete the tenant's enrollment codes. 5. `purgeTenantData` (the ticket queue, ledgers, archive,
   org stores — every registered purge). 6. Drop the user record.
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
