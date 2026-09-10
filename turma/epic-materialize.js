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
    issued: {},
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
    // Steps whose command has been RETURNED to the caller but whose outcome has
    // not yet been folded — the in-flight set. This is what stops a not-yet-
    // landed create from being re-emitted every beat (createTicket /
    // createEpicChild are NOT idempotent, so re-issuing one duplicates a
    // ticket). Cleared per step the beat its outcome folds. A caller that must
    // retry a command it believes was LOST (queued, no result, no session) can
    // delete that step's entry to force a re-emit — retry policy is the run's
    // (XERK-725, D), never the engine's.
    issued: (s.issued && typeof s.issued === "object") ? { ...s.issued } : {},
    failures: Array.isArray(s.failures) ? s.failures.slice() : [],
  };
}

// Re-open a run that STOPPED at `failed` so materialization continues from
// exactly what already exists (the epic + children + links recorded in the
// state), re-issuing only the steps that never landed. This is how the run
// tracker (XERK-725, D) retries after a partial failure: clear the terminal
// marker; the working phase is re-derived from content each tick, so nothing
// already created is re-issued (a create is never idempotent). A no-op on a
// non-failed state.
function reopenState(state) {
  const s = coerceState(state);
  if (s.phase === "failed") s.phase = "epic"; // non-terminal; real phase is derived
  return s;
}

// The working phase DERIVED from state CONTENT, not a stored label — so a
// corrupted or forged `phase` on a rehydrated run record can never make the
// engine (a) report done while the DAG is incomplete, or (b) enter the link
// phase with children still uncreated and emit null-keyed link commands. The
// authoritative terminal is `failed` (sticky, checked before this); every other
// phase is a pure function of what actually exists.
function derivePhase(plan, s) {
  if (!s.epicKey) return "epic";
  if (childOrder(plan).some((id) => !s.keyByLocalId[id])) return "children";
  const incomplete = linkSteps(plan).some((l) => {
    const r = s.links[linkStepId(l.blocker, l.blocked)];
    return !(r && r.ok);
  });
  return incomplete ? "links" : "done";
}

// The report the caller surfaces at every step and, decisively, on partial
// failure — "exactly what was created, no silent half-epic":
//   { phase, epicKey, epicUrl,
//     children:[{localId, key}],           // created, in plan order
//     links:[{blocker, blocked, action}],  // resolved, in creation order
//     failures:[{step, error}],
//     pending:[step],                       // steps not yet done
//     inFlight:[step],                      // commands issued, outcome pending
//     done, failed }
// `done`/`failed`/`phase` are derived from CONTENT (not a stored label), so the
// report is self-consistent even for a corrupted rehydrated state: `done` is
// true only when the epic, every child and every link actually exist.
function materializationReport(plan, state) {
  const s = coerceState(state);
  const created = childOrder(plan)
    .filter((id) => s.keyByLocalId[id])
    .map((id) => ({ localId: id, key: s.keyByLocalId[id] }));
  const links = linkSteps(plan)
    .map((l) => ({ l, r: s.links[linkStepId(l.blocker, l.blocked)] }))
    .filter((x) => x.r && x.r.ok)
    .map((x) => ({ blocker: x.l.blocker, blocked: x.l.blocked, action: x.r.action || null }));
  const pending = [];
  if (!s.epicKey) pending.push(EPIC_STEP);
  for (const id of childOrder(plan)) if (!s.keyByLocalId[id]) pending.push(childStepId(id));
  for (const l of linkSteps(plan)) {
    const st = linkStepId(l.blocker, l.blocked);
    if (!(s.links[st] && s.links[st].ok)) pending.push(st);
  }
  const failed = s.phase === "failed";
  return {
    phase: failed ? "failed" : derivePhase(plan, s),
    epicKey: s.epicKey,
    epicUrl: s.epicUrl,
    children: created,
    links,
    failures: s.failures.slice(),
    pending,
    inFlight: Object.keys(s.issued),
    done: !failed && pending.length === 0,
    failed,
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
// An outcome absent for an ISSUED step means "not landed yet" — the step stays
// in the in-flight set (`state.issued`) and is NOT re-emitted, so a create whose
// result rides a LATER heartbeat is issued EXACTLY ONCE. This is load-bearing:
// createTicket / createEpicChild are NOT idempotent, so re-emitting one every
// beat until its result lands (a beat or more) would create duplicate tickets —
// precisely the regime this state machine exists to handle. A tick with an
// outstanding step and no new outcome therefore legitimately returns ZERO
// commands (the run is waiting), not a stall.
//
// Failure policy: a create that comes back `!ok` is recorded in `failures` and
// STOPS the run at `failed` (sticky) — a half-created wave must not silently
// proceed to links that can't resolve. The report then names exactly what
// exists, so D can surface it and a resumed run can continue. A link that comes
// back `!ok` also fails the run (the DAG would be wrong), but createBlocksLink is
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

  // A failure is TERMINAL and sticky — re-entering a failed run issues nothing
  // (a resume deliberately re-opens it by clearing `phase`/the failed step).
  if (s.phase === "failed") {
    return { state: s, commands: [], report: materializationReport(plan, s),
             done: false, failed: true };
  }

  const commands = [];
  const emit = (step, cmd) => { commands.push({ step, cmd }); s.issued[step] = true; };
  const recordFailure = (step, error) => {
    s.failures.push({ step, error: String(error || "unknown error").slice(0, 300) });
    delete s.issued[step];
    s.phase = "failed";
  };
  // A step that succeeds THIS tick clears any earlier failure for it — so a
  // resume (which re-opens a failed run) that then succeeds the once-failed step
  // reports a clean run, not a stale failure in the log.
  const clearFailure = (step) => {
    if (s.failures.length) s.failures = s.failures.filter((f) => f.step !== step);
  };

  // ---- 1. FOLD every outcome present, clearing the in-flight mark ----------
  // Done regardless of phase (an outcome for a step folds it whatever phase the
  // stored label claims). The epic first, then children, then links.
  //
  // DELIBERATELY not gated on `issued`: a real outcome is trusted over the
  // in-flight bookkeeping, because the outcome came from a ticket that WAS
  // created (the result cache only holds results of commands D queued). If D
  // persisted the run record a beat behind the emit — dispatch, restart, then
  // the result lands — the `issued` mark can be missing while the ticket exists;
  // folding the outcome anyway records the real key and avoids re-issuing (a
  // duplicate). Gating on `issued` would trade that duplicate-safety for
  // strictness against a FABRICATED outcome (an outcome for a step never
  // issued), which is a D-owned forged-input class and cannot arise under the
  // cmdId→step contract. Duplicate-avoidance wins — do not "tighten" this.
  if (!s.epicKey) {
    const out = o[EPIC_STEP];
    if (out) {
      delete s.issued[EPIC_STEP];
      if (out.ok && out.key) { s.epicKey = out.key; s.epicUrl = out.url || null; clearFailure(EPIC_STEP); }
      else recordFailure(EPIC_STEP, out.error || "epic creation failed");
    }
  }
  if (s.phase !== "failed") {
    for (const id of childOrder(plan)) {
      if (s.keyByLocalId[id]) continue;               // already created
      const out = o[childStepId(id)];
      if (!out) continue;                             // not landed yet
      delete s.issued[childStepId(id)];
      if (out.ok && out.key) { s.keyByLocalId[id] = out.key; clearFailure(childStepId(id)); }
      else recordFailure(childStepId(id), out.error || "child creation failed");
    }
  }
  if (s.phase !== "failed") {
    for (const l of linkSteps(plan)) {
      const st = linkStepId(l.blocker, l.blocked);
      if (s.links[st] && s.links[st].ok) continue;    // already linked
      const out = o[st];
      if (!out) continue;
      delete s.issued[st];
      if (out.ok) { s.links[st] = { ok: true, action: out.action || null }; clearFailure(st); }
      else recordFailure(st, out.error || "blocks link failed");
    }
  }
  if (s.phase === "failed") {
    return { state: s, commands: [], report: materializationReport(plan, s),
             done: false, failed: true };
  }

  // ---- 2. DERIVE the phase from CONTENT, then EMIT only NOT-in-flight steps -
  // Deriving (never trusting the stored label) is what keeps a corrupted resume
  // from emitting a null-keyed link (the link phase is only reached once every
  // child key exists) or reporting done over an empty build.
  s.phase = derivePhase(plan, s);
  if (s.phase === "epic") {
    if (!s.issued[EPIC_STEP]) emit(EPIC_STEP, epicCommand(plan, options));
  } else if (s.phase === "children") {
    // Create children WAVE BY WAVE: issue the earliest wave that still has an
    // uncreated child, and no LATER wave until it completes. createEpicChild
    // only needs the epic to exist (not the child's blockers), so all-at-once
    // would create correctly — but a mid-plan failure would then leave
    // DOWNSTREAM children created whose failed blockers can never be linked.
    // Wave-gating bounds a failure's blast radius to one wave. Siblings within a
    // wave are independent, so they are issued together (one round-trip/wave).
    const waves = EP.waves(plan).waves;
    for (const wave of waves) {
      const uncreated = wave.filter((id) => !s.keyByLocalId[id]);
      if (uncreated.length === 0) continue;           // this wave is complete
      for (const id of uncreated) {
        if (!s.issued[childStepId(id)]) emit(childStepId(id), childCommand(plan, options, s, id));
      }
      break;                                          // hold later waves
    }
  } else if (s.phase === "links") {
    // Every child exists now, so all links can go together — an in-flight link
    // is not re-emitted, so a batch that partly landed only re-issues the rest.
    for (const l of linkSteps(plan)) {
      const st = linkStepId(l.blocker, l.blocked);
      if (s.links[st] && s.links[st].ok) continue;    // already linked
      if (!s.issued[st]) emit(st, linkCommand(s, l.blocker, l.blocked));
    }
  }
  // s.phase === "done" falls through with no commands.

  return {
    state: s,
    commands,
    report: materializationReport(plan, s),
    done: s.phase === "done",
    failed: false,
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
  reopenState,
  derivePhase,
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
