"use strict";

// XERK-2552 — the admin panel: users, local groups and roles, deleting a user
// (and its tenant), the audit log. Its own process: the break-glass and
// bootstrap env are read at require time. Credentials are test fixtures.

const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, scratchDir } = require("./tmpdirs");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "glass";
process.env.TURMA_PASSWORD = "glass-pass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
process.env.TURMA_BOOTSTRAP_ADMIN_USER = "rootadmin";
process.env.TURMA_BOOTSTRAP_ADMIN_PASSWORD = "root-admin-pass";
process.env.ADMIN_DELETE_KILL_WAIT_MS = "3000";

const tmp = (name) => path.join(scratchDir(), `turma-admin-${name}-${process.pid}.json`);
for (const [k, n] of [
  ["STATE_FILE", "state"], ["DEVICES_FILE", "devices"], ["TICKET_AGENTS_FILE", "ticket-agents"],
  ["AGENT_IDENTITIES_FILE", "agent-identities"], ["TENANCY_FILE", "tenancy"],
  ["AUTOSTART_ORGS_FILE", "autostart-orgs"], ["TICKET_MODELS_FILE", "ticket-models"],
  ["TICKET_RUNTIMES_FILE", "ticket-runtimes"], ["ORG_COLORS_FILE", "org-colors"],
  ["TRIAGE_POLICIES_FILE", "triage-policies"], ["TRIAGE_ACTIONS_FILE", "triage-actions"],
  ["USAGE_LEDGER_FILE", "usage-ledger"], ["ENROLL_CODES_FILE", "enroll-codes"],
  ["ADMIN_AUDIT_FILE", "admin-audit"], ["NAME_TOKEN_GENS_FILE", "name-token-gens"],
  ["MEETING_TOKENS_FILE", "meeting-tokens"], ["MODEL_POLICY_FILE", "model-policy"],
  ["PERMISSION_LEDGER_FILE", "permission-ledger"], ["OUTCOME_LEDGER_FILE", "outcome-ledger"],
  ["ARCHIVE_PURGED_TENANTS_FILE", "archive-purged-tenants"],
]) process.env[k] = tmp(n);
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-admin-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-admin-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const tenancy = require("../tenancy.js");
const hub = require("../server.js");
const { server } = hub;

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
        try { parsed = JSON.parse(raw); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
async function cookieFor(username, password) {
  const r = await request("POST", "/api/login", { body: { username, password } });
  const m = (r.headers["set-cookie"] || []).join("\n").match(/hub_session=([^;]+)/);
  return m ? { cookie: `hub_session=${m[1]}` } : null;
}
const BASIC = { authorization: "Basic " + Buffer.from("glass:glass-pass").toString("base64") };
async function addUser(username, groups) {
  const { state, user } = tenancy.createLocalUser(hub.tenancyState(), {
    username, passwordHash: await tenancy.hashPassword(`${username}-password`), groups,
  });
  hub.__setTenancy(state);
  return user;
}
const userOf = (name) => Object.values(hub.tenancyState().users).find((u) => u.username === name);

const ADMIN_ROUTES = [
  ["GET", "/admin"], ["GET", "/api/admin/users"], ["POST", "/api/admin/users", { username: "x9", password: "longenough1" }],
  ["GET", "/api/admin/groups"], ["PUT", "/api/admin/groups", { groups: { "turma-users": "admin" } }],
  ["GET", "/api/admin/audit"],
];

test("XERK-2552: a user-role principal gets 404 on every admin route; nothing changes", async () => {
  const u = await addUser("plainuser", ["turma-users"]);
  const h = await cookieFor("plainuser", "plainuser-password");
  assert.ok(h);
  for (const [m, p, body] of [...ADMIN_ROUTES,
    ["PATCH", `/api/admin/users/${u.id}`, { disabled: true }],
    ["POST", `/api/admin/users/${u.id}/password`, { password: "another-pass" }],
    ["DELETE", `/api/admin/users/${u.id}`]]) {
    const r = await request(m, p, { headers: h, body });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  assert.ok(userOf("plainuser"), "the user still exists");
  assert.equal(userOf("x9"), undefined, "no user was created");
  assert.equal(hub.tenancyState().groups, undefined, "the group map is untouched");
  // Unauthenticated: the login gate answers before the admin gate.
  assert.equal((await request("GET", "/api/admin/users")).status, 401);
});

test("XERK-2552: break-glass and an admin-group user reach the panel; the list is metadata only", async () => {
  const bootstrap = await cookieFor("rootadmin", "root-admin-pass");
  for (const h of [BASIC, bootstrap]) {
    const r = await request("GET", "/api/admin/users", { headers: h });
    assert.equal(r.status, 200);
    assert.ok(r.body.users.some((u) => u.name === "rootadmin" && u.roles.includes("admin")));
    for (const u of r.body.users) {
      assert.deepEqual(Object.keys(u).filter((k) => !["id", "name", "displayName", "source", "roles", "groups",
        "disabled", "createdAt", "hosts", "lastLoginAt", "disabledBy", "idpRoles"].includes(k)), [], "no extra field");
    }
    for (const t of Object.values(hub.tenancyState().users).map((x) => x.tenantId)) {
      assert.ok(!r.raw.includes(t), "never a tenant id");
    }
    assert.ok(!r.raw.includes("scrypt$"), "never a password hash");
    const page = await request("GET", "/admin", { headers: h });
    assert.equal(page.status, 200);
    assert.match(page.raw, /<title>Turma — Admin<\/title>/);
  }
});

test("XERK-2552: an admin-ONLY principal still sees no tenant data", async () => {
  await addUser("adminonly", ["turma-admins"]);
  const h = await cookieFor("adminonly", "adminonly-password");
  assert.equal((await request("GET", "/api/admin/users", { headers: h })).status, 200);
  const me = await request("GET", "/api/me", { headers: h });
  assert.equal(me.body.tenant, false, "the admin role grants no tenant");
});

test("XERK-2552: create, sign in, regroup, reset password, disable/enable — each audited, no password logged", async () => {
  const H = BASIC;
  assert.equal((await request("POST", "/api/admin/users", { headers: H, body: { username: "bad name", password: "longenough1" } })).status, 400);
  assert.equal((await request("POST", "/api/admin/users", { headers: H, body: { username: "newbie", password: "short" } })).status, 400);
  const c = await request("POST", "/api/admin/users", { headers: H, body: { username: "newbie", password: "first-secret-1", groups: ["turma-users"] } });
  assert.equal(c.status, 200, c.raw);
  assert.deepEqual(c.body.user.roles, ["user"]);
  assert.equal((await request("POST", "/api/admin/users", { headers: H, body: { username: "NEWBIE", password: "first-secret-1" } })).status, 409);
  assert.ok(await cookieFor("newbie", "first-secret-1"), "the new user signs in");
  const id = c.body.user.id;

  const g = await request("PATCH", `/api/admin/users/${id}`, { headers: H, body: { groups: ["turma-users", "turma-admins"] } });
  assert.deepEqual(g.body.user.roles, ["user", "admin"]);
  assert.equal((await request("PATCH", `/api/admin/users/${id}`, { headers: H, body: { groups: ["bad group!"] } })).status, 400);

  assert.equal((await request("POST", `/api/admin/users/${id}/password`, { headers: H, body: { password: "second-secret-2" } })).status, 200);
  assert.equal(await cookieFor("newbie", "first-secret-1"), null, "the old password no longer works");
  // XERK-2630: the reset password signs in nowhere until the user replaces it.
  assert.equal(await cookieFor("newbie", "second-secret-2"), null);
  assert.equal((await request("POST", "/api/password", {
    body: { username: "newbie", password: "second-secret-2", newPassword: "third-secret-3" } })).status, 200);
  const live = await cookieFor("newbie", "third-secret-3");
  assert.ok(live);

  assert.equal((await request("PATCH", `/api/admin/users/${id}`, { headers: H, body: { disabled: true } })).status, 200);
  assert.equal((await request("GET", "/api/me", { headers: live })).status, 401, "a disable ends the live session");
  assert.equal(await cookieFor("newbie", "third-secret-3"), null);
  assert.equal((await request("PATCH", `/api/admin/users/${id}`, { headers: H, body: { disabled: false } })).status, 200);
  assert.ok(await cookieFor("newbie", "third-secret-3"));

  const audit = await request("GET", "/api/admin/audit", { headers: H });
  const acts = audit.body.entries.filter((e) => e.target === "newbie (local)").map((e) => e.action);
  for (const a of ["user.create", "user.update", "user.password"]) assert.ok(acts.includes(a), a);
  assert.ok(audit.body.entries.every((e) => e.actor), "every row names who");
  assert.ok(!audit.raw.includes("secret"), "no password in the log");
  // Durable: the store file holds it.
  const fs = require("fs");
  assert.ok(fs.readFileSync(process.env.ADMIN_AUDIT_FILE, "utf8").includes("user.password"));
});

test("XERK-2630: an admin's reset ends the user's sessions, forces a new password and is shown to the user", async () => {
  await addUser("lu1", ["turma-users"]);
  const lu1 = userOf("lu1");
  const before = await cookieFor("lu1", "lu1-password");
  assert.ok(before);
  const admin = await cookieFor("rootadmin", "root-admin-pass");
  assert.equal((await request("POST", `/api/admin/users/${lu1.id}/password`, { headers: admin, body: { password: "admin-chosen-1" } })).status, 200);

  // Every session the user held is over.
  assert.equal((await request("GET", "/api/me", { headers: before })).status, 401, "the user's session ends");

  // The admin cannot sign in as the user with the password it set.
  const asAdmin = await request("POST", "/api/login", { body: { username: "lu1", password: "admin-chosen-1" } });
  assert.equal(asAdmin.status, 403);
  assert.equal(asAdmin.body.mustChangePassword, true);
  assert.ok(!(asAdmin.headers["set-cookie"] || []).join("").includes("hub_session=u2."), "no session");
  // A wrong password learns nothing about the reset.
  const wrong = await request("POST", "/api/login", { body: { username: "lu1", password: "not-the-one-1" } });
  assert.equal(wrong.status, 401);

  // The new password: wrong current 401, too short 400, same as current 400.
  const chg = (password, newPassword) => request("POST", "/api/password", { body: { username: "lu1", password, newPassword } });
  assert.equal((await chg("not-the-one-1", "users-own-pass-1")).status, 401);
  assert.equal((await chg("admin-chosen-1", "short")).status, 400);
  assert.equal((await chg("admin-chosen-1", "admin-chosen-1")).status, 400);
  const ok = await chg("admin-chosen-1", "users-own-pass-1");
  assert.equal(ok.status, 200, ok.raw);
  const m = (ok.headers["set-cookie"] || []).join("\n").match(/hub_session=([^;]+)/);
  const fresh = { cookie: `hub_session=${m[1]}` };
  const me = await request("GET", "/api/me", { headers: fresh });
  assert.equal(me.status, 200);
  assert.equal(me.body.tenant, true);
  // The user sees the reset, and who did it.
  assert.equal(me.body.passwordResets.length, 1);
  assert.equal(me.body.passwordResets[0].by, "rootadmin (local)");
  assert.ok(Number.isFinite(me.body.passwordResets[0].at));
  assert.equal(await cookieFor("lu1", "admin-chosen-1"), null, "the admin's password is gone");

  // The user's own change also ends other sessions (one an admin may have opened).
  const other = await cookieFor("lu1", "users-own-pass-1");
  assert.equal((await chg("users-own-pass-1", "users-own-pass-2")).status, 200);
  assert.equal((await request("GET", "/api/me", { headers: other })).status, 401);
  // The admin panel never serves the reset list or the flags.
  const list = await request("GET", "/api/admin/users", { headers: admin });
  assert.ok(!/passwordResets|mustChangePassword|sessionEpoch/.test(list.raw));
});

// An open /api/events stream: resolves `closed` when the hub ends it.
function openEvents(headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + "/api/events", { headers }, (res) => {
      const closed = new Promise((r) => { res.on("end", r); res.on("close", r); });
      res.resume();
      const e = { status: res.statusCode, closed, abort: () => req.destroy() };
      openStreams.push(e); // a failing test must not hold the server open
      resolve(e);
    });
    req.on("error", reject);
  });
}

const openStreams = [];
test.after(() => { for (const e of openStreams) e.abort(); });
test("XERK-2630: a stream opened before a reset, or a disable, is closed by it", async () => {
  await addUser("lu2", ["turma-users"]);
  const lu2 = userOf("lu2");
  const h = await cookieFor("lu2", "lu2-password");
  const ev = await openEvents(h);
  assert.equal(ev.status, 200);
  const bystander = await openEvents(await cookieFor("rootadmin", "root-admin-pass"));
  assert.equal((await request("POST", `/api/admin/users/${lu2.id}/password`, { headers: BASIC, body: { password: "admin-chosen-2" } })).status, 200);
  await Promise.race([ev.closed, new Promise((_, rej) => setTimeout(() => rej(new Error("stream outlived the reset")), 2000))]);
  // Disable: the same rule, for a stream opened after the user's own change.
  assert.equal((await request("POST", "/api/password", {
    body: { username: "lu2", password: "admin-chosen-2", newPassword: "lu2-own-pass-1" } })).status, 200);
  const ev2 = await openEvents(await cookieFor("lu2", "lu2-own-pass-1"));
  assert.equal(ev2.status, 200);
  assert.equal((await request("PATCH", `/api/admin/users/${lu2.id}`, { headers: BASIC, body: { disabled: true } })).status, 200);
  await Promise.race([ev2.closed, new Promise((_, rej) => setTimeout(() => rej(new Error("stream outlived the disable")), 2000))]);
  // Another user's stream is untouched.
  let bystanderClosed = false;
  bystander.closed.then(() => { bystanderClosed = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bystanderClosed, false);
  bystander.abort();
  assert.ok([...hub.userStreams].every((e) => e.claims.u !== lu2.id), "no tracked stream of lu2 is left");
});

test("XERK-2552: an admin cannot disable or delete its own account; SSO-owned fields are refused", async () => {
  const h = await cookieFor("rootadmin", "root-admin-pass");
  const me = userOf("rootadmin");
  assert.equal((await request("PATCH", `/api/admin/users/${me.id}`, { headers: h, body: { disabled: true } })).status, 409);
  assert.equal((await request("DELETE", `/api/admin/users/${me.id}`, { headers: h })).status, 409);
  const { state, user } = tenancy.upsertOidcUser(hub.tenancyState(), { iss: "https://idp/", sub: "s-1", displayName: "Sso Person", idpRoles: ["user"] });
  hub.__setTenancy(state);
  assert.equal((await request("POST", `/api/admin/users/${user.id}/password`, { headers: h, body: { password: "longenough1" } })).status, 409);
  const list = await request("GET", "/api/admin/users", { headers: h });
  const sso = list.body.users.find((u) => u.id === user.id);
  assert.deepEqual(sso.idpRoles, ["user"], "the IdP's roles are shown, read-only");
});

test("XERK-2631: an SSO user is named in the audit log by its fixed id, not only its IdP display name", async () => {
  const h = await cookieFor("rootadmin", "root-admin-pass");
  // A display name chosen to read as someone else's label.
  const { state, user } = tenancy.upsertOidcUser(hub.tenancyState(), { iss: "https://idp/", sub: "s-spoof", displayName: "rootadmin (local)", idpRoles: ["user"] });
  hub.__setTenancy(state);
  assert.equal((await request("PATCH", `/api/admin/users/${user.id}`, { headers: h, body: { groups: ["devs"] } })).status, 200);
  const audit = await request("GET", "/api/admin/audit", { headers: h });
  const rows = audit.body.entries.filter((e) => e.action === "user.update" && e.detail.includes("devs"));
  assert.deepEqual(rows.map((e) => e.target), [`oidc:${user.id} (rootadmin (local))`],
    "the stable id leads, so the display name cannot pose as another label");
});

test("XERK-2552: the group map is replaced whole and validated", async () => {
  const bad = await request("PUT", "/api/admin/groups", { headers: BASIC, body: { groups: { "turma-users": "root" } } });
  assert.equal(bad.status, 400);
  const ok = await request("PUT", "/api/admin/groups", { headers: BASIC,
    body: { groups: { "turma-users": "user", "turma-admins": "admin", "devs": "user" } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.isDefault, false);
  assert.deepEqual(ok.body.groups.map((g) => g.name).sort(), ["devs", "turma-admins", "turma-users"]);
  // Stranding: without break-glass, no admin left would be refused.
  const next = tenancy.setGroupMap(hub.tenancyState(), { "turma-users": "user" });
  assert.equal(hub.adminWayInRemains(next), true, "break-glass is set in this process");
});

test("XERK-2552: deleting a user kills its sessions, revokes its hosts, cancels its queue and purges its tenant", async () => {
  await addUser("leaver", ["turma-users"]);
  const leaver = userOf("leaver");
  const t = leaver.tenantId;
  const h = await cookieFor("leaver", "leaver-password");
  // Enroll a host into the leaver's tenant and beat with a running session.
  const code = await request("POST", "/api/enroll-codes", { headers: h, body: {} });
  assert.equal(code.status, 200, code.raw);
  const en = await request("POST", "/api/agent/enroll", { body: { code: code.body.code, device: "leaverbox" } });
  assert.equal(en.status, 200, en.raw);
  const token = en.body.token;
  const beat = () => request("POST", "/api/heartbeat", {
    headers: { authorization: `Bearer ${token}` },
    body: { device: "leaverbox", sessions: [{ id: "s1", status: "running" }] },
  });
  assert.equal((await beat()).status, 200);
  const key = `leaverbox@${t}`;
  assert.ok(hub.agents[key], "the host is in the tenant");
  // A spare code and a queued ticket, both the tenant's.
  const spare = await request("POST", "/api/enroll-codes", { headers: h, body: {} });
  assert.equal(spare.status, 200);
  hub.ticketQueue.push({ siteKey: `acme.atlassian.net@${t}`, issueKey: "AC-1", source: "manual", at: Date.now(), reason: "capacity" });
  // Some tenant usage on the ledger.
  hub.usageLedger.ingest(key, { usage: { totals: { input: 5, output: 5, cacheRead: 0, cacheCreation: 0 },
    days: { "2026-10-31": { input: 5, output: 5, cacheRead: 0, cacheCreation: 0 } } } });
  assert.equal(hub.usageLedger.has(key), true, "the ledger holds the tenant's usage");
  const listBefore = await request("GET", "/api/admin/users", { headers: BASIC });
  assert.equal(listBefore.body.users.find((u) => u.name === "leaver").hosts, 1);

  // Delete; the host takes its kill on the beat it makes meanwhile.
  const pending = request("DELETE", `/api/admin/users/${leaver.id}`, { headers: BASIC });
  let killSeen = false;
  for (let i = 0; i < 20 && !killSeen; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const b = await beat();
    if (b.status !== 200) break;
    killSeen = (b.body.commands || []).some((c) => c.type === "kill" && c.sessionId === "s1");
  }
  assert.ok(killSeen, "the kill reached the host before its token died");
  const del = await pending;
  assert.equal(del.status, 200, del.raw);
  assert.equal(del.body.hosts, 1);
  assert.equal(del.body.sessionsKilled, 1);
  assert.equal(del.body.killsDelivered, 1);
  assert.equal(del.body.identitiesRevoked, 1);
  assert.equal(del.body.enrollCodes, 2, "the used code and the spare");
  assert.ok(!Object.values(del.body.purge).includes("failed"), JSON.stringify(del.body.purge));

  assert.equal(userOf("leaver"), undefined, "the user is gone");
  assert.equal(await cookieFor("leaver", "leaver-password"), null);
  assert.equal((await request("GET", "/api/me", { headers: h })).status, 401, "its old cookie names nobody");
  assert.equal(hub.agents[key], undefined, "the host left the registry");
  assert.ok(!Object.values(hub.agentIdentities()).some((e) => e.tenantId === t), "no identity keeps the tenant");
  assert.ok([401, 403].includes((await beat()).status), "the host's token is revoked");
  assert.ok(!hub.ticketQueue.some((e) => e.siteKey.endsWith(`@${t}`)), "its queued ticket is cancelled");
  assert.ok(!Object.values(hub.enrollCodes()).some((c) => c.tenantId === t), "its codes are gone");
  assert.equal(hub.usageLedger.has(key), false, "its usage is purged");

  const audit = await request("GET", "/api/admin/audit", { headers: BASIC });
  const row = audit.body.entries.find((e) => e.action === "user.delete" && e.target === "leaver (local)");
  assert.ok(row, "the delete is audited");
  assert.equal(row.actor, "break-glass");
  assert.equal((await request("DELETE", `/api/admin/users/${leaver.id}`, { headers: BASIC })).status, 404);
});

test("XERK-2552 QA: an admin write must be same-origin JSON (no cross-site form or text/plain post)", async () => {
  const body = { username: "csrfuser", password: "longenough1" };
  const evil = await request("POST", "/api/admin/users", { headers: { ...BASIC, origin: "https://evil.example" }, body });
  assert.equal(evil.status, 403);
  const data = JSON.stringify(body);
  const plain = await new Promise((resolve, reject) => {
    const req = http.request(baseUrl + "/api/admin/users", { method: "POST",
      headers: { ...BASIC, "content-type": "text/plain", "content-length": Buffer.byteLength(data) } },
    (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end(data);
  });
  assert.equal(plain, 415);
  assert.equal(userOf("csrfuser"), undefined);
  // The hub's own page (Origin = its host) is fine.
  const own = await request("POST", "/api/admin/users", { headers: { ...BASIC, origin: baseUrl }, body });
  assert.equal(own.status, 200, own.raw);
});

test("XERK-2552 QA: a disabled owner's enrollment code no longer enrolls a host", async () => {
  await addUser("codeowner", ["turma-users"]);
  const h = await cookieFor("codeowner", "codeowner-password");
  const code = await request("POST", "/api/enroll-codes", { headers: h, body: {} });
  assert.equal(code.status, 200);
  const u = userOf("codeowner");
  assert.equal((await request("PATCH", `/api/admin/users/${u.id}`, { headers: BASIC, body: { disabled: true } })).status, 200);
  const en = await request("POST", "/api/agent/enroll", { body: { code: code.body.code, device: "orphanbox" } });
  assert.equal(en.status, 410, en.raw);
});

test("XERK-2552 QA: a delete kills sessions that appear during its wait, refuses a re-enable, and leaves no late host", async () => {
  await addUser("racer", ["turma-users"]);
  const racer = userOf("racer");
  const t = racer.tenantId;
  const h = await cookieFor("racer", "racer-password");
  const mint = async () => (await request("POST", "/api/enroll-codes", { headers: h, body: {} })).body.code;
  const en = await request("POST", "/api/agent/enroll", { body: { code: await mint(), device: "racebox" } });
  const spare = await mint();
  const token = en.body.token;
  let sessions = [{ id: "r1", status: "running" }];
  const beat = () => request("POST", "/api/heartbeat", {
    headers: { authorization: `Bearer ${token}` }, body: { device: "racebox", sessions },
  });
  assert.equal((await beat()).status, 200);
  hub.ticketQueue.push({ siteKey: `race.atlassian.net@${t}`, issueKey: "RC-1", source: "manual", at: Date.now(), reason: "capacity" });
  const pending = request("DELETE", `/api/admin/users/${racer.id}`, { headers: BASIC });
  await new Promise((r) => setTimeout(r, 50));
  // The queue is emptied at the START, so nothing dispatches into the tenant during the wait.
  assert.ok(!hub.ticketQueue.some((e) => e.siteKey.endsWith(`@${t}`)), "queued work is cancelled before the kill wait");
  // Mid-delete: a re-enable is refused, a code minted before it enrolls nothing.
  assert.equal((await request("PATCH", `/api/admin/users/${racer.id}`, { headers: BASIC, body: { disabled: false } })).status, 409);
  const late = await request("POST", "/api/agent/enroll", { body: { code: spare, device: "latebox" } });
  assert.ok(late.status >= 400, `a pre-delete code must not enroll (got ${late.status})`);
  // A second session shows up on the next beat.
  sessions = [{ id: "r1", status: "running" }, { id: "r2", status: "running" }, { id: "r3", status: "cloning" },
    { id: "r4", status: "stopped" }];
  const killed = new Set();
  for (let i = 0; i < 25 && killed.size < 3; i++) {
    const b = await beat();
    if (b.status !== 200) break;
    for (const c of b.body.commands || []) if (c.type === "kill") killed.add(c.sessionId);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual([...killed].sort(), ["r1", "r2", "r3"], "every live session (a cloning one too) was killed; a stopped one is not");
  const del = await pending;
  assert.equal(del.status, 200, del.raw);
  assert.equal(del.body.sessionsKilled, 3);
  assert.ok(!Object.keys(hub.agents).some((k) => k.endsWith(`@${t}`)), "no host of the tenant remains");
});

test("XERK-2552 QA: a roll-bound host keeps a tombstone at its plain name and its name token is revoked", async () => {
  await addUser("roller", ["turma-users"]);
  const u = userOf("roller");
  const uid = "c".repeat(32);
  hub.agentIdentities()[uid] = { origin: "plainhost", home: `plainhost@${u.tenantId}`, at: 1, tenantId: u.tenantId, used: true };
  const before = hub.nameTokenGen("plainhost");
  const del = await request("DELETE", `/api/admin/users/${u.id}`, { headers: BASIC });
  assert.equal(del.status, 200, del.raw);
  const e = hub.agentIdentities()[uid];
  assert.ok(e && e.revoked === true, "kept as a tombstone");
  assert.equal(e.home, "plainhost");
  assert.equal(e.tenantId, undefined);
  assert.equal(hub.nameTokenGen("plainhost"), before + 1, "the plain name's token generation was bumped");
  assert.equal(del.body.nameTokens.revoked, 1);
});
