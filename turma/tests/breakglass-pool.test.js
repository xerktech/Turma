"use strict";

// XERK-2587 — break-glass guesses keyed on CF-Connecting-IP alone share one hub-wide pool.
//
// Its own process: TURMA_TRUSTED_PROXIES and the break-glass env are read at require time.
// 127.0.0.1 stands in for the trusted proxies, so a request carrying X-Forwarded-For 127.0.0.1
// is keyed on its CF-Connecting-IP alone (the in-cluster rotation this ticket closes), while
// X-Forwarded-For 192.0.2.x is a LAN caller keyed on the ingress's view.
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
process.env.TURMA_TRUSTED_PROXIES = "127.0.0.1/32";

const tmp = (name) => path.join(scratchDir(), `turma-bgpool-${name}-${process.pid}.json`);
for (const [k, n] of [
  ["STATE_FILE", "state"], ["DEVICES_FILE", "devices"], ["TICKET_AGENTS_FILE", "ticket-agents"],
  ["AGENT_IDENTITIES_FILE", "agent-identities"], ["TENANCY_FILE", "tenancy"],
  ["AUTOSTART_ORGS_FILE", "autostart-orgs"], ["TICKET_MODELS_FILE", "ticket-models"],
  ["TICKET_RUNTIMES_FILE", "ticket-runtimes"], ["ORG_COLORS_FILE", "org-colors"],
  ["TRIAGE_POLICIES_FILE", "triage-policies"], ["TRIAGE_ACTIONS_FILE", "triage-actions"],
  ["USAGE_LEDGER_FILE", "usage-ledger"],
]) process.env[k] = tmp(n);
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-bgpool-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-bgpool-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const { server } = hub;

let baseUrl;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => hub.__resetBreakGlassPool());

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

let n = 0;
const freshCf = () => `203.0.113.${(n++ % 250) + 1}`; // a new forged CF-Connecting-IP per request
const via = (xff, cf) => ({ "x-forwarded-for": xff, "cf-connecting-ip": cf });
const glass = (headers, password) => request("POST", "/api/login", { headers, body: { username: "glass", password } });
const basic = (headers, password) => request("GET", "/api/agents", { headers: {
  ...headers, authorization: `Basic ${Buffer.from(`glass:${password}`).toString("base64")}`,
} });

// Drains the pool the way the attack does: every guess from a fresh, trusted-path key.
async function drain() {
  for (let i = 0; i < 20; i++) assert.equal((await basic(via("127.0.0.1", freshCf()), "guess")).status, 401, `miss ${i}`);
}

test("XERK-2587: only a key that is CF-Connecting-IP alone draws on the pool", () => {
  const req = (xff, remoteAddress = "127.0.0.1") => ({ headers: via(xff, "203.0.113.9"), socket: { remoteAddress } });
  assert.equal(hub.loginKeyFromCf(req("127.0.0.1")), true);
  assert.equal(hub.loginClientKey(req("127.0.0.1")), "203.0.113.9");
  assert.equal(hub.loginKeyFromCf(req("192.0.2.5")), false, "LAN: the ingress's view is unforgeable");
  assert.equal(hub.loginKeyFromCf(req("127.0.0.1", "10.9.9.9")), false, "untrusted socket");
  assert.equal(hub.loginKeyFromCf({ headers: { "x-forwarded-for": "127.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } }), false);
});

test("XERK-2587: rotating CF-Connecting-IP stops getting evaluated once the pool is spent", async () => {
  await drain();
  // The right password from yet another fresh key is no longer compared: a plain 401 (the form
  // falls through to the local check), never 429, so the pool reveals nothing about the name.
  assert.equal((await basic(via("127.0.0.1", freshCf()), "glass-pass")).status, 401);
  const form = await glass(via("127.0.0.1", freshCf()), "glass-pass");
  assert.equal(form.status, 401);
  assert.equal(form.headers["retry-after"], undefined);
});

test("XERK-2587: a spent pool never locks out a caller with an unforgeable key", async () => {
  await drain();
  assert.equal((await basic(via("192.0.2.5", freshCf()), "glass-pass")).status, 200, "Basic over the LAN");
  assert.equal((await glass(via("192.0.2.6", freshCf()), "glass-pass")).status, 200, "form over the LAN");
  // LAN misses keep their own per-client backoff and never touch the pool.
  for (let i = 0; i < 5; i++) assert.equal((await basic(via("192.0.2.7", freshCf()), "guess")).status, 401);
  hub.__resetBreakGlassPool();
  for (let i = 0; i < 5; i++) assert.equal((await basic(via("192.0.2.8", freshCf()), "guess")).status, 401);
  assert.equal((await basic(via("127.0.0.1", freshCf()), "glass-pass")).status, 200, "the pool is still full");
});

test("XERK-2587: the pool refills, a success costs nothing, and only misses drain it", () => {
  const t0 = Date.now();
  // Successes from fresh keys at any rate leave the pool untouched (a polling script).
  for (let i = 0; i < 50; i++) assert.equal(hub.breakGlassAttempt(`ok${i}`, "glass", "glass-pass", t0, true), true);
  for (let i = 0; i < 20; i++) assert.equal(hub.breakGlassAttempt(`k${i}`, "glass", "guess", t0, true), false, `miss ${i}`);
  assert.equal(hub.breakGlassAttempt("k-next", "glass", "glass-pass", t0, true), null, "spent: not evaluated");
  assert.equal(hub.breakGlassAttempt("k-next", "glass", "glass-pass", t0 + 1999, true), null);
  assert.equal(hub.breakGlassAttempt("k-next", "glass", "glass-pass", t0 + 2000, true), true, "one refill, one check");
  assert.equal(hub.breakGlassAttempt("k-lan", "glass", "glass-pass", t0 + 2000, false), true, "off-pool keys never wait");
});
