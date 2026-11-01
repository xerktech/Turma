"use strict";

// XERK-2530 — hub users + tenants, local accounts, and the request principal.
//
// Its own process: the break-glass and bootstrap env are read at require time.
// Credentials below are test fixtures, not real secrets.

const path = require("path");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, scratchDir } = require("./tmpdirs");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "glass";
process.env.TURMA_PASSWORD = "glass-pass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
process.env.TURMA_BOOTSTRAP_ADMIN_USER = "firstadmin";
process.env.TURMA_BOOTSTRAP_ADMIN_PASSWORD = "first-admin-pass";
process.env.TURMA_MEETINGS_TOKEN = "meetingstok"; // XERK-2556: Tenir's route, per-tenant tokens

const tmp = (name) => path.join(scratchDir(), `turma-tenancy-${name}-${process.pid}.json`);
// Every durable store the hub opens gets a scratch file: an unset one writes the
// host's real /data (XERK-2556 found most of them unset here).
for (const k of [
  "STATE_FILE", "DEVICES_FILE", "TICKET_AGENTS_FILE", "AGENT_IDENTITIES_FILE", "TENANCY_FILE",
  "AUTOSTART_ORGS_FILE", "TICKET_MODELS_FILE", "TICKET_RUNTIMES_FILE", "ORG_COLORS_FILE",
  "TRIAGE_POLICIES_FILE", "TRIAGE_ACTIONS_FILE", "USAGE_LEDGER_FILE", "ADMIN_AUDIT_FILE",
  "ARCHIVE_PURGED_TENANTS_FILE", "AUTOMERGE_ORGS_FILE", "DAILY_BRIEFS_FILE",
  "DAILY_BRIEF_SCHEDULES_FILE", "DECISIONS_FILE", "DEDUPE_LINK_ORGS_FILE", "ENROLL_CODES_FILE",
  "EPIC_BUILDERS_FILE", "EPIC_RUNS_FILE", "MEETING_PROPOSALS_FILE", "MEETING_TOKENS_FILE",
  "MODEL_POLICY_FILE", "NAME_TOKEN_GENS_FILE", "PERMISSION_POLICIES_FILE",
  "PRIORITY_WRITEBACK_ORGS_FILE", "REPO_TIERS_FILE", "TENANT_MIGRATION_FILE",
  "TICKET_PLATFORMS_FILE",
]) process.env[k] = tmp(k.toLowerCase().replace(/_file$/, "").replace(/_/g, "-"));
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-tenancy-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-tenancy-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const tenancy = require("../tenancy.js");
const archive = require("../archive.js");
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

// ---- XERK-2577: break-glass guesses share the per-client backoff ------------

const glassFrom = (client, password) =>
  request("POST", "/api/login", { headers: { "cf-connecting-ip": client }, body: { username: "glass", password } });
const basicFrom = (client, password, path = "/api/agents") =>
  request("GET", path, { headers: {
    "cf-connecting-ip": client,
    authorization: `Basic ${Buffer.from(`glass:${password}`).toString("base64")}`,
  } });

test("XERK-2577: break-glass misses back off that client; the right password waits too", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await glassFrom("198.51.100.20", "guess")).status, 401, `miss ${i}`);
  const held = await glassFrom("198.51.100.20", "glass-pass");
  assert.equal(held.status, 429, "a backed-off client learns nothing, not even from the right password");
  assert.ok(Number(held.headers["retry-after"]) >= 1, held.headers["retry-after"]);
  // Another client is never locked out by that one.
  assert.equal((await glassFrom("198.51.100.21", "glass-pass")).status, 200);
});

test("XERK-2577: a concurrent burst of break-glass guesses is counted, not slipped past", async () => {
  // The right password rides right behind the first miss: a guess arriving while this client's
  // previous miss is still being checked is refused busy, never evaluated. A slow runner can let
  // the TAIL of the burst land after that check finished — those are fairly evaluated (and counted),
  // so assert on the overlap, not on an exact 401 total.
  const burst = await Promise.all(Array.from({ length: 40 },
    (_, i) => glassFrom("198.51.100.30", i === 1 ? "glass-pass" : "guess")));
  const codes = burst.map((r) => r.status);
  assert.ok(!codes.includes(200), codes.join());
  assert.ok(codes.every((c) => c === 401 || c === 503), codes.join());
  const evaluated = codes.filter((c) => c === 401).length;
  assert.ok(evaluated >= 1 && evaluated <= 3, `most of the burst is refused busy: ${codes.join()}`);
});

test("XERK-2577: a break-glass miss counts once, and a success clears the count", async () => {
  for (let i = 0; i < 4; i++) assert.equal((await glassFrom("198.51.100.40", "guess")).status, 401);
  assert.equal((await glassFrom("198.51.100.40", "glass-pass")).status, 200, "four misses are still free");
  for (let i = 0; i < 4; i++) assert.equal((await glassFrom("198.51.100.40", "guess")).status, 401, `after reset ${i}`);
});

test("XERK-2577: Basic auth draws on the same budget, one count per request", async () => {
  assert.equal((await basicFrom("198.51.100.50", "glass-pass")).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await basicFrom("198.51.100.50", "guess")).status, 401, `miss ${i}`);
  assert.equal((await basicFrom("198.51.100.50", "glass-pass")).status, 401, "backed off: refused");
  assert.equal((await glassFrom("198.51.100.50", "glass-pass")).status, 429, "the form shares it");
  assert.equal((await basicFrom("198.51.100.51", "glass-pass")).status, 200, "another client is unaffected");
  // A request that asks for its principal twice records one miss, not two.
  const req = { headers: { "cf-connecting-ip": "198.51.100.52",
    authorization: `Basic ${Buffer.from("glass:guess").toString("base64")}` }, socket: { remoteAddress: "127.0.0.1" } };
  for (let i = 0; i < 4; i++) {
    const r = { ...req, headers: { ...req.headers } };
    assert.equal(hub.requestPrincipal(r), null);
    assert.equal(hub.requestPrincipal(r), null);
  }
  assert.equal((await basicFrom("198.51.100.52", "glass-pass")).status, 200, "four requests, four misses: still free");
});

test("XERK-2577: Basic carrying a LOCAL user's password never backs that user off", async () => {
  await addLocalUser("basicky", "basicky-pass");
  const basic = () => request("GET", "/api/agents", { headers: {
    "cf-connecting-ip": "198.51.100.60",
    authorization: `Basic ${Buffer.from("basicky:basicky-pass").toString("base64")}`,
  } });
  const codes = await Promise.all(Array.from({ length: 8 }, basic));
  assert.deepEqual(codes.map((r) => r.status), Array(8).fill(401), "Basic is break-glass only");
  const form = await request("POST", "/api/login", {
    headers: { "cf-connecting-ip": "198.51.100.60" }, body: { username: "basicky", password: "basicky-pass" },
  });
  assert.equal(form.status, 200);
});

test("XERK-2577: a busy refusal looks the same for the break-glass name as for any other", async () => {
  await addLocalUser("plainuser", "plainuser-pass");
  const tally = async (client, username) => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => request("POST", "/api/login", {
      headers: { "cf-connecting-ip": client }, body: { username, password: "guess" },
    })));
    const out = {};
    for (const r of rs) out[r.status] = (out[r.status] || 0) + 1;
    const next = await request("POST", "/api/login", {
      headers: { "cf-connecting-ip": client }, body: { username, password: "guess" },
    });
    return { out, next: next.status };
  };
  const glass = await tally("198.51.100.70", "glass");
  const plain = await tally("198.51.100.71", "plainuser");
  assert.deepEqual(glass, plain);
  assert.deepEqual(glass, { out: { 401: 1, 503: 5 }, next: 401 }, "a busy refusal neither evaluates nor counts");
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

test("XERK-2586: a break-glass sign-in whose socket already closed is not evaluated", async () => {
  // A closed socket reports no peer address, so its key would be shared by every such caller.
  // `connection: close` keeps the doctored socket out of the keep-alive pool.
  const strip = (req) => {
    if (req.headers["x-test-closed"]) Object.defineProperty(req.socket, "remoteAddress", { value: undefined, configurable: true });
  };
  server.prependListener("request", strip);
  const gone = (password) => request("POST", "/api/login", {
    headers: { "x-test-closed": "1", connection: "close" }, body: { username: "glass", password },
  });
  try {
    const r = await gone("glass-pass");
    assert.ok(!/hub_session=/.test(String(r.headers["set-cookie"] || "")), "no session for a caller that is gone");
    for (let i = 0; i < 8; i++) await gone("wrong");
    assert.equal(hub.loginBackoffMs("||", "glass", Date.now()), 0, "no shared backoff bucket built up");
  } finally {
    server.removeListener("request", strip);
  }
  const ok = await login("glass", "glass-pass");
  assert.equal(ok.status, 200, "a live break-glass sign-in afterwards still works");
  assert.ok(/hub_session=/.test(String(ok.headers["set-cookie"] || "")), "and is issued a session");
});

test("XERK-2553: admin-only means an admin with no workspace AND no host to drive", async () => {
  const glass = { authorization: "Basic " + Buffer.from("glass:glass-pass").toString("base64") };
  const me = async (h) => JSON.parse((await request("GET", "/api/me", { headers: h })).raw);
  // No host anywhere: break-glass has nothing to drive. An open hub's principal
  // is still never admin-only (no account to switch to).
  assert.equal((await me(glass)).adminOnly, true);
  assert.equal(hub.meView({ kind: "open", userId: null, tenantId: null, roles: ["user", "admin"] }).adminOnly, false);
  const root = await addLocalUser("root2553", "root-2553-pass", ["turma-admins"]);
  const both = await addLocalUser("both2553", "both-2553-pass", ["turma-users", "turma-admins"]);
  const cookieFor = (u, r) => ({ cookie: `hub_session=${hub.issueSessionToken(60_000, { u: u.id, t: u.tenantId, r })}` });
  assert.equal((await me(cookieFor(root, ["admin"]))).adminOnly, true);
  assert.equal((await me(cookieFor(both, ["user", "admin"]))).adminOnly, false, "a workspace is never admin-only");
  // An untenanted host appears: break-glass and an admin-role user drive it, so
  // they are the fleet's operators, not admin-only (QA D1/D2).
  const beat = await request("POST", "/api/heartbeat", {
    headers: { authorization: "Bearer agenttok" }, body: { device: "ops2553" } });
  assert.equal(beat.status, 200);
  assert.equal((await me(glass)).adminOnly, false);
  assert.equal((await me(cookieFor(root, ["admin"]))).adminOnly, false);
  // An open hub's principal is never admin-only (no account to switch to).
  assert.equal(hub.meView({ kind: "open", userId: null, tenantId: null, roles: ["user", "admin"] }).adminOnly, false);
});

// ---- XERK-2556: cross-tenant isolation, every surface, one fleet ---------------
//
// One hub, two tenants (A, B), an admin-only user (C: admin role, no tenant) and
// break-glass, with REAL agent payloads for a host in each tenant plus one
// untenanted host. The fixture collides on purpose: all three hosts are named
// "laptop", both tenants report the same Jira site, the same session id and the
// same transcript id. Each tenant's data carries a canary string; no response a
// principal gets may contain another tenant's canary, tenant id or host key.

const SITE = "iso2556.atlassian.net";
const rand = () => crypto.randomBytes(6).toString("hex");
const CANARY = { A: `canaryA${rand()}`, B: `canaryB${rand()}`, U: `canaryU${rand()}` };

let iso = null;
async function isoFleet() {
  if (iso) return iso;
  const mk = async (name, groups) => {
    const pw = `${name}-pass-2556`;
    const user = await addLocalUser(name, pw, groups);
    const res = await login(name, pw);
    assert.equal(res.status, 200, res.raw);
    return { user, t: user.tenantId, h: { cookie: `hub_session=${sessionOf(res)}` } };
  };
  const A = await mk("iso2556a", ["turma-users"]);
  const B = await mk("iso2556b", ["turma-users"]);
  const C = await mk("iso2556c", ["turma-admins"]);
  const G = { h: { cookie: `hub_session=${hub.issueSessionToken(600_000, { bg: 1, r: ["admin"] })}` } };
  // The untenanted "laptop" beats first, on the fleet master (an operators' host).
  const beatAs = (bearer, device, body) => request("POST", "/api/heartbeat", {
    headers: { authorization: `Bearer ${bearer}` }, body: { device, ...body } });
  const payload = (tag, canary) => ({
    jira: { configured: true, available: true, siteKey: SITE,
      tickets: [{ key: "ISO-1", summary: `${canary} ticket`, status: "To Do", statusCategory: "new" }] },
    repos: [{ name: "shared-repo" }, { name: `repo-${tag}-${canary}` }],
    sessions: [
      { id: "s-same", status: "running", repo: "shared-repo", transcriptId: "t-same",
        rcName: `rc-${canary}`, label: `${canary} label`, ttydPort: 7700 },
      { id: `s-${tag}-only`, status: "running", repo: "shared-repo", transcriptId: `t-${tag}-only`,
        rcName: `rc2-${canary}`, ttydPort: 7701 },
    ],
  });
  assert.equal((await beatAs("agenttok", "laptop", payload("u", CANARY.U))).status, 200);
  const enroll = async (who) => {
    const m = await request("POST", "/api/enroll-codes", { headers: who.h, body: {} });
    assert.equal(m.status, 200, m.raw);
    const r = await request("POST", "/api/agent/enroll", { body: { code: JSON.parse(m.raw).code, device: "laptop" } });
    assert.equal(r.status, 200, r.raw);
    return JSON.parse(r.raw).token;
  };
  A.tok = await enroll(A);
  B.tok = await enroll(B);
  A.key = `laptop@${A.t}`; B.key = `laptop@${B.t}`;
  A.site = `${SITE}@${A.t}`; B.site = `${SITE}@${B.t}`;
  A.canary = CANARY.A; B.canary = CANARY.B;
  for (const [who, tag] of [[A, "a"], [B, "b"]]) {
    const r = await beatAs(who.tok, "laptop", payload(tag, who.canary));
    assert.equal(r.status, 200, r.raw);
    who.reply = JSON.parse(r.raw);
    who.beat = (extra = {}) => beatAs(who.tok, "laptop", { ...payload(tag, who.canary), ...extra });
    who.tag = tag;
  }
  iso = { A, B, C, G, beatAs };
  return iso;
}
// Everything that names a tenant: its id, its host key, its org key, its canary.
const marks = (who) => [who.t, who.canary];
function assertNoneOf(text, whos, what) {
  for (const w of whos) {
    for (const m of marks(w)) assert.ok(!text.includes(m), `${what} leaks ${m}`);
  }
}
const get = async (p, h) => request("GET", p, { headers: h });

test("XERK-2556: three hosts named 'laptop', one site, one session id — three separate records", async () => {
  const { A, B } = await isoFleet();
  const keys = Object.keys(hub.agents).filter((k) => k === "laptop" || k.startsWith("laptop@"));
  assert.deepEqual(keys.sort(), ["laptop", A.key, B.key].sort());
  assert.equal(hub.tenantOfKey(A.key), A.t);
  assert.equal(hub.tenantOfKey("laptop"), "");
  // The same session id resolves to each caller's own host, and to nobody's else.
  const pa = principalOfToken(A.h.cookie.slice("hub_session=".length));
  const pb = principalOfToken(B.h.cookie.slice("hub_session=".length));
  assert.equal(hub.findSession("s-same", pa).host, A.key);
  assert.equal(hub.findSession("s-same", pb).host, B.key);
  assert.equal(hub.findSession("s-b-only", pa), null);
  assert.equal(hub.findSession("s-u-only", pa), null);
});

// The route table, swept: every row whose path names a host, org, session,
// transcript or repo, called with ANOTHER tenant's id, by every principal that
// must not reach it. Each answers 404 — byte-identical to a never-seen id — and
// changes nothing.
test("XERK-2556: every scoped route answers another tenant's id exactly as an unknown one", async () => {
  const { A, B, C, G } = await isoFleet();
  const scope = require("../tenant-scope.js");
  const ghost = `laptop@${crypto.randomBytes(16).toString("hex")}`;
  const targets = (who) => ({
    host: who ? who.key : "laptop", site: who ? who.site : SITE,
    sid: who ? `s-${who.tag}-only` : "s-u-only", tid: who ? `t-${who.tag}-only` : "t-u-only",
    repo: who ? `repo-${who.tag}-${who.canary}` : `repo-u-${CANARY.U}`,
  });
  const unknown = { host: ghost, site: `${SITE}@${ghost.slice(7)}`, sid: "s-nobody", tid: "t-nobody",
    repo: `repo-nobody-${rand()}` };
  const fill = (pattern, t) => "/" + pattern.split("/").filter(Boolean).map((seg) => {
    if (seg === "*") return "x";
    if (!seg.startsWith(":")) return seg;
    const v = { host: t.host, site: t.site, sid: t.sid, tid: t.tid, repo: t.repo, issue: "ISO-1" }[seg.slice(1)];
    return encodeURIComponent(v === undefined ? "x1" : v);
  }).join("/") + (pattern.startsWith("/term/") ? "/" : "");
  const call = (m, p, h) => request(m, p, { headers: h, body: m === "GET" || m === "HEAD" ? undefined : {} });
  const before = JSON.stringify(hub.agents[B.key].commands || []);
  // who → the targets they must never reach.
  const cases = [
    [A, [B, null]], [B, [A, null]], [C, [A, B]], [G, [A, B]],
  ];
  let checked = 0;
  for (const row of scope.ROUTES) {
    const [methods, pattern, cls] = row;
    if (!["host", "org", "session", "transcript", "repo"].includes(cls)) continue;
    // A repo/transcript no host reports is the operators' (untenanted) by design,
    // so the "unknown" twin only means "unknown" to a tenant user.
    for (const m of methods.split(" ")) {
      for (const [who, forbidden] of cases) {
        const tenantCaller = who === A || who === B;
        for (const victim of forbidden) {
          const p = fill(pattern, targets(victim));
          const r = await call(m, p, who.h);
          assert.equal(r.status, 404, `${m} ${p} as ${who.user ? who.user.username : "break-glass"}: ${r.status} ${r.raw}`);
          if (tenantCaller || (cls !== "repo" && cls !== "transcript")) {
            const u = await call(m, fill(pattern, unknown), who.h);
            assert.equal(u.status, 404, `${m} unknown twin of ${p}`);
            if (m !== "HEAD") assert.equal(r.raw, u.raw, `${m} ${p}: another tenant's id must read as an unknown one`);
          }
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 300, `swept only ${checked} calls`);
  // Nothing reached B's host: no command queued, the record still there.
  assert.ok(hub.agents[B.key]);
  assert.equal(JSON.stringify(hub.agents[B.key].commands || []), before);
  // Positive control: the owner reaches the same rows.
  assert.equal((await request("POST", `/api/jira/${encodeURIComponent(B.site)}/color`, { headers: B.h, body: { slot: 4 } })).status, 200);
  assert.equal((await request("POST", `/api/agents/${encodeURIComponent(B.key)}/restart`, { headers: B.h, body: {} })).status, 200);
  assert.equal((await request("POST", "/api/agents/laptop/restart", { headers: G.h, body: {} })).status, 200);
});

test("XERK-2556: /api/agents carries nothing of another tenant, for every principal", async () => {
  const { A, B, C, G } = await isoFleet();
  // Give each org something in every per-org store a client can set.
  for (const w of [A, B]) {
    const s = encodeURIComponent(w.site);
    for (const [m, p, body] of [
      ["POST", `/api/jira/${s}/color`, { slot: 2 }],
      ["POST", `/api/jira/${s}/autostart`, { enabled: true }],
      ["POST", `/api/jira/${s}/triage-policy`, { minPriority: "P2" }],
      ["POST", `/api/jira/${s}/ISO-1/triage`, { action: "hold" }],
      ["POST", `/api/jira/${s}/ISO-1/model`, { model: "opus" }],
      ["POST", `/api/orgs/${s}/decisions`, { text: `${w.canary} decision` }],
      ["PUT", `/api/orgs/${s}/daily-brief/schedule`, { enabled: false }],
    ]) {
      const r = await request(m, p, { headers: w.h, body });
      assert.ok(r.status < 500 && r.status !== 404, `${m} ${p} as owner: ${r.status} ${r.raw}`);
    }
  }
  for (const [who, others] of [[A, [B]], [B, [A]], [C, [A, B]], [G, [A, B]]]) {
    const r = await get("/api/agents", who.h);
    assert.equal(r.status, 200);
    assertNoneOf(r.raw, others, "/api/agents");
    const body = JSON.parse(r.raw);
    const mine = body.agents.map((a) => a.key).filter((k) => k === "laptop" || k.startsWith("laptop@"));
    assert.deepEqual(mine, who.key ? [who.key] : ["laptop"]);
    if (who.key) {
      assert.ok(r.raw.includes(who.canary), "positive control: the owner sees its own data");
      assert.ok(!r.raw.includes(CANARY.U), "a tenant sees nothing of the operators' fleet");
    }
  }
  // One tenant's ETag never answers another's 304.
  const ra = await get("/api/agents", A.h);
  const rb = await request("GET", "/api/agents", { headers: { ...B.h, "if-none-match": ra.headers.etag } });
  assert.equal(rb.status, 200);
});

// A live SSE stream, read raw.
function sseOpen(h) {
  return new Promise((resolve, reject) => {
    let text = "";
    const req = http.get(baseUrl + "/api/events", { headers: h }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      resolve({ status: res.statusCode, text: () => text, close: () => req.destroy() });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
  });
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test("XERK-2556: SSE frames from one tenant's activity reach no other stream", async () => {
  const { A, B, C, G } = await isoFleet();
  const streams = { A: await sseOpen(A.h), B: await sseOpen(B.h), C: await sseOpen(C.h), G: await sseOpen(G.h) };
  try {
    for (const s of Object.values(streams)) assert.equal(s.status, 200);
    await settle(100);
    // B acts: a beat with new content, an org setting, a decision note.
    const fresh = `${B.canary}-live`;
    await B.beat({ sessions: [{ id: "s-b-only", status: "running", repo: "shared-repo",
      transcriptId: "t-b-only", label: fresh, ttydPort: 7701 }] });
    await request("POST", `/api/jira/${encodeURIComponent(B.site)}/color`, { headers: B.h, body: { slot: 7 } });
    await request("POST", `/api/orgs/${encodeURIComponent(B.site)}/decisions`, { headers: B.h, body: { text: `${fresh} note` } });
    await settle();
    assert.ok(streams.B.text().includes(fresh), "positive control: B's own stream hears it");
    for (const k of ["A", "C", "G"]) {
      assertNoneOf(streams[k].text(), [B], `SSE stream of ${k}`);
      assert.ok(!streams[k].text().includes(fresh), `SSE stream of ${k} heard B's activity`);
    }
    assertNoneOf(streams.B.text(), [A], "B's own stream");
  } finally { for (const s of Object.values(streams)) s.close(); }
});

// A raw WebSocket upgrade; resolves with the status line.
function upgrade(pathAndQuery, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, "127.0.0.1", () => {
      socket.write(`GET ${pathAndQuery} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
        "Connection: Upgrade\r\nSec-WebSocket-Key: dGVzdC1rZXktMDEyMzQ1Ng==\r\nSec-WebSocket-Version: 13\r\n" +
        Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n");
    });
    let buf = "";
    socket.on("data", (c) => {
      buf += c.toString("latin1");
      const i = buf.indexOf("\r\n");
      if (i >= 0) { socket.destroy(); resolve(buf.slice(0, i)); }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(buf.split("\r\n")[0] || "closed"));
  });
}

test("XERK-2556: terminals and live transcripts never open onto another tenant's host", async () => {
  const { A, B } = await isoFleet();
  const tokOf = async (who) => JSON.parse((await get("/api/ws-token", who.h)).raw).token;
  const ta = await tokOf(A);
  const live = (host, sid, tok) => upgrade(`/live/${encodeURIComponent(host)}/${sid}?auth=${encodeURIComponent(tok)}`);
  assert.match(await live(B.key, "s-b-only", ta), / 404 /);
  assert.match(await live(B.key, "s-same", ta), / 404 /, "a shared session id grants nothing");
  assert.match(await live("laptop", "s-u-only", ta), / 404 /, "nor the operators' host of that name");
  assert.match(await live(A.key, "s-same", ta), / 101 /, "positive control");
  // A ws-token re-signed to claim B's tenant names nobody.
  const parts = ta.split(".");
  const claims = JSON.parse(Buffer.from(parts[2], "base64url").toString());
  claims.t = B.t;
  const forged = [parts[0], parts[1], Buffer.from(JSON.stringify(claims)).toString("base64url"), parts[3]].join(".");
  assert.doesNotMatch(await live(B.key, "s-b-only", forged), / 101 /);
  assert.doesNotMatch(await live(A.key, "s-same", forged), / 101 /, "a tampered token is nobody's");
  // The terminal proxy: another tenant's session, over HTTP and as an upgrade.
  assert.equal((await get("/term/s-b-only/", A.h)).status, 404);
  assert.match(await upgrade("/term/s-b-only/ws", { Cookie: A.h.cookie.split(";")[0] }), / 404 /);
});

test("XERK-2556: archive search, browse and reads see only the caller's tenant", async () => {
  const { A, B, C, G, beatAs } = await isoFleet();
  void beatAs;
  const meta = (who) => ({ remoteKey: "github.com/x/shared-repo", repo: "shared-repo", worktree: "/w/iso",
    slug: "-w-iso", createdAt: "2026-10-01T00:00:00Z", endedTs: "2026-10-01T01:00:00Z", summary: `${who.canary} summary` });
  const ingest = (who, tid, word) => request("POST", `/api/agents/laptop/archive/${tid}`, {
    headers: { authorization: `Bearer ${who.tok}` },
    body: { startOffset: 0, endOffset: 64, size: 64, meta: meta(who),
      entries: [{ uuid: `${tid}-${who.tag}`, role: "user", ts: "2026-10-01T00:00:00Z", text: `${word} ${who.canary}` }] },
  });
  // Both tenants archive the SAME transcript id, and each one of its own. A row
  // never crosses tenants: the first writer's tenant owns the id, and the other's
  // push stores nothing (cursor handed back, never an error) — it cannot append to
  // or re-point A's copy.
  for (const w of [A, B]) {
    for (const tid of ["t-same", `t-${w.tag}-only`]) {
      const r = await ingest(w, tid, "zebrafish");
      assert.equal(r.status, 200, `${w.tag} ${tid}: ${r.raw}`);
    }
  }
  assert.equal(hub.tenantOfKey(archive.sessionRow("t-same").host), A.t, "B's push never re-pointed A's row");
  for (const [who, others] of [[A, [B]], [B, [A]], [C, [A, B]], [G, [A, B]]]) {
    const s = await get("/api/search?q=zebrafish", who.h);
    assert.equal(s.status, 200, s.raw);
    assertNoneOf(s.raw, others, "/api/search");
    const list = await get("/api/archive", who.h);
    assertNoneOf(list.raw, others, "/api/archive");
    const same = await get("/api/archive/t-same", who.h);
    assertNoneOf(same.raw, others, "/api/archive/t-same");
    if (who.canary) {
      assert.ok(s.raw.includes(who.canary), "positive control: the owner finds its own words");
      const own = await get(`/api/archive/t-${who.tag}-only`, who.h);
      assert.ok(own.raw.includes(who.canary), "positive control: the owner reads its own transcript");
    }
    if (who === B) assert.equal(same.status, 404, "the id A owns reads as unknown to B");
  }
  assert.equal((await get("/api/archive/t-b-only", A.h)).status, 404);
  assert.equal((await get("/api/archive/t-b-only/raw", A.h)).status, 404);
  // A's agent cannot write into B's archive under a guessed key.
  const cross = await request("POST", `/api/agents/${encodeURIComponent(B.key)}/archive/t-b-only`, {
    headers: { authorization: `Bearer ${A.tok}` },
    body: { startOffset: 0, endOffset: 8, size: 8, meta: meta(A), entries: [] } });
  assert.equal(cross.status, 403);
});

test("XERK-2556: usage and insights aggregate only the caller's tenant", async () => {
  const { A, B, C, G } = await isoFleet();
  const now = Date.now();
  const row = (id, w) => ({ id, kind: "dialog", dialogKind: "permission", tool: "Bash", head: `${w.canary} cmd`,
    status: "answered", answer: "allow", askedAt: now - 1000, answeredAt: now, repo: "shared-repo" });
  hub.permissionLedger.ingest(A.key, [row("1", A)], now);
  hub.permissionLedger.ingest(B.key, [row("1", B), row("2", B)], now);
  for (const [who, others] of [[A, [B]], [B, [A]], [C, [A, B]], [G, [A, B]]]) {
    for (const p of ["/api/permissions", "/api/model-quality", `/api/model-quality?org=${encodeURIComponent((others[0]).site)}`]) {
      const r = await get(p, who.h);
      assert.ok(r.status === 200 || r.status === 404, `${p}: ${r.status}`);
      assertNoneOf(r.raw, others, p);
    }
  }
  // The unauthenticated /metrics counts the untenanted fleet only.
  const m = await get("/metrics", {});
  assertNoneOf(m.raw, [A, B], "/metrics");
});

test("XERK-2556: board ids, epic builders and meetings stay inside their org", async () => {
  const { A, B } = await isoFleet();
  // B arms an epic builder; A cannot cancel it through A's own org.
  const arm = await request("POST", `/api/jira/${encodeURIComponent(B.site)}/epic-builder`,
    { headers: B.h, body: { title: `${B.canary} epic`, idea: "an idea" } });
  assert.equal(arm.status, 200, arm.raw);
  const id = JSON.parse(arm.raw).run.id;
  const del = await request("DELETE", `/api/jira/${encodeURIComponent(A.site)}/epic-builder/${id}`, { headers: A.h });
  const ghost = await request("DELETE", `/api/jira/${encodeURIComponent(A.site)}/epic-builder/${"0".repeat(id.length)}`, { headers: A.h });
  assert.equal(del.status, 404);
  assert.equal(del.raw, ghost.raw, "another org's builder id reads as unknown");
  assert.ok(JSON.parse((await get("/api/agents", B.h)).raw).epicBuilders[id], "B's builder survives");
  // Tenir's meeting post: each tenant's token posts to the PLAIN site, landing in its own org.
  const tokens = {};
  for (const w of [A, B]) {
    const r = await request("POST", "/api/meetings-token", { headers: w.h, body: {} });
    assert.equal(r.status, 200, r.raw);
    tokens[w.tag] = JSON.parse(r.raw).token;
  }
  const post = (tok, mid, who) => request("POST", `/api/orgs/${encodeURIComponent(SITE)}/meetings`, {
    headers: { authorization: `Bearer ${tok}` },
    body: { meetingId: mid, title: `${who.canary} standup`, platform: "zoom", startedAt: Date.now() - 60_000,
      endedAt: Date.now(), participants: ["x"], segments: [{ speaker: "x", text: `${who.canary} said`, startMs: 0, endMs: 1 }] },
  });
  assert.equal((await post(tokens.a, "m-same", A)).status, 200);
  assert.equal((await post(tokens.b, "m-same", B)).status, 200, "one meeting id, two tenants: no duplicate");
  // A token naming B's tenant with A's secret, or the suffixed site, is refused.
  assert.equal((await post(`tm1.${B.t}.${tokens.a.split(".")[2]}`, "m-x", A)).status, 401);
  const suffixed = await request("POST", `/api/orgs/${encodeURIComponent(B.site)}/meetings`,
    { headers: { authorization: `Bearer ${tokens.a}` }, body: {} });
  assert.equal(suffixed.status, 404);
  const pa = JSON.parse((await get("/api/agents", A.h)).raw);
  assert.ok(pa.meetingProposals[A.site].some((m) => m.meetingId === "m-same"));
  assertNoneOf(JSON.stringify(pa), [B], "A's payload after both meetings");
  // A's review route on B's meeting id, through A's org, finds no item of B's.
  const rv = await request("POST", `/api/orgs/${encodeURIComponent(A.site)}/meetings/m-b-${rand()}/items/p1`,
    { headers: A.h, body: { action: "reject" } });
  assert.equal(rv.status, 404);
});

test("XERK-2556: push, peer roster and migration never cross a tenant", async () => {
  const { A, B, G } = await isoFleet();
  for (const [w, tok] of [[A, "dev2556a"], [B, "dev2556b"], [G, "dev2556g"]]) {
    const r = await request("POST", "/api/devices", { headers: w.h, body: { token: tok } });
    assert.equal(r.status, 200, r.raw);
  }
  try {
    const toks = (host) => hub.devicesForHost(host).map((d) => d.token);
    assert.ok(toks(A.key).includes("dev2556a") && !toks(A.key).includes("dev2556b") && !toks(A.key).includes("dev2556g"));
    assert.ok(toks(B.key).includes("dev2556b") && !toks(B.key).includes("dev2556a"));
    assert.ok(toks("laptop").includes("dev2556g") && !toks("laptop").some((t) => t === "dev2556a" || t === "dev2556b"));
  } finally {
    for (const t of ["dev2556a", "dev2556b", "dev2556g"]) hub.unregisterDevice(t);
  }
  // The roster on each beat reply: its own tenant's sessions only.
  const ra = JSON.parse((await A.beat()).raw);
  const peers = JSON.stringify(ra.peers || []);
  assert.ok(peers.includes(`rc-${A.canary}`), "positive control: A's own sessions are its peers");
  assertNoneOf(peers, [B], "A's peer roster");
  assert.ok(!peers.includes(CANARY.U), "A's roster holds no operator session");
  // A session moves only within its tenant.
  for (const to of [B.key, "laptop", `laptop@${crypto.randomBytes(16).toString("hex")}`]) {
    const r = await request("POST", `/api/agents/${encodeURIComponent(A.key)}/sessions/s-a-only/migrate`,
      { headers: A.h, body: { host: to } });
    assert.equal(r.status, 404, `migrate to ${to}: ${r.raw}`);
  }
});

test("XERK-2556: enrollment codes are their tenant's; ids from another read as unknown", async () => {
  const { A, B, C, G } = await isoFleet();
  const m = await request("POST", "/api/enroll-codes", { headers: A.h, body: { device: "spare2556" } });
  assert.equal(m.status, 200, m.raw);
  const listA = JSON.parse((await get("/api/enroll-codes", A.h)).raw).codes;
  const mine = listA.find((c) => c.device === "spare2556");
  assert.ok(mine, "positive control");
  for (const who of [B, C, G]) {
    const l = await get("/api/enroll-codes", who.h);
    assert.ok(!JSON.parse(l.raw).codes.some((c) => c.id === mine.id), "another principal lists A's code");
    const d = await request("DELETE", `/api/enroll-codes/${mine.id}`, { headers: who.h });
    const u = await request("DELETE", `/api/enroll-codes/${"f".repeat(mine.id.length)}`, { headers: who.h });
    assert.equal(d.status, 404);
    assert.equal(d.raw, u.raw, "another tenant's code id reads as unknown");
  }
  assert.ok(JSON.parse((await get("/api/enroll-codes", A.h)).raw).codes.some((c) => c.id === mine.id), "A's code survives");
});

test("XERK-2556: forged tokens name nobody — session, agent, meetings", async () => {
  const { A, B } = await isoFleet();
  // hub_session claiming A's user in B's tenant, or with its MAC bent.
  assert.equal(principalOfToken(hub.issueSessionToken(60_000, { u: A.user.id, t: B.t, r: ["user"] })), null);
  const real = A.h.cookie.slice("hub_session=".length);
  const bent = real.slice(0, -2) + (real.endsWith("AA") ? "BB" : "AA");
  for (const tok of [bent, real.replace(/^u2\.\d+/, "u2.9999999999999")]) {
    const r = await get("/api/agents", { cookie: `hub_session=${tok}` });
    assert.equal(r.status, 401, "a tampered cookie is signed out");
  }
  // A's agent token can be no other key: B's, the operators' plain name, or a ghost.
  for (const dev of [B.key, `laptop@${crypto.randomBytes(16).toString("hex")}`]) {
    const r = await request("POST", "/api/heartbeat", { headers: { authorization: `Bearer ${A.tok}` }, body: { device: dev } });
    assert.equal(r.status, 403, `A's token beating ${dev}`);
  }
  // The plain name typed with A's token is namespaced into A's tenant: it acts on
  // A's own "laptop", never the operators' record of that name.
  const before = JSON.stringify(hub.agents.laptop);
  await request("POST", `/api/agents/laptop/updating`, { headers: { authorization: `Bearer ${A.tok}` }, body: {} });
  assert.equal(JSON.stringify(hub.agents.laptop), before, "the operators' laptop is untouched");
  // The fleet master proves no tenant.
  const master = await request("POST", "/api/heartbeat", { headers: { authorization: "Bearer agenttok" }, body: { device: B.key } });
  assert.equal(master.status, 403);
  // A meetings token is random per tenant, never derivable from the fleet token.
  const derived = `tm1.${B.t}.${crypto.createHmac("sha256", "meetingstok").update(B.t).digest("base64url")}`;
  const r = await request("POST", `/api/orgs/${encodeURIComponent(SITE)}/meetings`,
    { headers: { authorization: `Bearer ${derived}` }, body: {} });
  assert.equal(r.status, 401);
});

test("XERK-2556: the admin surface is admins-only and serves identities, never tenant data", async () => {
  const { A, B, C, G } = await isoFleet();
  const scope = require("../tenant-scope.js");
  for (const [methods, pattern, cls] of scope.ROUTES) {
    if (cls !== "admin") continue;
    const p = pattern.replace(":id", A.user.id);
    for (const m of methods.split(" ")) {
      for (const who of [A, B]) {
        const r = await request(m, p, { headers: { ...who.h, origin: baseUrl }, body: m === "GET" ? undefined : {} });
        assert.equal(r.status, 404, `${m} ${p} as a tenant user: ${r.status}`);
      }
    }
  }
  for (const who of [C, G]) {
    const r = await get("/api/admin/users", who.h);
    assert.equal(r.status, 200, r.raw);
    assert.ok(r.raw.includes("iso2556a"), "positive control: the admin sees the identity");
    assertNoneOf(r.raw, [A, B], "/api/admin/users");
    assert.ok(!/scrypt\$|"tenantId"|laptop@/.test(r.raw), "no hash, tenant id or host key");
    const audit = await get("/api/admin/audit", who.h);
    assertNoneOf(audit.raw, [A, B], "/api/admin/audit");
  }
});

test("XERK-2556: host names shaped like another tenant's key are no way in", async () => {
  const { A, B } = await isoFleet();
  // Enrolling a device named as B's key is refused; an upper-cased copy is not a
  // tenant key at all (ids are lower-case hex), so it lands inside A's own tenant.
  for (const dev of [B.key, `x@${B.t}`]) {
    const m = await request("POST", "/api/enroll-codes", { headers: A.h, body: {} });
    const r = await request("POST", "/api/agent/enroll", { body: { code: JSON.parse(m.raw).code, device: dev } });
    assert.notEqual(r.status, 200, `enrolled ${dev}`);
    await request("DELETE", `/api/enroll-codes/${JSON.parse(m.raw).id}`, { headers: A.h });
  }
  {
    const m = await request("POST", "/api/enroll-codes", { headers: A.h, body: {} });
    const r = await request("POST", "/api/agent/enroll", { body: { code: JSON.parse(m.raw).code, device: B.key.toUpperCase() } });
    if (r.status === 200) {
      const tok = JSON.parse(r.raw).token;
      const beat = await request("POST", "/api/heartbeat", { headers: { authorization: `Bearer ${tok}` }, body: { device: B.key.toUpperCase() } });
      assert.equal(beat.status, 200);
      const k = `${B.key.toUpperCase()}@${A.t}`;
      assert.ok(hub.agents[k], "the look-alike is A's host");
      assert.equal((await request("POST", `/api/agents/${encodeURIComponent(k)}/restart`, { headers: B.h, body: {} })).status, 404);
      assert.ok(!JSON.parse((await get("/api/agents", B.h)).raw).agents.some((a) => a.key === k), "B never sees it");
      delete hub.agents[k];
    }
  }
  // The fleet master beating a name of that shape (any case) never becomes B's host.
  for (const dev of [`laptop@${B.t}`, `LAPTOP@${B.t.toUpperCase()}`, `laptop@${B.t}/`]) {
    const had = new Set(Object.keys(hub.agents));
    const r = await request("POST", "/api/heartbeat", { headers: { authorization: "Bearer agenttok" }, body: { device: dev } });
    const made = Object.keys(hub.agents).filter((k) => !had.has(k) && k.toLowerCase() === dev.toLowerCase());
    for (const k of made) {
      assert.equal(hub.tenantOfKey(k), "", `${dev} became a tenant key`);
      assert.equal((await request("POST", `/api/agents/${encodeURIComponent(k)}/restart`, { headers: B.h, body: {} })).status, 404,
        "and B cannot drive it as its own");
      delete hub.agents[k];
    }
    if (dev === `laptop@${B.t}`) assert.equal(r.status, 403, "the master never beats as B's key");
    assert.ok(hub.agents[B.key] && hub.tenantOfKey(B.key) === B.t, "B's record is untouched");
  }
  // A second "laptop" inside one tenant is refused (two machines, one key).
  const m = await request("POST", "/api/enroll-codes", { headers: A.h, body: { device: "Laptop" } });
  assert.notEqual(m.status, 200, "a case twin of A's own host");
});
