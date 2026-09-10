"use strict";

// The Epic Builder's materialization engine + builder directive (XERK-724, epic
// XERK-721 — subtask C, "the builder session: research repo, expand idea,
// materialize epic").
//
// Two things live here, both belonging to C:
//
//   1. The MATERIALIZER — turns a validated EpicPlan (XERK-722, `epic-plan.js`)
//      into the real Jira epic, driving XERK-723's three write primitives in a
//      DETERMINISTIC dependency order, with a dry-run PREVIEW before any write
//      and an EXACT "what got created" report on partial failure (never a silent
//      half-epic). It is PURE and RESUMABLE: it never queues a command, reads a
//      result cache, or persists anything itself — the hub route + run tracking
//      (XERK-725, subtask D) owns the heartbeat loop, host selection and durable
//      run record, and calls `materializeTick` each beat with the outcomes it
//      has gathered. This split is the same one `epic-plan.js`'s `waves` and
//      `server.js`'s `buildEpicWaves`/`epicRunDriveSweep` already use: the pure
//      brain here, the beat-loop driver there.
//
//   2. The BUILDER DIRECTIVE — the fixed instruction text a builder SESSION runs
//      (`EPIC_BUILDER_DIRECTIVE` / `buildEpicBuilderPrompt`): research the repo
//      and the idea, expand it into an Auto-Epic-ready EpicPlan, emit it in a
//      recognizable block. `extractEpicPlan` reads that block back out. The
//      session PRODUCES the plan; the hub MATERIALIZES it (a session cannot queue
//      a hub command), which is why the two halves meet through the EpicPlan JSON.
//
// Why materialization is a MULTI-BEAT STATE MACHINE, not one `await` chain: the
// primitives are agent commands whose results ride a LATER heartbeat
// (`server.js` `awaitResult` only registers a poll-wait — the outcome lands in a
// result cache a beat or more after the command is acked). So the engine cannot
// block on a create; it issues a batch, is re-entered next beat with the
// outcomes, and advances. It is resumable across a hub restart because its whole
// state is a plain-JSON object D persists on the run record.
//
// The three primitives it drives (XERK-723 + XERK-137), and the DIRECTION that
// makes the result Auto-Epic-ready (verified in `hub-agent.py`):
//   - the EPIC:  {type:"createTicket", project, issueType:"Epic", summary, …}
//       → `createTicketResults` {cmdId, key, url, error, warning}
//   - each CHILD: {type:"createEpicChild", epicKey, project, issueType, summary, …}
//       → `epicChildResults`   {cmdId, key, url, epicKey, error, warning}
//       (parent = the epic key, so a re-read via `_shape_issue` sets `epicKey`)
//   - each LINK:  {type:"createBlocksLink", blockerKey, blockedKey}
//       → `blocksLinkResults`  {cmdId, blockerKey, blockedKey, ok, error, action}
//       (blockerKey blocks blockedKey, so the blocked child lists the blocker in
//        its `blockedBy` — exactly what `buildEpicWaves` orders on).

const EP = require("./epic-plan.js");

// ---- ordering: the deterministic write plan --------------------------------
//
// A plan materializes in three phases, and WITHIN a phase in a fixed order, so a
// preview equals the run and a partial failure is reproducible.
//   - children are created in WAVE order (the same `waves(plan)` layering the
//     Auto-Epic run executes), children within a wave kept in plan order;
//   - links are created only AFTER every child exists (a Blocks link needs both
//     real keys), one per in-plan `blockedBy` edge, walked in child order then
//     each child's `blockedBy` order, de-duplicated and self-edges dropped
//     exactly as `layerWaves` filters them — so preview edges == run edges.

// The children of `plan`, flattened from their dependency waves into one
// deterministic order. `waves(plan).waves` is `[[localId]]`; concatenating keeps
// wave-then-plan order. A child caught in a cycle never appears in `waves`, so it
// is not returned here either — but `validateEpicPlan` reports the cycle as an
// error, and the materializer refuses to write for an invalid plan, so a cyclic
// plan never reaches this ordering.
function childOrder(plan) {
  const { waves } = EP.waves(plan);
  const order = [];
  for (const wave of waves) for (const id of wave) order.push(id);
  return order;
}

// The `blockedBy` edges of `plan` as `{ blocker, blocked }` link steps, in the
// order they will be created: outer loop over `childOrder`, inner loop over that
// child's `blockedBy`, filtered to IN-PLAN ids, self-edges dropped, duplicates
// dropped — the SAME filter `epic-plan.js`'s `layerWaves` applies when it orders
// the waves, so the links written are exactly the edges the preview drew and the
// run orders on. `blocked` is the child that declares the dependency; `blocker`
// is the id in its `blockedBy`.
function linkSteps(plan) {
  const ids = new Set(childOrder(plan));
  const steps = [];
  const seen = new Set();
  const byId = new Map();
  for (const c of (plan && Array.isArray(plan.children) ? plan.children : [])) {
    if (c && typeof c.localId === "string") byId.set(c.localId, c);
  }
  for (const blocked of childOrder(plan)) {
    const c = byId.get(blocked);
    const bs = c && Array.isArray(c.blockedBy) ? c.blockedBy : [];
    for (const blocker of bs) {
      if (typeof blocker !== "string" || blocker === blocked) continue;
      if (!ids.has(blocker)) continue;         // an out-of-plan ref: no link
      const k = blocker + "\x00" + blocked;
      if (seen.has(k)) continue;
      seen.add(k);
      steps.push({ blocker, blocked });
    }
  }
  return steps;
}

// A stable STEP ID for each write, so the caller (D) can correlate the cmdId it
// mints with the engine step, across beats and a persisted/rehydrated run:
//   "epic", "child:<localId>", "link:<blocker>-><blocked>".
// Deliberately derived from the plan's own localIds (which are unique by
// validation), never a positional index — a cursor would break if the plan were
// re-validated in a different order.
const EPIC_STEP = "epic";
function childStepId(localId) { return "child:" + localId; }
function linkStepId(blocker, blocked) { return "link:" + blocker + "->" + blocked; }

// ---- the dry-run preview ---------------------------------------------------

// A PREVIEW of exactly what materialization will write, in order, WITHOUT
// writing anything — so a bad plan is caught before a single ticket exists.
// Returns:
//   { valid, errors, epic:{summary,description}, waves:[[localId]],
//     children:[{step, localId, issueType, summary}],   // in creation order
//     links:[{step, blocker, blocked}],                 // in creation order
//     finalId }
// `valid`/`errors` come straight from `validateEpicPlan`; when invalid the
// children/links are still projected best-effort for display, but the
// materializer will REFUSE to run (a preview is for looking, the guard is at the
// write). `opts.project` is echoed for the caller's display only.
function materializationPreview(plan, opts) {
  const v = EP.validateEpicPlan(plan);
  const order = v.valid ? childOrder(plan) : [];
  const byId = new Map();
  for (const c of (plan && Array.isArray(plan.children) ? plan.children : [])) {
    if (c && typeof c.localId === "string") byId.set(c.localId, c);
  }
  const children = order.map((id) => {
    const c = byId.get(id) || {};
    return {
      step: childStepId(id), localId: id,
      issueType: c.issueType, summary: c.summary,
    };
  });
  const links = (v.valid ? linkSteps(plan) : []).map((l) => ({
    step: linkStepId(l.blocker, l.blocked), blocker: l.blocker, blocked: l.blocked,
  }));
  return {
    valid: v.valid,
    errors: v.errors,
    project: (opts && opts.project) || null,
    epic: {
      summary: plan && plan.epic && plan.epic.summary,
      description: plan && plan.epic && plan.epic.description,
    },
    waves: v.waves,
    children,
    links,
    finalId: v.finalId,
  };
}

// ---- the resumable materializer --------------------------------------------
//
// State shape (plain JSON, persisted by D on the run record):
//   {
//     phase: "epic"|"children"|"links"|"done"|"failed",
//     epicKey: null|string, epicUrl: null|string,
//     keyByLocalId: { <localId>: <realKey> },   // children created SO FAR
//     links: { <linkStep>: {action, ok} },      // links resolved SO FAR
//     failures: [ { step, error } ],            // every write that came back !ok
//   }
// A fresh run passes no state; a resumed run passes the persisted object. The
// engine NEVER re-issues a step already recorded in `keyByLocalId`/`links`
// (create is NOT idempotent — a re-create would duplicate the child), so a retry
// after partial failure continues rather than doubling. Only createBlocksLink is
// itself idempotent (XERK-723), so a link may be safely re-issued.

function freshState() {
  return {
    phase: "epic",
    epicKey: null,
    epicUrl: null,
    keyByLocalId: {},
    links: {},
    failures: [],
  };
}

// Normalize a possibly-partial / rehydrated state so every field is present.
function coerceState(state) {
  const s = state && typeof state === "object" ? state : {};
  return {
    phase: typeof s.phase === "string" ? s.phase : "epic",
    epicKey: s.epicKey || null,
    epicUrl: s.epicUrl || null,
    keyByLocalId: (s.keyByLocalId && typeof s.keyByLocalId === "object") ? { ...s.keyByLocalId } : {},
    links: (s.links && typeof s.links === "object") ? { ...s.links } : {},
    failures: Array.isArray(s.failures) ? s.failures.slice() : [],
  };
}

// The report the caller surfaces at every step and, decisively, on partial
// failure — "exactly what was created, no silent half-epic":
//   { phase, epicKey, epicUrl,
//     children:[{localId, key}],           // created, in plan order
//     links:[{blocker, blocked, action}],  // resolved, in creation order
//     failures:[{step, error}],
//     pending:[step],                       // steps not yet done
//     done, failed }
function materializationReport(plan, state) {
  const s = coerceState(state);
  const created = childOrder(plan)
    .filter((id) => s.keyByLocalId[id])
    .map((id) => ({ localId: id, key: s.keyByLocalId[id] }));
  const links = linkSteps(plan)
    .map((l) => ({ l, r: s.links[linkStepId(l.blocker, l.blocked)] }))
    .filter((x) => x.r)
    .map((x) => ({ blocker: x.l.blocker, blocked: x.l.blocked, action: x.r.action || null }));
  const pending = [];
  if (!s.epicKey) pending.push(EPIC_STEP);
  for (const id of childOrder(plan)) if (!s.keyByLocalId[id]) pending.push(childStepId(id));
  for (const l of linkSteps(plan)) {
    const st = linkStepId(l.blocker, l.blocked);
    if (!s.links[st]) pending.push(st);
  }
  return {
    phase: s.phase,
    epicKey: s.epicKey,
    epicUrl: s.epicUrl,
    children: created,
    links,
    failures: s.failures.slice(),
    pending,
    done: s.phase === "done",
    failed: s.phase === "failed",
  };
}

// The command a step maps to (WITHOUT a cmdId — the caller mints that via
// `queueCommand`). `opts.project` is required to create the epic and children;
// `opts.epicLabels`/`opts.childLabels` are optional label lists.
function epicCommand(plan, opts) {
  return {
    type: "createTicket",
    project: opts.project,
    issueType: "Epic",
    summary: plan.epic.summary,
    description: (plan.epic.description || ""),
    labels: (opts.epicLabels || []),
  };
}
function childCommand(plan, opts, state, localId) {
  const c = (plan.children || []).find((x) => x && x.localId === localId) || {};
  return {
    type: "createEpicChild",
    epicKey: state.epicKey,
    project: opts.project,
    issueType: c.issueType,
    summary: c.summary,
    description: (c.description || ""),
    labels: (opts.childLabels || []),
  };
}
function linkCommand(state, blocker, blocked) {
  return {
    type: "createBlocksLink",
    blockerKey: state.keyByLocalId[blocker],
    blockedKey: state.keyByLocalId[blocked],
  };
}

// Advance the materialization by one beat. PURE: it reads `outcomes` (the caller
// maps each command it issued LAST tick — keyed by the engine step id — to that
// command's staged result) and returns what to do NEXT, plus the new state and a
// report. The caller then queues each returned command (remembering cmdId→step),
// persists `state`, and re-enters next beat with the outcomes it has gathered.
//
//   materializeTick(plan, opts, state, outcomes) ->
//     { state, commands:[{step, cmd}], report, done, failed }
//
// `outcomes` is `{ <step>: {ok, key?, url?, error?, action?} }`, exactly the
// shape the caller distils from a result cache entry:
//   - createTicket/createEpicChild result → ok = !result.error, key/url from it;
//   - createBlocksLink result → ok = result.ok, action from it.
// An outcome absent for an issued step means "not landed yet" — the engine
// simply re-returns nothing new and waits (idempotent per beat).
//
// Failure policy: a create that comes back `!ok` is recorded in `failures` and
// STOPS the run at `failed` — a half-created wave must not silently proceed to
// links that can't resolve. The report then names exactly what exists, so D can
// surface it and a human (or a resumed run) can continue. A link that comes back
// `!ok` also fails the run (the DAG would be wrong), but createBlocksLink is
// idempotent so a resume re-issues it cleanly.
function materializeTick(plan, opts, state, outcomes) {
  const o = outcomes && typeof outcomes === "object" ? outcomes : {};
  const options = opts && typeof opts === "object" ? opts : {};

  // Guard: never write for an invalid plan or with no project to create in.
  const v = EP.validateEpicPlan(plan);
  if (!v.valid) {
    const s = coerceState(state);
    s.phase = "failed";
    s.failures = [{ step: "plan", error: "invalid epic plan: "
      + v.errors.map((e) => e.code + ": " + e.message).join("; ") }];
    return { state: s, commands: [], report: materializationReport(plan, s),
             done: false, failed: true };
  }
  if (!options.project || typeof options.project !== "string") {
    const s = coerceState(state);
    s.phase = "failed";
    s.failures = [{ step: "plan", error: "a project is required to materialize" }];
    return { state: s, commands: [], report: materializationReport(plan, s),
             done: false, failed: true };
  }

  const s = state ? coerceState(state) : freshState();
  const commands = [];
  const recordFailure = (step, error) => {
    s.failures.push({ step, error: String(error || "unknown error").slice(0, 300) });
    s.phase = "failed";
  };

  // Fold in the outcomes of whatever was issued last tick, per phase.
  // ---- epic -------------------------------------------------------------
  if (s.phase === "epic") {
    const out = o[EPIC_STEP];
    if (out) {
      if (out.ok && out.key) {
        s.epicKey = out.key;
        s.epicUrl = out.url || null;
        s.phase = "children";
      } else {
        recordFailure(EPIC_STEP, out.error || "epic creation failed");
      }
    } else if (!s.epicKey) {
      // Nothing issued yet (or not landed): issue the epic create.
      commands.push({ step: EPIC_STEP, cmd: epicCommand(plan, options) });
    }
  }

  // ---- children ---------------------------------------------------------
  if (s.phase === "children") {
    // Ingest any child outcomes present.
    for (const id of childOrder(plan)) {
      if (s.keyByLocalId[id]) continue;               // already created
      const out = o[childStepId(id)];
      if (!out) continue;                             // not landed yet
      if (out.ok && out.key) s.keyByLocalId[id] = out.key;
      else recordFailure(childStepId(id), out.error || "child creation failed");
    }
    if (s.phase === "children") {                     // not tripped into failed
      // Create children WAVE BY WAVE, not all at once: issue the earliest wave
      // that still has an uncreated child, and issue no LATER wave until it
      // completes. createEpicChild only needs the epic to exist (not the child's
      // blockers), so all-at-once would create correctly — but a mid-plan
      // failure would then leave DOWNSTREAM children created whose failed
      // blockers can never be linked. Wave-gating bounds a failure's blast
      // radius to one wave: a wave with a failure stops the run before any later
      // wave is touched, so the partial-failure report never shows a child whose
      // predecessors did not land. Siblings WITHIN a wave are independent, so
      // they are still issued together (one round-trip per wave). Not re-issuing
      // ones already in keyByLocalId is what makes a retry non-duplicating.
      const waves = EP.waves(plan).waves;
      let issued = false;
      for (const wave of waves) {
        const missing = wave.filter((id) => !s.keyByLocalId[id]);
        if (missing.length === 0) continue;           // this wave is complete
        for (const id of missing) {
          commands.push({ step: childStepId(id), cmd: childCommand(plan, options, s, id) });
        }
        issued = true;
        break;                                        // hold later waves
      }
      if (!issued) s.phase = "links";                 // every child created
    }
  }

  // ---- links ------------------------------------------------------------
  if (s.phase === "links") {
    const steps = linkSteps(plan);
    for (const l of steps) {
      const st = linkStepId(l.blocker, l.blocked);
      if (s.links[st] && s.links[st].ok) continue;    // already linked
      const out = o[st];
      if (!out) continue;
      if (out.ok) s.links[st] = { ok: true, action: out.action || null };
      else recordFailure(st, out.error || "blocks link failed");
    }
    if (s.phase === "links") {
      const missing = steps.filter((l) => {
        const st = linkStepId(l.blocker, l.blocked);
        return !(s.links[st] && s.links[st].ok);
      });
      if (missing.length === 0) {
        s.phase = "done";
      } else {
        for (const l of missing) {
          commands.push({ step: linkStepId(l.blocker, l.blocked),
                          cmd: linkCommand(s, l.blocker, l.blocked) });
        }
      }
    }
  }

  return {
    state: s,
    commands,
    report: materializationReport(plan, s),
    done: s.phase === "done",
    failed: s.phase === "failed",
  };
}

// Distil a result-cache entry into the `outcomes` shape `materializeTick` reads,
// so the caller (D) does not re-derive the per-primitive success rule. `kind` is
// one of "createTicket" | "createEpicChild" | "createBlocksLink".
//   - create* results carry an `error` (null on success) + `key`/`url`;
//   - createBlocksLink carries `ok` + `action`.
// A missing entry returns null (the caller then treats the step as not-landed).
function outcomeFromResult(kind, result) {
  if (!result || typeof result !== "object") return null;
  if (kind === "createBlocksLink") {
    return { ok: !!result.ok, action: result.action || null, error: result.error || null };
  }
  // createTicket / createEpicChild
  return {
    ok: !result.error && !!result.key,
    key: result.key || null,
    url: result.url || null,
    error: result.error || null,
    warning: result.warning || null,
  };
}

// ---- the builder directive + plan extraction -------------------------------
//
// The fixed instruction a builder SESSION runs. It tells the session to research
// the repo + the idea, expand it into an Auto-Epic-ready EpicPlan, PREVIEW its
// own waves, and emit the final plan in a block the hub can read back. The hub
// (D) interpolates the operator's title/idea and dispatches a session with this;
// the session produces the plan, and the hub materializes it with the engine
// above (a session cannot queue a hub write command).

// The sentinel that brackets the final plan JSON in the session's output, so the
// plan can be extracted unambiguously from surrounding prose. Kept distinctive so
// it can never collide with ordinary transcript text.
const EPIC_PLAN_BEGIN = "===EPIC-PLAN-BEGIN===";
const EPIC_PLAN_END = "===EPIC-PLAN-END===";

const EPIC_BUILDER_DIRECTIVE = [
  "You are the Epic Builder. Turn the operator's idea into a single, well-formed",
  "Jira Epic whose children are already shaped for Turma's Auto Epic feature, so",
  "the epic rolls out in dependency order with no manual link fixup.",
  "",
  "Do this in order:",
  "",
  "1. RESEARCH. You are in a real worktree of the target repo — read the code and",
  "   the idea before planning, exactly as an engineer would. Understand what the",
  "   idea actually requires, which components it touches, and the natural seams",
  "   to split the work along.",
  "",
  "2. EXPAND into a plan of work tickets (Tasks/Stories, never Epics or Subtasks):",
  "   - Order them into WAVES by dependency, running in PARALLEL where the work is",
  "     genuinely independent, and SERIALIZED only where one child truly needs",
  "     another's output. Each child names the children it is blocked by.",
  "   - The LAST child is a QA-and-enable step that is blocked by EVERY other",
  "     child, so the epic converges to one wrap-up sink.",
  "   - Keep each child a real, self-contained piece of work with a clear summary",
  "     and enough description to start on.",
  "",
  "3. EMIT the plan as JSON in exactly this shape (localId is a builder-local",
  "   handle you choose; real Jira keys are assigned when the hub materializes it):",
  "",
  "   { \"epic\": { \"summary\": \"…\", \"description\": \"…\" },",
  "     \"children\": [",
  "       { \"localId\": \"w1a\", \"summary\": \"…\", \"description\": \"…\",",
  "         \"issueType\": \"Task\", \"blockedBy\": [] },",
  "       … ,",
  "       { \"localId\": \"qa\", \"summary\": \"QA end-to-end and enable\",",
  "         \"description\": \"…\", \"issueType\": \"Task\",",
  "         \"blockedBy\": [\"w1a\", …every other localId…] } ] }",
  "",
  "   Output that JSON as the LAST thing you say, on its own, bracketed EXACTLY by",
  "   these two marker lines and nothing else between them:",
  "",
  "   " + EPIC_PLAN_BEGIN,
  "   { …the plan JSON… }",
  "   " + EPIC_PLAN_END,
  "",
  "The plan must satisfy: exactly one epic with a non-empty summary; every child a",
  "unique non-empty localId; every blockedBy naming another child in the plan (no",
  "dangling or self references); the dependency graph acyclic; the final child",
  "blocked by every other child. Do NOT create any Jira ticket yourself — the hub",
  "materializes the plan from the JSON you emit.",
].join("\n");

// Compose the full builder prompt for a dispatched session: the operator's title
// + idea followed by the directive. `project` is named so the session's summaries
// can reference it, but the session never writes to Jira.
function buildEpicBuilderPrompt(opts) {
  const o = opts || {};
  const title = String(o.title || "").trim();
  const idea = String(o.idea || "").trim();
  const lines = ["# New epic to build"];
  if (title) lines.push("", "Title: " + title);
  if (o.project) lines.push("Jira project: " + String(o.project));
  if (idea) lines.push("", "Idea / details:", "", idea);
  lines.push("", "---", "", EPIC_BUILDER_DIRECTIVE);
  return lines.join("\n");
}

// Pull the EpicPlan JSON back out of the session's output. Returns the PARSED
// object (validate it separately with `validateEpicPlan` — the transport is this
// function's concern, the content is the plan's). Returns null when no complete,
// parseable plan block is present (the session hasn't finished, or emitted
// nothing usable). Takes the LAST complete block, so a session that revises its
// plan and re-emits wins with its final answer.
function extractEpicPlan(text) {
  if (typeof text !== "string") return null;
  let from = -1;
  let best = null;
  // Walk every BEGIN…END pair, keeping the last one that parses.
  for (;;) {
    const b = text.indexOf(EPIC_PLAN_BEGIN, from + 1);
    if (b === -1) break;
    from = b;
    const e = text.indexOf(EPIC_PLAN_END, b + EPIC_PLAN_BEGIN.length);
    if (e === -1) break; // an unterminated block: not complete yet
    const inner = text.slice(b + EPIC_PLAN_BEGIN.length, e).trim();
    const json = stripJsonFence(inner);
    try {
      best = JSON.parse(json);
    } catch (_) { /* keep the previous good one, if any */ }
  }
  return best;
}

// A model routinely wraps JSON in a ```json … ``` fence even when asked not to.
// Strip a single surrounding fence if present; otherwise return the text as-is.
function stripJsonFence(s) {
  const t = s.trim();
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fence ? fence[1].trim() : t;
}

module.exports = {
  // ordering + preview
  childOrder,
  linkSteps,
  materializationPreview,
  // step ids
  EPIC_STEP,
  childStepId,
  linkStepId,
  // the resumable engine
  freshState,
  coerceState,
  materializeTick,
  materializationReport,
  outcomeFromResult,
  // command builders (exported for D's dispatch + tests)
  epicCommand,
  childCommand,
  linkCommand,
  // the builder directive
  EPIC_PLAN_BEGIN,
  EPIC_PLAN_END,
  EPIC_BUILDER_DIRECTIVE,
  buildEpicBuilderPrompt,
  extractEpicPlan,
};
