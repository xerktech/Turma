// The wire shape every client TYPES, and the coercion that holds the agent
// record to it (XERK-259).
//
// Its OWN module for a reason that is not tidiness: `server.js` restores
// `state.json` at module init, near the top of the file, and that restore
// coerces what it loads. A `const` declared further down the file is in its
// temporal dead zone at that moment, so reading one throws a ReferenceError
// that the restore's own `catch {}` swallows — leaving records half-coerced,
// silently, on every boot. A `require` runs this file to completion first, so
// nothing here can be in that window however the table grows.
// Tests: the wire-shape cases in `turma/tests/server.test.js`.

"use strict";

// `server.js`'s own `normalize*` passes coerce three blocks by hand, each with
// its own semantics (dropping a window with no percentage, forcing
// `available:false`). This one runs after them and covers the WHOLE record,
// because "which blocks happen to have a normalize* yet" was never
// the boundary that matters: a field is decode-fatal the moment a client TYPES
// it, and Android types nearly all of `AgentInfo`. `repoUsage:[null]` — four
// bytes from one host — made the app refuse to sign in at all, reporting "Could
// not reach the hub", because `/api/agents` decodes atomically and the login
// probe reads it.
//
// Two rules this table exists to enforce, both learned the hard way:
//
//   - A LIST's ELEMENTS are as fatal as its type. Rewriting a non-array
//     `repoUsage` to `[]` and leaving `[null]` alone fixes the shape nobody
//     sends and serves the one that breaks the phone.
//   - `typeof x === "object"` is not "is an object" — `typeof [] === "object"`,
//     so an ARRAY element slips through that test. Everything here goes through
//     `isPlainObject`.
//
// Coercion is IN PLACE and touches only the keys named below. That is what keeps
// it from being a whitelist: a sub-key a newer agent adds rides through
// untouched (it is not typed anywhere yet, so `ignoreUnknownKeys` skips it),
// where rebuilding the object would drop it fleet-wide until this table caught
// up. Values become the "can't tell you" one every client already handles — ""
// / false / 0 / null / [] — never a plausible-looking default.
//
// Keep it in step with `android/.../model/Models.kt`: typing a field there and
// adding it here are the same change (see CLAUDE.md's heartbeat contract).
// Scope is the agent record only — the payload whose decode is ATOMIC. The
// per-request endpoints (history, archive, search) decode one at a time and fail
// only themselves.
//
// Spec grammar: "s"/"b"/"i"/"l"/"d" are String/Boolean/Int/Long/Double, a
// trailing "?" marking the ones a client declares nullable (they coerce to null
// rather than to a zero that reads as a real measurement); `objOf`/`listOf`/
// `mapOf` nest. The bounds are the CLIENT's, not JSON's: an Int past 2^31 and a
// non-integer Long are both decode-fatal on Android.
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const objOf = (fields) => ({ kind: "obj", fields });
const listOf = (of) => ({ kind: "list", of });
const mapOf = (of) => ({ kind: "map", of });

const WIRE_TICKET_REF = { key: "s", siteKey: "s", url: "s", summary: "s", branch: "s?" };
const WIRE_PR = { url: "s", number: "i", state: "s", title: "s", checks: "s",
                  mergeable: "s", ready: "s" };
const WIRE_BUCKET = { input: "l", output: "l", cacheWrite: "l", cacheRead: "l" };
const WIRE_USAGE = {
  today: objOf(WIRE_BUCKET), week: objOf(WIRE_BUCKET), totals: objOf(WIRE_BUCKET),
  // `days` is a Map<String, UsageBucket> on Android: a null or a string VALUE is
  // fatal there even though the same value is fine in a defaulted field, because
  // `coerceInputValues` does not reach map values. Bad entries are dropped.
  days: mapOf(objOf(WIRE_BUCKET)),
  lastActivity: "s",
  models: listOf(objOf({ model: "s", today: objOf(WIRE_BUCKET),
                         week: objOf(WIRE_BUCKET), totals: objOf(WIRE_BUCKET) })),
};
const WIRE_GITHUB_REPO = { nameWithOwner: "s", name: "s", description: "s",
                           isPrivate: "b", updatedAt: "s" };
// One transcript block. Polymorphic on `t`, so this is the UNION of every
// subclass's fields — no name collides on a different type, and a block whose
// `t` is not a string decodes as neither a known block nor the Unknown fallback:
// it throws. Coercing `t` to "" lands it on that fallback instead.
const WIRE_BLOCK = {
  t: "s", text: "s", truncated: "b", id: "s", name: "s", caption: "s",
  files: listOf(objOf({ name: "s", kind: "s", src: "s", html: "s" })),
  forId: "s", isError: "b", summary: "s", status: "s", result: "s", ignored: "s",
  // `input` is a ToolUseBlock's raw tool arguments, typed `JsonElement?` —
  // deliberately ANY shape, so it is the one field here left alone.
};
const WIRE_LIVE = {
  paneBusy: "b?", agents: listOf(objOf({ type: "s", label: "s" })),
  transcriptAgeSec: "d?", lastRole: "s", lastHasToolUse: "b", bridgeAttached: "b",
  question: "s", questionOptions: listOf("s"),
  questionOptionsRich: listOf(objOf({ label: "s", description: "s", preview: "s" })),
  questionHeader: "s", questionIndex: "i?", questionTotal: "i?", questionMulti: "b",
  newPrUrls: listOf("s"),
  tail: listOf(objOf({ id: "s", uuid: "s", role: "s", text: "s", ts: "s",
                       blocks: listOf(objOf(WIRE_BLOCK)) })),
};
const WIRE_SESSION = {
  id: "s", status: "s", repo: "s", worktreePath: "s", branch: "s",
  git: objOf({ repoName: "s", branch: "s", dirtyFiles: "i" }),
  summary: "s", label: "s", root: "b", rcName: "s", ttydPort: "i", model: "s",
  permissionMode: "s", modelSource: "s", modelSourceAt: "s",
  usage: objOf(WIRE_USAGE), prs: listOf(objOf(WIRE_PR)), newWorkSincePrs: "b",
  session: objOf(WIRE_LIVE), ticket: objOf(WIRE_TICKET_REF), spawnCmdId: "s",
  transcriptId: "s", createdAt: "s", stoppedAt: "s", errorMsg: "s",
  queuedReason: "s", queuedAt: "s", restartCount: "i",
  work: objOf({ baseRef: "s?", aheadOfBase: "i?", pushed: "b?", aheadOfRemote: "i?" }),
};
const WIRE_JIRA = {
  available: "b", configured: "b", site: "s", siteKey: "s", user: "s",
  fetchedAt: "s", error: "s?", truncated: "b", orgName: "s", source: "s",
  tickets: listOf(objOf({
    key: "s", url: "s", summary: "s", status: "s", statusCategory: "s",
    priority: "s", type: "s", project: "s", projectName: "s", labels: listOf("s"),
    updated: "s", created: "s", dueDate: "s?", parentKey: "s?",
    repoGuess: objOf({ repo: "s?", cloned: "b", nameWithOwner: "s?", reason: "s",
                       at: "s", manual: "b" }),
  })),
  repoOptions: listOf(objOf({ name: "s", cloned: "b", nameWithOwner: "s?",
                              description: "s" })),
};
const AGENT_WIRE_SHAPE = {
  device: "s", claudeVersion: "s", agentVersion: "s", startedAt: "s",
  codingAgent: objOf({ name: "s", version: "s" }),
  claudeAuth: objOf({ present: "b", needsLogin: "b", expiringSoon: "b",
                      refreshExpiresAt: "l?" }),
  updating: objOf({ version: "s", until: "l" }),
  repos: listOf(objOf({
    name: "s", root: "b", lastActivity: "s",
    resumable: listOf(objOf({ transcriptId: "s", cwd: "s", repo: "s", root: "b",
                              summary: "s", endedTs: "s",
                              ticket: objOf(WIRE_TICKET_REF),
                              prs: listOf(objOf(WIRE_PR)) })),
  })),
  sessions: listOf(objOf(WIRE_SESSION)),
  models: objOf({ available: listOf("s"), defaultLabel: "s", at: "s" }),
  usage: objOf(WIRE_USAGE),
  repoUsage: listOf(objOf({ repo: "s", remoteKey: "s", usage: objOf(WIRE_USAGE) })),
  github: objOf({ available: "b", login: "s", repos: listOf(objOf(WIRE_GITHUB_REPO)) }),
  gitSources: listOf(objOf({ source: "s", label: "s", available: "b", user: "s",
                             repos: listOf(objOf(WIRE_GITHUB_REPO)) })),
  clones: listOf(objOf({ repo: "s", name: "s", status: "s", error: "s",
                         startedAt: "s" })),
  // Hub-authored rather than agent-authored, and listed anyway: a table with a
  // hole in it is one the next reader has to re-derive to trust.
  commands: listOf(objOf({ type: "s", cmdId: "s", sessionId: "s", repo: "s" })),
  jira: objOf(WIRE_JIRA),
  closedSessions: listOf(objOf({
    id: "s", repo: "s", branch: "s", root: "b", summary: "s", summaryManual: "b",
    label: "s", createdAt: "s", closedAt: "s", ticket: objOf(WIRE_TICKET_REF),
    transcriptId: "s", prs: listOf(objOf(WIRE_PR)),
  })),
  capacity: objOf({ maxSessions: "i", running: "i", queued: "i", free: "i",
                    rootRunning: "b" }),
  uploadMaxBytes: "l",
  // `normalizeLimits`/`normalizeLocalModel` rebuild these two wholesale, which
  // is not a reason to leave them out — a rebuild is only as good as its own
  // gates, and `limits` shipped for a release gating its two epoch fields on
  // `Number.isFinite`, so `resetsAt: 1.5` (a Long cannot take a fractional
  // literal) went out raw and killed the whole payload. Listed here they get the
  // same backstop as everything else AND the Models.kt drift test, which is the
  // part that keeps the next such gap from lasting a release.
  limits: objOf({
    fiveHour: objOf({ usedPct: "d?", resetsAt: "l?" }),
    sevenDay: objOf({ usedPct: "d?", resetsAt: "l?" }),
    capturedAt: "l", source: "s",
  }),
  localModel: objOf({ available: "b", model: "s?", contextTokens: "i?" }),
};

// Sentinel for "this value cannot be made decodable" — a list element or map
// value, where the only repair is to drop it (a null there is fatal, unlike a
// null in a defaulted FIELD, which every client reads as its default).
const WIRE_DROP = Symbol("drop");

const WIRE_SCALAR_OK = {
  s: (v) => typeof v === "string",
  b: (v) => typeof v === "boolean",
  // Kotlin `Int` is 32-bit and `Long` cannot take a fractional literal; either
  // overflow throws for the whole payload, so both are checked here, not just
  // "is a number".
  i: (v) => typeof v === "number" && Number.isInteger(v) &&
            v >= -2147483648 && v <= 2147483647,
  l: (v) => typeof v === "number" && Number.isSafeInteger(v),
  d: (v) => typeof v === "number" && Number.isFinite(v),
};
const WIRE_SCALAR_ZERO = { s: "", b: false, i: 0, l: 0, d: 0 };

// Coerce one value against one spec. `nullOk` is the difference between a FIELD
// (a null is that client's default — leave it) and a list element or map value
// (a null throws — drop it).
function coerceWireValue(v, spec, nullOk) {
  if (v === null || v === undefined) return nullOk ? v : WIRE_DROP;
  if (typeof spec === "string") {
    const nullable = spec.endsWith("?");
    const tag = nullable ? spec.slice(0, -1) : spec;
    // A tag the grammar doesn't define is a typo in the table, not a value to
    // judge: pass the value through rather than throw, since a throw in here is
    // a refused beat on ingest and an abandoned record on the restore path.
    // `every spec tag in AGENT_WIRE_SHAPE is one the walker knows` is the test
    // that catches the typo instead.
    if (!WIRE_SCALAR_OK[tag]) return v;
    if (WIRE_SCALAR_OK[tag](v)) return v;
    if (!nullOk) return WIRE_DROP;
    return nullable ? null : WIRE_SCALAR_ZERO[tag];
  }
  if (spec.kind === "obj") {
    if (!isPlainObject(v)) return nullOk ? null : WIRE_DROP;
    coerceWireFields(v, spec.fields);
    return v;
  }
  if (spec.kind === "list") {
    // A non-array becomes [], the shape "this host reported none" already has.
    if (!Array.isArray(v)) return nullOk ? [] : WIRE_DROP;
    // Compacted IN PLACE — no new array, no `push(...kept)` spread that would
    // blow the stack on a long list, and the record keeps holding the same
    // array `commands` was queued into.
    let w = 0;
    for (let r = 0; r < v.length; r++) {
      const c = coerceWireValue(v[r], spec.of, false);
      if (c !== WIRE_DROP) v[w++] = c;
    }
    v.length = w;
    return v;
  }
  // map: string keys only, and a value that cannot be coerced is deleted.
  if (!isPlainObject(v)) return nullOk ? {} : WIRE_DROP;
  for (const k of Object.keys(v)) {
    const c = coerceWireValue(v[k], spec.of, false);
    if (c === WIRE_DROP) delete v[k];
    else v[k] = c;
  }
  return v;
}

// Walk one object against its spec, touching ONLY the keys the spec names and
// only when the record actually carries them — an older agent's payload has to
// come out byte-identical, and a key it never sent must not appear.
function coerceWireFields(target, fields) {
  for (const k of Object.keys(fields)) {
    // hasOwnProperty, not `in`: `in` walks the prototype chain, so a field
    // sharing a name with an Object.prototype member would read as present on
    // every record and be written onto one that never carried it.
    if (!Object.prototype.hasOwnProperty.call(target, k)) continue;
    target[k] = coerceWireValue(target[k], fields[k], true);
  }
}

function normalizeWireShapes(a) {
  if (!isPlainObject(a)) return;
  coerceWireFields(a, AGENT_WIRE_SHAPE);
}

module.exports = { normalizeWireShapes, AGENT_WIRE_SHAPE };
