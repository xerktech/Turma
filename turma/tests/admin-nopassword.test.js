"use strict";

// XERK-2552 — the admin panel's no-admin-left guard, on a hub with NO break-glass
// (the bootstrap admin only) and no OIDC. Its own process: env read at require time.

const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, scratchDir } = require("./tmpdirs");

process.env.TURMA_TEST = "1";
delete process.env.TURMA_USER;
delete process.env.TURMA_PASSWORD;
process.env.TURMA_AGENT_TOKEN = "agenttok";
process.env.TURMA_BOOTSTRAP_ADMIN_USER = "soleadmin";
process.env.TURMA_BOOTSTRAP_ADMIN_PASSWORD = "sole-admin-pass";
for (const k of ["TURMA_OIDC_ISSUER", "TURMA_OIDC_CLIENT_ID", "TURMA_OIDC_CLIENT_SECRET", "TURMA_OIDC_REDIRECT_URI"]) delete process.env[k];
const tmp = (name) => path.join(scratchDir(), `turma-adminnp-${name}-${process.pid}.json`);
for (const [k, n] of [["STATE_FILE", "state"], ["DEVICES_FILE", "devices"], ["AGENT_IDENTITIES_FILE", "ids"],
  ["TENANCY_FILE", "tenancy"], ["USAGE_LEDGER_FILE", "usage"], ["ENROLL_CODES_FILE", "codes"],
  ["ADMIN_AUDIT_FILE", "audit"], ["NAME_TOKEN_GENS_FILE", "gens"]]) process.env[k] = tmp(n);
process.env.MIGRATE_SPOOL_DIR = mkdtemp("turma-adminnp-mig-");
process.env.ARCHIVE_DIR = mkdtemp("turma-adminnp-archive-");
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
function request(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(baseUrl + p, { method,
      headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } },
    (res) => { let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => resolve({ status: res.statusCode, raw })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

test("XERK-2552 QA: with no break-glass, a change leaving no usable admin is refused; an SSO admin does not count while OIDC is off", async () => {
  const m = /hub_session=([^;]+)/.exec((await new Promise((res) => {
    const d = JSON.stringify({ username: "soleadmin", password: "sole-admin-pass" });
    const r = http.request(baseUrl + "/api/login", { method: "POST", headers: { "content-type": "application/json", "content-length": d.length } },
      (x) => { x.resume(); x.on("end", () => res(x.headers["set-cookie"] || [])); });
    r.end(d);
  })).join("\n"));
  assert.ok(m, "the bootstrap admin signs in");
  const h = { cookie: `hub_session=${m[1]}` };
  // An SSO user whose last login granted admin — unusable with OIDC off.
  const { state } = tenancy.upsertOidcUser(hub.tenancyState(), { iss: "https://idp/", sub: "a1", displayName: "Sso Admin", idpRoles: ["admin"] });
  hub.__setTenancy(state);
  const demote = await request("PUT", "/api/admin/groups", { headers: h, body: { groups: { "turma-users": "user", "turma-admins": "user" } } });
  assert.equal(demote.status, 409, demote.raw);
  assert.match(demote.raw, /no administrator/);
  // The pure guard: the SSO admin counts once OIDC is on.
  const next = tenancy.setGroupMap(hub.tenancyState(), { "turma-users": "user" });
  assert.equal(hub.adminWayInRemains(next, false, false), false);
  assert.equal(hub.adminWayInRemains(next, false, true), true);
  assert.equal(hub.adminWayInRemains(next, true, false), true, "break-glass is always a way in");
  // With a second local admin, demoting the first is fine.
  const c = await request("POST", "/api/admin/users", { headers: h, body: { username: "second", password: "second-pass-1", groups: ["turma-admins"] } });
  assert.equal(c.status, 200, c.raw);
  const sole = Object.values(hub.tenancyState().users).find((u) => u.username === "soleadmin");
  assert.equal((await request("PATCH", `/api/admin/users/${sole.id}`, { headers: h, body: { groups: ["turma-users"] } })).status, 200);
});
