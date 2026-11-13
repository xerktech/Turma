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
  hub.usageLedger.setHostAliases([], [T]); // as syncLedgerAliases does each cache build
  agents[`k8x-01@${T}`] = { device: "k8x-01", lastSeen: NOW, sessions: [] };
  // Another tenant runs a host with the SAME new name: never a target for T's history.
  agents[`K8X-01@${OTHER}`] = { device: "K8X-01", lastSeen: NOW, sessions: [] };
  hub.ticketAgents[`${SITE}/ACME-7`] = { host: "MaxAI", at: NOW };
  agents["maxai-win"] = { device: "maxai-win", lastSeen: NOW, sessions: [] };
  seedHost(`k8x-01@${T}`, 50, tenantSite);
  seedHost("k8x", 30);
  seedHost(`k8x@${T}`, 70, tenantSite);
  seedHost("MaxAI", 9);
  hub.usageLedger.ingest("maxai-win", { device: "maxai-win", jira: { siteKey: SITE }, usage: usageOf(4), repoUsage: [] });
  // Another tenant's "maxai" is never another tenant's to take.
  seedHost(`maxai@${OTHER}`, 4, `${SITE}@${OTHER}`);

  // Before the merge the static alias already folds the tenant's old name into
  // its live card, so the Usage page never lists it as removed.
  const retired = hub.usageLedger.retiredAgents([`k8x-01@${T}`, "maxai-win"], NOW).map((r) => r.key);
  assert.ok(!retired.includes(`k8x@${T}`), `k8x@tenant read as a removed host: ${retired}`);
  assert.ok(!retired.includes("MaxAI"));
});

// The live card's total: the fold when it augments the report, else the host's own entry.
const servedTotal = (key, live) => {
  const f = hub.usageLedger.fold(key, { usage: null, repoUsage: [] }, NOW, live);
  return f ? f.usage.totals.input : hub.usageLedger.retiredAgents([], NOW).find((r) => r.key === key).usage.totals.input;
};

test("renamed hosts: every store's rows move to the live host", () => {
  const r = hub.runHostMerges();
  assert.equal(r.pending, 0);
  assert.ok(r.moved > 0);
  for (const old of ["k8x", `k8x@${T}`, "MaxAI"]) {
    assert.ok(!hub.permissionLedger.hostKeys().includes(old), `permission rows left under ${old}`);
    assert.ok(!hub.outcomeLedger.hostKeys().includes(old), `outcome rows left under ${old}`);
  }
  const perms = hub.permissionLedger.hostKeys();
  assert.ok(perms.includes(`k8x-01@${T}`) && perms.includes("maxai-win"));
  // Usage stays stored per install: the pre-tenancy row joined its own name's
  // tenant key (same install, high-water), nothing was summed into storage.
  assert.equal(hub.usageLedger.has("k8x"), false);
  assert.equal(hub.usageLedger.has(`k8x@${T}`), true);
  assert.equal(hub.usageLedger.has("MaxAI"), true);
  // ...and the live card SUMS the two installs: 50 (k8x-01) + 70 (k8x, max of its two copies).
  const live = [`k8x-01@${T}`, "maxai-win", `K8X-01@${OTHER}`];
  assert.equal(servedTotal(`k8x-01@${T}`, live), 120);
  assert.equal(servedTotal("maxai-win", live), 13);
  assert.ok(!hub.usageLedger.retiredAgents(live, NOW).some((x) => /^(k8x|maxai)/i.test(x.key) && !x.key.endsWith(OTHER)),
    "an old name still reads as a removed host");
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

test("renamed hosts: a rerun moves nothing and never inflates usage", () => {
  const live = [`k8x-01@${T}`, "maxai-win", `K8X-01@${OTHER}`];
  assert.deepEqual(hub.runHostMerges(), { moved: 0, pending: 0 });
  assert.equal(servedTotal(`k8x-01@${T}`, live), 120);
});

test("renamed hosts: two eras' usage is kept whole (sum across installs, never high-water)", () => {
  const E = T;
  const rep = (total, day, n) => {
    const b = (x) => ({ input: x, output: 0, cacheWrite: 0, cacheRead: 0 });
    return { totals: b(total), today: b(0), week: b(0), days: { [day]: b(n) }, sessions: 1, lastActivity: `${day}T00:00:00Z`, models: [] };
  };
  hub.usageLedger.ingest(`maxai@${E}`, { device: "maxai", usage: rep(2000, "2026-01-01", 40), repoUsage: [] });
  hub.usageLedger.ingest(`maxai-win@${E}`, { device: "maxai-win", usage: rep(1970, "2026-09-01", 20), repoUsage: [] });
  assert.equal(servedTotal(`maxai-win@${E}`, [`maxai-win@${E}`]), 3970);
  // Another tenant's hosts that merely share the names stay apart.
  hub.usageLedger.ingest(`maxai@${OTHER}`, { device: "maxai", usage: rep(10, "2026-09-02", 10), repoUsage: [] });
  hub.usageLedger.ingest(`maxai-win@${OTHER}`, { device: "maxai-win", usage: rep(20, "2026-09-02", 20), repoUsage: [] });
  assert.equal(servedTotal(`maxai-win@${OTHER}`, [`maxai-win@${OTHER}`]), 20);
});

test("renamed hosts: an old name waiting for its host keeps the merge going", () => {
  // A deployment migrated into W whose k8x-01 has not beaten there yet.
  const W = "d".repeat(32);
  const marker = hub.tenantMigrationMarker();
  marker.tenantId = W;
  try {
    seedHost(`k8x@${W}`, 5, `${SITE}@${W}`, "t-wait");
    assert.equal(hub.runHostMerges().pending, 1);
    agents[`k8x-01@${W}`] = { device: "k8x-01", lastSeen: NOW, sessions: [] };
    const r = hub.runHostMerges();
    assert.equal(r.pending, 0);
    assert.equal(archive.sessionRow("t-wait").host, `k8x-01@${W}`);
  } finally {
    marker.tenantId = T;
    delete agents[`k8x-01@${W}`];
  }
});

test("renamed hosts: an old name a machine still runs as is left alone", () => {
  agents.k8x = { device: "k8x", lastSeen: NOW, sessions: [] };
  seedHost("k8x", 3, SITE, "t-k8x-again");
  assert.equal(hub.runHostMerges().moved, 0);
  assert.equal(hub.usageLedger.has("k8x"), true);
  assert.equal(archive.sessionRow("t-k8x-again").host, "k8x");
  delete agents.k8x;
});

test("renamed hosts: an identity rename of a static host stays one card (no double count)", () => {
  const R = "e".repeat(32);
  const b = (x) => ({ input: x, output: 0, cacheWrite: 0, cacheRead: 0 });
  const rep = (n, day) => ({ totals: b(n), today: b(0), week: b(0), days: { [day]: b(n) }, sessions: 1, lastActivity: `${day}T00:00:00Z`, models: [] });
  hub.usageLedger.setHostAliases([[`k8x-01@${R}`, `k8x-02@${R}`]], [R]);
  try {
    hub.usageLedger.ingest(`k8x@${R}`, { device: "k8x", usage: rep(1000, "2026-05-01"), repoUsage: [] });
    hub.usageLedger.ingest(`k8x-01@${R}`, { device: "k8x-01", usage: rep(400, "2026-09-01"), repoUsage: [] });
    // k8x-02 is k8x-01 renamed: the same store, reported again under the new name.
    hub.usageLedger.ingest(`k8x-02@${R}`, { device: "k8x-02", usage: rep(400, "2026-09-01"), repoUsage: [] });
    const live = [`k8x-02@${R}`];
    assert.equal(servedTotal(`k8x-02@${R}`, live), 1400);
    assert.ok(!hub.usageLedger.retiredAgents(live, NOW).some((x) => x.key.endsWith(R)));
  } finally {
    hub.usageLedger.setHostAliases([], [T]);
  }
});

test("renamed hosts: a live host with no usage of its own still shows its old name's", () => {
  const Z = "f".repeat(32);
  hub.usageLedger.setHostAliases([], [Z]);
  try {
    hub.usageLedger.ingest(`maxai@${Z}`, { device: "maxai", usage: usageOf(77), repoUsage: [] });
    const f = hub.usageLedger.fold(`maxai-win@${Z}`, { usage: null, repoUsage: [] }, NOW, [`maxai-win@${Z}`]);
    assert.equal(f.usage.totals.input, 77);
  } finally {
    hub.usageLedger.setHostAliases([], [T]);
  }
});

test("renamed hosts: the tick keeps going while an old name is still live or waits for its host", () => {
  const H = 3600e3;
  agents.k8x = { device: "k8x", lastSeen: NOW, sessions: [] };
  hub.permissionLedger.ingest("k8x", [{ id: "p-tick", kind: "dialog", dialogKind: "permission", tool: "Bash",
    head: "ls", openedAt: NOW - 1000, closedAt: NOW, waitedMs: 1000, answer: "allow", via: "terminal" }], NOW);
  hub.hostMergeTick(NOW + H);
  assert.ok(hub.permissionLedger.hostKeys().includes("k8x"), "moved while the old name still ran");
  delete agents.k8x;
  hub.hostMergeTick(NOW + 2 * H);
  assert.ok(!hub.permissionLedger.hostKeys().includes("k8x"), "a skip for a live old name settled the tick");
});
