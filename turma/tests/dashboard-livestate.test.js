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
    src + "\n;globalThis.__dash = { liveState, prBadgeHtml, fmtTokens };\n;globalThis.__setRender = (f) => { render = f; };"
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

// XERK-162: the dashboard's own prBadgeHtml copy labels a GitLab MR / ADO PR
// with its platform's !n sigil, GitHub with #n. Guarded here because this copy
// lives inline in index.html — a QA mutation pass flipped its sigil back to
// "#" and every suite stayed green.
test("dashboard prBadgeHtml: !n for GitLab/ADO, #n for GitHub", () => {
  const { prBadgeHtml } = loadDashboard();
  assert.match(prBadgeHtml({ url: "https://github.com/o/r/pull/7", number: 7, state: "OPEN" }), /#7/);
  const mr = prBadgeHtml({
    url: "https://gitlab.example.com/grp/app/-/merge_requests/12",
    number: 12, state: "OPEN",
  });
  assert.match(mr, /!12/);
  assert.doesNotMatch(mr, /#12/);
  // The URL fallback (bare {url} chip, no status yet) takes the same sigil.
  assert.match(
    prBadgeHtml({ url: "https://gitlab.example.com/grp/app/-/merge_requests/13" }), /!13/);
  assert.match(
    prBadgeHtml({ url: "https://dev.azure.com/org/P/_git/app/pullrequest/9" }), /!9/);
});

// --- fmtTokens (the dashboard's own copy) ------------------------------------
// The THIRD copy of this formatter — usage.html and ui/UsageScreen.kt are the
// others — and until now the only one no test loaded. Its tiles show the same
// fleet figures as the Usage page's headline strip and the Android screens, so
// it has to agree with them digit for digit; its own contract, which the others
// do NOT share, is "–" for a null count.

test("dashboard fmtTokens: '–' for a count the fleet cannot state", () => {
  // The dashboard's tiles are drawn before any host has reported, so null here
  // means "nothing known yet", not "zero tokens". A mutation to "0" was
  // invisible to every suite.
  const { fmtTokens } = loadDashboard();
  assert.equal(fmtTokens(null), "–");
  assert.equal(fmtTokens(undefined), "–");
  assert.equal(fmtTokens(NaN), "–");
  assert.equal(fmtTokens("<img src=x onerror=1>"), "–");
  assert.equal(fmtTokens(0), "0");
});

test("dashboard fmtTokens: same digits as the Usage page and Android", () => {
  // Shared vectors with turma/tests/usage.test.js and ui/FmtTokensTest.kt. The
  // .x5 boundaries are where a float-rounding implementation diverges.
  const { fmtTokens } = loadDashboard();
  assert.equal(fmtTokens(1150), "1.2k");
  assert.equal(fmtTokens(1_450_000), "1.5M");
  assert.equal(fmtTokens(1_950_000_000), "2.0B");
  assert.equal(fmtTokens(999_950), "1000.0k");
  assert.equal(fmtTokens(850), "850");
  assert.equal(fmtTokens(272_500_000), "272.5M");
  assert.equal(fmtTokens(1e30).includes("e+"), false);
  // The unscaled fall-through is the same trap on the other path.
  assert.equal(fmtTokens(-1e21), "-1000000000000000000000");
  assert.equal(fmtTokens(5e-324), "0");
  assert.equal(fmtTokens(-1500), "-1500");
});

test("dashboard fmtTokens: the unit boundary is inclusive, as everywhere else", () => {
  // 1000 is 1.0k, not "1000" — a `>` here and a `>=` on the Usage page is a
  // divergence at exactly the value most likely to be looked at.
  const { fmtTokens } = loadDashboard();
  assert.equal(fmtTokens(1_000), "1.0k");
  assert.equal(fmtTokens(1_000_000), "1.0M");
  assert.equal(fmtTokens(1_000_000_000), "1.0B");
});
