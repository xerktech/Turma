---
paths:
  - turma/usage-ledger.js
  - turma/usage-ledger-store.js
  - turma/permission-ledger.js
  - turma/outcome-ledger.js
  - turma/tenancy.js
  - turma/server.js
  - turma/tests/ledger-tenancy.test.js
  - turma/tests/usage-ledger.test.js
  - turma/tests/permission-ledger.test.js
  - turma/tests/outcome-ledger.test.js
  - turma/tests/server.test.js
description: Usage, permission and outcome ledgers + the routing policy partitioned by tenant (XERK-2550).
---

# Ledgers, insights and routing by tenant (XERK-2550, epic XERK-2529)

Decision + rationale: `docs/multi-tenant-adr.md` ("Usage, ledgers and insights belong to the
tenant"). Tenancy model: `turma-tenancy.md`.

## A row's tenant is its host key

- Every ledger row is keyed by the REGISTRY key of the host that produced it; a tenant host's key is
  `<device>@<tenantId>` (XERK-2533). `tenancy.tenantOfHostKey` reads it; server.js's `tenantOfKey`
  is the same function. Never add a separate stored tenant field — it could only disagree.
- A read takes a scope `visible(hostKey)`; `tenantScope(t)` is one tenant's ("" = untenanted).
- **A principal reads exactly ONE scope** (`ledgerTenantOf`/`ledgerVisible`): a tenant user its
  own tenant — even with the admin role too; a tenant-less principal that may drive untenanted
  hosts (break-glass, admin-only, legacy, open) the untenanted fleet; anyone else nothing.
  - Never `principalMayDriveHost` as the read scope: an admin + user would read its tenant AND the
    untenanted fleet as one aggregate, under its tenant's routing policy (QA-reproduced).

## No aggregate spans two tenants

- Served: `/api/permissions`, `/api/model-quality` and `/api/agents`' `retiredUsage` +
  `modelPolicy` are the caller's scope. `/metrics` (unauthenticated) counts the untenanted fleet.
- **`/api/agents` keeps ONE shared fleet body; only a per-scope TAIL differs**
  (`agentsScopeTail`, `"modelPolicy":…,"retiredUsage":…` appended last). `agentsCache.body` carries
  the operators' tail; `agentsPayloadFor(p)` composes another scope's and memoizes only its tail
  (bounded `AGENTS_SCOPED_TAILS_MAX_BYTES`). Never memoize a whole body per scope — each is the
  whole fleet. The agent LIST itself is not scoped here (XERK-2534).
- **`retiredAgents(liveKeys, now, visible)` filters BEFORE the `RETIRED_MAX` byte budget**, or
  another tenant's newer retired hosts crowd this scope's out.
- **`foldKey` leads with the key's tenant**, and `setHostAliases` never unions two tenants: no case
  twin, rename or tenant BIND folds spend across tenants. A host's pre-bind spend stays untenanted.
- Routing policy: state keys `<class>/<model>` (untenanted, the pre-tenancy keys) and
  `<tenantId>:<class>/<model>`; `modelPolicySweepTenant` per tenant; `modelPolicyPick` takes the
  DISPATCH host's tenant; the SSE `modelPolicy` frame goes only to clients whose ledger scope is
  that tenant (`sseBroadcast(..., {policyTenant})`, `ledgerTenantOf` of the `ssePrincipals` entry
  stamped at `/api/events` connect — a client with no scope gets no scoped frame).
- A tenant's demotion is NOT pushed: `notify()` fans out to every device until push is
  tenant-routed (XERK-2551). The untenanted fleet's demotion still notifies.
- A bus frame whose `policyTenant` is present but not a string is dropped, never delivered unscoped.
- Shadows: `shadowHostFor` takes only the live row's tenant's hosts; the daily cap and pair counts
  are per tenant; `pairsOf`/`pairEvidence` skip a pair whose two rows' tenants differ.
- Defects: `attributeDefects` entries carry the reporting host's `tenant` and mark only that tenant's
  rows of the org (absent = untenanted).
- `subscriptionKeyOf` prefixes the host's tenant: one Claude account in two tenants is two pools.
- Outcome eviction's org pass ranks by (tenant, org).

## Tenant purge

- `registerTenantPurge(name, fn)` + `purgeTenantData(tenantId)` (server.js) — the one entry point
  user deletion (XERK-2552) calls; sibling stores register into it. Each purge runs in its own
  try/catch; an invalid id throws before any runs.
- Ledger purges: usage `forget`s each host (Postgres `_deleteHost`); permission drops shards and
  `DELETE … WHERE right(host, 33) = '@<t>'` after any in-flight insert batch (else it lands after
  the DELETE); outcome deletes by key (live AND shadow rows); the
  routing policy drops `<t>:` keys. An empty/invalid id purges nothing in each ledger.

## Tests

- `turma/tests/ledger-tenancy.test.js` (own process): per-ledger scope, fold/alias, pair, defect,
  eviction and purge isolation.
- The `XERK-2550:` cases in `server.test.js`: per-principal `/api/agents` tail + ETag, scoped
  insights routes + `/metrics`, per-tenant promotion/pick, scoped SSE frame, shadow host + pause
  pools, `purgeTenantData`.
