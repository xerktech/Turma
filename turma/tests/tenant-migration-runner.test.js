// XERK-2554 — the pure migration runner (turma/tenant-migration.js) and the owner
// resolution (turma/tenancy.js ensureOwner): dry run, resume after a failed step,
// a changed owner refused, and the owner spec forms.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runMigration, coerceMarker } = require("../tenant-migration.js");
const tenancy = require("../tenancy.js");

const T = "c".repeat(32);
const quiet = () => {};
function store() {
  const moved = { a: 0, b: 0 };
  let failB = false;
  const pending = { a: 2, b: 3 };
  const steps = ["a", "b"].map((name) => ({
    name,
    count: () => pending[name],
    apply: () => {
      if (name === "b" && failB) throw new Error("boom");
      const n = pending[name];
      pending[name] = 0;
      moved[name] += n;
      return n;
    },
  }));
  return { steps, moved, setFail: (v) => { failB = v; } };
}

test("XERK-2554: a dry run counts every store and moves nothing", async () => {
  const s = store();
  const lines = [];
  const r = await runMigration({ steps: s.steps, marker: {}, tenantId: T, dryRun: true,
    save: () => assert.fail("a dry run saves nothing"), log: (l) => lines.push(l) });
  assert.equal(r.state, "dry-run");
  assert.deepEqual(r.counts, { a: 2, b: 3 });
  assert.deepEqual(s.moved, { a: 0, b: 0 });
  assert.match(lines.join("\n"), /dry run.*a=2 b=3/);
});

test("XERK-2554: a failed step leaves the marker incomplete; the rerun resumes at it", async () => {
  const s = store();
  let saved = {};
  const save = (m) => { saved = m; };
  s.setFail(true);
  const r1 = await runMigration({ steps: s.steps, marker: saved, tenantId: T, save, log: quiet,
    snapshot: () => ({ hosts: ["h1"], sites: ["acme"] }) });
  assert.equal(r1.state, "failed");
  assert.match(r1.error, /step b failed: boom/);
  assert.ok(saved.steps.a && !saved.steps.b && !saved.completedAt);
  assert.deepEqual(saved.hosts, ["h1"]);
  s.setFail(false);
  const r2 = await runMigration({ steps: s.steps, marker: saved, tenantId: T, save, log: quiet,
    snapshot: () => assert.fail("the resumed run keeps the first snapshot") });
  assert.equal(r2.state, "done");
  assert.deepEqual(s.moved, { a: 2, b: 3 });
  assert.ok(saved.completedAt);
  assert.equal(saved.steps.b.moved, 3);
  // Done is done: nothing runs again.
  assert.equal((await runMigration({ steps: s.steps, marker: saved, tenantId: T, save, log: quiet })).state, "already-done");
});

test("XERK-2554: a marker for another tenant is refused, never re-migrated", async () => {
  const s = store();
  const r = await runMigration({ steps: s.steps, marker: { tenantId: "d".repeat(32), startedAt: 1, steps: {} },
    tenantId: T, save: () => assert.fail("nothing saved"), log: quiet });
  assert.equal(r.state, "refused");
  assert.match(r.error, /pre-migration \/data snapshot/);
  assert.deepEqual(s.moved, { a: 0, b: 0 });
});

test("XERK-2554: coerceMarker is a whitelist and a fixed point", () => {
  const m = coerceMarker({ tenantId: T, owner: "e".repeat(32), startedAt: 5, steps: { a: { moved: 2, at: 6 }, "bad name!": {} },
    hosts: ["h1", "h1", 7], sites: ["acme"], completedAt: 9, extra: 1 });
  assert.deepEqual(Object.keys(m.steps), ["a"]);
  assert.deepEqual(m.hosts, ["h1"]);
  assert.ok(!("extra" in m));
  assert.deepEqual(coerceMarker(JSON.parse(JSON.stringify(m))), m);
  assert.deepEqual(coerceMarker({ tenantId: "nope" }), {});
});

test("XERK-2554: the owner spec finds a local user or an OIDC subject, and creates only when told how", () => {
  let st = tenancy.coerceTenancy({});
  st = tenancy.createLocalUser(st, { username: "alice", passwordHash: tenancy.hashPasswordSync("alice-pass-1"), groups: ["turma-users"] }).state;
  st = tenancy.upsertOidcUser(st, { iss: "https://idp/", sub: "sub-123", idpRoles: ["user"] }).state;
  assert.equal(tenancy.findOwner(st, "alice").username, "alice");
  assert.equal(tenancy.findOwner(st, "local:ALICE").username, "alice");
  assert.equal(tenancy.findOwner(st, "sub-123").oidcSub, "sub-123");
  assert.equal(tenancy.findOwner(st, "oidc:sub-123").oidcSub, "sub-123");
  assert.equal(tenancy.findOwner(st, "local:sub-123"), null);
  // A bare unknown name is a typo, never a new account.
  assert.throws(() => tenancy.ensureOwner(st, "nobody"), /prefix it with local: or oidc:/);
  const r = tenancy.ensureOwner(st, "local:bob");
  assert.equal(r.created, true);
  assert.equal(r.user.username, "bob");
  assert.ok(tenancy.effectiveRoles(r.state, r.user).includes("user"));
  assert.equal(tenancy.ensureOwner(r.state, "local:bob").created, false);
  assert.throws(() => tenancy.ensureOwner(st, "oidc:new-sub"), /needs OIDC configured/);
  const o = tenancy.ensureOwner(st, "oidc:new-sub", { iss: "https://idp/" });
  assert.equal(o.user.oidcIss, "https://idp/");
  assert.equal(o.user.oidcSub, "new-sub");
});

test("XERK-2554: an OIDC subject under two issuers is never re-upserted, and a bare one is refused", () => {
  let st = tenancy.coerceTenancy({});
  st = tenancy.upsertOidcUser(st, { iss: "https://a/", sub: "s1", idpRoles: ["user", "admin"] }).state;
  st = tenancy.upsertOidcUser(st, { iss: "https://b/", sub: "s1", idpRoles: ["user"] }).state;
  assert.throws(() => tenancy.ensureOwner(st, "s1"), /more than one OIDC user/);
  const r = tenancy.ensureOwner(st, "oidc:s1", { iss: "https://a/" });
  assert.equal(r.created, false);
  assert.deepEqual(r.user.idpRoles, ["user", "admin"], "its roles are untouched");
  assert.equal(r.state, st);
});
