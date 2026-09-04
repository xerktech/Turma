// XERK-592: the hub's OIDC relying-party core — Authorization Code + PKCE
// discovery/JWKS RS256 validation, session cookie, RP-initiated logout.
//
// OIDC config is read at REQUIRE time, so this lives in its own file — `node
// --test` runs each test file in its own process, so the OIDC env set here does
// not leak into server.test.js (which requires the module with OIDC unset, i.e.
// disabled). The security-critical validation (signature + claims) is tested
// OFFLINE with a locally-minted RSA key; the flow routes are driven against the
// real HTTP server with discovery/JWKS seeded and only the token endpoint (a
// single outbound POST) stubbed on global.fetch.

"use strict";

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

// The OIDC env under test. All four present => OIDC_ENABLED. Note the issuer's
// TRAILING SLASH (Authentik's shape) — the discovery URL strips it, the `iss`
// claim keeps it.
const ISSUER = "https://idp.test/application/o/turma/";
const CLIENT_ID = "turma-client";
const CLIENT_SECRET = "shh-secret";
const REDIRECT_URI = "https://turma.test/auth/oidc/callback";
process.env.TURMA_OIDC_ISSUER = ISSUER;
process.env.TURMA_OIDC_CLIENT_ID = CLIENT_ID;
process.env.TURMA_OIDC_CLIENT_SECRET = CLIENT_SECRET;
process.env.TURMA_OIDC_REDIRECT_URI = REDIRECT_URI;

const tmp = (name) => path.join(os.tmpdir(), `turma-oidc-${name}-${process.pid}.json`);
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
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-oidc-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-oidc-archive-");
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

function signJwt(claims, { kid = KID, alg = "RS256", key = privateKey } = {}) {
  const header = { alg, kid, typ: "JWT" };
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = `${h}.${p}`;
  if (alg === "none") return `${data}.`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(data), key).toString("base64url");
  return `${data}.${sig}`;
}

function goodClaims(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISSUER, aud: CLIENT_ID, sub: "user-123", nonce: "the-nonce", iat: now, exp: now + 300, ...over };
}
const EXPECT = { iss: ISSUER, aud: CLIENT_ID, nonce: "the-nonce" };

// ---- pure units --------------------------------------------------------------

test("OIDC is enabled when all four env vars are set", () => {
  assert.equal(hub.OIDC_ENABLED, true);
});

test("pkceChallenge matches the RFC 7636 Appendix B test vector", () => {
  assert.equal(
    hub.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  );
});

test("oidcSafeNext only permits local, same-origin paths", () => {
  assert.equal(hub.oidcSafeNext("/board"), "/board");
  assert.equal(hub.oidcSafeNext("/usage?x=1"), "/usage?x=1");
  assert.equal(hub.oidcSafeNext("//evil.example"), "/"); // protocol-relative
  assert.equal(hub.oidcSafeNext("https://evil.example"), "/");
  assert.equal(hub.oidcSafeNext("/\\evil.example"), "/"); // backslash trick
  assert.equal(hub.oidcSafeNext(""), "/");
  assert.equal(hub.oidcSafeNext(null), "/");
});

test("oidcVerifySignature accepts a valid RS256 token and returns its claims", () => {
  const claims = hub.oidcVerifySignature(signJwt(goodClaims()), jwksKeys);
  assert.equal(claims.sub, "user-123");
});

test("oidcVerifySignature rejects a tampered payload", () => {
  const token = signJwt(goodClaims());
  const [h, , s] = token.split(".");
  const forged = Buffer.from(JSON.stringify(goodClaims({ sub: "admin" }))).toString("base64url");
  assert.throws(() => hub.oidcVerifySignature(`${h}.${forged}.${s}`, jwksKeys), /signature is invalid/);
});

test("oidcVerifySignature rejects alg:none (no algorithm confusion)", () => {
  assert.throws(() => hub.oidcVerifySignature(signJwt(goodClaims(), { alg: "none" }), jwksKeys), /unsupported/);
});

test("oidcVerifySignature rejects a token signed by a different key", () => {
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.throws(
    () => hub.oidcVerifySignature(signJwt(goodClaims(), { key: other }), jwksKeys),
    /signature is invalid/
  );
});

test("oidcVerifySignature rejects an unknown kid", () => {
  assert.throws(
    () => hub.oidcVerifySignature(signJwt(goodClaims(), { kid: "nope" }), jwksKeys),
    /no JWKS key/
  );
});

test("oidcValidateClaims enforces iss/aud/exp/iat/nonce", () => {
  assert.deepEqual(hub.oidcValidateClaims(goodClaims(), EXPECT).sub, "user-123");
  assert.throws(() => hub.oidcValidateClaims(goodClaims({ iss: "https://evil/" }), EXPECT), /iss mismatch/);
  assert.throws(() => hub.oidcValidateClaims(goodClaims({ aud: "someone-else" }), EXPECT), /aud mismatch/);
  const past = Math.floor(Date.now() / 1000) - 10000;
  assert.throws(() => hub.oidcValidateClaims(goodClaims({ exp: past }), EXPECT), /expired/);
  const future = Math.floor(Date.now() / 1000) + 10000;
  assert.throws(() => hub.oidcValidateClaims(goodClaims({ iat: future }), EXPECT), /future/);
  assert.throws(() => hub.oidcValidateClaims(goodClaims({ nonce: "wrong" }), EXPECT), /nonce mismatch/);
});

test("oidcValidateClaims accepts an array aud that includes us, with matching azp", () => {
  assert.ok(hub.oidcValidateClaims(goodClaims({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID }), EXPECT));
  assert.throws(
    () => hub.oidcValidateClaims(goodClaims({ aud: [CLIENT_ID, "other"], azp: "other" }), EXPECT),
    /azp mismatch/
  );
});

test("oidcVerifyIdToken (offline: seeded discovery+JWKS) validates end to end", async () => {
  hub.__setOidcCaches(DISCOVERY, jwksKeys);
  const claims = await hub.oidcVerifyIdToken(signJwt(goodClaims()), EXPECT);
  assert.equal(claims.sub, "user-123");
});

test("oidcVerifyIdToken refetches JWKS once on a kid miss (key rotation)", async () => {
  // Seed an EMPTY key set so the first verify misses, then serve the real JWKS
  // over a stubbed fetch — the second attempt must succeed.
  hub.__setOidcCaches(DISCOVERY, new Map());
  const saved = global.fetch;
  let jwksFetches = 0;
  global.fetch = async (url) => {
    if (String(url) === DISCOVERY.jwks_uri) {
      jwksFetches++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ keys: [jwk] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const claims = await hub.oidcVerifyIdToken(signJwt(goodClaims()), EXPECT);
    assert.equal(claims.sub, "user-123");
    assert.equal(jwksFetches, 1);
  } finally {
    global.fetch = saved;
  }
});

// ---- flow routes -------------------------------------------------------------

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

test("GET /auth/oidc/login redirects to the IdP with PKCE + state, storing the tx", async () => {
  hub.__setOidcCaches(DISCOVERY, jwksKeys);
  hub.oidcTx.clear();
  const res = await get("/auth/oidc/login?next=/board");
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.location);
  assert.equal(`${loc.origin}${loc.pathname}`, DISCOVERY.authorization_endpoint.replace(/\/$/, "/"));
  assert.equal(loc.searchParams.get("response_type"), "code");
  assert.equal(loc.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(loc.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  assert.ok(loc.searchParams.get("code_challenge"));
  assert.ok(loc.searchParams.get("nonce"));
  const state = loc.searchParams.get("state");
  assert.ok(state);
  // The transaction was stored under that exact state, remembering the safe next.
  const tx = hub.oidcTx.get(state);
  assert.ok(tx);
  assert.equal(tx.next, "/board");
  // The challenge is the S256 of the stored verifier.
  assert.equal(loc.searchParams.get("code_challenge"), hub.pkceChallenge(tx.verifier));
  // The flow is bound to the browser: a state cookie carrying that exact state
  // is set, HttpOnly (login-CSRF defence).
  const setCookie = (res.headers["set-cookie"] || []).join("\n");
  assert.match(setCookie, new RegExp(`hub_oidc_state=${state}(;|$)`, "m"));
  assert.match(setCookie, /hub_oidc_state=[^;]+; .*HttpOnly/);
});

test("GET /auth/oidc/callback exchanges the code and issues the hub session", async () => {
  hub.__setOidcCaches(DISCOVERY, jwksKeys);
  const state = "state-abc";
  const verifier = "verifier-xyz-1234567890";
  hub.oidcTx.set(state, { nonce: "the-nonce", verifier, next: "/usage", at: Date.now() });

  const saved = global.fetch;
  let tokenBody = null;
  let tokenAuth = null;
  global.fetch = async (url, opts) => {
    assert.equal(String(url), DISCOVERY.token_endpoint);
    tokenBody = new URLSearchParams(opts.body);
    tokenAuth = opts.headers.Authorization;
    return { ok: true, status: 200, text: async () => JSON.stringify({ id_token: signJwt(goodClaims()) }) };
  };
  try {
    const res = await get(`/auth/oidc/callback?state=${state}&code=the-code`, {
      cookie: `hub_oidc_state=${state}`,
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/usage");
    // PKCE verifier + confidential-client Basic auth reached the token endpoint.
    assert.equal(tokenBody.get("grant_type"), "authorization_code");
    assert.equal(tokenBody.get("code_verifier"), verifier);
    assert.equal(tokenBody.get("code"), "the-code");
    const expectBasic =
      "Basic " + Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString("base64");
    assert.equal(tokenAuth, expectBasic);
    // Both cookies were set: the hub session and the OIDC logout-hint sid.
    const setCookie = res.headers["set-cookie"].join("\n");
    assert.match(setCookie, /hub_session=/);
    assert.match(setCookie, /hub_oidc=/);
    assert.match(setCookie, /HttpOnly/);
    // The tx was consumed (single use).
    assert.equal(hub.oidcTx.has(state), false);
  } finally {
    global.fetch = saved;
  }
});

test("GET /auth/oidc/callback rejects an unknown or reused state", async () => {
  hub.__setOidcCaches(DISCOVERY, jwksKeys);
  const res = await get("/auth/oidc/callback?state=never-issued&code=x");
  assert.equal(res.status, 400);
});

test("GET /auth/oidc/callback is bound to the browser (login-CSRF)", async () => {
  // A live tx + valid state in the query, but the browser presents NO matching
  // state cookie — the callback must reject it and issue no session (an attacker
  // delivering their own code+state to a victim).
  hub.__setOidcCaches(DISCOVERY, jwksKeys);
  const state = "state-csrf";
  hub.oidcTx.set(state, { nonce: "the-nonce", verifier: "v-1234567890", next: "/", at: Date.now() });
  let tokenCalled = false;
  const saved = global.fetch;
  global.fetch = async () => { tokenCalled = true; return { ok: true, status: 200, text: async () => "{}" }; };
  try {
    // No cookie at all.
    let res = await get(`/auth/oidc/callback?state=${state}&code=c`);
    assert.equal(res.status, 400);
    // A DIFFERENT state cookie (attacker's own) — still rejected.
    hub.oidcTx.set(state, { nonce: "the-nonce", verifier: "v-1234567890", next: "/", at: Date.now() });
    res = await get(`/auth/oidc/callback?state=${state}&code=c`, { cookie: "hub_oidc_state=someone-else" });
    assert.equal(res.status, 400);
    // The token endpoint was never even contacted.
    assert.equal(tokenCalled, false);
  } finally {
    global.fetch = saved;
  }
});

test("GET /auth/oidc/callback bounces an IdP error to the login page", async () => {
  const res = await get("/auth/oidc/callback?error=access_denied");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/login?error=oidc");
});

test("GET /auth/oidc/logout clears cookies and redirects to the IdP end-session", async () => {
  hub.__setOidcCaches(DISCOVERY, jwksKeys);
  const sid = "sid-1";
  hub.oidcSessions.set(sid, { idToken: "the-id-token", sub: "user-123", at: Date.now() });
  const res = await get("/auth/oidc/logout", { cookie: `hub_oidc=${sid}` });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.location);
  assert.equal(`${loc.origin}${loc.pathname}`, DISCOVERY.end_session_endpoint.replace(/\/$/, "/"));
  assert.equal(loc.searchParams.get("id_token_hint"), "the-id-token");
  assert.equal(loc.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(loc.searchParams.get("post_logout_redirect_uri"), "https://turma.test/login");
  const setCookie = res.headers["set-cookie"].join("\n");
  assert.match(setCookie, /hub_session=; .*Max-Age=0/);
  assert.match(setCookie, /hub_oidc=; .*Max-Age=0/);
  // The server-side session record was dropped.
  assert.equal(hub.oidcSessions.has(sid), false);
});

test("the OIDC routes are reachable WITHOUT a hub login (public gate)", async () => {
  // No Authorization header, no cookie: the login route must not 401/redirect to
  // /login — it starts the OIDC flow instead.
  hub.__setOidcCaches(DISCOVERY, jwksKeys);
  const res = await get("/auth/oidc/login");
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /idp\.test/);
});
