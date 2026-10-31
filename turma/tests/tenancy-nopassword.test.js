"use strict";

// XERK-2530 — a hub whose ONLY credential is a local account (bootstrap admin,
// no TURMA_PASSWORD, no TURMA_SESSION_SECRET). Its own process: those env vars
// are read at require time. Guards the passwordless path tenancy.test.js (which
// always sets a break-glass password) cannot see. Test fixtures, not secrets.

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, scratchDir } = require("./tmpdirs");

process.env.TURMA_TEST = "1";
delete process.env.TURMA_USER;
delete process.env.TURMA_PASSWORD;
delete process.env.TURMA_SESSION_SECRET;
process.env.TURMA_AGENT_TOKEN = "agenttok";
process.env.TURMA_BOOTSTRAP_ADMIN_USER = "rootadmin";
process.env.TURMA_BOOTSTRAP_ADMIN_PASSWORD = "root-admin-pass";

const tmp = (name) => path.join(scratchDir(), `turma-tenancy-nopw-${name}-${process.pid}.json`);
for (const [k, n] of [
  ["STATE_FILE", "state"], ["DEVICES_FILE", "devices"], ["TICKET_AGENTS_FILE", "ticket-agents"],
  ["AGENT_IDENTITIES_FILE", "agent-identities"], ["TENANCY_FILE", "tenancy"],
  ["AUTOSTART_ORGS_FILE", "autostart-orgs"], ["TICKET_MODELS_FILE", "ticket-models"],
  ["TICKET_RUNTIMES_FILE", "ticket-runtimes"], ["ORG_COLORS_FILE", "org-colors"],
  ["TRIAGE_POLICIES_FILE", "triage-policies"], ["TRIAGE_ACTIONS_FILE", "triage-actions"],
  ["USAGE_LEDGER_FILE", "usage-ledger"],
]) process.env[k] = tmp(n);
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-tenancy-nopw-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-tenancy-nopw-archive-");
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
const principalOfToken = (token) => hub.requestPrincipal({ headers: { cookie: `hub_session=${token}` } });

// The pre-tenancy default signing key: a hash of a PUBLIC string when neither
// TURMA_PASSWORD nor TURMA_SESSION_SECRET is set. Anyone can compute it.
const PUBLIC_KEY = crypto.createHash("sha256").update("\n").digest("hex");
function forge(claims) {
  const exp = Date.now() + 60000;
  const body = `u2.${exp}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${crypto.createHmac("sha256", PUBLIC_KEY).update(body).digest("base64url")}`;
}
function forgeLegacy() {
  const exp = String(Date.now() + 60000);
  return `${exp}.${crypto.createHmac("sha256", PUBLIC_KEY).update(exp).digest("base64url")}`;
}

test("XERK-2530: a hub whose only credential is the bootstrap admin requires a login", async () => {
  assert.equal(hub.authEnabled(), true);
  assert.equal(hub.breakGlassEnabled(), false);
  assert.equal((await request("GET", "/api/agents")).status, 401);
  const ok = await login("rootadmin", "root-admin-pass");
  assert.equal(ok.status, 200);
  const token = (ok.headers["set-cookie"] || []).join("").match(/hub_session=([^;]+)/)[1];
  const p = principalOfToken(token);
  assert.equal(p.kind, "user");
  assert.deepEqual([...p.roles], ["user", "admin"]);
});

test("XERK-2530: sessions cannot be forged with the public default key", () => {
  const admin = tenancy.findLocalUser(hub.tenancyState(), "rootadmin");
  assert.equal(principalOfToken(forge({ u: admin.id, t: admin.tenantId, r: ["admin"] })), null);
  assert.equal(principalOfToken(forge({ bg: 1, r: ["admin"] })), null);
  assert.equal(principalOfToken(forgeLegacy()), null);
});

test("XERK-2530: with no break-glass password, no Basic credential is break-glass", () => {
  for (const pair of [":", "x:", ":y", "rootadmin:root-admin-pass"]) {
    const authorization = "Basic " + Buffer.from(pair).toString("base64");
    assert.equal(hub.requestPrincipal({ headers: { authorization } }), null, pair);
  }
  // Nor does an empty /api/login pair (the empty TURMA_USER/TURMA_PASSWORD compare equal).
  return login("", "").then((r) => assert.equal(r.status, 401));
});

test("XERK-2530: an unknown username still pays the scrypt verify, against the dummy hash", async () => {
  const seen = [];
  const real = tenancy.verifyPassword;
  tenancy.verifyPassword = async (pw, hash) => { seen.push(hash); return real(pw, hash); };
  try {
    assert.equal((await login("nobody-here", "whatever-pass")).status, 401);
  } finally {
    tenancy.verifyPassword = real;
  }
  assert.deepEqual(seen, [tenancy.dummyPasswordHash()]);
});

test("XERK-2530: a user disabled while its password is being checked is not signed in", async () => {
  const admin = tenancy.findLocalUser(hub.tenancyState(), "rootadmin");
  const real = tenancy.verifyPassword;
  tenancy.verifyPassword = async (pw, hash) => {
    const ok = await real(pw, hash);
    hub.__setTenancy(tenancy.updateUser(hub.tenancyState(), admin.id, { disabled: true }).state);
    return ok;
  };
  try {
    assert.equal((await login("rootadmin", "root-admin-pass")).status, 401);
  } finally {
    tenancy.verifyPassword = real;
    hub.__setTenancy(tenancy.updateUser(hub.tenancyState(), admin.id, { disabled: false }).state);
  }
  assert.equal((await login("rootadmin", "root-admin-pass")).status, 200);
});

// ---- XERK-2568: fair local sign-in under an anonymous flood ------------------

const loginAs = (client, username, password) =>
  request("POST", "/api/login", { headers: { "cf-connecting-ip": client }, body: { username, password } });

test("XERK-2568: the sign-in client is CF-Connecting-IP, else the last X-Forwarded-For hop, else the socket", () => {
  const key = (headers, remoteAddress = "10.0.0.9") => hub.loginClientKey({ headers, socket: { remoteAddress } });
  assert.equal(key({ "cf-connecting-ip": " 203.0.113.7 ", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), "203.0.113.7");
  assert.equal(key({ "x-forwarded-for": "6.6.6.6, 198.51.100.4" }), "198.51.100.4", "a client-sent first hop is ignored");
  assert.equal(key({}), "10.0.0.9");
  assert.equal(key({ "cf-connecting-ip": "x".repeat(500) }).length, 64, "bounded");
});

test("XERK-2568: a flood from one client neither locks out another nor exceeds the scrypt cap", async () => {
  const real = tenancy.verifyPassword;
  let inflight = 0;
  let peak = 0;
  tenancy.verifyPassword = async (pw, hash) => {
    peak = Math.max(peak, ++inflight);
    try { return await real(pw, hash); } finally { inflight--; }
  };
  let flooding = true;
  const attackerCodes = [];
  // Four concurrent loops of wrong passwords, a fresh username each time so the
  // per-username backoff never quiets the attacker: only the queue protects the victim.
  const attacker = Array.from({ length: 4 }, async () => {
    while (flooding) attackerCodes.push((await loginAs("198.51.100.66", `ghost-${crypto.randomUUID()}`, "nope")).status);
  });
  try {
    await new Promise((r) => setTimeout(r, 150)); // let the flood saturate
    for (let i = 0; i < 5; i++) {
      const victim = await loginAs("203.0.113.10", "rootadmin", "root-admin-pass");
      assert.equal(victim.status, 200, `victim attempt ${i}`);
    }
  } finally {
    flooding = false;
    await Promise.all(attacker);
    tenancy.verifyPassword = real;
  }
  assert.ok(peak <= 2, `peak concurrent scrypt ${peak}`);
  assert.ok(attackerCodes.includes(503), "the attacker's extra in-flight requests are refused");
});

test("XERK-2568: repeated failures back off per client and username, answered before scrypt", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await loginAs("192.0.2.50", "rootadmin", "wrong")).status, 401);
  const real = tenancy.verifyPassword;
  let calls = 0;
  tenancy.verifyPassword = async (...a) => { calls++; return real(...a); };
  try {
    const held = await loginAs("192.0.2.50", "rootadmin", "root-admin-pass");
    assert.equal(held.status, 429);
    assert.ok(Number(held.headers["retry-after"]) >= 1, held.headers["retry-after"]);
    assert.equal(calls, 0, "a backed-off attempt costs no scrypt");
    // The same username from another client is not locked out.
    assert.equal((await loginAs("192.0.2.51", "rootadmin", "root-admin-pass")).status, 200);
  } finally {
    tenancy.verifyPassword = real;
  }
});

test("XERK-2568: a client's second concurrent sign-in is refused, not queued", async () => {
  const both = await Promise.all([1, 2].map(() => loginAs("192.0.2.77", "rootadmin", "root-admin-pass")));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 503]);
});
