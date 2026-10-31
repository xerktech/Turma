"use strict";

// XERK-2530 — hub users + tenants, local accounts, and the request principal.
//
// Its own process: the break-glass and bootstrap env are read at require time.
// Credentials below are test fixtures, not real secrets.

const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, scratchDir } = require("./tmpdirs");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "glass";
process.env.TURMA_PASSWORD = "glass-pass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
process.env.TURMA_BOOTSTRAP_ADMIN_USER = "firstadmin";
process.env.TURMA_BOOTSTRAP_ADMIN_PASSWORD = "first-admin-pass";

const tmp = (name) => path.join(scratchDir(), `turma-tenancy-${name}-${process.pid}.json`);
for (const [k, n] of [
  ["STATE_FILE", "state"], ["DEVICES_FILE", "devices"], ["TICKET_AGENTS_FILE", "ticket-agents"],
  ["AGENT_IDENTITIES_FILE", "agent-identities"], ["TENANCY_FILE", "tenancy"],
  ["AUTOSTART_ORGS_FILE", "autostart-orgs"], ["TICKET_MODELS_FILE", "ticket-models"],
  ["TICKET_RUNTIMES_FILE", "ticket-runtimes"], ["ORG_COLORS_FILE", "org-colors"],
  ["TRIAGE_POLICIES_FILE", "triage-policies"], ["TRIAGE_ACTIONS_FILE", "triage-actions"],
  ["USAGE_LEDGER_FILE", "usage-ledger"],
]) process.env[k] = tmp(n);
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-tenancy-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-tenancy-archive-");
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
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const login = (username, password) => request("POST", "/api/login", { body: { username, password } });
const sessionOf = (res) => {
  const m = (res.headers["set-cookie"] || []).join("\n").match(/hub_session=([^;]+)/);
  return m ? m[1] : null;
};
const principalOfToken = (token) => hub.requestPrincipal({ headers: { cookie: `hub_session=${token}` } });

// A local user straight into the store (the admin panel is a later ticket).
async function addLocalUser(username, password, groups = ["turma-users"]) {
  const { state, user } = tenancy.createLocalUser(hub.tenancyState(), {
    username, passwordHash: await tenancy.hashPassword(password), groups,
  });
  hub.__setTenancy(state);
  return user;
}

// ---- the pure module --------------------------------------------------------

test("XERK-2530: a password is stored as an scrypt hash, never the plaintext, and verifies", async () => {
  const h = await tenancy.hashPassword("correct horse");
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!h.includes("correct horse"));
  assert.notEqual(h, await tenancy.hashPassword("correct horse"), "salted");
  assert.equal(await tenancy.verifyPassword("correct horse", h), true);
  assert.equal(await tenancy.verifyPassword("wrong horse", h), false);
  assert.equal(await tenancy.verifyPassword("correct horse", "plaintext"), false);
  assert.equal(await tenancy.verifyPassword(123, h), false);
});

test("XERK-2530: a stored hash naming a cost past the ceiling is refused, not run", async () => {
  const h = await tenancy.hashPassword("pw-123456");
  const huge = h.replace(/^scrypt\$16384\$/, "scrypt$1048576$");
  assert.equal(await tenancy.verifyPassword("pw-123456", huge), false);
});

test("XERK-2530: the store whitelist is a fixed point and drops what it cannot vouch for", async () => {
  const hash = await tenancy.hashPassword("pw-123456");
  const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32), t1 = "1".repeat(32), t2 = "2".repeat(32);
  const raw = {
    users: {
      [a]: { tenantId: t1, source: "local", username: "Alice", passwordHash: hash, groups: ["turma-users", "bad group!"], extra: 1 },
      [b]: { tenantId: t2, source: "local", username: "alice", passwordHash: hash }, // same login, case-folded
      [c]: { tenantId: t1, source: "oidc", oidcIss: "i", oidcSub: "s" }, // reuses a tenant
      __proto__x: { tenantId: t2, source: "local", username: "x" },
      ["d".repeat(32)]: { tenantId: "d".repeat(32), source: "local", username: "self" }, // tenant == id
      ["e".repeat(32)]: { tenantId: "3".repeat(32), source: "martian", username: "m" },
    },
  };
  const out = tenancy.coerceTenancy(raw);
  assert.deepEqual(Object.keys(out.users), [a]);
  assert.deepEqual(out.users[a].groups, ["turma-users"]);
  assert.equal(out.users[a].extra, undefined);
  assert.equal(out.groups, undefined, "no stored group map: the defaults apply");
  const again = tenancy.coerceTenancy(JSON.parse(JSON.stringify(out)));
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(out)));
  assert.equal(Object.getPrototypeOf(out.users), null);
});

test("XERK-2530: roles come from the group map (defaults until one is stored) and OIDC's IdP roles", () => {
  const local = { source: "local", groups: ["turma-users", "turma-admins", "unknown"] };
  assert.deepEqual(tenancy.effectiveRoles({ users: {} }, local), ["user", "admin"]);
  const custom = tenancy.coerceTenancy({ groups: { "turma-users": { role: "user" }, ops: { role: "admin" } } });
  assert.deepEqual(tenancy.effectiveRoles(custom, local), ["user"], "turma-admins no longer mapped");
  assert.deepEqual(tenancy.effectiveRoles(custom, { source: "local", groups: [] }), []);
  assert.deepEqual(tenancy.effectiveRoles({ users: {} }, { source: "oidc", idpRoles: ["admin"], groups: [] }), ["admin"]);
});

test("XERK-2530: one user = one tenant, ids opaque and distinct from the login", async () => {
  let s = tenancy.coerceTenancy({});
  const hash = await tenancy.hashPassword("pw-123456");
  ({ state: s } = tenancy.createLocalUser(s, { username: "u1", passwordHash: hash }));
  ({ state: s } = tenancy.createLocalUser(s, { username: "u2", passwordHash: hash }));
  assert.throws(() => tenancy.createLocalUser(s, { username: "U1", passwordHash: hash }), /taken/);
  assert.throws(() => tenancy.createLocalUser(s, { username: "u3", passwordHash: "pw-123456" }), /hash/);
  const users = Object.values(s.users);
  assert.equal(new Set(users.map((u) => u.tenantId)).size, 2);
  for (const u of users) {
    assert.match(u.id, /^[0-9a-f]{32}$/);
    assert.match(u.tenantId, /^[0-9a-f]{32}$/);
    assert.notEqual(u.tenantId, u.id);
    assert.ok(!u.tenantId.includes(u.username));
  }
  // The tenant never moves, whatever a patch says.
  const { user } = tenancy.updateUser(s, users[0].id, { tenantId: users[1].tenantId, displayName: "Renamed" });
  assert.equal(user.tenantId, users[0].tenantId);
  assert.equal(user.displayName, "Renamed");
});

test("XERK-2530: an OIDC identity is (issuer, sub); a re-login keeps the user and its tenant", () => {
  let s = tenancy.coerceTenancy({});
  const r1 = tenancy.upsertOidcUser(s, { iss: "https://idp/", sub: "abc", displayName: "A", idpRoles: ["user"] });
  const r2 = tenancy.upsertOidcUser(r1.state, { iss: "https://idp/", sub: "abc", displayName: "A2", idpRoles: ["user", "admin"] });
  assert.equal(r2.user.id, r1.user.id);
  assert.equal(r2.user.tenantId, r1.user.tenantId);
  assert.deepEqual(r2.user.idpRoles, ["user", "admin"]);
  const other = tenancy.upsertOidcUser(r2.state, { iss: "https://other-idp/", sub: "abc", idpRoles: ["user"] });
  assert.notEqual(other.user.id, r1.user.id, "the same sub at another issuer is another person");
  s = other.state;
  assert.equal(Object.keys(s.users).length, 2);
});

// ---- bootstrap --------------------------------------------------------------

test("XERK-2530: first run created the bootstrap admin from env, hashed, with both roles", () => {
  const u = tenancy.findLocalUser(hub.tenancyState(), "firstadmin");
  assert.ok(u, "bootstrap admin exists");
  assert.ok(!JSON.stringify(hub.tenancyState()).includes("first-admin-pass"));
  assert.deepEqual(tenancy.effectiveRoles(hub.tenancyState(), u), ["user", "admin"]);
  // Never again once a user exists.
  assert.equal(tenancy.bootstrapAdmin(hub.tenancyState(), { username: "other", password: "other-pass" }), null);
  assert.throws(() => tenancy.bootstrapAdmin({ users: {} }, { username: "x", password: "short" }), /8\+/);
  // An OIDC user does not count: a passwordless OIDC hub closed with the pair still gets its admin.
  const oidcOnly = tenancy.upsertOidcUser(tenancy.coerceTenancy({}), { iss: "i", sub: "s", idpRoles: ["user"] }).state;
  const made = tenancy.bootstrapAdmin(oidcOnly, { username: "boot", password: "boot-pass-1" });
  assert.ok(made, "bootstrap runs when only OIDC users exist");
  assert.equal(Object.keys(made.state.users).length, 2);
});

// ---- login + principal ------------------------------------------------------

test("XERK-2530: a local user signs in and every request carries its user + tenant", async () => {
  const user = await addLocalUser("bob", "bob-password");
  const res = await login("bob", "bob-password");
  assert.equal(res.status, 200);
  const token = sessionOf(res);
  assert.match(token, /^u2\./);
  const p = principalOfToken(token);
  assert.equal(p.kind, "user");
  assert.equal(p.userId, user.id);
  assert.equal(p.tenantId, user.tenantId);
  assert.deepEqual([...p.roles], ["user"]);
  assert.deepEqual(hub.sessionTokenClaims(token), { u: user.id, t: user.tenantId, r: ["user"] });
  assert.ok(hub.tenancyState().users[user.id].lastLoginAt > 0);
  const api = await request("GET", "/api/agents", { headers: { cookie: `hub_session=${token}` } });
  assert.equal(api.status, 200);
});

test("XERK-2530: a wrong password, an unknown user and a bad body type are all a plain 401", async () => {
  await addLocalUser("carol", "carol-password");
  for (const [u, pw] of [["carol", "nope-nope"], ["nobody", "carol-password"], [{ a: 1 }, "x"], ["carol", ["carol-password"]]]) {
    const res = await login(u, pw);
    assert.equal(res.status, 401, JSON.stringify([u, pw]));
    assert.equal(sessionOf(res), null);
  }
});

test("XERK-2530: disabling a user, or removing its access group, ends its live session at once", async () => {
  const user = await addLocalUser("dave", "dave-password");
  const token = sessionOf(await login("dave", "dave-password"));
  assert.ok(principalOfToken(token));
  hub.__setTenancy(tenancy.updateUser(hub.tenancyState(), user.id, { groups: [] }).state);
  assert.equal(principalOfToken(token), null, "no group grants access");
  assert.equal((await login("dave", "dave-password")).status, 401);
  hub.__setTenancy(tenancy.updateUser(hub.tenancyState(), user.id, { groups: ["turma-users"], disabled: true }).state);
  assert.equal(principalOfToken(token), null, "disabled");
  assert.equal((await login("dave", "dave-password")).status, 401);
  const api = await request("GET", "/api/agents", { headers: { cookie: `hub_session=${token}` } });
  assert.equal(api.status, 401);
});

test("XERK-2530: the break-glass login is an ADMIN-only principal with NO tenant (cookie and Basic)", async () => {
  const res = await login("glass", "glass-pass");
  assert.equal(res.status, 200);
  const p = principalOfToken(sessionOf(res));
  assert.equal(p.kind, "breakglass");
  assert.equal(p.tenantId, null);
  assert.equal(p.userId, null);
  assert.deepEqual([...p.roles], ["admin"]);
  const basic = "Basic " + Buffer.from("glass:glass-pass").toString("base64");
  const pb = hub.requestPrincipal({ headers: { authorization: basic } });
  assert.equal(pb.kind, "breakglass");
  assert.equal(pb.tenantId, null);
  // A local user's password is never accepted over Basic (no per-request scrypt).
  const bobBasic = "Basic " + Buffer.from("bob:bob-password").toString("base64");
  assert.equal(hub.requestPrincipal({ headers: { authorization: bobBasic } }), null);
});

test("XERK-2530: a forged, tampered or tenant-swapped token names nobody", async () => {
  const bob = tenancy.findLocalUser(hub.tenancyState(), "bob");
  const good = hub.issueSessionToken(60000, { u: bob.id, t: bob.tenantId, r: ["user"] });
  assert.ok(principalOfToken(good));
  const [, exp, , mac] = good.split(".");
  const evil = Buffer.from(JSON.stringify({ u: bob.id, t: bob.tenantId, r: ["user", "admin"] })).toString("base64url");
  assert.equal(principalOfToken(`u2.${exp}.${evil}.${mac}`), null, "claims edited under the old mac");
  const other = tenancy.findLocalUser(hub.tenancyState(), "carol");
  assert.equal(principalOfToken(hub.issueSessionToken(60000, { u: bob.id, t: other.tenantId, r: ["user"] })), null);
  assert.equal(principalOfToken(hub.issueSessionToken(60000, { u: "f".repeat(32), t: bob.tenantId })), null);
  assert.equal(principalOfToken(hub.issueSessionToken(-1000, { u: bob.id, t: bob.tenantId })), null, "expired");
  // Roles come from the store, not the cookie.
  const claimsAdmin = hub.issueSessionToken(60000, { u: bob.id, t: bob.tenantId, r: ["admin"] });
  assert.deepEqual([...principalOfToken(claimsAdmin).roles], ["user"]);
});

test("XERK-2530: a pre-tenancy session cookie stays signed in but has no tenant and no role", () => {
  const p = principalOfToken(hub.issueSessionToken());
  assert.equal(p.kind, "legacy");
  assert.equal(p.tenantId, null);
  assert.deepEqual([...p.roles], []);
});

test("XERK-2530: concurrent local sign-ins past the cap are told to retry; break-glass is never capped", async () => {
  await addLocalUser("erin", "erin-password");
  const many = await Promise.all(Array.from({ length: 8 }, () => login("erin", "erin-password")));
  const codes = many.map((r) => r.status);
  assert.ok(codes.includes(200), codes.join());
  assert.ok(codes.includes(503), codes.join());
  for (const r of many.filter((x) => x.status === 503)) assert.equal(r.headers["retry-after"], "1");
  const glass = await Promise.all(Array.from({ length: 8 }, () => login("glass", "glass-pass")));
  assert.deepEqual(glass.map((r) => r.status), Array(8).fill(200));
});

// ---- OIDC converges on the same principal -----------------------------------

test("XERK-2530: an OIDC login becomes a hub user with its own tenant; disabled gets none", () => {
  const iss = "https://idp.test/application/o/turma/";
  const p1 = hub.oidcPrincipal(iss, { sub: "oidc-1", name: "Olive" }, ["user"]);
  assert.equal(p1.kind, "user");
  assert.equal(p1.source, "oidc");
  assert.match(p1.tenantId, /^[0-9a-f]{32}$/);
  assert.deepEqual([...p1.roles], ["user"]);
  const p2 = hub.oidcPrincipal(iss, { sub: "oidc-1", name: "Olive" }, ["user", "admin"]);
  assert.equal(p2.userId, p1.userId);
  assert.equal(p2.tenantId, p1.tenantId);
  assert.deepEqual([...p2.roles], ["user", "admin"]);
  const token = hub.issueSessionToken(60000, hub.principalClaims(p2));
  assert.equal(principalOfToken(token).userId, p1.userId);
  hub.__setTenancy(tenancy.updateUser(hub.tenancyState(), p1.userId, { disabled: true }).state);
  assert.equal(hub.oidcPrincipal(iss, { sub: "oidc-1" }, ["user", "admin"]), null);
  assert.equal(principalOfToken(token), null);
  assert.throws(() => hub.oidcPrincipal(iss, { sub: 42 }, ["user"]), /subject/);
});

test("XERK-2530: the store is written to its own durable file, never state.json", async () => {
  const fs = require("fs");
  await new Promise((r) => setTimeout(r, 50));
  const onDisk = JSON.parse(fs.readFileSync(process.env.TENANCY_FILE, "utf8"));
  assert.ok(Object.values(onDisk.users).some((u) => u.username === "firstadmin"));
  assert.ok(!fs.readFileSync(process.env.TENANCY_FILE, "utf8").includes("first-admin-pass"));
  assert.equal(fs.statSync(process.env.TENANCY_FILE).mode & 0o777, 0o600, "password hashes are owner-only");
  // Opaque ids only — never the login or display name as a key.
  for (const [id, u] of Object.entries(onDisk.users)) {
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.match(u.tenantId, /^[0-9a-f]{32}$/);
  }
});
