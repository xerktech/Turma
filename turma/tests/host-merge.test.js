// Hosts renamed before agents had an identity (k8x -> k8x-01, maxai -> maxai-win)
// are MERGED into the name they beat as now: usage, permission prompts, outcomes
// and archived sessions all move to the live host, nothing is dropped, and a
// rerun moves nothing.
//
// Its own process: every store file is read at require time.

"use strict";

const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp } = require("./tmpdirs");

const DIR = mkdtemp("turma-host-merge-");
process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "glass";
process.env.TURMA_PASSWORD = "glass-pass";
for (const k of [
  "STATE_FILE", "DEVICES_FILE", "TICKET_AGENTS_FILE", "AGENT_IDENTITIES_FILE", "TENANT_MIGRATION_FILE",
  "ENROLL_CODES_FILE", "NAME_TOKEN_GENS_FILE", "TENANCY_FILE", "ARCHIVE_PURGED_TENANTS_FILE",
  "USAGE_LEDGER_FILE", "PERMISSION_LEDGER_FILE", "OUTCOME_LEDGER_FILE",
]) process.env[k] = path.join(DIR, `${k.toLowerCase()}.json`);
process.env.MIGRATE_SPOOL_DIR = path.join(DIR, "spool");
process.env.ARCHIVE_DIR = path.join(DIR, "archive");
process.env.ARCHIVE_DB = path.join(DIR, "archive", "index.db");

const archive = require("../archive.js");
const hub = require("../server.js");
const { agents } = hub;

const T = "a".repeat(32);
const OTHER = "b".repeat(32);
const SITE = "acme.atlassian.net";
const DAY = new Date().toISOString().slice(0, 10);
const NOW = Date.now();

const usageOf = (n) => {
  const b = { input: n, output: 0, cacheWrite: 0, cacheRead: 0 };
  return { totals: b, today: b, week: b, days: { [DAY]: b }, sessions: 1, lastActivity: `${DAY}T00:00:00Z`, models: [] };
};
const siteOf = (tid) => archive.listRowOwners().find((r) => r.transcriptId === tid).siteKey;
function seedHost(host, n, site = SITE, tid = `t-${host}`) {
  hub.usageLedger.ingest(host, { device: host.split("@")[0], jira: { siteKey: site }, usage: usageOf(n), repoUsage: [] });
  hub.permissionLedger.ingest(host, [{ id: `p-${host}`, kind: "dialog", dialogKind: "permission", tool: "Bash",
    head: "ls", openedAt: NOW - 1000, closedAt: NOW, waitedMs: 1000, answer: "allow", via: "terminal" }], NOW);
  hub.outcomeLedger.observe([{ site, issue: "ACME-1", host, sid: `s-${host}`, repo: "app",
    model: "opus", running: true, createdAt: "2026-10-01T00:00:00Z", prs: [], type: "Bug",
    statusCategory: "inprogress" }], NOW);
  const list = [{ uuid: "u1", role: "user", ts: "2026-10-01T00:00:00Z", text: "hello" }];
  archive.ingestChunk(host, tid, { repo: "app", remoteKey: "github.com/x/app", worktree: "/w",
    slug: "s", createdAt: "2026-10-01T00:00:00Z", endedTs: "2026-10-01T00:00:00Z", summary: "s" },
  0, Buffer.byteLength(JSON.stringify(list)), list, site);
}
const tenantSite = `${SITE}@${T}`;

test("renamed hosts: seed the old names' history beside the live hosts", () => {
  // k8x-01 lives in a tenant now (the pre-tenancy migration bound it); its old
  // name's history is both untenanted (never migrated) and migrated.
  // The pre-tenancy migration moved this deployment into tenant T.
  Object.assign(hub.tenantMigrationMarker(), { completedAt: NOW - 864e5, tenantId: T });
  agents[`k8x-01@${T}`] = { device: "k8x-01", lastSeen: NOW, sessions: [] };
  // Another tenant runs a host with the SAME new name: never a target for T's history.
  agents[`K8X-01@${OTHER}`] = { device: "K8X-01", lastSeen: NOW, sessions: [] };
  hub.ticketAgents[`${SITE}/ACME-7`] = { host: "MaxAI", at: NOW };
  agents["maxai-win"] = { device: "maxai-win", lastSeen: NOW, sessions: [] };
  seedHost(`k8x-01@${T}`, 50, tenantSite);
  seedHost("k8x", 30);
  seedHost(`k8x@${T}`, 70, tenantSite);
  seedHost("MaxAI", 9);
  // Another tenant's "maxai" is never another tenant's to take.
  seedHost(`maxai@${OTHER}`, 4, `${SITE}@${OTHER}`);

  // Before the merge the static alias already folds the tenant's old name into
  // its live card, so the Usage page never lists it as removed.
  const retired = hub.usageLedger.retiredAgents([`k8x-01@${T}`, "maxai-win"], NOW).map((r) => r.key);
  assert.ok(!retired.includes(`k8x@${T}`), `k8x@tenant read as a removed host: ${retired}`);
  assert.ok(!retired.includes("MaxAI"));
});

test("renamed hosts: every store's rows move to the live host", () => {
  const moved = hub.runHostMerges();
  assert.equal(moved, 3);
  for (const old of ["k8x", `k8x@${T}`, "MaxAI"]) {
    assert.equal(hub.usageLedger.has(old), false, `usage left under ${old}`);
    assert.ok(!hub.permissionLedger.hostKeys().includes(old), `permission rows left under ${old}`);
    assert.ok(!hub.outcomeLedger.hostKeys().includes(old), `outcome rows left under ${old}`);
  }
  // Nothing dropped: each old name's rows are on the live host.
  const perms = hub.permissionLedger.hostKeys();
  assert.ok(perms.includes(`k8x-01@${T}`) && perms.includes("maxai-win"));
  // Usage SUMS: the old names were different installs, so no era is dropped.
  const card = hub.usageLedger.retiredAgents([], NOW).find((r) => r.key === `k8x-01@${T}`);
  assert.equal(card.usage.totals.input, 150);
  assert.equal(hub.usageLedger.has(`K8X-01@${OTHER}`), false);
  assert.equal(hub.ticketAgents[`${SITE}/ACME-7`].host, "maxai-win");
  assert.equal(archive.sessionRow("t-k8x").host, `k8x-01@${T}`);
  // An untenanted row moving into the tenant takes its org into the tenant too.
  assert.equal(siteOf("t-k8x"), tenantSite);
  assert.equal(archive.sessionRow(`t-k8x@${T}`).host, `k8x-01@${T}`);
  assert.equal(archive.sessionRow("t-MaxAI").host, "maxai-win");
  assert.equal(siteOf("t-MaxAI"), SITE);
  // Another tenant's same-named host is untouched.
  assert.equal(hub.usageLedger.has(`maxai@${OTHER}`), true);
  assert.equal(archive.sessionRow(`t-maxai@${OTHER}`).host, `maxai@${OTHER}`);
});

test("renamed hosts: two eras' usage is kept whole (sum, never high-water)", () => {
  const rep = (total, day, n) => {
    const b = (x) => ({ input: x, output: 0, cacheWrite: 0, cacheRead: 0 });
    return { totals: b(total), today: b(0), week: b(0), days: { [day]: b(n) }, sessions: 1, lastActivity: `${day}T00:00:00Z`, models: [] };
  };
  hub.usageLedger.ingest("eraold", { device: "eraold", usage: rep(2000, "2026-01-01", 40), repoUsage: [] });
  hub.usageLedger.ingest("eranew", { device: "eranew", usage: rep(1970, "2026-09-01", 20), repoUsage: [] });
  const total = (k) => hub.usageLedger.retiredAgents([], NOW).find((r) => r.key === k).usage.totals.input;
  const before = total("eraold") + total("eranew");
  assert.ok(hub.usageLedger.rekeyHost("eraold", "eranew", { rename: true }));
  assert.equal(total("eranew"), before);
});

test("renamed hosts: a rerun moves nothing", () => {
  assert.equal(hub.runHostMerges(), 0);
});

test("renamed hosts: an old name a machine still runs as is left alone", () => {
  agents.k8x = { device: "k8x", lastSeen: NOW, sessions: [] };
  seedHost("k8x", 3, SITE, "t-k8x-again");
  assert.equal(hub.runHostMerges(), 0);
  assert.equal(hub.usageLedger.has("k8x"), true);
  assert.equal(archive.sessionRow("t-k8x-again").host, "k8x");
  delete agents.k8x;
});
