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
    sess({ paneBusy: false, transcriptAgeSec: 900, agents: [{ type: "Explore", label: "Search it" }] }),
    onlineHost, NOW);
  assert.equal(one.label, "1 background agent");
  assert.equal(one.cls, "sess-working");
  assert.equal(one.busy, true);

  const many = liveState(
    sess({ paneBusy: false, transcriptAgeSec: 900, agents: [{ type: "Explore" }, { type: "general-purpose" }] }),
    onlineHost, NOW);
  assert.equal(many.label, "2 background agents");
});

// A background shell (Bash run_in_background) rides `agents` as a `shell` row:
// the session is working, and the label says what kind of work it is.
test("dashboard liveState: a background shell reads as working and is named", () => {
  const { liveState } = loadDashboard();
  const shell = liveState(
    sess({ paneBusy: false, transcriptAgeSec: 900, agents: [{ type: "shell", label: "Watch CI" }] }),
    onlineHost, NOW);
  assert.equal(shell.label, "1 background shell");
  assert.equal(shell.cls, "sess-working");
  const mixed = liveState(
    sess({ paneBusy: false, transcriptAgeSec: 900, agents: [{ type: "shell" }, { type: "Explore" }] }),
    onlineHost, NOW);
  assert.equal(mixed.label, "2 background tasks");
});

// XERK-1570: a WAITING shell is not work — the card says what it waits on, in
// the quiet holding style, and a stalled one says so without reading busy.
test("dashboard liveState: waiting shells hold, stall, and never read working", () => {
  const { liveState } = loadDashboard();
  const ci = { type: "shell", label: "Watch CI", kind: "wait-external" };
  const held = liveState(sess({ paneBusy: false, transcriptAgeSec: 5, agents: [ci] }), onlineHost, NOW);
  assert.equal(held.label, "⏳ waiting · Watch CI");
  assert.equal(held.cls, "sess-holding");
  assert.notEqual(held.busy, true);
  const timed = liveState(sess({ paneBusy: false, transcriptAgeSec: 5,
    agents: [{ type: "shell", kind: "wait-timed", eta: NOW + 5 * 60 * 1000 }] }), onlineHost, NOW);
  assert.equal(timed.label, "⏳ waiting · 5m left");
  const stalled = liveState(sess({ paneBusy: false, transcriptAgeSec: 50 * 60, agents: [ci] }), onlineHost, NOW);
  assert.equal(stalled.label, "stalled · Watch CI");
  // XERK-1571: the danger tone it has on every surface.
  assert.equal(stalled.cls, "sess-stalled");
  // A work shell beside the wait is working, named by its work rows only.
  const mixed = liveState(sess({ paneBusy: false, transcriptAgeSec: 5,
    agents: [ci, { type: "shell", kind: "work" }] }), onlineHost, NOW);
  assert.equal(mixed.label, "1 background shell");
  assert.equal(mixed.cls, "sess-working");
  // paneBusy unknown + a fresh transcript: still not working.
  assert.equal(liveState(sess({ transcriptAgeSec: 1, agents: [ci] }), onlineHost, NOW).cls, "sess-holding");
  // Offline host: no wait read at all — plain idle.
  assert.equal(liveState(sess({ paneBusy: false, transcriptAgeSec: 5, agents: [ci] }),
    { online: false, lastSeen: NOW - 600_000 }, NOW).label, "idle");
});

// XERK-1571: a wait with no ETA says how long it has waited, off the oldest
// wait row's startedAt; an ETA still says the time left.
test("dashboard liveState: a wait with no ETA says how long it has waited", () => {
  const { liveState } = loadDashboard();
  const ci = { type: "shell", label: "Watch CI on PR #412", kind: "wait-external", startedAt: NOW - 12 * 60 * 1000 };
  const ciCard = liveState(sess({ paneBusy: false, transcriptAgeSec: 12 * 60, agents: [ci] }), onlineHost, NOW);
  assert.equal(ciCard.label, "⏳ waiting · Watch CI on PR #412 · 12m");
  // Screenshot defect: "· 12m · last write 12m ago" was two ages for one wait.
  // The wait's own age is the card's one clock.
  assert.equal(ciCard.detail, "");
  const two = [{ ...ci, label: "" }, { type: "shell", kind: "wait-timed", startedAt: NOW - 20 * 60 * 1000 }];
  assert.equal(liveState(sess({ paneBusy: false, transcriptAgeSec: 5, agents: two }), onlineHost, NOW).label,
    "⏳ waiting on 2 background shells · 20m");
  const timed = { ...ci, kind: "wait-timed", eta: NOW + 11 * 60 * 1000 };
  const timedCard = liveState(sess({ paneBusy: false, transcriptAgeSec: 5, agents: [timed] }), onlineHost, NOW);
  assert.equal(timedCard.label, "⏳ waiting · Watch CI on PR #412 · 11m left");
  // Time LEFT is not an age: the last write still shows beside it.
  assert.match(timedCard.detail, /^last write 5s/);
  // A wait row with no startedAt (an older agent): the last write is its only clock.
  const { startedAt, ...noStart } = ci;
  assert.match(liveState(sess({ paneBusy: false, transcriptAgeSec: 5, agents: [noStart] }), onlineHost, NOW).detail,
    /^last write 5s/);
  // Stalled: no start age — the stall's own age (the hub's `since`) is the
  // State row's, and a second number here read as a second stall length.
  assert.equal(liveState(sess({ paneBusy: false, transcriptAgeSec: 50 * 60, agents: [ci] }), onlineHost, NOW).label,
    "stalled · Watch CI on PR #412");
});

// XERK-1571 screenshot defect: a stalled card showed a second age (its last
// write) beside the 31m the hub says it has been stalled. It now shows ONE age,
// the hub's attention `since`; "last write" stays only for an older hub.
test("dashboard liveState: a stall shows one age, the hub's since", () => {
  const { liveState } = loadDashboard();
  const ci = { type: "shell", label: "Watch CI", kind: "wait-external", startedAt: NOW - 60 * 60 * 1000 };
  const s = { paneBusy: false, transcriptAgeSec: 50 * 60, agents: [ci] };
  const stalled = liveState({ session: s,
    attention: { state: "needs-you:stalled", since: NOW - 31 * 60 * 1000, why: "Watch CI" } }, onlineHost, NOW);
  assert.equal(stalled.label, "stalled · Watch CI");
  // The age is glued to its word by a no-break space, so "31m" never wraps alone.
  assert.equal(stalled.detail, "for\u00a031m");
  assert.equal(stalled.cls, "sess-stalled");
  // The hub is a beat behind (still "waiting"): no second number at all.
  assert.equal(liveState({ session: s, attention: { state: "waiting", since: NOW - 60_000 } }, onlineHost, NOW).detail, "");
  // An older hub: the transcript's last write is the only clock there is.
  assert.match(liveState({ session: s }, onlineHost, NOW).detail, /^last write 50m/);
});

// XERK-1571: a permission dialog is not a question — the card says so and names
// the pending command (the hub's why), falling back to the dialog's question
// from an older hub that serves no attention.
test("dashboard liveState: a permission names what it asks for", () => {
  const { liveState } = loadDashboard();
  const pp = { paneBusy: false, transcriptAgeSec: 5, panePrompt: { prompt: "Do you want to proceed?" } };
  const withWhy = liveState({ session: pp,
    attention: { state: "needs-you:permission", since: NOW, why: "Bash: kubectl rollout restart" } }, onlineHost, NOW);
  assert.equal(withWhy.label, "waiting for your permission");
  assert.equal(withWhy.ask, "Bash: kubectl rollout restart");
  assert.equal(withWhy.question, undefined);
  // Screenshot defect: the State row showed an age for review and stalled but
  // not here, where the Sessions page shows "for 4m". Now it does.
  const asked = liveState({ session: pp,
    attention: { state: "needs-you:permission", since: NOW - 4 * 60 * 1000, why: "Bash: ls" } }, onlineHost, NOW);
  assert.equal(asked.detail, "for\u00a04m");
  assert.equal(liveState({ session: pp }, onlineHost, NOW).ask, "Do you want to proceed?");
});

// XERK-1571 screenshot defect: a question card's State row carries how long it
// has waited, like every other needs-you card and the Sessions page's "for 22m".
test("dashboard liveState: a question card says how long it has waited", () => {
  const { liveState } = loadDashboard();
  const q = { paneBusy: false, transcriptAgeSec: 5, question: "Ship it?" };
  const card = liveState({ session: q,
    attention: { state: "needs-you:question", since: NOW - 22 * 60 * 1000 } }, onlineHost, NOW);
  assert.equal(card.label, "waiting for your answer");
  assert.equal(card.detail, "for\u00a022m");
  // The hub a beat behind (still "review"): not the review's age under a question.
  assert.equal(liveState({ session: q,
    attention: { state: "needs-you:review", since: NOW - 47 * 60 * 1000 } }, onlineHost, NOW).detail, "");
  // An older hub: no age, as before.
  assert.equal(liveState({ session: q }, onlineHost, NOW).detail, "");
});

// XERK-1571: a card the hub says needs the operator never reads "idle" — its
// State row takes the attention read Ready for review lists it under.
test("dashboard liveState: a needs-you session reads its attention, never idle", () => {
  const { liveState } = loadDashboard();
  const done = { paneBusy: false, transcriptAgeSec: 52 * 60 };
  const review = liveState({ session: done,
    attention: { state: "needs-you:review", since: NOW - 60_000, why: "PR open · CI passing" } }, onlineHost, NOW);
  assert.equal(review.label, "review · PR open · CI passing");
  assert.equal(review.cls, "sess-review");
  // How long it has waited is the hub's since — one age, not the last write.
  assert.equal(review.detail, "for\u00a01m");
  const stalled = liveState({ session: done,
    attention: { state: "needs-you:stalled", since: NOW - 60_000, why: "Watch CI" } }, onlineHost, NOW);
  assert.equal(stalled.label, "stalled · Watch CI");
  assert.equal(stalled.cls, "sess-stalled");
  // No attention (an older hub) or a non-needs-you state: idle as before.
  assert.equal(liveState({ session: done }, onlineHost, NOW).label, "idle");
  assert.equal(liveState({ session: done, attention: { state: "idle", since: NOW } }, onlineHost, NOW).label, "idle");
  // Working outranks it.
  assert.equal(liveState({ session: { paneBusy: true, transcriptAgeSec: 1 },
    attention: { state: "needs-you:review", since: NOW } }, onlineHost, NOW).label, "working");
});

// XERK-1571: a session-CLI wake still ahead reads sleeping (holding style), "until
// HH:MM" in local time; a due wake no longer does.
test("dashboard liveState: a pending wake reads sleeping until its time", () => {
  const { liveState } = loadDashboard();
  const wakeAt = NOW + 30 * 60 * 1000;
  const d = new Date(wakeAt), p = (n) => String(n).padStart(2, "0");
  const asleep = liveState(sess({ paneBusy: false, transcriptAgeSec: 5, wakeAt }), onlineHost, NOW);
  assert.equal(asleep.label, `💤 sleeping until ${p(d.getHours())}:${p(d.getMinutes())}`);
  assert.equal(asleep.cls, "sess-holding");
  // The wake reason, when the session gave one, says what it will check.
  assert.equal(liveState(sess({ paneBusy: false, transcriptAgeSec: 5, wakeAt, wakeReason: " check CI on #412 " }), onlineHost, NOW).label,
    `💤 sleeping until ${p(d.getHours())}:${p(d.getMinutes())} · check CI on #412`);
  assert.notEqual(asleep.busy, true);
  assert.equal(liveState(sess({ paneBusy: false, transcriptAgeSec: 5, wakeAt: NOW - 1000 }), onlineHost, NOW).label, "idle");
  // Working outranks it: a session still finishing its turn is working.
  assert.equal(liveState(sess({ paneBusy: true, transcriptAgeSec: 1, wakeAt }), onlineHost, NOW).label, "working");
});

// XERK-538: a QA / QA-delta pass reads "QA Review" while staying working (Active).
test("dashboard liveState: a QA agent reads 'QA Review' and stays working", () => {
  const { liveState } = loadDashboard();
  const qa = liveState(
    sess({ paneBusy: false, transcriptAgeSec: 900, agents: [{ type: "qa", label: "QA it" }] }),
    onlineHost, NOW);
  assert.equal(qa.label, "QA Review");
  assert.equal(qa.cls, "sess-working");
  assert.equal(qa.busy, true);

  // qa-delta wins over a co-running ordinary agent.
  const delta = liveState(
    sess({ paneBusy: false, transcriptAgeSec: 900, agents: [{ type: "Explore" }, { type: "qa-delta" }] }),
    onlineHost, NOW);
  assert.equal(delta.label, "QA Review");
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
  // Rounded BEFORE the scale is picked, like the Usage page: rounding after
  // lets 999.6 escape the k scale and then land on "1000". Pinned here as well
  // as there, because this copy's rounding was otherwise held only by the
  // 5e-324 vector — which truncation satisfies too, leaving the two pages free
  // to disagree at exactly the value this is about.
  assert.equal(fmtTokens(999.6), "1.0k");
  assert.equal(fmtTokens(999_999.6), "1.0M");
  assert.equal(fmtTokens(999_999_999.6), "1.0B");
  assert.equal(fmtTokens(999.4), "999");
  assert.equal(fmtTokens(0.6), "1");
});

test("dashboard fmtTokens: the unit boundary is inclusive, as everywhere else", () => {
  // 1000 is 1.0k, not "1000" — a `>` here and a `>=` on the Usage page is a
  // divergence at exactly the value most likely to be looked at.
  const { fmtTokens } = loadDashboard();
  assert.equal(fmtTokens(1_000), "1.0k");
  assert.equal(fmtTokens(1_000_000), "1.0M");
  assert.equal(fmtTokens(1_000_000_000), "1.0B");
});
