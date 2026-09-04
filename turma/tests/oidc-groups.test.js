"use strict";

// XERK-594 — group-based access from the OIDC `groups` claim (k8x-ai / k8x-admins).
//
// Its own process, like oidc.test.js: the group config AND the OIDC env are read
// at require time. Here group enforcement is ON (the default names) and the OIDC
// session TTL is pinned short so the cookie's Max-Age can be asserted.

const os = require("os");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
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

const tmp = (name) => path.join(os.tmpdir(), `turma-oidcgrp-${name}-${process.pid}.json`);
process.env.STATE_FILE = tmp("state");
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
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
const { server } = hub;

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

test("oidcAccessDecision maps groups to allow + role", () => {
  assert.deepEqual(hub.oidcAccessDecision([USER_GROUP]), { allowed: true, role: "user" });
  assert.deepEqual(hub.oidcAccessDecision([ADMIN_GROUP]), { allowed: true, role: "admin" });
  // Admin outranks user when a user is in both.
  assert.deepEqual(hub.oidcAccessDecision([USER_GROUP, ADMIN_GROUP]), { allowed: true, role: "admin" });
  // In neither group -> denied.
  assert.deepEqual(hub.oidcAccessDecision(["something-else"]), { allowed: false, role: null });
  assert.deepEqual(hub.oidcAccessDecision([]), { allowed: false, role: null });
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
async function driveCallback(groups) {
  hub.__setOidcCaches(DISCOVERY, jwksKeys);
  const state = `state-${crypto.randomBytes(4).toString("hex")}`;
  hub.oidcTx.set(state, { nonce: "the-nonce", verifier: "verifier-xyz-1234567890", next: "/board", at: Date.now() });
  const saved = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id_token: signJwt(claimsWith(groups)) }),
  });
  try {
    const res = await get(`/auth/oidc/callback?state=${state}&code=the-code`, { cookie: `hub_oidc_state=${state}` });
    return { res, state };
  } finally {
    global.fetch = saved;
  }
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
  const rec = hub.oidcSessions.get(sidFromSetCookie(res));
  assert.ok(rec);
  assert.equal(rec.role, "user");
  assert.deepEqual(rec.groups, [USER_GROUP]);
  assert.equal(hub.oidcTx.has(state), false); // tx consumed
});

test("a user in the admin group is admitted with an admin-role session", async () => {
  const { res } = await driveCallback([ADMIN_GROUP, USER_GROUP]);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/board");
  const rec = hub.oidcSessions.get(sidFromSetCookie(res));
  assert.ok(rec);
  assert.equal(rec.role, "admin");
});

test("a user in NEITHER group is denied a session and bounced to /login?error=forbidden", async () => {
  const before = hub.oidcSessions.size;
  const { res, state } = await driveCallback(["some-other-group"]);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/login?error=forbidden");
  const sc = setCookieText(res);
  // No hub session was issued; only the state cookie was cleared.
  assert.doesNotMatch(sc, /hub_session=[^;]/);
  assert.doesNotMatch(sc, /hub_oidc=[^;]/);
  assert.match(sc, /hub_oidc_state=; .*Max-Age=0/);
  assert.equal(hub.oidcSessions.size, before); // no server-side record added
  assert.equal(hub.oidcTx.has(state), false); // tx still consumed (single use)
});

test("a token with NO groups claim at all is denied", async () => {
  const { res } = await driveCallback(undefined);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/login?error=forbidden");
  assert.doesNotMatch(setCookieText(res), /hub_session=[^;]/);
});
