"use strict";

// XERK-594 — group-based access from the OIDC `groups` claim (k8x-ai / k8x-admins);
// XERK-2532 — each group maps to its own role (user = a tenant, admin = the panel).
//
// Its own process, like oidc.test.js: the group config AND the OIDC env are read
// at require time. Here group enforcement is ON (the default names) and the OIDC
// session TTL is pinned short so the cookie's Max-Age can be asserted.

const path = require("path");
const { mkdtemp, scratchDir } = require("./tmpdirs");
const http = require("http");
const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";

const ISSUER = "https://idp.test/application/o/turma/";
const CLIENT_ID = "turma-client";
const CLIENT_SECRET = "shh-secret";
const REDIRECT_URI = "https://turma.test/auth/oidc/callback";
process.env.TURMA_OIDC_ISSUER = ISSUER;
process.env.TURMA_OIDC_CLIENT_ID = CLIENT_ID;
process.env.TURMA_OIDC_CLIENT_SECRET = CLIENT_SECRET;
process.env.TURMA_OIDC_REDIRECT_URI = REDIRECT_URI;
// Group enforcement ON with the real default names; a short session TTL so its
// effect on the cookie Max-Age is observable.
const USER_GROUP = "k8x-ai";
const ADMIN_GROUP = "k8x-admins";
process.env.TURMA_OIDC_USER_GROUP = USER_GROUP;
process.env.TURMA_OIDC_ADMIN_GROUP = ADMIN_GROUP;
const OIDC_TTL_MS = 3600 * 1000; // 1h
process.env.TURMA_OIDC_SESSION_TTL_MS = String(OIDC_TTL_MS);

const tmp = (name) => path.join(scratchDir(), `turma-oidcgrp-${name}-${process.pid}.json`);
process.env.STATE_FILE = tmp("state");
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AGENT_IDENTITIES_FILE = tmp("agent-identities");
process.env.TENANCY_FILE = tmp("tenancy");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.TICKET_RUNTIMES_FILE = tmp("ticket-runtimes");
process.env.ORG_COLORS_FILE = tmp("org-colors");
process.env.TRIAGE_POLICIES_FILE = tmp("triage-policies");
process.env.TRIAGE_ACTIONS_FILE = tmp("triage-actions");
process.env.USAGE_LEDGER_FILE = tmp("usage-ledger");
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-oidcgrp-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-oidcgrp-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const tenancy = require("../tenancy.js");
const { server } = hub;

// The OIDC side-stores moved into the shared LiveStore (XERK-760); in tests HA is
// off so `hub.liveStore` is an in-memory FileLiveStore. Seed/peek it as the old
// Map-based tests did.
const store = hub.liveStore;
const txSet = (state, rec) => store.set(hub.OIDC_TX_PREFIX + state, rec);
const txHas = async (state) => (await store.get(hub.OIDC_TX_PREFIX + state)) != null;
const sessGet = (sid) => store.get(hub.OIDC_SESSION_PREFIX + sid);
const sessSize = async () => (await store.scan(hub.OIDC_SESSION_PREFIX)).length;

// ---- a locally-minted RSA signing key + JWKS ---------------------------------

const KID = "test-key-1";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const jwksKeys = new Map([[KID, crypto.createPublicKey({ key: jwk, format: "jwk" })]]);

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: "https://idp.test/application/o/authorize/",
  token_endpoint: "https://idp.test/application/o/token/",
  jwks_uri: "https://idp.test/application/o/turma/jwks/",
  end_session_endpoint: "https://idp.test/application/o/turma/end-session/",
};

function signJwt(claims) {
  const header = { alg: "RS256", kid: KID, typ: "JWT" };
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = `${h}.${p}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url");
  return `${data}.${sig}`;
}

function claimsWith(groups, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const c = { iss: ISSUER, aud: CLIENT_ID, sub: "user-123", nonce: "the-nonce", iat: now, exp: now + 300, ...over };
  if (groups !== undefined) c.groups = groups;
  return c;
}

// ---- pure helpers ------------------------------------------------------------

test("group config is enforced with the expected names + short session TTL", () => {
  assert.equal(hub.OIDC_GROUPS_ENFORCED, true);
  assert.equal(hub.OIDC_USER_GROUP, USER_GROUP);
  assert.equal(hub.OIDC_ADMIN_GROUP, ADMIN_GROUP);
  assert.equal(hub.OIDC_SESSION_TTL_MS, OIDC_TTL_MS);
});

test("oidcGroupsFromClaims normalizes the many shapes of the claim", () => {
  assert.deepEqual(hub.oidcGroupsFromClaims({ groups: [USER_GROUP, "other"] }), [USER_GROUP, "other"]);
  assert.deepEqual(hub.oidcGroupsFromClaims({ groups: USER_GROUP }), [USER_GROUP]); // single bare string
  assert.deepEqual(hub.oidcGroupsFromClaims({}), []); // claim absent
  assert.deepEqual(hub.oidcGroupsFromClaims({ groups: null }), []);
  assert.deepEqual(hub.oidcGroupsFromClaims(null), []);
  // Non-string / empty members are dropped (a forged number can't match a name).
  assert.deepEqual(hub.oidcGroupsFromClaims({ groups: [USER_GROUP, 1, "", null, {}] }), [USER_GROUP]);
});

test("XERK-2532: oidcAccessDecision maps each group to its own role", () => {
  assert.deepEqual(hub.oidcAccessDecision([USER_GROUP]), { allowed: true, roles: ["user"] });
  // Admin alone no longer implies user: admin panel, no tenant.
  assert.deepEqual(hub.oidcAccessDecision([ADMIN_GROUP]), { allowed: true, roles: ["admin"] });
  // Both groups -> both roles, in tenancy.ROLES order whatever the claim's order.
  assert.deepEqual(hub.oidcAccessDecision([ADMIN_GROUP, USER_GROUP]), { allowed: true, roles: ["user", "admin"] });
  // In neither group -> denied.
  assert.deepEqual(hub.oidcAccessDecision(["something-else"]), { allowed: false, roles: [] });
  assert.deepEqual(hub.oidcAccessDecision([]), { allowed: false, roles: [] });
});

// ---- the callback route ------------------------------------------------------

let baseUrl;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function get(pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathName, { method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Drive a full callback with the token endpoint stubbed to mint the given claims.
// `over` overrides claims (a distinct `sub` keeps a test's user its own); `mobile`
// is a PKCE challenge, making it the native-app flow.
async function driveCallback(groups, over = {}, mobile = "") {
  hub.__setOidcCaches(DISCOVERY, jwksKeys);
  const state = `state-${crypto.randomBytes(4).toString("hex")}`;
  await txSet(state, { nonce: "the-nonce", verifier: "verifier-xyz-1234567890", next: "/board", mobile, at: Date.now() });
  const saved = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id_token: signJwt(claimsWith(groups, over)) }),
  });
  try {
    const res = await get(`/auth/oidc/callback?state=${state}&code=the-code`, { cookie: `hub_oidc_state=${state}` });
    return { res, state };
  } finally {
    global.fetch = saved;
  }
}

function post(pathName, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(baseUrl + pathName, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: out }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

function setCookieText(res) {
  return (res.headers["set-cookie"] || []).join("\n");
}
function sidFromSetCookie(res) {
  const m = setCookieText(res).match(/hub_oidc=([^;]+)/);
  return m ? m[1] : null;
}

test("a user in the user group is admitted with a user-role session", async () => {
  const { res, state } = await driveCallback([USER_GROUP]);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/board");
  const sc = setCookieText(res);
  assert.match(sc, /hub_session=/);
  assert.match(sc, /hub_oidc=/);
  // The session cookie's Max-Age reflects the shorter OIDC TTL, not 30 days.
  assert.match(sc, new RegExp(`hub_session=[^;]+; .*Max-Age=${OIDC_TTL_MS / 1000}(;|\\b)`));
  const rec = await sessGet(sidFromSetCookie(res));
  assert.ok(rec);
  assert.deepEqual(rec.roles, ["user"]);
  assert.deepEqual(rec.groups, [USER_GROUP]);
  assert.equal(await txHas(state), false); // tx consumed
});

test("a user in both groups is admitted with both roles", async () => {
  const { res } = await driveCallback([ADMIN_GROUP, USER_GROUP], { sub: "both-1" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/board");
  const rec = await sessGet(sidFromSetCookie(res));
  assert.ok(rec);
  assert.deepEqual(rec.roles, ["user", "admin"]);
  const p = principalOf(res);
  assert.deepEqual([...p.roles], ["user", "admin"]);
  assert.match(p.tenantId, /^[0-9a-f]{32}$/);
});

function tokenOf(res) {
  const m = setCookieText(res).match(/hub_session=([^;]+)/);
  return m ? m[1] : null;
}
function principalOf(res) {
  return hub.requestPrincipal({ headers: { cookie: `hub_session=${tokenOf(res)}` } });
}
const userBySub = (sub) => Object.values(hub.tenancyState().users).find((u) => u.oidcSub === sub) || null;

test("XERK-2532: an admin-group-only user gets the admin role and NO tenant; joining the user group adds it", async () => {
  const { res } = await driveCallback([ADMIN_GROUP], { sub: "admin-only-1" });
  assert.equal(res.status, 302);
  const p = principalOf(res);
  assert.equal(p.kind, "user");
  assert.equal(p.source, "oidc");
  assert.deepEqual([...p.roles], ["admin"]);
  assert.equal(p.tenantId, null, "admin grants no tenant");
  const rec = await sessGet(sidFromSetCookie(res));
  assert.equal(rec.userId, p.userId);
  // The record keeps a reserved tenant, so a later user role is that same tenant.
  const stored = userBySub("admin-only-1");
  assert.match(stored.tenantId, /^[0-9a-f]{32}$/);
  const again = await driveCallback([USER_GROUP], { sub: "admin-only-1" });
  const p2 = principalOf(again.res);
  assert.equal(p2.userId, p.userId);
  assert.equal(p2.tenantId, stored.tenantId);
  assert.deepEqual([...p2.roles], ["user"]);
  // The earlier admin-only cookie now reads the CURRENT roles (store, not cookie).
  assert.deepEqual([...principalOf(res).roles], ["user"]);
});

test("XERK-2532: a user-group-only user gets a tenant and no admin role", async () => {
  const { res } = await driveCallback([USER_GROUP], { sub: "user-only-1" });
  const p = principalOf(res);
  assert.deepEqual([...p.roles], ["user"]);
  assert.match(p.tenantId, /^[0-9a-f]{32}$/);
});

test("XERK-2532: the identity is (issuer, sub) — a changed email/name is the same user", async () => {
  const a = await driveCallback([USER_GROUP], { sub: "stable-1", email: "a@x.test", name: "A" });
  const b = await driveCallback([USER_GROUP], { sub: "stable-1", email: "b@x.test", name: "B" });
  assert.equal(principalOf(a.res).userId, principalOf(b.res).userId);
  assert.equal(userBySub("stable-1").displayName, "B");
  // A different sub sharing the email is a different user and tenant.
  const c = await driveCallback([USER_GROUP], { sub: "stable-2", email: "b@x.test", name: "B" });
  assert.notEqual(principalOf(c.res).userId, principalOf(b.res).userId);
  assert.notEqual(principalOf(c.res).tenantId, principalOf(b.res).tenantId);
});

test("XERK-2532: removal from every group disables the user (tenant kept), revoking its live session; re-adding restores it", async () => {
  const first = await driveCallback([USER_GROUP], { sub: "leaver-1" });
  const p = principalOf(first.res);
  assert.ok(p);
  const tenantId = p.tenantId;
  // Removed from the groups: the next login is refused AND marks the user disabled.
  const denied = await driveCallback(["something-else"], { sub: "leaver-1" });
  assert.equal(denied.res.headers.location, "/login?error=forbidden");
  const u = userBySub("leaver-1");
  assert.equal(u.disabled, true);
  assert.equal(u.disabledBy, "idp");
  assert.equal(u.tenantId, tenantId, "tenant retained until an admin deletes the user");
  // The still-unexpired cookie from before names nobody now (roles re-read per request).
  assert.equal(principalOf(first.res), null);
  // Re-added to the user group: the IdP disable lifts, same user + tenant.
  const back = await driveCallback([USER_GROUP], { sub: "leaver-1" });
  const p2 = principalOf(back.res);
  assert.equal(p2.userId, p.userId);
  assert.equal(p2.tenantId, tenantId);
  assert.equal(userBySub("leaver-1").disabled, false);
  assert.equal(userBySub("leaver-1").disabledBy, undefined);
});

test("XERK-2532: an operator's disable is never lifted by a login", async () => {
  await driveCallback([USER_GROUP], { sub: "op-disabled-1" });
  const u = userBySub("op-disabled-1");
  hub.__setTenancy(tenancy.updateUser(hub.tenancyState(), u.id, { disabled: true }).state);
  const again = await driveCallback([USER_GROUP], { sub: "op-disabled-1" });
  assert.equal(again.res.headers.location, "/login?error=forbidden");
  assert.equal(userBySub("op-disabled-1").disabled, true);
  // Re-stating an IdP disable as the operator's makes it the operator's too.
  await driveCallback([USER_GROUP], { sub: "op-disabled-2" });
  await driveCallback([], { sub: "op-disabled-2" });
  const u2 = userBySub("op-disabled-2");
  assert.equal(u2.disabledBy, "idp");
  hub.__setTenancy(tenancy.updateUser(hub.tenancyState(), u2.id, { disabled: true }).state);
  assert.equal(userBySub("op-disabled-2").disabledBy, undefined);
  await driveCallback([USER_GROUP], { sub: "op-disabled-2" });
  assert.equal(userBySub("op-disabled-2").disabled, true);
});

test("XERK-2532: losing only the user group drops the tenant but keeps admin (not disabled)", async () => {
  await driveCallback([USER_GROUP, ADMIN_GROUP], { sub: "demoted-1" });
  const { res } = await driveCallback([ADMIN_GROUP], { sub: "demoted-1" });
  const p = principalOf(res);
  assert.deepEqual([...p.roles], ["admin"]);
  assert.equal(p.tenantId, null);
  assert.equal(userBySub("demoted-1").disabled, false);
});

test("XERK-2532: a local group an operator added admits a user the IdP groups don't", async () => {
  await driveCallback([USER_GROUP], { sub: "local-grp-1" });
  const u = userBySub("local-grp-1");
  hub.__setTenancy(tenancy.updateUser(hub.tenancyState(), u.id, { groups: ["turma-admins"] }).state);
  const { res } = await driveCallback([], { sub: "local-grp-1" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/board");
  const p = principalOf(res);
  assert.deepEqual([...p.roles], ["admin"]);
  assert.equal(p.tenantId, null);
  assert.equal(userBySub("local-grp-1").disabled, false);
});

test("XERK-2532: an identity in neither group is never provisioned", async () => {
  await driveCallback(["something-else"], { sub: "never-1" });
  assert.equal(userBySub("never-1"), null);
});

test("XERK-2532: the mobile exchange issues the same principal as the browser flow", async () => {
  const verifier = "mobile-verifier-2532-abcdefgh";
  const { res } = await driveCallback([ADMIN_GROUP], { sub: "mobile-1" }, hub.pkceChallenge(verifier));
  assert.equal(res.status, 302);
  const code = new URL(res.headers.location).searchParams.get("code");
  const ex = await post("/api/oidc/mobile/exchange", { code, verifier });
  assert.equal(ex.status, 200);
  const { token } = JSON.parse(ex.raw);
  const pm = hub.requestPrincipal({ headers: { cookie: `hub_session=${token}` } });
  const browser = await driveCallback([ADMIN_GROUP], { sub: "mobile-1" });
  const pb = principalOf(browser.res);
  assert.equal(pm.userId, pb.userId);
  assert.deepEqual([...pm.roles], ["admin"]);
  assert.deepEqual([...pm.roles], [...pb.roles]);
  assert.equal(pm.tenantId, null);
});

test("a user in NEITHER group is denied a session and bounced to /login?error=forbidden", async () => {
  const before = await sessSize();
  const { res, state } = await driveCallback(["some-other-group"]);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/login?error=forbidden");
  const sc = setCookieText(res);
  // No hub session was issued; only the state cookie was cleared.
  assert.doesNotMatch(sc, /hub_session=[^;]/);
  assert.doesNotMatch(sc, /hub_oidc=[^;]/);
  assert.match(sc, /hub_oidc_state=; .*Max-Age=0/);
  assert.equal(await sessSize(), before); // no server-side record added
  assert.equal(await txHas(state), false); // tx still consumed (single use)
});

test("a token with NO groups claim at all is denied", async () => {
  const { res } = await driveCallback(undefined);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/login?error=forbidden");
  assert.doesNotMatch(setCookieText(res), /hub_session=[^;]/);
});
