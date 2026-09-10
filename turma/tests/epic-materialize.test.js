// Unit tests for the Epic Builder materialization engine + builder directive
// (XERK-724, epic XERK-721 — subtask C). Pure, stdlib-only: no network, no
// server. The load-bearing tests DRIVE the resumable engine through a full
// multi-beat loop against a fake command executor, and assert the RESULT is
// Auto-Epic-ready — isEpic on the epic (the createTicket issueType), epicKey on
// every child (the createEpicChild parent), and a Blocks link per intended
// blockedBy edge — plus the deterministic ordering, the dry-run preview, exact
// partial-failure reporting, and non-duplicating resume.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const M = require("../epic-materialize.js");
const EP = require("../epic-plan.js");

// A diamond A -> {B, C} -> D, D the final QA sink blocked by every other child.
function diamondPlan() {
  return {
    epic: { summary: "Build the widget", description: "the whole widget" },
    children: [
      { localId: "a", summary: "scaffold", description: "d-a", issueType: "Task", blockedBy: [] },
      { localId: "b", summary: "left", description: "d-b", issueType: "Story", blockedBy: ["a"] },
      { localId: "c", summary: "right", description: "d-c", issueType: "Task", blockedBy: ["a"] },
      { localId: "d", summary: "qa+enable", description: "d-d", issueType: "Task", blockedBy: ["a", "b", "c"] },
    ],
  };
}

// A fake Jira the engine drives through the caller. It mints real keys, records
// parents (epicKey) and Blocks links, and can be told to FAIL a given step once.
function fakeTracker(opts) {
  const o = opts || {};
  const state = {
    created: {},      // realKey -> { type, issueType, parent, summary }
    links: [],        // { blocker, blocked }
    nextNum: 100,
    failOnce: new Set(o.failSteps || []),
  };
  // Run one queued command, returning the staged RESULT shape the real agent
  // would put on the heartbeat for that primitive.
  function run(step, cmd) {
    if (state.failOnce.has(step)) {
      state.failOnce.delete(step);
      if (cmd.type === "createBlocksLink") return { blockerKey: cmd.blockerKey, blockedKey: cmd.blockedKey, ok: false, error: "boom", action: null };
      return { key: null, url: null, error: "boom", warning: null };
    }
    if (cmd.type === "createTicket") {
      const key = "XERK-" + (state.nextNum++);
      state.created[key] = { type: "epic", issueType: cmd.issueType, parent: null, summary: cmd.summary };
      return { key, url: "http://j/" + key, error: null, warning: null };
    }
    if (cmd.type === "createEpicChild") {
      const key = "XERK-" + (state.nextNum++);
      state.created[key] = { type: "child", issueType: cmd.issueType, parent: cmd.epicKey, summary: cmd.summary };
      return { key, url: "http://j/" + key, epicKey: cmd.epicKey, error: null, warning: null };
    }
    if (cmd.type === "createBlocksLink") {
      state.links.push({ blocker: cmd.blockerKey, blocked: cmd.blockedKey });
      return { blockerKey: cmd.blockerKey, blockedKey: cmd.blockedKey, ok: true, error: null, action: "linked" };
    }
    throw new Error("unknown command " + cmd.type);
  }
  return { state, run };
}

// Drive the engine to completion (or failure) the way D's beat loop would: each
// "beat" folds the PREVIOUS beat's outcomes, gets the next commands, runs them
// against the tracker, and stages their outcomes for the next beat. Bounded so a
// stuck engine can't loop forever. Returns { report, state, beats, tracker }.
function drive(plan, opts, tracker, seedState) {
  let mstate = seedState || null;
  let outcomes = {};
  let beats = 0;
  for (;;) {
    beats++;
    assert.ok(beats < 50, "engine did not settle");
    const tick = M.materializeTick(plan, opts, mstate, outcomes);
    mstate = tick.state;
    if (tick.done || tick.failed) return { report: tick.report, state: mstate, beats, tick };
    if (tick.commands.length === 0) {
      // No progress and not terminal: only legitimate if we are waiting on an
      // outcome we already fed — which `drive` never does, so this is a stall.
      throw new Error("engine stalled with no commands at phase " + mstate.phase);
    }
    // Run this beat's commands; stage outcomes keyed by step for the next tick.
    outcomes = {};
    for (const { step, cmd } of tick.commands) {
      const result = tracker.run(step, cmd);
      const kind = cmd.type;
      outcomes[step] = M.outcomeFromResult(kind, result);
    }
  }
}

// ---- ordering: preview == the run ------------------------------------------

test("XERK-724: childOrder is the wave layering, flattened deterministically", () => {
  assert.deepEqual(M.childOrder(diamondPlan()), ["a", "b", "c", "d"]);
});

test("XERK-724: linkSteps are the blockedBy edges in creation order, deduped", () => {
  assert.deepEqual(M.linkSteps(diamondPlan()), [
    { blocker: "a", blocked: "b" },
    { blocker: "a", blocked: "c" },
    { blocker: "a", blocked: "d" },
    { blocker: "b", blocked: "d" },
    { blocker: "c", blocked: "d" },
  ]);
});

test("XERK-724: preview shows the exact writes without touching the tracker", () => {
  const pv = M.materializationPreview(diamondPlan(), { project: "XERK" });
  assert.equal(pv.valid, true);
  assert.deepEqual(pv.waves, [["a"], ["b", "c"], ["d"]]);
  assert.equal(pv.finalId, "d");
  assert.deepEqual(pv.children.map((c) => c.localId), ["a", "b", "c", "d"]);
  assert.deepEqual(pv.links.map((l) => [l.blocker, l.blocked]),
    [["a", "b"], ["a", "c"], ["a", "d"], ["b", "d"], ["c", "d"]]);
});

test("XERK-724: an invalid plan previews invalid and never writes", () => {
  const bad = diamondPlan();
  bad.children[3].blockedBy = ["a", "b"]; // final child NOT blocked by c
  const pv = M.materializationPreview(bad, { project: "XERK" });
  assert.equal(pv.valid, false);
  assert.ok(pv.errors.some((e) => e.code === "FINAL_NOT_BLOCKED_BY_ALL"));

  const tracker = fakeTracker();
  const tick = M.materializeTick(bad, { project: "XERK" }, null, {});
  assert.equal(tick.failed, true);
  assert.deepEqual(tick.commands, []);
  assert.equal(Object.keys(tracker.state.created).length, 0);
});

// ---- the happy path: a real Auto-Epic-ready result -------------------------

test("XERK-724: a full run yields isEpic + epicKey-on-every-child + the DAG links", () => {
  const plan = diamondPlan();
  const tracker = fakeTracker();
  const { report, beats } = drive(plan, { project: "XERK" }, tracker);

  assert.equal(report.done, true);
  assert.equal(report.failed, false);
  // The epic is a real ticket of type Epic (=> isEpic on re-read).
  const epicKey = report.epicKey;
  assert.ok(epicKey);
  assert.equal(tracker.state.created[epicKey].type, "epic");
  assert.equal(tracker.state.created[epicKey].issueType, "Epic");
  // Every child was parented to the epic (=> epicKey on re-read).
  assert.equal(report.children.length, 4);
  for (const { key } of report.children) {
    assert.equal(tracker.state.created[key].parent, epicKey);
  }
  // The links reproduce the intended DAG, with blocker->blocked direction.
  const keyOf = Object.fromEntries(report.children.map((c) => [c.localId, c.key]));
  const gotLinks = tracker.state.links.map((l) => [l.blocker, l.blocked]).sort();
  const wantLinks = [
    [keyOf.a, keyOf.b], [keyOf.a, keyOf.c], [keyOf.a, keyOf.d],
    [keyOf.b, keyOf.d], [keyOf.c, keyOf.d],
  ].sort();
  assert.deepEqual(gotLinks, wantLinks);
  // One round-trip for the epic, one per dependency WAVE of children (a/{b,c}/d
  // = 3 waves), one for the links batch, plus a final fold beat = 6.
  assert.equal(beats, 6);
});

test("XERK-724: buildEpicWaves over the materialized DAG yields the intended waves", () => {
  // Prove the produced structure arms as the intended plan: reconstruct the
  // child rows from the report's real keys + the plan's edges, and run them
  // through the SAME layering the Auto-Epic run uses (epic-plan.js `layerWaves`,
  // the byte-identical mirror of server.js buildEpicWaves).
  const plan = diamondPlan();
  const tracker = fakeTracker();
  const { report } = drive(plan, { project: "XERK" }, tracker);
  const keyOf = Object.fromEntries(report.children.map((c) => [c.localId, c.key]));
  const rows = plan.children.map((c) => ({
    key: keyOf[c.localId],
    blockedBy: c.blockedBy.map((b) => keyOf[b]),
  }));
  const { waves, cycle } = EP.layerWaves(rows);
  assert.deepEqual(cycle, []);
  assert.deepEqual(waves, [[keyOf.a], [keyOf.b, keyOf.c], [keyOf.d]]);
  // The final child is blocked by every other child.
  const finalRow = rows.find((r) => r.key === keyOf.d);
  assert.deepEqual([...finalRow.blockedBy].sort(), [keyOf.a, keyOf.b, keyOf.c].sort());
});

// ---- partial failure: exactly what was created, no silent half-epic --------

test("XERK-724: a child failure stops the run and reports exactly what exists", () => {
  const plan = diamondPlan();
  const tracker = fakeTracker({ failSteps: ["child:c"] });
  const { report } = drive(plan, { project: "XERK" }, tracker);

  assert.equal(report.failed, true);
  assert.equal(report.done, false);
  // The epic and the children that DID land are reported (no silent loss).
  assert.ok(report.epicKey);
  assert.deepEqual(report.children.map((c) => c.localId).sort(), ["a", "b"]);
  // The failure names the exact step; no links were attempted.
  assert.ok(report.failures.some((f) => f.step === "child:c"));
  assert.equal(tracker.state.links.length, 0);
  // `pending` names what is left to do, including the failed child.
  assert.ok(report.pending.includes("child:c"));
  assert.ok(report.pending.includes("child:d"));
});

test("XERK-724: a resume after partial failure does NOT re-create the landed children", () => {
  const plan = diamondPlan();
  // First run: fail creating child c.
  const t1 = fakeTracker({ failSteps: ["child:c"] });
  const first = drive(plan, { project: "XERK" }, t1);
  assert.equal(first.report.failed, true);
  const landedBefore = Object.keys(t1.state.created).length; // epic + a + b = 3
  assert.equal(landedBefore, 3);

  // Resume from the persisted state against a fresh (healthy) tracker that
  // continues the key numbering, but SHARES the already-created records so a
  // duplicate would be visible. Simplest: reuse the same tracker, cleared of the
  // failure, and re-seed the engine's phase to children.
  const resumeState = M.coerceState(first.state);
  resumeState.phase = "children"; // re-open the run from where it failed
  const second = drive(plan, { project: "XERK" }, t1, resumeState);

  assert.equal(second.report.done, true);
  // a and b were NOT re-created (still their original keys); only c and d added.
  assert.equal(t1.state.created[first.report.children[0].key].summary, "scaffold");
  const childKeys = second.report.children.map((c) => c.localId + ":" + c.key);
  // a and b keep the keys from the first run.
  const aKey = first.report.children.find((c) => c.localId === "a").key;
  const bKey = first.report.children.find((c) => c.localId === "b").key;
  assert.ok(childKeys.includes("a:" + aKey));
  assert.ok(childKeys.includes("b:" + bKey));
  // Exactly two NEW creates happened on resume (c and d); the epic + a + b were
  // not re-created.
  assert.equal(Object.keys(t1.state.created).length, 5); // epic, a, b, c, d
});

test("XERK-724: an epic-create failure stops before any child is created", () => {
  const plan = diamondPlan();
  const tracker = fakeTracker({ failSteps: ["epic"] });
  const { report } = drive(plan, { project: "XERK" }, tracker);
  assert.equal(report.failed, true);
  assert.equal(report.epicKey, null);
  assert.equal(report.children.length, 0);
  assert.ok(report.failures.some((f) => f.step === "epic"));
  assert.equal(Object.keys(tracker.state.created).length, 0);
});

test("XERK-724: materialize refuses with no project, before any write", () => {
  const tick = M.materializeTick(diamondPlan(), {}, null, {});
  assert.equal(tick.failed, true);
  assert.deepEqual(tick.commands, []);
  assert.ok(tick.report.failures.some((f) => /project/.test(f.error)));
});

// ---- a single-child plan (trivially blocked-by-all) ------------------------

test("XERK-724: a one-child plan materializes epic + child + no links", () => {
  const plan = {
    epic: { summary: "tiny", description: "" },
    children: [{ localId: "only", summary: "do it", description: "", issueType: "Task", blockedBy: [] }],
  };
  const tracker = fakeTracker();
  const { report, beats } = drive(plan, { project: "XERK" }, tracker);
  assert.equal(report.done, true);
  assert.equal(report.children.length, 1);
  assert.equal(tracker.state.links.length, 0);
  // epic beat, child beat, and a final fold beat (no link phase work).
  assert.equal(beats, 3);
});

// ---- outcomeFromResult: the per-primitive success rule ---------------------

test("XERK-724: outcomeFromResult distils each primitive's result faithfully", () => {
  assert.deepEqual(
    M.outcomeFromResult("createTicket", { key: "XERK-1", url: "u", error: null }),
    { ok: true, key: "XERK-1", url: "u", error: null, warning: null });
  assert.equal(M.outcomeFromResult("createEpicChild", { key: null, error: "no board" }).ok, false);
  // A create with no error but ALSO no key is not a success (defensive).
  assert.equal(M.outcomeFromResult("createTicket", { key: null, error: null }).ok, false);
  assert.deepEqual(
    M.outcomeFromResult("createBlocksLink", { ok: true, action: "no-op" }),
    { ok: true, action: "no-op", error: null });
  assert.equal(M.outcomeFromResult("createBlocksLink", { ok: false, error: "bad key" }).ok, false);
  assert.equal(M.outcomeFromResult("createTicket", null), null);
});

// ---- the builder directive + plan extraction -------------------------------

test("XERK-724: the directive prompt carries the idea and the emit markers", () => {
  const prompt = M.buildEpicBuilderPrompt({ title: "Widgets", idea: "make widgets", project: "XERK" });
  assert.ok(prompt.includes("Widgets"));
  assert.ok(prompt.includes("make widgets"));
  assert.ok(prompt.includes("XERK"));
  assert.ok(prompt.includes(M.EPIC_PLAN_BEGIN));
  assert.ok(prompt.includes(M.EPIC_PLAN_END));
});

test("XERK-724: extractEpicPlan pulls the plan out of session output (plain + fenced)", () => {
  const plan = diamondPlan();
  const out = "Here is my plan.\n" + M.EPIC_PLAN_BEGIN + "\n"
    + JSON.stringify(plan) + "\n" + M.EPIC_PLAN_END + "\nDone.";
  const got = M.extractEpicPlan(out);
  assert.deepEqual(got, plan);
  assert.equal(EP.validateEpicPlan(got).valid, true);

  // A ```json fence inside the block is stripped.
  const fenced = M.EPIC_PLAN_BEGIN + "\n```json\n" + JSON.stringify(plan) + "\n```\n" + M.EPIC_PLAN_END;
  assert.deepEqual(M.extractEpicPlan(fenced), plan);
});

test("XERK-724: extractEpicPlan returns null for no/partial/garbage block", () => {
  assert.equal(M.extractEpicPlan("no plan here"), null);
  assert.equal(M.extractEpicPlan(M.EPIC_PLAN_BEGIN + "\n{ unterminated"), null); // no END
  assert.equal(M.extractEpicPlan(M.EPIC_PLAN_BEGIN + "\nnot json\n" + M.EPIC_PLAN_END), null);
});

test("XERK-724: extractEpicPlan takes the LAST complete block (a revised plan wins)", () => {
  const a = { epic: { summary: "first" }, children: [] };
  const b = { epic: { summary: "second" }, children: [] };
  const out = M.EPIC_PLAN_BEGIN + "\n" + JSON.stringify(a) + "\n" + M.EPIC_PLAN_END
    + "\n...revised...\n"
    + M.EPIC_PLAN_BEGIN + "\n" + JSON.stringify(b) + "\n" + M.EPIC_PLAN_END;
  assert.equal(M.extractEpicPlan(out).epic.summary, "second");
});
