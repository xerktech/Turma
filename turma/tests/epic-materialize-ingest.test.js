// Hub-side ingestion of the Epic Builder's write-primitive results (XERK-724,
// the "hub-side consumption is XERK-721's (C)" note in XERK-723). Verifies the
// per-cmdId caches for createEpicChild / createBlocksLink key + evict like the
// sibling `createResults`/`linkResults`, and — the load-bearing invariant — that
// both are STRIPPED from the served fleet payload (they are read hub-side by the
// materialization run, never shipped to clients).

"use strict";

process.env.TURMA_TEST = "1";

const test = require("node:test");
const assert = require("node:assert/strict");

const hub = require("../server.js");

function agentRecord() {
  return {
    lastSeen: Date.now(),
    epicChildResults: {},
    blocksLinkResults: {},
  };
}

test("XERK-724: ingestEpicChildResults keys by cmdId and echoes the parent", () => {
  const a = agentRecord();
  hub.ingestEpicChildResults(a, [
    { cmdId: "c1", key: "XERK-900", url: "http://j/XERK-900", epicKey: "XERK-800", error: null },
    { cmdId: "c2", key: null, epicKey: "XERK-800", error: "no board credentials" },
    { key: "XERK-901" }, // no cmdId -> ignored
  ]);
  assert.equal(a.epicChildResults.c1.key, "XERK-900");
  assert.equal(a.epicChildResults.c1.epicKey, "XERK-800");
  assert.equal(a.epicChildResults.c2.error, "no board credentials");
  assert.equal(a.epicChildResults.c2.key, null);
  assert.equal(Object.keys(a.epicChildResults).length, 2);
});

test("XERK-724: ingestBlocksLinkResults carries ok + action per cmdId", () => {
  const a = agentRecord();
  hub.ingestBlocksLinkResults(a, [
    { cmdId: "l1", blockerKey: "XERK-900", blockedKey: "XERK-901", ok: true, action: "linked" },
    { cmdId: "l2", blockerKey: "XERK-902", blockedKey: "XERK-903", ok: false, error: "bad key" },
  ]);
  assert.equal(a.blocksLinkResults.l1.ok, true);
  assert.equal(a.blocksLinkResults.l1.action, "linked");
  assert.equal(a.blocksLinkResults.l1.blockedKey, "XERK-901");
  assert.equal(a.blocksLinkResults.l2.ok, false);
  assert.equal(a.blocksLinkResults.l2.error, "bad key");
});

test("XERK-724: a non-array results payload is a no-op, never a throw", () => {
  const a = agentRecord();
  hub.ingestEpicChildResults(a, undefined);
  hub.ingestBlocksLinkResults(a, null);
  assert.deepEqual(a.epicChildResults, {});
  assert.deepEqual(a.blocksLinkResults, {});
});

test("XERK-724: both caches are STRIPPED from the served fleet payload", () => {
  const a = agentRecord();
  hub.ingestEpicChildResults(a, [{ cmdId: "c1", key: "XERK-900", epicKey: "XERK-800", error: null }]);
  hub.ingestBlocksLinkResults(a, [{ cmdId: "l1", blockerKey: "XERK-900", blockedKey: "XERK-901", ok: true }]);
  const served = hub.serializeAgent("someHost", a, Date.now());
  assert.equal(served.epicChildResults, undefined);
  assert.equal(served.blocksLinkResults, undefined);
});
