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
  "ORG_COLORS_FILE", "REPO_TIERS_FILE", "USAGE_LEDGER_FILE", "STATE_FILE",
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
  const file = tmp("persist-probe");
  try { fs.unlinkSync(file); } catch { /* first run */ }
  const store = fileStore({ "policy:probe": { file, debounceMs: 5000 } });
  X.setLiveStore(store);
  let mirror = {};
  const persist = X.registerExternalStore({
    name: "probe", file, coerce: X.asPlainObject,
    read: () => mirror, install: (v) => { mirror = v; },
  });
  mirror = { "site/KEY-1": { host: "h1", at: 123 } };
  persist();                 // liveStore.set(key, mirror), debounced write
  assert.deepEqual(await store.get("policy:probe"), mirror);
  store.flush();             // drain the debounced durable write synchronously
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(mirror));
  store.close();
  X.setLiveStore(null);
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
  X.setLiveStore(null);
});
