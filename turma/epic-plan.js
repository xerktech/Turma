"use strict";

// The "epic plan" data model + wire contract (XERK-722, epic XERK-721).
//
// This is the intermediate structure the Epic Builder produces BEFORE it writes
// anything to Jira: one shape that expansion, validation and materialization all
// agree on. It is PURE and stdlib-only — no network, no tracker writes, no
// server state — so the builder session (XERK-721 C) and the hub route
// (XERK-721 D) validate and preview a plan the same way.
//
//   EpicPlan = {
//     epic: { summary, description },
//     children: [
//       { localId, summary, description, issueType, blockedBy: [localId, ...] },
//       ...
//     ],
//   }
//
// `localId` is a builder-LOCAL handle (e.g. "w1a"); real Jira keys are assigned
// only at materialization, so the whole plan is expressible before a single
// ticket exists. `blockedBy` names other children by their localId.
//
// The plan must map cleanly onto what the Auto-Epic run (XERK-633) consumes:
//   - exactly one epic (a non-empty summary),
//   - every blockedBy names an IN-PLAN localId (no dangling / self references),
//   - the dependency DAG is acyclic (a cycle is REPORTED, never silently
//     dropped) — laid out with the SAME Kahn layering `buildEpicWaves` uses in
//     turma/server.js, so the plan's preview waves EQUAL the run's waves,
//   - the DESIGNATED FINAL child (the last element of `children`) is blocked by
//     every other child, so the epic has a single wrap-up sink,
//   - every child's issueType is a project child type (Task/Story), never
//     Epic or Subtask.

// The child issue types a plan may use. An epic organizes work tickets; a child
// is a Task or a Story, never another Epic and never a Subtask (Subtasks are a
// Jira parenting the Auto-Epic run does not drive). Compared case-INSENSITIVELY
// so "task"/"Task"/"TASK" all validate, but the canonical forms are these.
const EPIC_PLAN_CHILD_TYPES = ["Task", "Story"];
const CHILD_TYPE_SET = new Set(EPIC_PLAN_CHILD_TYPES.map((t) => t.toLowerCase()));

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

// The shared Kahn layering — a BYTE-FOR-BYTE mirror of `buildEpicWaves` in
// turma/server.js (XERK-635). `childRows` is a list of `{ key, blockedBy }`;
// only blockers WITHIN the row set order the waves (an external key is a
// readiness concern for the driver, not a wave-ordering one), self-blocks are
// dropped, and input order is kept stable within a wave (a diamond
// A->{B,C}->D yields [[A],[B,C],[D]], deterministic for tests). Returns
// `{ waves: [[key]], cycle: [key] }`; `cycle` holds the rows a dependency loop
// stalls — never a silent deadlock. `waves(plan)` runs the plan's children
// through THIS so a plan previews exactly as the run will execute it.
function layerWaves(childRows) {
  const keys = [];
  const seen = new Set();
  for (const r of childRows || []) {
    if (r && typeof r.key === "string" && r.key && !seen.has(r.key)) {
      seen.add(r.key);
      keys.push(r.key);
    }
  }
  const inSet = new Set(keys);
  const byKey = new Map();
  for (const r of childRows || []) if (r && r.key) byKey.set(r.key, r);
  const blockers = new Map();  // key -> [blocker keys within the row set]
  for (const k of keys) {
    const r = byKey.get(k);
    const bs = Array.isArray(r && r.blockedBy) ? r.blockedBy : [];
    blockers.set(k, [...new Set(bs.filter(
      (b) => typeof b === "string" && inSet.has(b) && b !== k))]);
  }
  const waves = [];
  const placed = new Set();
  let remaining = keys.slice();
  while (remaining.length) {
    const wave = remaining.filter((k) => blockers.get(k).every((b) => placed.has(b)));
    if (!wave.length) break;   // nothing new can be placed -> the rest is a cycle
    for (const k of wave) placed.add(k);
    waves.push(wave);
    remaining = remaining.filter((k) => !placed.has(k));
  }
  return { waves, cycle: remaining };
}

// Project a plan's children onto the `{ key, blockedBy }` rows `layerWaves`
// (and the run's `buildEpicWaves`) consume: the localId IS the key. So a plan's
// preview waves are identical to the run's waves for the same edges — pinned by
// the shared-fixture test against server.js's buildEpicWaves.
function planChildRows(plan) {
  const children = (plan && Array.isArray(plan.children)) ? plan.children : [];
  return children.map((c) => ({
    key: c && c.localId,
    blockedBy: c && Array.isArray(c.blockedBy) ? c.blockedBy : [],
  }));
}

// Pure preview: the plan's children laid out as dependency waves, with any
// cycle reported (never dropped). `{ waves: [[localId]], cycle: [localId] }`.
function waves(plan) {
  return layerWaves(planChildRows(plan));
}

// The DESIGNATED final child of a plan: the LAST element of `children`. This is
// the builder's wrap-up sink (the child that must be blocked by every other
// child, so the epic converges to one terminal ticket). Positional designation
// keeps the wire shape fixed — there is no `final` flag to forge or drop — and
// lets validation report "a final child that is NOT blocked-by-all" (the last
// child is the final child whether or not it satisfies the property).
function finalChild(plan) {
  const children = (plan && Array.isArray(plan.children)) ? plan.children : [];
  return children.length ? children[children.length - 1] : null;
}

// Validate a plan against everything the Auto-Epic run needs. Returns
//   { valid: boolean, errors: [{ code, message }], waves, cycle, finalId }
// — never throws on a malformed plan (that is what `errors` is for); a caller
// that wants an exception uses `assertValidEpicPlan`. Every distinct problem is
// its own error entry so a builder can surface all of them at once. `waves` /
// `cycle` are always computed (a cycle IS one of the errors), and `finalId` is
// the designated final child's localId when there is one.
function validateEpicPlan(plan) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return {
      valid: false,
      errors: [{ code: "NOT_AN_OBJECT", message: "plan must be an object" }],
      waves: [], cycle: [], finalId: null,
    };
  }

  // Exactly one epic: a non-null object with a non-empty summary. There is no
  // "second epic" field to reject; a child masquerading as an Epic is caught by
  // the issueType check below (Epic is never a valid child type).
  if (!plan.epic || typeof plan.epic !== "object" || Array.isArray(plan.epic)) {
    add("EPIC_MISSING", "plan.epic must be an object with a summary");
  } else if (!isNonEmptyString(plan.epic.summary)) {
    add("EPIC_MISSING", "plan.epic.summary must be a non-empty string");
  }

  const children = Array.isArray(plan.children) ? plan.children : null;
  if (!children) {
    add("NO_CHILDREN", "plan.children must be an array");
  } else if (children.length === 0) {
    add("NO_CHILDREN", "plan.children must not be empty");
  }

  // localId set + per-child shape. Build the in-plan id set first so blockedBy
  // can be checked against it.
  const ids = new Set();
  if (children) {
    const dup = new Set();
    for (const c of children) {
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        add("CHILD_NOT_OBJECT", "each child must be an object");
        continue;
      }
      if (!isNonEmptyString(c.localId)) {
        add("LOCALID_MISSING", "each child needs a non-empty localId");
        continue;
      }
      if (ids.has(c.localId) && !dup.has(c.localId)) {
        dup.add(c.localId);
        add("LOCALID_DUPLICATE", `duplicate localId "${c.localId}"`);
      }
      ids.add(c.localId);
    }
  }

  if (children) {
    for (const c of children) {
      if (!c || typeof c !== "object" || Array.isArray(c) || !isNonEmptyString(c.localId)) {
        continue;  // already reported above
      }
      const id = c.localId;
      if (!isNonEmptyString(c.summary)) {
        add("SUMMARY_MISSING", `child "${id}" needs a non-empty summary`);
      }
      // issueType constrained to the project's child types (Task/Story); never
      // Epic or Subtask.
      if (!isNonEmptyString(c.issueType) || !CHILD_TYPE_SET.has(c.issueType.trim().toLowerCase())) {
        add(
          "ISSUETYPE_INVALID",
          `child "${id}" issueType must be one of ${EPIC_PLAN_CHILD_TYPES.join("/")} `
          + `(got ${JSON.stringify(c && c.issueType)})`,
        );
      }
      // blockedBy references only in-plan localIds, and never itself.
      const bs = Array.isArray(c.blockedBy) ? c.blockedBy : [];
      for (const b of bs) {
        if (b === id) {
          add("BLOCKEDBY_SELF", `child "${id}" cannot block itself`);
        } else if (!ids.has(b)) {
          add("BLOCKEDBY_DANGLING", `child "${id}" is blocked by unknown localId ${JSON.stringify(b)}`);
        }
      }
    }
  }

  // The DAG must be acyclic. A cycle is reported, not dropped.
  const { waves: laidOut, cycle } = waves(plan);
  if (cycle.length) {
    add("CYCLE", `dependency cycle among children: ${cycle.join(", ")}`);
  }

  // The designated final child (last in the array) must be blocked by every
  // OTHER child, so the epic converges to a single wrap-up sink. Only checked
  // when there is more than one child and the ids are otherwise sound — a
  // single-child plan is trivially "blocked by all zero others".
  const fc = finalChild(plan);
  const finalId = fc && isNonEmptyString(fc.localId) ? fc.localId : null;
  if (children && children.length > 1 && finalId) {
    const blockedBy = new Set(
      Array.isArray(fc.blockedBy) ? fc.blockedBy.filter((b) => b !== finalId) : [],
    );
    const missing = [];
    for (const c of children) {
      if (!c || !isNonEmptyString(c.localId) || c.localId === finalId) continue;
      if (!blockedBy.has(c.localId)) missing.push(c.localId);
    }
    if (missing.length) {
      add(
        "FINAL_NOT_BLOCKED_BY_ALL",
        `final child "${finalId}" must be blocked by every other child; missing: ${missing.join(", ")}`,
      );
    }
  }

  return { valid: errors.length === 0, errors, waves: laidOut, cycle, finalId };
}

// Throwing form: returns the plan on success, throws an Error whose message
// lists every validation problem otherwise. For a caller that treats an invalid
// plan as exceptional (a route that 400s, a builder assertion).
function assertValidEpicPlan(plan) {
  const res = validateEpicPlan(plan);
  if (!res.valid) {
    const err = new Error(
      "invalid epic plan: " + res.errors.map((e) => `${e.code}: ${e.message}`).join("; "),
    );
    err.errors = res.errors;
    throw err;
  }
  return plan;
}

// ---- the wire contract -----------------------------------------------------
// The plan is plain JSON, so the wire form is just JSON.stringify/parse — but
// go through these so the round-trip has ONE home and a builder/route never
// hand-rolls it. `parseEpicPlan` throws on malformed JSON (the transport
// failed); validate the RESULT with validateEpicPlan (the content is the plan's
// concern, not the parser's).

function serializeEpicPlan(plan) {
  return JSON.stringify(plan);
}

function parseEpicPlan(json) {
  if (typeof json !== "string") {
    throw new TypeError("parseEpicPlan expects a JSON string");
  }
  return JSON.parse(json);
}

module.exports = {
  EPIC_PLAN_CHILD_TYPES,
  layerWaves,
  planChildRows,
  waves,
  finalChild,
  validateEpicPlan,
  assertValidEpicPlan,
  serializeEpicPlan,
  parseEpicPlan,
};
