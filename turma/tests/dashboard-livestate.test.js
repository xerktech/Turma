// Unit tests for the Dashboard's own `liveState` (the inline script in
// public/index.html). It is the SIXTH copy of the working/idle read — the five
// `readyForReview` mirrors in CLAUDE.md plus this one — and it was the only copy
// no test loaded: a QA mutation pass disabled its background-agent branch
// outright and every suite stayed green (XERK-245).
//
// The code lives inline rather than in a require-able module, so this loads the
// page's <script> body under lightweight browser-global stubs and drives the
// real function — node:test, no npm, matching this package's stance. Harness
// shape borrowed from clone.test.js, which does the same for the clone bar.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadDashboard() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const store = {};
  const g = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      get activeElement() { return null; },
      createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
      body: {}, title: "",
    },
    EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
    fetch: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ agents: [] }), text: () => Promise.resolve("") }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    location: { pathname: "/", href: "" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    TurmaOrg: { get: () => "", filter: (a) => a || [], update() {}, subscribe() {}, sse() {} },
  };
  g.window = g; g.globalThis = g;

  const fn = new Function(
    "localStorage", "document", "window", "EventSource", "fetch",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "location", "matchMedia", "TurmaOrg", "globalThis",
    src + "\n;globalThis.__dash = { liveState };\n;globalThis.__setRender = (f) => { render = f; };"
  );
  fn(g.localStorage, g.document, g.window, g.EventSource, g.fetch,
     g.setInterval, g.clearInterval, g.setTimeout, g.clearTimeout, g.location, g.matchMedia, g.TurmaOrg, g);
  // The page's boot refresh() resolves after the test ends and would paint into
  // the stub DOM; neuter it, as clone.test.js does.
  g.__setRender(() => {});
  return g.__dash;
}

const NOW = 1_000_000;
const onlineHost = { online: true, lastSeen: NOW };
const sess = (session) => ({ session });

test("dashboard liveState: paneBusy still decides when no agents are reported", () => {
  const { liveState } = loadDashboard();
  assert.equal(liveState(sess({ paneBusy: true, transcriptAgeSec: 3 }), onlineHost, NOW).label, "working");
  assert.equal(liveState(sess({ paneBusy: false, transcriptAgeSec: 900 }), onlineHost, NOW).label, "idle");
});

// XERK-245: a session that delegated work ends its own turn, so paneBusy reads
// false while an agent it launched keeps going.
test("dashboard liveState: background agents read as working and are named", () => {
  const { liveState } = loadDashboard();
  const one = liveState(
    sess({ paneBusy: false, transcriptAgeSec: 900, agents: [{ type: "qa", label: "QA it" }] }),
    onlineHost, NOW);
  assert.equal(one.label, "1 background agent");
  assert.equal(one.cls, "sess-working");
  assert.equal(one.busy, true);

  const many = liveState(
    sess({ paneBusy: false, transcriptAgeSec: 900, agents: [{ type: "qa" }, { type: "Explore" }] }),
    onlineHost, NOW);
  assert.equal(many.label, "2 background agents");
});

test("dashboard liveState: empty list is 'no agents'; a missing field changes nothing", () => {
  const { liveState } = loadDashboard();
  assert.equal(liveState(sess({ paneBusy: false, transcriptAgeSec: 900, agents: [] }), onlineHost, NOW).label, "idle");
  assert.equal(liveState(sess({ paneBusy: false, transcriptAgeSec: 900 }), onlineHost, NOW).label, "idle");
});

test("dashboard liveState: agents stay behind the offline and waiting gates", () => {
  const { liveState } = loadDashboard();
  const live = { paneBusy: false, transcriptAgeSec: 900, agents: [{ type: "qa", label: "QA it" }] };
  // A host that died mid-run must not leave its sessions reading working forever.
  const offline = { online: false, lastSeen: NOW - 600_000 };
  assert.equal(liveState(sess(live), offline, NOW).label, "idle");
  // A pending question outranks it — it is blocked on a human either way.
  assert.equal(
    liveState(sess({ ...live, question: "Pick one?" }), onlineHost, NOW).label,
    "waiting for your answer");
  // And no transcript yet is decided before any of it.
  assert.equal(
    liveState(sess({ agents: live.agents, transcriptAgeSec: null }), onlineHost, NOW).label,
    "no transcript yet");
});
