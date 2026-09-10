// Unit tests for the EpicPlan data model + wire contract (XERK-722, epic
// XERK-721) — the pure intermediate the Epic Builder produces before writing
// anything to Jira. No network, no server: epic-plan.js is stdlib-only.
//
// The load-bearing acceptance is the LAST test group: waves() must produce the
// SAME layering as turma/server.js's buildEpicWaves for the same edges, over a
// shared fixture — so a plan previews exactly as the Auto-Epic run (XERK-633)
// will execute it. That is verified by requiring the real server module (under
// TURMA_TEST, which makes it export its internals and NOT bind a port).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const EP = require("../epic-plan.js");

// A well-formed reference plan: a diamond A -> {B, C} -> D, D the final sink.
function goodPlan() {
  return {
    epic: { summary: "Build the widget", description: "the whole widget" },
    children: [
      { localId: "a", summary: "scaffold", description: "", issueType: "Task", blockedBy: [] },
      { localId: "b", summary: "left", description: "", issueType: "Story", blockedBy: ["a"] },
      { localId: "c", summary: "right", description: "", issueType: "Task", blockedBy: ["a"] },
      { localId: "d", summary: "integrate", description: "", issueType: "Task", blockedBy: ["a", "b", "c"] },
    ],
  };
}

// ---- validation: the happy path --------------------------------------------

test("XERK-722: a well-formed plan validates, with its waves + final child", () => {
  const res = EP.validateEpicPlan(goodPlan());
  assert.equal(res.valid, true);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.waves, [["a"], ["b", "c"], ["d"]]);
  assert.deepEqual(res.cycle, []);
  assert.equal(res.finalId, "d");
});

test("XERK-722: a single-child plan is trivially final-blocked-by-all", () => {
  const res = EP.validateEpicPlan({
    epic: { summary: "solo" },
    children: [{ localId: "only", summary: "do it", issueType: "Task", blockedBy: [] }],
  });
  assert.equal(res.valid, true, JSON.stringify(res.errors));
  assert.deepEqual(res.waves, [["only"]]);
});

test("XERK-722: assertValidEpicPlan returns the plan and throws on invalid", () => {
  const p = goodPlan();
  assert.equal(EP.assertValidEpicPlan(p), p);
  assert.throws(() => EP.assertValidEpicPlan({ epic: {}, children: [] }), /invalid epic plan/);
});

// ---- validation: the rejections the acceptance names ------------------------

test("XERK-722: rejects a dependency cycle (reported, never dropped)", () => {
  const p = goodPlan();
  // Make b <-> c a loop; d still references them.
  p.children[1].blockedBy = ["a", "c"];
  p.children[2].blockedBy = ["a", "b"];
  const res = EP.validateEpicPlan(p);
  assert.equal(res.valid, false);
  const codes = res.errors.map((e) => e.code);
  assert.ok(codes.includes("CYCLE"), codes.join(","));
  // b <-> c loop; d depends on both, so it can never be placed either.
  assert.deepEqual(res.cycle.slice().sort(), ["b", "c", "d"]);
});

test("XERK-722: rejects a dangling blockedBy (unknown localId)", () => {
  const p = goodPlan();
  p.children[1].blockedBy = ["a", "ghost"];
  const res = EP.validateEpicPlan(p);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.code === "BLOCKEDBY_DANGLING"));
});

test("XERK-722: rejects a self-blocking child", () => {
  const p = goodPlan();
  p.children[0].blockedBy = ["a"];
  const res = EP.validateEpicPlan(p);
  assert.ok(res.errors.some((e) => e.code === "BLOCKEDBY_SELF"));
});

test("XERK-722: rejects a missing epic", () => {
  const res = EP.validateEpicPlan({ children: goodPlan().children });
  assert.ok(res.errors.some((e) => e.code === "EPIC_MISSING"));
  const res2 = EP.validateEpicPlan({ epic: { summary: "  " }, children: goodPlan().children });
  assert.ok(res2.errors.some((e) => e.code === "EPIC_MISSING"), "blank summary is missing");
});

test("XERK-722: rejects a duplicate localId (the 'duplicate' half of missing/duplicate)", () => {
  const p = goodPlan();
  p.children[2].localId = "b";  // now two children share "b"
  const res = EP.validateEpicPlan(p);
  assert.ok(res.errors.some((e) => e.code === "LOCALID_DUPLICATE"));
});

test("XERK-722: rejects a final child not blocked by every other child", () => {
  const p = goodPlan();
  p.children[3].blockedBy = ["b", "c"];  // d no longer waits on a
  const res = EP.validateEpicPlan(p);
  assert.equal(res.valid, false);
  const e = res.errors.find((x) => x.code === "FINAL_NOT_BLOCKED_BY_ALL");
  assert.ok(e, "expected FINAL_NOT_BLOCKED_BY_ALL");
  assert.match(e.message, /\ba\b/);  // the missing blocker is named
});

test("XERK-722: issueType is constrained to Task/Story, never Epic/Subtask", () => {
  for (const bad of ["Epic", "Subtask", "Bug", "", undefined, null, 3]) {
    const p = goodPlan();
    p.children[1].issueType = bad;
    const res = EP.validateEpicPlan(p);
    assert.ok(
      res.errors.some((e) => e.code === "ISSUETYPE_INVALID"),
      `expected ISSUETYPE_INVALID for ${JSON.stringify(bad)}`,
    );
  }
  // Case-insensitive on the allowed set.
  for (const ok of ["Task", "task", "STORY", "Story"]) {
    const p = goodPlan();
    p.children[1].issueType = ok;
    assert.equal(EP.validateEpicPlan(p).valid, true, `expected ${ok} to validate`);
  }
});

test("XERK-722: non-object / empty-children plans are rejected, not thrown", () => {
  assert.equal(EP.validateEpicPlan(null).valid, false);
  assert.equal(EP.validateEpicPlan([]).valid, false);
  assert.equal(EP.validateEpicPlan("x").valid, false);
  const res = EP.validateEpicPlan({ epic: { summary: "e" }, children: [] });
  assert.ok(res.errors.some((e) => e.code === "NO_CHILDREN"));
});

// ---- the wire contract: round-trip -----------------------------------------

test("XERK-722: a plan round-trips through serialize/parse unchanged", () => {
  const p = goodPlan();
  const back = EP.parseEpicPlan(EP.serializeEpicPlan(p));
  assert.deepEqual(back, p);
  assert.equal(EP.validateEpicPlan(back).valid, true);
});

test("XERK-722: parseEpicPlan throws on malformed JSON / non-string", () => {
  assert.throws(() => EP.parseEpicPlan("{not json"), SyntaxError);
  assert.throws(() => EP.parseEpicPlan({}), TypeError);
});

// ---- the acceptance: waves() EQUALS buildEpicWaves() over a shared fixture --

// Require the real hub module the way its own suite does: TURMA_TEST makes
// server.js export its internals instead of binding the production port.
process.env.TURMA_TEST = process.env.TURMA_TEST || "1";
const { buildEpicWaves } = require("../server.js");

// One fixture of edges, expressed BOTH as buildEpicWaves rows ({key, blockedBy})
// and as an EpicPlan (localId === key). The two must lay out identically.
const SHARED_EDGES = [
  { id: "E-A", blockedBy: [] },
  { id: "E-B", blockedBy: ["E-A"] },
  { id: "E-C", blockedBy: ["E-A"] },
  { id: "E-D", blockedBy: ["E-A", "E-B", "E-C"] },
];

function edgesToRows(edges) {
  return edges.map((e) => ({ key: e.id, blockedBy: e.blockedBy }));
}
function edgesToPlan(edges) {
  return {
    epic: { summary: "shared fixture" },
    children: edges.map((e) => ({
      localId: e.id, summary: e.id, issueType: "Task", blockedBy: e.blockedBy,
    })),
  };
}

test("XERK-722: waves(plan) equals buildEpicWaves(rows) for the same edges", () => {
  const rows = edgesToRows(SHARED_EDGES);
  const plan = edgesToPlan(SHARED_EDGES);
  assert.deepEqual(EP.waves(plan), buildEpicWaves(rows));
});

test("XERK-722: waves equals buildEpicWaves for a staggered chain and a cycle too", () => {
  const chain = [
    { id: "N1", blockedBy: [] },
    { id: "N2", blockedBy: ["N1"] },
    { id: "N3", blockedBy: ["N1", "N2"] },
  ];
  assert.deepEqual(EP.waves(edgesToPlan(chain)), buildEpicWaves(edgesToRows(chain)));

  const cyclic = [
    { id: "Z", blockedBy: [] },
    { id: "X", blockedBy: ["Y"] },
    { id: "Y", blockedBy: ["X"] },
  ];
  const a = EP.waves(edgesToPlan(cyclic));
  const b = buildEpicWaves(edgesToRows(cyclic));
  assert.deepEqual(a.waves, b.waves);
  assert.deepEqual(a.cycle.slice().sort(), b.cycle.slice().sort());
});

// layerWaves is the exposed shared primitive; it IS what buildEpicWaves does.
test("XERK-722: layerWaves matches buildEpicWaves directly on rows", () => {
  const rows = edgesToRows(SHARED_EDGES);
  assert.deepEqual(EP.layerWaves(rows), buildEpicWaves(rows));
});

// Self-blocks and external refs are exactly what the `&& b !== k` / `inSet`
// filters in layerWaves exist to drop. Pin them against buildEpicWaves too, so
// dropping the self-block handling in only one of the two mirrors is caught (a
// self-blocking node must lay out normally, NOT stall as a cycle).
test("XERK-722: waves equals buildEpicWaves for self-blocks and external refs", () => {
  const edges = [
    { id: "S1", blockedBy: ["S1"] },              // self-block: dropped, S1 is ready
    { id: "S2", blockedBy: ["S1", "OUTSIDE-9"] }, // external ref: dropped, S2 waits on S1
  ];
  const a = EP.waves(edgesToPlan(edges));
  const b = buildEpicWaves(edgesToRows(edges));
  assert.deepEqual(a, b);
  assert.deepEqual(a.waves, [["S1"], ["S2"]]);
  assert.deepEqual(a.cycle, []);
});
