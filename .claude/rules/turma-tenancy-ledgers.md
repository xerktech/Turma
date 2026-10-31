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
- A read takes a scope `visible(hostKey)`; a principal's is `ledgerVisible(p)` =
  `principalMayDriveHost`, the per-host routes' rule. `tenantScope(t)` is one tenant's ("" =
  untenanted), what the routing sweep and `/metrics` read.

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
  DISPATCH host's tenant; the SSE `modelPolicy` frame goes only to clients reading that tenant's
  policy (`sseBroadcast(..., {policyTenant})`, `ssePrincipals` stamped at `/api/events` connect).
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
  `DELETE … WHERE right(host, 33) = '@<t>'`; outcome deletes by key (live AND shadow rows); the
  routing policy drops `<t>:` keys. An empty/invalid id purges nothing in each ledger.

## Tests

- `turma/tests/ledger-tenancy.test.js` (own process): per-ledger scope, fold/alias, pair, defect,
  eviction and purge isolation.
- The `XERK-2550:` cases in `server.test.js`: per-principal `/api/agents` tail + ETag, scoped
  insights routes + `/metrics`, per-tenant promotion/pick, scoped SSE frame, shadow host + pause
  pools, `purgeTenantData`.
