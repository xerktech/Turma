// XERK-1092: a DRAIN that stops making progress gives its slot back. An
// over-cap body keeps reading after its refusal so the 413 is readable, holding
// one of DRAIN_CONCURRENCY_MAX slots; a client that sends just past the cap and
// then stalls used to hold that slot until Node's requestTimeout (300s). With
// every slot pinned, each other over-cap refusal fell back to answer-and-close,
// which a write-before-read client (python urllib, the agent) sees as a reset,
// not a 413 — XERK-235's offline loop. Own process: the idle window is pinned
// short at require time. node:test, no npm.

"use strict";

const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const { mkdtemp } = require("./tmpdirs");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
// Wide enough that all 8 drains pin before the first one times out.
process.env.BODY_IDLE_TIMEOUT_MS = "1000";
const tmp = (name) => path.join(os.tmpdir(), `turma-drain-idle-${name}-${process.pid}.json`);
process.env.STATE_FILE = tmp("state");
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.ORG_COLORS_FILE = tmp("org-colors");
process.env.USAGE_LEDGER_FILE = tmp("usage-ledger");
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-drain-idle-migrations-");
process.env.ARCHIVE_DIR = mkdtemp("turma-drain-idle-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const { server, DRAIN_CONCURRENCY_MAX, BODY_IDLE_TIMEOUT_MS } = hub;
const BODY_MAX = 1 << 20; // /api/login reads with readBody's default cap

let port;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
test.after(() => { server.closeAllConnections(); server.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}

// A raw POST that declares 2x the cap, sends just past it, then goes quiet
// without closing. Resolves with whatever the hub wrote back once it closes.
function stalledOverCap() {
  const sock = net.connect(port, "127.0.0.1");
  let got = "";
  const closed = new Promise((r) => sock.on("close", () => r(got)));
  sock.on("data", (c) => (got += c));
  sock.on("error", () => {});
  sock.write(`POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${2 * BODY_MAX}\r\n\r\n`);
  sock.write("x".repeat(BODY_MAX + (64 << 10)));
  return { sock, closed };
}

// Write-before-read, like urllib: the whole body goes out before the response
// is read, so an answer-and-close reaches it as a reset instead of the 413.
function overCapLogin() {
  return new Promise((resolve) => {
    const body = "y".repeat(BODY_MAX + (256 << 10));
    const req = http.request({ port, host: "127.0.0.1", path: "/api/login", method: "POST",
      headers: { "content-type": "application/json", "content-length": body.length } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", (e) => resolve(e.code));
    req.end(body);
  });
}

test("XERK-1092: stalled drains release their slots after the idle window", async (t) => {
  assert.equal(hub.drainingNow, 0, "starts clean");
  const stalled = Array.from({ length: DRAIN_CONCURRENCY_MAX }, stalledOverCap);
  t.after(() => stalled.forEach((s) => s.sock.destroy()));
  assert.ok(await until(() => hub.drainingNow === DRAIN_CONCURRENCY_MAX, 5000),
    `expected every slot pinned, drainingNow=${hub.drainingNow}`);
  // Well past one idle window, the stalled drains must have given the slots back.
  assert.ok(await until(() => hub.drainingNow === 0, BODY_IDLE_TIMEOUT_MS * 10),
    `stalled drains still hold ${hub.drainingNow} slots`);
  // Each stalled client is answered its 413 and closed, not left hanging.
  const replies = await Promise.all(stalled.map((s) => s.closed));
  for (const r of replies) assert.match(r, /^HTTP\/1\.1 413 /, `stalled client got: ${r.slice(0, 40)}`);
  // And the next honest over-cap body drains to a readable 413.
  assert.equal(await overCapLogin(), 413);
  assert.ok(await until(() => hub.drainingNow === 0, 2000), `drainingNow=${hub.drainingNow}`);
});

test("XERK-1092: a drain that keeps making progress is not cut", async () => {
  const sock = net.connect(port, "127.0.0.1");
  let got = "";
  const closed = new Promise((r) => sock.on("close", () => r(got)));
  sock.on("data", (c) => (got += c));
  sock.on("error", () => {});
  const total = BODY_MAX + (1 << 20);
  sock.write(`POST /api/login HTTP/1.1\r\nHost: x\r\nConnection: close\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${total}\r\n\r\n`);
  sock.write("x".repeat(BODY_MAX + 1024));
  // Trickle the rest in 128 KiB steps, each well inside the idle window.
  let sent = BODY_MAX + 1024;
  while (sent < total) {
    await sleep(BODY_IDLE_TIMEOUT_MS / 3);
    const n = Math.min(128 << 10, total - sent);
    sock.write("x".repeat(n)); sent += n;
    assert.equal(got, "", "answered before the body finished — the drain was cut");
  }
  const reply = await closed;
  assert.match(reply, /^HTTP\/1\.1 413 /);
  assert.ok(await until(() => hub.drainingNow === 0, 2000));
});
