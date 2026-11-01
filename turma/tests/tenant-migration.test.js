// XERK-2554 — moving the pre-tenancy deployment into its owner's tenant.
//
// A fixture seeds untenanted data in EVERY partitioned store (each name the tenant
// purge knows, XERK-2550/2551/2549), runs the boot migration, and checks each one
// moved under the owner's tenant; the tenant routes stay closed until it
// completes; a host keeps its identity across the move; a rerun is a no-op.
//
// Its own process: TURMA_MIGRATE_OWNER and every store file are read at require time.

"use strict";

const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp } = require("./tmpdirs");

const DIR = mkdtemp("turma-tenant-migration-");
process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "glass";
process.env.TURMA_PASSWORD = "glass-pass";
process.env.TURMA_AGENT_TOKEN = "agenttok-2554";
process.env.TURMA_MIGRATE_OWNER = "local:owner2554";
for (const k of [
  "STATE_FILE", "DEVICES_FILE", "TICKET_AGENTS_FILE", "AGENT_IDENTITIES_FILE", "TENANT_MIGRATION_FILE",
  "ENROLL_CODES_FILE", "NAME_TOKEN_GENS_FILE", "TICKET_MODELS_FILE", "TICKET_RUNTIMES_FILE",
  "TICKET_PLATFORMS_FILE", "AUTOSTART_ORGS_FILE", "TRIAGE_POLICIES_FILE", "MODEL_POLICY_FILE",
  "PERMISSION_POLICIES_FILE", "TRIAGE_ACTIONS_FILE", "PRIORITY_WRITEBACK_ORGS_FILE",
  "DEDUPE_LINK_ORGS_FILE", "AUTOMERGE_ORGS_FILE", "ORG_COLORS_FILE", "REPO_TIERS_FILE",
  "EPIC_RUNS_FILE", "EPIC_BUILDERS_FILE", "DECISIONS_FILE", "TENANCY_FILE",
  "DAILY_BRIEF_SCHEDULES_FILE", "DAILY_BRIEFS_FILE", "MEETING_PROPOSALS_FILE", "MEETING_TOKENS_FILE",
  "ARCHIVE_PURGED_TENANTS_FILE", "USAGE_LEDGER_FILE", "PERMISSION_LEDGER_FILE", "OUTCOME_LEDGER_FILE",
]) process.env[k] = path.join(DIR, `${k.toLowerCase()}.json`);
process.env.MIGRATE_SPOOL_DIR = path.join(DIR, "spool");
process.env.ARCHIVE_DIR = path.join(DIR, "archive");
process.env.ARCHIVE_DB = path.join(DIR, "archive", "index.db");

const tenancy = require("../tenancy.js");
const archive = require("../archive.js");
const hub = require("../server.js");
const { server, agents } = hub;

const SITE = "acme.atlassian.net";
const DAY = new Date().toISOString().slice(0, 10);
const NOW = Date.now();

let baseUrl;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function request(method, pathName, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(baseUrl + pathName, {
      method,
      headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const breakGlass = { authorization: `Basic ${Buffer.from("glass:glass-pass").toString("base64")}` };
const beat = (token, device, extra = {}) => request("POST", "/api/heartbeat", {
  headers: { authorization: `Bearer ${token}` },
  body: { device, sessions: [], jira: { siteKey: SITE, configured: true, available: true }, ...extra },
});
const usageOf = (n) => {
  const b = { input: n, output: 0, cacheWrite: 0, cacheRead: 0 };
  return { totals: b, today: b, week: b, days: { [DAY]: b }, sessions: 1, lastActivity: `${DAY}T00:00:00Z`, models: [] };
};

// Every untenanted sample, one per org store (a value its coerce keeps).
const ORG_SAMPLES = {
  autoStartOrgs: [SITE, true],
  autoMergeOrgs: [SITE, true],
  triagePolicies: [SITE, { minPriority: "P2" }],
  permissionPolicies: [SITE, { text: "allow reads", at: NOW }],
  priorityWriteBackOrgs: [SITE, true],
  dedupeLinkOrgs: [SITE, true],
  orgColors: [SITE, 3],
  decisions: [SITE, [{ at: NOW, source: "note", text: "ship it" }]],
  dailyBriefSchedules: [SITE, { enabled: false }],
  dailyBriefs: [SITE, [{ runId: "ab12", status: "ok", trigger: "manual", meetingAt: NOW, dayFrom: NOW - 864e5,
    weekFrom: NOW - 7 * 864e5, until: NOW, startedAt: NOW, model: "haiku", host: "box2554", generatedAt: NOW,
    day: "Done.", week: "Done.", next: "Nothing." }]],
  meetingProposals: [SITE, [{ meetingId: "m-2554", status: "ok", title: "Standup", platform: "zoom",
    startedAt: NOW - 6e5, endedAt: NOW, receivedAt: NOW, participants: [], items: [] }]],
  ticketAgents: [`${SITE}/ACME-1`, { host: "box2554", at: NOW }],
  ticketModels: [`${SITE}/ACME-1`, { model: "sonnet", at: NOW }],
  ticketRuntimes: [`${SITE}/ACME-1`, { runtime: "dsh", at: NOW }],
  ticketPlatforms: [`${SITE}/ACME-1`, { platform: "linux", at: NOW }],
  triageActions: [`${SITE}/ACME-1`, { action: "hold", at: NOW }],
  epicRuns: [`${SITE}/ACME-9`, { epicKey: "ACME-9", siteKey: SITE, state: "running", children: ["ACME-1"],
    waves: [["ACME-1"]], startedAt: NOW, updatedAt: NOW }],
};

let owner;
let ownerCookie;
let boxToken;
test("XERK-2554: seed untenanted data in every partitioned store", async () => {
  // The owner exists (it signed in once before) — and is a tenant user.
  const r = tenancy.createLocalUser(hub.tenancyState(), {
    username: "owner2554", passwordHash: tenancy.hashPasswordSync("owner-pass-2554"), groups: ["turma-users"],
  });
  hub.__setTenancy(r.state);
  owner = r.user;
  ownerCookie = { cookie: `hub_session=${hub.issueSessionToken(60_000, { u: owner.id, t: owner.tenantId, r: ["user"] })}` };

  // A live host on its NAME token, and a retired one that only the ledgers and
  // the archive remember.
  boxToken = hub.hostAgentToken("box2554");
  assert.equal((await beat(boxToken, "box2554", { repoUsage: [], usage: usageOf(5) })).status, 200);
  assert.ok(agents.box2554);
  hub.usageLedger.ingest("gone2554", { device: "gone2554", jira: { siteKey: SITE }, usage: usageOf(7), repoUsage: [] });
  hub.permissionLedger.ingest("gone2554", [{ id: "p1", kind: "dialog", dialogKind: "permission", tool: "Bash",
    head: "ls", openedAt: NOW - 1000, closedAt: NOW, waitedMs: 1000, answer: "allow", via: "terminal" }], NOW);
  hub.outcomeLedger.observe([{ site: SITE, issue: "ACME-1", host: "gone2554", sid: "s1", repo: "app",
    model: "opus", running: true, createdAt: "2026-10-01T00:00:00Z", prs: [], type: "Bug",
    statusCategory: "inprogress" }], NOW);
  const list = [{ uuid: "u1", role: "user", ts: "2026-10-01T00:00:00Z", text: "hello" }];
  archive.ingestChunk("gone2554", "t2554", { repo: "app", remoteKey: "github.com/x/app", worktree: "/w",
    slug: "s", createdAt: "2026-10-01T00:00:00Z", endedTs: "2026-10-01T00:00:00Z", summary: "s" },
  0, Buffer.byteLength(JSON.stringify(list)), list, SITE);
  assert.equal(archive.sessionRow("t2554").host, "gone2554");

  for (const s of hub.tenantOrgStores()) {
    assert.ok(ORG_SAMPLES[s.name], `no sample for org store ${s.name} — add one`);
    const [k, v] = ORG_SAMPLES[s.name];
    s.read()[k] = v;
    await s.persist();
    assert.ok(Object.prototype.hasOwnProperty.call(s.read(), k), `${s.name}: the sample did not survive its coerce`);
  }
  hub.epicBuilders.b2554 = { id: "b2554", siteKey: SITE, title: "T", idea: "I", state: "queued", startedAt: NOW, updatedAt: NOW };
  hub.ticketQueue.push({ siteKey: SITE, issueKey: "ACME-2", source: "manual", at: NOW });
  hub.registerDevice("fcm-2554", "android", ["dismiss"], "");
  hub.__modelPolicyState()["bug/sonnet"] = { state: "promoted", at: NOW, graded: 40, mOnlyFail: 0 };
});

test("XERK-2554: every partitioned store has a migration step (meeting tokens are tenant-only)", () => {
  const steps = new Set(hub.tenantMigrationSteps.map((s) => s.name));
  for (const name of hub.tenantMigrationPurgeNames()) {
    if (name === "meetingTokens") continue;
    assert.ok(steps.has(name), `the ${name} store has a tenant purge but no migration step`);
  }
});

test("XERK-2554: the tenant routes stay closed until the migration completes; operators are served", async () => {
  assert.equal(hub.tenantMigrationGateClosed(), true);
  const a = await request("GET", "/api/agents", { headers: ownerCookie });
  assert.equal(a.status, 503);
  assert.match(a.body.error, /owner's tenant/);
  assert.equal((await request("GET", "/api/ws-token", { headers: ownerCookie })).status, 503);
  assert.equal((await request("GET", "/api/me", { headers: ownerCookie })).status, 200, "who am I still answers");
  assert.equal((await request("GET", "/api/agents", { headers: breakGlass })).status, 200);
});

test("XERK-2554: the migration moves every store into the owner's tenant; hosts keep their identity", async () => {
  const T = owner.tenantId;
  const tk = (k) => `${k}@${T}`;
  const r = await hub.runTenantMigration();
  assert.equal(r.state, "done", JSON.stringify(r));
  const m = hub.tenantMigrationMarker();
  assert.equal(m.tenantId, T);
  assert.ok(m.completedAt && m.hosts.includes("box2554") && m.hosts.includes("gone2554") && m.sites.includes(SITE));
  assert.equal(hub.tenantMigrationGateClosed(), false);
  // Every step reached disk before the marker did: a kill right after "done"
  // must not boot a completed marker over data that never moved (QA).
  const fs = require("fs");
  const disk = (k) => JSON.parse(fs.readFileSync(process.env[k], "utf8"));
  assert.ok(disk("TENANT_MIGRATION_FILE").completedAt);
  assert.ok(Object.prototype.hasOwnProperty.call(disk("AUTOSTART_ORGS_FILE"), tk(SITE)));
  assert.ok(Object.values(disk("AGENT_IDENTITIES_FILE")).some((e) => e.home === "box2554" && e.tenantId === T));
  assert.ok(disk("DEVICES_FILE").some((d) => d.token === "fcm-2554" && d.tenantId === T));

  // Org stores: the plain key is gone, the tenant's holds the value.
  for (const s of hub.tenantOrgStores()) {
    const [k] = ORG_SAMPLES[s.name];
    const nk = k === SITE ? tk(SITE) : `${tk(SITE)}${k.slice(SITE.length)}`;
    assert.ok(!Object.prototype.hasOwnProperty.call(s.read(), k), `${s.name}: plain key left behind`);
    assert.ok(Object.prototype.hasOwnProperty.call(s.read(), nk), `${s.name}: not moved to ${nk}`);
  }
  // A moved value's site and host fields follow.
  assert.equal(hub.tenantOrgStores().find((s) => s.name === "epicRuns").read()[`${tk(SITE)}/ACME-9`].siteKey, tk(SITE));
  assert.equal(hub.tenantOrgStores().find((s) => s.name === "ticketAgents").read()[`${tk(SITE)}/ACME-1`].host, tk("box2554"));
  assert.equal(hub.epicBuilders.b2554.siteKey, tk(SITE));
  assert.equal(hub.ticketQueue.find((e) => e.issueKey === "ACME-2").siteKey, tk(SITE));
  assert.equal(hub.devicesState().find((d) => d.token === "fcm-2554").tenantId, T);
  assert.ok(hub.__modelPolicyState()[`${T}:bug/sonnet`] && !hub.__modelPolicyState()["bug/sonnet"]);

  // The retired host's ledgers and archive rows moved at once.
  assert.ok(hub.usageLedger.has(tk("gone2554")) && !hub.usageLedger.has("gone2554"));
  assert.deepEqual(hub.permissionLedger.hostKeys().filter((h) => h.startsWith("gone2554")), [tk("gone2554")]);
  assert.deepEqual(hub.outcomeLedger.hostKeys(), [tk("gone2554")]);
  assert.deepEqual(hub.outcomeLedger.siteKeys(), [tk(SITE)]);
  const row = archive.listRowOwners().find((x) => x.transcriptId === "t2554");
  assert.equal(row.host, tk("gone2554"));
  assert.equal(row.siteKey, tk(SITE));
  assert.ok(archive.sessionRow("t2554", { tenant: T }), "the tenant's scope reads it");
  assert.equal(archive.sessionRow("t2554", { untenanted: true }), null, "the operators' scope does not");

  // The live host: its identity is bound and handed to it; its rows wait for it.
  const uid = Object.keys(hub.agentIdentities()).find((u) => hub.agentIdentities()[u].home === "box2554");
  assert.equal(hub.agentIdentities()[uid].tenantId, T);
  const st = agents.box2554.commands.find((c) => c.type === "setToken");
  assert.ok(st && st.bindTenant === T, JSON.stringify(agents.box2554.commands));
  assert.ok(hub.usageLedger.has("box2554"), "a live host's rows move at its bind beat");

  // Its next beat on the identity token lands in the tenant and its rows follow.
  const after = await beat(st.token, "box2554", { repoUsage: [], usage: usageOf(5) });
  assert.equal(after.status, 200);
  assert.ok(agents[tk("box2554")] && !agents.box2554);
  assert.ok(!hub.usageLedger.has("box2554") && hub.usageLedger.has(tk("box2554")));
  // The owner sees its fleet now.
  const a = await request("GET", "/api/agents", { headers: ownerCookie });
  assert.equal(a.status, 200);
  assert.ok(a.body.agents.some((x) => x.key === tk("box2554")));
  // …and break-glass no longer reaches it.
  const bg = await request("GET", "/api/agents", { headers: breakGlass });
  assert.ok(!bg.body.agents.some((x) => x.key === tk("box2554")));
});

test("XERK-2554: a rerun is a no-op", async () => {
  const before = JSON.stringify(hub.tenantMigrationMarker());
  assert.equal(await hub.runTenantMigration(), null);
  assert.equal(hub.migrateTenantLeftovers(), 0);
  for (const s of hub.tenantMigrationSteps) assert.equal(s.count(owner.tenantId), 0, `${s.name} still counts work`);
  assert.equal(JSON.stringify(hub.tenantMigrationMarker()), before);
});

test("XERK-2554: a leftover row for a migrated host is re-keyed; a new untenanted host is left alone", () => {
  const T = owner.tenantId;
  hub.usageLedger.ingest("gone2554", { device: "gone2554", jira: { siteKey: SITE }, usage: usageOf(9), repoUsage: [] });
  hub.usageLedger.ingest("fresh2554", { device: "fresh2554", jira: { siteKey: "other.example" }, usage: usageOf(1), repoUsage: [] });
  hub.tenantOrgStores().find((s) => s.name === "autoStartOrgs").read()["other.example"] = true;
  assert.ok(hub.migrateTenantLeftovers() >= 1);
  assert.ok(!hub.usageLedger.has("gone2554") && hub.usageLedger.has(`gone2554@${T}`));
  assert.ok(hub.usageLedger.has("fresh2554"), "a host enrolled after the move stays the operators'");
  assert.equal(hub.tenantOrgStores().find((s) => s.name === "autoStartOrgs").read()["other.example"], true);
});

test("XERK-2554: an org an operator host works in after the move keeps its operators' settings", async () => {
  const T = owner.tenantId;
  // An operator enrolls a new untenanted host on the same site and opts it in.
  assert.equal((await beat(hub.hostAgentToken("opz2554"), "opz2554")).status, 200);
  const autostart = hub.tenantOrgStores().find((s) => s.name === "autoStartOrgs").read();
  autostart[SITE] = true;
  hub.ticketQueue.push({ siteKey: SITE, issueKey: "ACME-7", source: "manual", at: Date.now() });
  hub.migrateTenantLeftovers();
  assert.equal(autostart[SITE], true, "the operators' new setting stays theirs");
  assert.equal(hub.ticketQueue.find((e) => e.issueKey === "ACME-7").siteKey, SITE);
  assert.ok(agents.opz2554 && !agents[`opz2554@${T}`], "nor is the new host bound");
});

test("XERK-2554: at one host's bind beat its outcome rows move host AND site, while another recorded host still beats plain", async () => {
  const T = owner.tenantId;
  delete agents.opz2554;   // the previous test's operator host would make the org the operators'
  // A recorded host still on its plain name (bound, it has not re-beaten yet).
  assert.equal((await beat(hub.hostAgentToken("gone2554"), "gone2554")).status, 200);
  assert.ok(agents.gone2554);
  hub.agentIdentities()["f".repeat(32)] = { origin: "gone2554", home: "gone2554", at: 1, tenantId: T };
  agents.gone2554.agentUid = "f".repeat(32);
  hub.outcomeLedger.observe([{ site: SITE, issue: "ACME-5", host: "box2554", sid: "s5", repo: "app",
    model: "opus", running: true, createdAt: "2026-10-01T00:00:00Z", prs: [], type: "Bug",
    statusCategory: "inprogress" }], Date.now());
  hub.migrateTenantLeftovers("box2554");
  assert.ok(!hub.outcomeLedger.siteKeys().includes(SITE), JSON.stringify(hub.outcomeLedger.siteKeys()));
  assert.ok(hub.outcomeLedger.hostKeys().includes(`box2554@${T}`));
  // A row already on the tenant's host but left on the plain site is healed too.
  hub.outcomeLedger.observe([{ site: SITE, issue: "ACME-6", host: `box2554@${T}`, sid: "s6", repo: "app",
    model: "opus", running: true, createdAt: "2026-10-01T00:00:00Z", prs: [], type: "Bug",
    statusCategory: "inprogress" }], Date.now());
  hub.migrateTenantLeftovers();
  assert.ok(!hub.outcomeLedger.siteKeys().includes(SITE));
});

test("XERK-2554: an operator host re-using a recorded name keeps its own settings, rows and identity", () => {
  const T = owner.tenantId;
  // gone2554 is now an operator's host under the recorded name: no bound identity.
  delete agents.gone2554.agentUid;
  delete hub.agentIdentities()["f".repeat(32)];
  const autostart = hub.tenantOrgStores().find((s) => s.name === "autoStartOrgs").read();
  autostart[SITE] = true;
  hub.migrateTenantLeftovers();
  assert.equal(autostart[SITE], true, "its org's plain settings stay the operators'");
  // A fresh identity minted for that name after the run is never bound by the sweep.
  hub.agentIdentities()["e".repeat(32)] = { origin: "gone2554", home: "gone2554", at: Date.now() };
  agents.gone2554.agentUid = "e".repeat(32);
  for (const s of hub.tenantMigrationSteps.filter((x) => x.name === "hosts" || x.name === "agentIdentities")) {
    assert.equal(s.count(T, { hosts: new Set(["gone2554"]), sites: new Set(), recorded: new Set(["gone2554"]), t: T }), 0, s.name);
  }
  hub.migrateTenantLeftovers();
  assert.ok(!hub.agentIdentities()["e".repeat(32)].tenantId);
  // box2554 arrived on its tenant key: rows an operator later leaves under its
  // plain name (the host removed again) stay plain.
  delete agents.gone2554;
  hub.usageLedger.ingest("box2554", { device: "box2554", jira: { siteKey: SITE }, usage: usageOf(2), repoUsage: [] });
  hub.migrateTenantLeftovers();
  assert.ok(hub.usageLedger.has("box2554"), "a re-used name's rows are not the migrated host's");
});

test("XERK-2554: a refusal the tick repeats is logged once, not every tick", () => {
  const lines = [];
  const orig = console.error;
  console.error = (l) => lines.push(l);
  try {
    hub.logTenantMigrationError("tenant migration refused: x");
    hub.logTenantMigrationError("tenant migration refused: x");
    hub.logTenantMigrationError("tenant migration refused: y");
  } finally { console.error = orig; }
  assert.equal(lines.length, 2);
});

test("XERK-2554: a bound host that lost its queued setToken (pruned offline) is handed its identity again", async () => {
  const T = owner.tenantId;
  const uid = "d".repeat(32);
  delete hub.agentIdentities()["e".repeat(32)];   // the previous test's operator identity
  hub.agentIdentities()[uid] = { origin: "gone2554", home: "gone2554", at: 1, tenantId: T };
  assert.equal((await beat(hub.hostAgentToken("gone2554"), "gone2554")).status, 200);
  agents.gone2554.commands = [];
  hub.migrateTenantLeftovers();
  const st = (agents.gone2554.commands || []).find((c) => c.type === "setToken");
  assert.ok(st && st.bindTenant === T && st.token === hub.uidAgentToken(uid), JSON.stringify(agents.gone2554.commands));
  hub.migrateTenantLeftovers();
  assert.equal(agents.gone2554.commands.filter((c) => c.type === "setToken").length, 1, "queued once");
  // It adopts the token: its record is carried over, no plain ghost is left, and
  // its rows follow it.
  hub.usageLedger.ingest("gone2554", { device: "gone2554", jira: { siteKey: SITE }, usage: usageOf(4), repoUsage: [] });
  assert.equal((await beat(st.token, "gone2554", { usage: usageOf(4), repoUsage: [] })).status, 200);
  assert.ok(agents[`gone2554@${T}`] && !agents.gone2554, Object.keys(agents).join(","));
  assert.ok(!hub.usageLedger.has("gone2554") && hub.usageLedger.has(`gone2554@${T}`));
});

test("XERK-2554: a migrated host's arrival outlives a revoke of its identity", () => {
  const T = owner.tenantId;
  assert.ok(hub.tenantMigrationMarker().arrived.includes("box2554"));
  // The tenant removes + revokes it: its identity is gone, the name is not unarrived.
  for (const [u, e] of Object.entries(hub.agentIdentities())) if (e.home === `box2554@${T}`) delete hub.agentIdentities()[u];
  hub.usageLedger.ingest("box2554", { device: "box2554", jira: { siteKey: SITE }, usage: usageOf(3), repoUsage: [] });
  hub.migrateTenantLeftovers();
  assert.ok(hub.usageLedger.has("box2554"), "an operator's later rows under the name stay plain");
});
