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
process.env.ARCHIVE_TENANT_MAX_BYTES = "10";   // any moved archive is over it
for (const k of ["STATE_FILE", "DEVICES_FILE", "AGENT_IDENTITIES_FILE", "TENANT_MIGRATION_FILE", "TENANCY_FILE",
  "AUTOSTART_ORGS_FILE", "USAGE_LEDGER_FILE", "PERMISSION_LEDGER_FILE", "OUTCOME_LEDGER_FILE", "MODEL_POLICY_FILE"]) {
  process.env[k] = path.join(DIR, `${k.toLowerCase()}.json`);
}
process.env.MIGRATE_SPOOL_DIR = path.join(DIR, "spool");
process.env.ARCHIVE_DIR = path.join(DIR, "archive");
process.env.ARCHIVE_DB = path.join(DIR, "archive", "index.db");

const tenancy = require("../tenancy.js");
const hub = require("../server.js");
const archive = require("../archive.js");

test("XERK-2554: a dry run moves nothing, creates no owner and closes no route", async () => {
  hub.registerDevice("fcm-dry", "android", [], "");
  hub.tenantOrgStores().find((s) => s.name === "autoStartOrgs").read()["acme.atlassian.net"] = true;
  assert.equal(hub.tenantMigrationGateClosed(), false);
  const list = [{ uuid: "u1", role: "user", ts: "2026-10-01T00:00:00Z", text: "hello there" }];
  archive.ingestChunk("oldhost", "td2554", { repo: "app", remoteKey: "github.com/x/app", worktree: "/w",
    slug: "s", createdAt: "2026-10-01T00:00:00Z", endedTs: "2026-10-01T00:00:00Z", summary: "s" },
  0, Buffer.byteLength(JSON.stringify(list)), list, "acme.atlassian.net");
  const warned = [];
  const orig = console.warn;
  console.warn = (l) => warned.push(String(l));
  let r;
  try { r = await hub.runTenantMigration(); } finally { console.warn = orig; }
  assert.ok(warned.some((l) => /over its 10-byte quota \(ARCHIVE_TENANT_MAX_BYTES\)/.test(l)), warned.join("\n"));
  assert.equal(r.state, "dry-run");
  assert.equal(r.counts.devices, 1);
  assert.equal(r.counts.autoStartOrgs, 1);
  assert.equal(tenancy.findOwner(hub.tenancyState(), "local:nobody2554"), null, "no owner created");
  assert.ok(!hub.devicesState().find((d) => d.token === "fcm-dry").tenantId);
  assert.equal(hub.tenantMigrationMarker().tenantId, undefined);
  assert.equal(hub.tenantMigrationGateClosed(), false);
});
