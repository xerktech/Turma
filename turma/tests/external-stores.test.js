// Externalized operator/org policy stores (XERK-757, epic XERK-751).
//
// These low-churn stores moved off "/data file in one process" onto the LiveStore
// adapter so a toggle set on ONE replica is visible on EVERY replica. The full
// cross-replica behaviour over a live Valkey is host-QA (no Valkey in CI), so this
// drives the BACKEND-AGNOSTIC mechanism against a real FileLiveStore — the non-HA
// path verbatim — plus a two-mirror simulation of a shared backend's watch
// fan-out (one FileLiveStore, two watchers = two replicas sharing one backend).
//
// Its own process (env is read at require time), node:test, no npm.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";

const tmp = (name) => path.join(os.tmpdir(), `turma-xstore-${name}-${process.pid}.json`);
// Point every externalized store's file at a temp path so the module-init load is
// a clean "absent" and nothing touches a real /data.
for (const v of [
  "DEVICES_FILE", "TICKET_AGENTS_FILE", "TICKET_MODELS_FILE", "TICKET_RUNTIMES_FILE",
  "TICKET_PLATFORMS_FILE", "AUTOSTART_ORGS_FILE", "AUTOMERGE_ORGS_FILE", "TRIAGE_ACTIONS_FILE",
  "TRIAGE_POLICIES_FILE", "PRIORITY_WRITEBACK_ORGS_FILE", "DEDUPE_LINK_ORGS_FILE",
  "ORG_COLORS_FILE", "REPO_TIERS_FILE", "EPIC_RUNS_FILE", "EPIC_BUILDERS_FILE",
  "USAGE_LEDGER_FILE", "STATE_FILE",
]) {
  process.env[v] = tmp(v.toLowerCase());
}
// One repo pre-seeded via the boot config seed, to prove the boot-only seed.
process.env.REPO_TIER_SEED = JSON.stringify({ "seeded-repo": "live" });

const { FileLiveStore } = require("../store.js");
const srv = require("../server.js");
const X = srv.__externalStores;

function fileStore(persistent) {
  return new FileLiveStore({ persistent });
}

test("XERK-757: every listed store maps to a policy: key and a /data file", () => {
  const list = X.list();
  const persistent = X.persistentConfig();
  // The 13 stores the ticket names are all wired.
  const names = new Set(list.map((d) => d.name));
  for (const n of [
    "devices", "ticketAgents", "ticketModels", "ticketRuntimes", "ticketPlatforms",
    "autoStartOrgs", "autoMergeOrgs", "triageActions", "triagePolicies",
    "priorityWriteBackOrgs", "dedupeLinkOrgs", "orgColors", "repoTiers",
    // XERK-769 — the epic-run/-builder stores joined the externalized set so HA
    // replicas share them and they survive a pod restart.
    "epicRuns", "epicBuilders",
  ]) {
    assert.ok(names.has(n), `store ${n} is registered`);
  }
  for (const d of list) {
    assert.ok(d.key.startsWith("policy:"), `${d.name} key is namespaced`);
    assert.ok(persistent[d.key] && persistent[d.key].file, `${d.name} has a persistent file`);
    assert.equal(persistent[d.key].debounceMs, 5000, `${d.name} keeps the 5s debounce`);
  }
});

test("XERK-757: asFlagMap keeps only truthy keys as true; asPlainObject keeps objects", () => {
  assert.deepEqual(X.asFlagMap({ a: true, b: 1, c: 0, d: false, e: "x" }), { a: true, b: true, e: true });
  assert.deepEqual(X.asFlagMap(["a"]), {});
  assert.deepEqual(X.asFlagMap(null), {});
  assert.deepEqual(X.asPlainObject({ k: { v: 1 } }), { k: { v: 1 } });
  assert.deepEqual(X.asPlainObject([1, 2]), {});
  assert.deepEqual(X.asPlainObject(7), {});
});

test("XERK-757: applyExternalStoreValue installs a change, dedups an echo, coerces junk", () => {
  let mirror = {};
  const desc = {
    key: "policy:t", coerce: X.asFlagMap,
    read: () => mirror, install: (v) => { mirror = v; },
  };
  // A genuine change installs and returns true.
  assert.equal(X.applyExternalStoreValue(desc, { org1: true }), true);
  assert.deepEqual(mirror, { org1: true });
  // The same value again (our own write's echo) is a no-op.
  assert.equal(X.applyExternalStoreValue(desc, { org1: true }), false);
  assert.deepEqual(mirror, { org1: true });
  // A malformed remote value is coerced by the store's own whitelist.
  assert.equal(X.applyExternalStoreValue(desc, { org1: true, junk: 0, bad: false }), false);
  assert.deepEqual(mirror, { org1: true });
});

test("XERK-757: persist writes byte-identical JSON through the file backend", async () => {
  // persist() writes through the module-load backend (a FileLiveStore under
  // TURMA_TEST, sharing STORE_PERSISTENT). Registering a store adds its file to
  // that config, so a set() then finds it and writes byte-identical JSON.
  const file = tmp("persist-probe");
  try { fs.unlinkSync(file); } catch { /* first run */ }
  let mirror = {};
  const persist = X.registerExternalStore({
    name: "probe", file, coerce: X.asPlainObject,
    read: () => mirror, install: (v) => { mirror = v; },
  });
  mirror = { "site/KEY-1": { host: "h1", at: 123 } };
  persist();                       // liveStore.set("policy:probe", mirror), debounced
  assert.deepEqual(await srv.liveStore.get("policy:probe"), mirror);
  srv.liveStore.flush();           // drain the debounced durable write synchronously
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(mirror));
});

test("XERK-757: a change on one replica reaches another via the shared backend's watch", async () => {
  // ONE FileLiveStore = one shared backend; two mirrors watching the same key =
  // two replicas. A set from A must land in B's mirror (SSE fan-out to B's clients
  // is XERK-762's job, not the watch's), while A's own echo is deduped.
  const file = tmp("shared-probe");
  try { fs.unlinkSync(file); } catch { /* first run */ }
  const store = fileStore({ "policy:shared": { file, debounceMs: 5000 } });

  let mirrorA = {};
  let mirrorB = {};
  const descA = { key: "policy:shared", coerce: X.asFlagMap, read: () => mirrorA, install: (v) => { mirrorA = v; } };
  const descB = { key: "policy:shared", coerce: X.asFlagMap, read: () => mirrorB, install: (v) => { mirrorB = v; } };
  store.watch(descA.key, (ev) => X.applyExternalStoreValue(descA, ev && ev.value));
  store.watch(descB.key, (ev) => X.applyExternalStoreValue(descB, ev && ev.value));

  // Replica A flips a toggle: mutate its mirror, then persist through the backend.
  mirrorA = { "acme.atlassian.net": true };
  await store.set(descA.key, mirrorA);   // FileLiveStore fires BOTH watchers

  assert.deepEqual(mirrorB, { "acme.atlassian.net": true }, "B saw A's change");
  assert.deepEqual(mirrorA, { "acme.atlassian.net": true }, "A's own echo left it unchanged");
  store.close();
});

test("XERK-757: two triage-policy sets leave the mirror a coerce fixed-point (echo dedups)", () => {
  // triagePolicies is the one store whose coerce rebuilds nested objects in a
  // FIXED key order. setTriagePolicy must store that canonical order, or the
  // own-write watch echo (coerce(setValue)) fails the sameValue dedup and
  // re-broadcasts a redundant SSE frame (QA LOW). After any sequence of sets the
  // mirror must equal its own coerce BYTE-FOR-BYTE (the dedup is JSON-string).
  const desc = X.list().find((d) => d.name === "triagePolicies");
  const site = "canon.atlassian.net";
  srv.setTriagePolicy(site, { rateMax: 7 });
  srv.setTriagePolicy(site, { minPriority: "P1" });          // adds a key out of coerce order
  const v = desc.read();
  assert.deepEqual(v[site], { minPriority: "P1", rateMax: 7 });
  assert.equal(
    JSON.stringify(desc.coerce(structuredClone(v))),
    JSON.stringify(v),
    "the mirror is a coerce fixed-point, so the own-write echo dedups",
  );
  srv.setTriagePolicy(site, { rateMax: null, minPriority: null }); // clean up global state
});

test("XERK-757: boot load adopts the store's value; a fresh store is SEEDED from the mirror", async () => {
  // A store that already HAS the key wins on boot (authoritative). A store MISSING
  // the key is seeded up from the file/seed-primed mirror (single-process -> HA
  // migration with no operator action). Driven through the real repoTiers wiring.
  const seeded = X.repoTiers();
  assert.equal(seeded["seeded-repo"], "live", "the config seed primed the mirror at module-init");

  // Wire the real stores onto a backend that already carries a repoTiers value:
  // the store wins, then the boot-only seed is re-applied on top.
  const persistent = { ...X.persistentConfig() };
  const store = fileStore(persistent);
  await store.set("policy:repoTiers", { "other-repo": "archive" });
  X.wireExternalStores(store);
  await new Promise((r) => setTimeout(r, 50)); // let the async ready()->get load settle

  const after = X.repoTiers();
  assert.equal(after["other-repo"], "archive", "the store's value was adopted");
  assert.equal(after["seeded-repo"], "live", "the boot-only seed survived the adapter load");
  store.close();
});

// ---- XERK-769: epic-run / epic-builder stores are externalized -------------
// The epic auto-orchestration run store (epicRuns) and the Epic Builder store
// (epicBuilders) moved off "a /data file in one process" onto the SAME adapter,
// so a run armed or a builder queued on one HA replica is visible on every
// replica and survives a pod restart (the pre-HA gap the ticket closed). Same
// backend-agnostic mechanism as the 13 XERK-757 stores.

test("XERK-769: epicRuns/epicBuilders map to policy: keys with per-record coerces", () => {
  const list = X.list();
  const runs = list.find((d) => d.name === "epicRuns");
  const builders = list.find((d) => d.name === "epicBuilders");
  assert.ok(runs && builders, "both epic stores are registered");
  assert.ok(runs.key === "policy:epicRuns" && builders.key === "policy:epicBuilders");

  // The coerce is the SAME per-record whitelist the file boot-load used: a good
  // record survives, a malformed one (no epicKey / no id) is dropped — so a
  // hand-edited file AND a bad remote replica value degrade identically.
  const runsIn = {
    "o.atlassian.net/E-1": { epicKey: "E-1", siteKey: "o.atlassian.net", state: "running", children: ["C-1"], waves: [["C-1"]], startedAt: 1, updatedAt: 2 },
    "o.atlassian.net/bad": { siteKey: "o.atlassian.net", state: "running" }, // no epicKey -> dropped
  };
  const runsOut = runs.coerce(runsIn);
  assert.deepEqual(Object.keys(runsOut), ["o.atlassian.net/E-1"]);
  assert.equal(runsOut["o.atlassian.net/E-1"].state, "running");

  const buildersIn = {
    "abc": { id: "abc", siteKey: "o.atlassian.net", title: "Idea", idea: "do a thing", state: "queued", startedAt: 1, updatedAt: 2 },
    "bad": { siteKey: "o.atlassian.net", title: "no id" }, // no id -> dropped
  };
  const buildersOut = builders.coerce(buildersIn);
  assert.deepEqual(Object.keys(buildersOut), ["abc"]);
  assert.equal(buildersOut["abc"].title, "Idea");

  // Junk containers coerce to an empty map (the "not set" posture).
  assert.deepEqual(runs.coerce([1, 2]), {});
  assert.deepEqual(builders.coerce(7), {});
});

test("XERK-769: a live epicBuilder record is a coerce FIXED-POINT (own-write echo dedups)", () => {
  // In-place mutations (dispatch sets host/dispatchedAt, advance sets epicKey/
  // error) must land in the SAME key order sanitizeEpicBuilderRecord emits, or
  // the own-write watch echo (coerce(setValue)) fails the sameValue dedup under
  // HA and re-invalidates the cache every write. Build the record exactly as the
  // runtime does and assert it equals its own coerce byte-for-byte.
  const now = Date.now();
  const live = {
    id: "d1", siteKey: "o.atlassian.net", title: "T", idea: "i",
    state: "failed", startedAt: now, updatedAt: now,
    repo: "turma", targetHost: "host-a",
    host: "host-a", dispatchedAt: now, epicKey: "E-9", error: "boom",
  };
  assert.equal(
    JSON.stringify(srv.sanitizeEpicBuilderRecord(live)),
    JSON.stringify(live),
    "the coerce is a fixed-point of a fully-populated live record",
  );

  // And drive it through the real setters: arm (queued), fake a dispatch, then
  // advance — the resulting mirror record must still be a coerce fixed-point.
  const rec = srv.armEpicBuilder("o.atlassian.net", { title: "Build me", idea: "an epic" });
  const mirror = X.epicBuilders();
  mirror[rec.id].host = "host-x";        // stand in for the dispatch's host claim
  mirror[rec.id].dispatchedAt = Date.now();
  srv.advanceEpicBuilder("host-x", { id: rec.id, state: "creating", epicKey: "E-77" });
  const advanced = mirror[rec.id];
  assert.equal(advanced.state, "creating");
  assert.equal(advanced.epicKey, "E-77");
  assert.equal(
    JSON.stringify(srv.sanitizeEpicBuilderRecord(advanced)),
    JSON.stringify(advanced),
    "the advanced live record is still a coerce fixed-point",
  );
  srv.clearEpicBuilder(rec.id); // clean up global state
});

test("XERK-769: an epicRuns change on one replica reaches another via the shared watch", async () => {
  // Two mirrors watching one FileLiveStore = two replicas sharing a backend. A
  // set from A lands in B's mirror (SSE fan-out to B's clients is XERK-762's),
  // while A's own echo dedups. The coerce sanitizes what B installs.
  const file = tmp("epicruns-shared");
  try { fs.unlinkSync(file); } catch { /* first run */ }
  const store = fileStore({ "policy:epicRuns": { file, debounceMs: 5000 } });
  const runs = X.list().find((d) => d.name === "epicRuns");

  let mirrorA = {};
  let mirrorB = {};
  const descA = { key: runs.key, coerce: runs.coerce, read: () => mirrorA, install: (v) => { mirrorA = v; } };
  const descB = { key: runs.key, coerce: runs.coerce, read: () => mirrorB, install: (v) => { mirrorB = v; } };
  store.watch(descA.key, (ev) => X.applyExternalStoreValue(descA, ev && ev.value));
  store.watch(descB.key, (ev) => X.applyExternalStoreValue(descB, ev && ev.value));

  mirrorA = { "acme.atlassian.net/E-1": { epicKey: "E-1", siteKey: "acme.atlassian.net", state: "running", children: [], waves: [], startedAt: 1, updatedAt: 2 } };
  await store.set(descA.key, mirrorA);

  assert.equal(mirrorB["acme.atlassian.net/E-1"].state, "running", "B saw A's armed run");
  assert.deepEqual(mirrorA["acme.atlassian.net/E-1"].epicKey, "E-1", "A's own echo left it unchanged");
  store.close();
});

test("XERK-769: boot adopts a stored epicBuilders value; a fresh store is SEEDED from the file", async () => {
  // A store that already HAS the key wins (adopt). Prime the mirror with a
  // record, wire onto a backend that carries a different one: the store's value
  // is adopted. Seeding-up (the migration path) is proven by the repoTiers case;
  // this pins the adopt half for a per-record-coerced store.
  const seeded = srv.armEpicBuilder("boot.atlassian.net", { title: "local", idea: "primed" });
  assert.ok(X.epicBuilders()[seeded.id], "the mirror carries the primed builder");

  const persistent = { ...X.persistentConfig() };
  const store = fileStore(persistent);
  await store.set("policy:epicBuilders", {
    "remote1": { id: "remote1", siteKey: "boot.atlassian.net", title: "adopted", idea: "from the store", state: "queued", startedAt: 1, updatedAt: 2 },
  });
  X.wireExternalStores(store);
  await new Promise((r) => setTimeout(r, 50)); // let ready()->get settle

  const after = X.epicBuilders();
  assert.ok(after["remote1"], "the store's value was adopted on boot");
  assert.equal(after["remote1"].title, "adopted");
  assert.equal(after[seeded.id], undefined, "adopting the store replaces the primed mirror");
  store.close();
});
