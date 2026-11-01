"use strict";

// XERK-2552 QA — an OPEN hub (no login configured) makes every caller an admin;
// the admin panel must never let an anonymous caller create an account (which
// would close the hub and hand it to them). Own process: no credentials in env.

const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, scratchDir } = require("./tmpdirs");

process.env.TURMA_TEST = "1";
for (const k of ["TURMA_USER", "TURMA_PASSWORD", "TURMA_BOOTSTRAP_ADMIN_USER", "TURMA_BOOTSTRAP_ADMIN_PASSWORD"]) delete process.env[k];
process.env.TURMA_AGENT_TOKEN = "agenttok";
const tmp = (name) => path.join(scratchDir(), `turma-adminopen-${name}-${process.pid}.json`);
for (const [k, n] of [["STATE_FILE", "state"], ["DEVICES_FILE", "devices"], ["AGENT_IDENTITIES_FILE", "ids"],
  ["TENANCY_FILE", "tenancy"], ["USAGE_LEDGER_FILE", "usage"], ["ENROLL_CODES_FILE", "codes"],
  ["ADMIN_AUDIT_FILE", "audit"], ["NAME_TOKEN_GENS_FILE", "gens"]]) process.env[k] = tmp(n);
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-adminopen-mig-");
process.env.ARCHIVE_DIR = mkdtemp("turma-adminopen-archive-");
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const { server } = hub;
let baseUrl;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(baseUrl + p, { method,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
    (res) => { let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => resolve({ status: res.statusCode, raw })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

test("XERK-2552 QA: an anonymous caller on an open hub cannot create a user or change the group map", async () => {
  assert.equal((await request("GET", "/api/agents")).status, 200, "the hub is open");
  const c = await request("POST", "/api/admin/users", { username: "mallory", password: "mallory-pass", groups: ["turma-admins"] });
  assert.equal(c.status, 409, c.raw);
  assert.equal((await request("PUT", "/api/admin/groups", { groups: { "turma-users": "admin" } })).status, 409);
  assert.equal(Object.keys(hub.tenancyState().users).length, 0);
  assert.equal((await request("GET", "/api/agents")).status, 200, "still open");
});
