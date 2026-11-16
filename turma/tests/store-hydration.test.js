// A replica must not serve, or write a shared store, before it has read it (XERK-2995).
//
// Under HA each replica's /data is an emptyDir, so every externalized store's mirror
// is empty until wireExternalStores' GET returns the shared value. `persist()` writes
// the WHOLE mirror, so a write in that window replaced the shared value with almost
// nothing — an admin user create deleted every existing user. Drives the real routes
// against a FileLiveStore standing in as the shared store, with the tenancy GET held.
//
// Its own process (env is read at require time), node:test, no npm.

"use strict";

const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, scratchDir } = require("./tmpdirs");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "glass";
process.env.TURMA_PASSWORD = "glass-pass";
process.env.TURMA_AGENT_TOKEN = "agenttok";
const tmp = (name) => path.join(scratchDir(), `turma-hydrate-${name}-${process.pid}.json`);
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
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-hydrate-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-hydrate-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const tenancy = require("../tenancy.js");
const { FileLiveStore } = require("../store.js");
const hub = require("../server.js");
const { server } = hub;
const X = hub.__externalStores;

let baseUrl;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  hub.__setLiveStore(new FileLiveStore({ persistent: X.persistentConfig() }), false);
  server.close();
});

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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const BASIC = { authorization: "Basic " + Buffer.from("glass:glass-pass").toString("base64") };
const usernames = (v) => Object.values((v && v.users) || {}).map((u) => u.username).sort();
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// The shared store, holding alice, whose tenancy GET waits until `release()`.
async function heldStore() {
  const inner = new FileLiveStore({ persistent: {} });
  const seeded = tenancy.createLocalUser(tenancy.coerceTenancy({}), {
    username: "alice", passwordHash: await tenancy.hashPassword("alice-password"), groups: ["turma-users"],
  }).state;
  await inner.set("policy:tenancy", seeded);
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = Object.create(inner);
  store.get = (key) => (key === "policy:tenancy" ? gate.then(() => inner.get(key)) : inner.get(key));
  return { store, inner, release };
}

test("XERK-2995: before the shared stores load, a replica is unready and writes nothing", async () => {
  const { store, inner, release } = await heldStore();
  hub.__setLiveStore(store, true);
  X.wireExternalStores(store);
  await tick();

  const ready = await request("GET", "/readyz");
  assert.equal(ready.status, 503, "not ready while a store is unread");
  assert.ok(ready.body.loading.includes("tenancy"), "names the store it waits on");
  assert.equal((await request("GET", "/healthz")).status, 200, "liveness is unaffected");

  const create = await request("POST", "/api/admin/users",
    { headers: BASIC, body: { username: "carol", password: "carol-password-1" } });
  assert.equal(create.status, 503, "a write in the window is refused, not answered 200");
  assert.ok(create.headers["retry-after"], "with a Retry-After");
  assert.deepEqual(usernames(await inner.get("policy:tenancy")), ["alice"], "the shared users survive");

  release();
  await tick(80);
  assert.equal((await request("GET", "/readyz")).status, 200, "ready once every store loaded");
  assert.deepEqual(usernames(hub.tenancyState()), ["alice"], "the mirror adopted the shared users");

  const again = await request("POST", "/api/admin/users",
    { headers: BASIC, body: { username: "carol", password: "carol-password-1" } });
  assert.equal(again.status, 200);
  await tick();
  assert.deepEqual(usernames(await inner.get("policy:tenancy")), ["alice", "carol"], "the write adds, never replaces");
});

test("XERK-2995: a persist from inside the process (a sweep) never writes an unloaded store", async () => {
  const { store, inner, release } = await heldStore();
  hub.__setLiveStore(store, true);
  X.wireExternalStores(store);
  await tick();
  // Not via a route: the in-process setter a sweep or login would call.
  hub.setTenancy({});
  await tick();
  assert.deepEqual(usernames(await inner.get("policy:tenancy")), ["alice"], "the empty mirror was not written");
  release();
  await tick(80);
  assert.deepEqual(usernames(hub.tenancyState()), ["alice"], "the shared value wins once read");
});

test("XERK-2995: a load that fails is retried, and the replica stays unready meanwhile", async () => {
  const inner = new FileLiveStore({ persistent: {} });
  await inner.set("policy:tenancy", tenancy.coerceTenancy({}));
  let fails = 1;
  const store = Object.create(inner);
  store.get = (key) => (key === "policy:tenancy" && fails-- > 0
    ? Promise.reject(new Error("store blip")) : inner.get(key));
  hub.__setStoreLoadRetryMs(20);
  hub.__setLiveStore(store, true);
  X.wireExternalStores(store);
  await tick(5);
  assert.equal((await request("GET", "/readyz")).status, 503);
  await tick(120);
  assert.equal((await request("GET", "/readyz")).status, 200, "the retry loaded it");
});

test("XERK-2995: with HA off nothing is gated", async () => {
  const { store, release } = await heldStore();
  hub.__setLiveStore(store, false);
  X.wireExternalStores(store);
  await tick();
  assert.equal((await request("GET", "/readyz")).status, 200);
  release();
  await tick(50);
});

// A raw upgrade: the first line the hub writes back.
function upgradeStatus(pathName) {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const { port } = server.address();
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`GET ${pathName} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\n` +
        "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    });
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    sock.on("close", () => resolve(buf.split("\r\n")[0]));
    sock.on("error", reject);
  });
}

test("XERK-2995: an upgrade is refused while loading, and handled again after", async () => {
  const { store, release } = await heldStore();
  hub.__setLiveStore(store, true);
  X.wireExternalStores(store);
  await tick();
  assert.equal(hub.externalStoresPending(), true);
  assert.match(await upgradeStatus("/agent/control?name=h1&token=bad"), / 503 /);
  release();
  await tick(80);
  assert.equal(hub.externalStoresPending(), false);
  assert.doesNotMatch(await upgradeStatus("/agent/control?name=h1&token=bad"), / 503 /);
});

test("XERK-2995: a watch value clears the wait, and the older GET reply never rolls it back", async () => {
  const { store, inner, release } = await heldStore();
  // The GET is issued before the other replica's write, so it answers the OLD value.
  const old = await inner.get("policy:tenancy");
  let releaseOld;
  const oldReply = new Promise((r) => { releaseOld = r; });
  store.get = (key) => (key === "policy:tenancy" ? oldReply.then(() => old) : inner.get(key));
  hub.__setLiveStore(store, true);
  X.wireExternalStores(store);
  await tick();
  // Another replica writes while this one's GET is still in flight.
  const newer = tenancy.createLocalUser(tenancy.coerceTenancy(old), {
    username: "gina", passwordHash: await tenancy.hashPassword("gina-password"), groups: ["turma-users"],
  }).state;
  await inner.set("policy:tenancy", newer);
  await tick();
  assert.deepEqual(usernames(hub.tenancyState()), ["alice", "gina"], "the watch installed the newer value");
  assert.equal(hub.externalStoresPending(), false, "and cleared the wait");
  release();
  releaseOld();
  await tick(80);
  assert.deepEqual(usernames(hub.tenancyState()), ["alice", "gina"], "the late reply did not roll it back");
});

test("XERK-2995: a stored value that does not parse does not hold the replica unready", async () => {
  const inner = new FileLiveStore({ persistent: {} });
  const store = Object.create(inner);
  store.get = (key) => (key === "policy:orgColors"
    ? Promise.reject(new SyntaxError("Unexpected token")) : inner.get(key));
  hub.__setStoreLoadRetryMs(20);
  hub.__setLiveStore(store, true);
  X.wireExternalStores(store);
  await tick(80);
  assert.equal(hub.externalStoresPending(), false);
  assert.equal((await request("GET", "/readyz")).status, 200);
});

test("XERK-2995: the leader's sweeps and the lease both wait for the load (source pin)", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const tickBody = src.slice(src.indexOf("function masterOrchestrationTick()"));
  assert.match(tickBody.slice(0, 600), /if \(externalStoresPending\(\)\) return;/);
  assert.match(src, /canLead: \(\) => \([^\n]*\) && !externalStoresPending\(\)/);
});
