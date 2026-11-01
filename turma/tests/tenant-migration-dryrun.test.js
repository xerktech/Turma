// XERK-2554 — a dry run counts and logs, and changes nothing: no owner created,
// no row moved, and the tenant routes stay open (nothing is half-moved).
// Its own process: TURMA_MIGRATE_DRY_RUN is read at require time.

"use strict";

const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp } = require("./tmpdirs");

const DIR = mkdtemp("turma-tenant-migration-dry-");
process.env.TURMA_TEST = "1";
process.env.TURMA_PASSWORD = "glass-pass";
process.env.TURMA_AGENT_TOKEN = "agenttok-2554d";
process.env.TURMA_MIGRATE_OWNER = "local:nobody2554";
process.env.TURMA_MIGRATE_DRY_RUN = "1";
for (const k of ["STATE_FILE", "DEVICES_FILE", "AGENT_IDENTITIES_FILE", "TENANT_MIGRATION_FILE", "TENANCY_FILE",
  "AUTOSTART_ORGS_FILE", "USAGE_LEDGER_FILE", "PERMISSION_LEDGER_FILE", "OUTCOME_LEDGER_FILE", "MODEL_POLICY_FILE"]) {
  process.env[k] = path.join(DIR, `${k.toLowerCase()}.json`);
}
process.env.MIGRATE_SPOOL_DIR = path.join(DIR, "spool");
process.env.ARCHIVE_DIR = path.join(DIR, "archive");
process.env.ARCHIVE_DB = path.join(DIR, "archive", "index.db");

const tenancy = require("../tenancy.js");
const hub = require("../server.js");

test("XERK-2554: a dry run moves nothing, creates no owner and closes no route", async () => {
  hub.registerDevice("fcm-dry", "android", [], "");
  hub.tenantOrgStores().find((s) => s.name === "autoStartOrgs").read()["acme.atlassian.net"] = true;
  assert.equal(hub.tenantMigrationGateClosed(), false);
  const r = await hub.runTenantMigration();
  assert.equal(r.state, "dry-run");
  assert.equal(r.counts.devices, 1);
  assert.equal(r.counts.autoStartOrgs, 1);
  assert.equal(tenancy.findOwner(hub.tenancyState(), "local:nobody2554"), null, "no owner created");
  assert.ok(!hub.devicesState().find((d) => d.token === "fcm-dry").tenantId);
  assert.equal(hub.tenantMigrationMarker().tenantId, undefined);
  assert.equal(hub.tenantMigrationGateClosed(), false);
});
