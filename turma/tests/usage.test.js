// Unit tests for the Usage page's pure helpers (public/usage.html): the token
// cells — the cache read/write split and the hit rate that says whether sessions
// on a repo are re-paying for the same prompt prefix instead of reading it back
// from cache — and the subscription-limit snapshot readers beneath them.
// node:test, no npm — matches this package's zero-dependency stance. There's no
// jsdom here, so the page's real inline <script> is loaded into a minimal DOM
// shim (the same trick sessions.test.js uses) and the pure helpers are returned
// out of the sandbox; only those helpers are exercised, so the shim only has to
// be complete enough for the page's boot to not throw.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "usage.html"), "utf8");
// The page loads board.js/nav.js/org.js/newticket.js by <script src>, then its
// own logic in the one inline block — take the last, which is that block.
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const script = blocks[blocks.length - 1][1];

function makeEl() {
  const el = {
    _html: "", textContent: "", value: "", hidden: false,
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    append(...c) { this.children.push(...c); },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...c) { this.children = c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; }, remove() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; }, set(v) { this._html = String(v); },
  });
  return el;
}

// Run the page once and hand back the pure helpers. The page's boot calls
// (renderViewbar/connectSSE/the poll) run against the shim and are inert: fetch
// never settles and EventSource is a no-op, so nothing renders.
function loadHelpers() {
  const els = {};
  const noop = () => {};
  const document = {
    getElementById(id) { return (els[id] ||= makeEl()); },
    createElement() { return makeEl(); },
    createElementNS() { return makeEl(); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener: noop, removeEventListener: noop,
    body: makeEl(), documentElement: makeEl(),
  };
  const stubs = {
    document,
    localStorage: {
      _m: {},
      getItem(k) { return this._m[k] ?? null; },
      setItem(k, v) { this._m[k] = String(v); },
      removeItem(k) { delete this._m[k]; },
    },
    location: { href: "", search: "", pathname: "/usage" },
    navigator: { userAgent: "node" },
    fetch: () => new Promise(() => {}),
    EventSource: class { addEventListener() {} close() {} },
    setInterval: () => 0, clearInterval: noop,
    setTimeout: () => 0, clearTimeout: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    history: { replaceState: noop, pushState: noop },
    URL: global.URL, URLSearchParams: global.URLSearchParams,
    console, Date, Math, JSON, encodeURIComponent, decodeURIComponent,
    parseInt, parseFloat, isNaN, Number, String, Object, Array, Map, Set,
    addEventListener: noop, removeEventListener: noop,
    TurmaNav: { preserveScroll: (_el, paint) => paint() },
    TurmaOrg: { get: () => "", update: noop, filter: (a) => a, subscribe: noop, sse: noop, orgColors: () => ({}) },
    TurmaBoard: { orgName: (k) => k, orgColorMap: () => ({}) },
    TurmaNewTicket: { update: noop },
  };
  const keys = Object.keys(stubs);
  const body = `${script}\n;return { tokenCell, cacheSubLine, cacheHitRate, blankBucket,
    limitEntries, limitWindowView, fmtDuration, LIMIT_STALE_SEC, LIMIT_MAX_AGE_SEC,
    blankUsage, mergeUsageInto, subagentCard };`;
  return new Function(...keys, body)(...keys.map((k) => stubs[k]));
}

const H = loadHelpers();
const bucket = (o) => Object.assign(H.blankBucket(), o);

// --- cacheHitRate ------------------------------------------------------------
// The denominator is the prompt (input + cacheWrite + cacheRead), never output:
// output is generated, never served from cache, so counting it would make a
// perfectly-cached repo look like it was missing.

test("cacheHitRate is the cached share of the prompt, excluding output", () => {
  // 900 read of a 1000-token prompt, with a big output that must not dilute it.
  assert.equal(H.cacheHitRate(bucket({ input: 100, cacheRead: 900, output: 50_000 })), 90);
});

test("cacheHitRate counts a cache WRITE as a miss", () => {
  // The session paid 1.25x to write this prefix; it read none of it back.
  assert.equal(H.cacheHitRate(bucket({ input: 0, cacheWrite: 1000 })), 0);
});

test("cacheHitRate is null when there is no prompt traffic to take a ratio of", () => {
  assert.equal(H.cacheHitRate(bucket({ output: 500 })), null);
  assert.equal(H.cacheHitRate(bucket({})), null);
  assert.equal(H.cacheHitRate(null), null);
});

test("cacheHitRate rounds rather than truncating", () => {
  // 2/3 -> 67, not 66.
  assert.equal(H.cacheHitRate(bucket({ input: 1000, cacheRead: 2000 })), 67);
});

// --- cacheSubLine ------------------------------------------------------------

test("cacheSubLine is omitted entirely for a bucket with no cache traffic", () => {
  // An older agent reports no cache fields at all; "0 cached · 0 written" would
  // read as caching being broken rather than simply unreported.
  assert.equal(H.cacheSubLine(bucket({ input: 500, output: 200 })), "");
});

test("cacheSubLine shows read, write and hit rate once there is cache traffic", () => {
  const out = H.cacheSubLine(bucket({ input: 1000, cacheRead: 9000, cacheWrite: 0 }));
  assert.match(out, /9\.0k cached/);
  assert.match(out, /0 written/);
  assert.match(out, /90% hit/);
});

test("cacheSubLine survives a write-only bucket (first session on a prefix)", () => {
  const out = H.cacheSubLine(bucket({ cacheWrite: 4000 }));
  assert.match(out, /0 cached/);
  assert.match(out, /4\.0k written/);
  assert.match(out, /0% hit/);
});

// --- tokenCell ---------------------------------------------------------------

test("tokenCell keeps the in/out line and adds the cache line beneath it", () => {
  const td = H.tokenCell(bucket({ input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 4000 }));
  // Total stays the sum of all four keys — the headline number is unchanged.
  assert.match(td, /class="tok">10\.0k</);
  assert.match(td, /1\.0k in · 2\.0k out/);
  assert.match(td, /3\.0k cached · 4\.0k written/);
  // Two sub-lines, so the cache split lands under the in/out split.
  assert.equal((td.match(/sub-tok/g) || []).length, 2);
});

test("tokenCell renders a single sub-line when no cache is reported", () => {
  const td = H.tokenCell(bucket({ input: 10, output: 20 }));
  assert.equal((td.match(/sub-tok/g) || []).length, 1);
  assert.match(td, /10 in · 20 out/);
});

test("tokenCell still collapses an empty bucket to a dash", () => {
  assert.match(H.tokenCell(bucket({})), /class="zero">–</);
  assert.match(H.tokenCell(null), /–/);
});

test("tokenCell keeps the caller's column class alongside the cache line", () => {
  const td = H.tokenCell(bucket({ input: 1, cacheRead: 9 }), "total-col");
  assert.match(td, /class="total-col"/);
  assert.match(td, /90% hit/);
});

// --- subscription limits (XERK-247) -----------------------------------------
// The 5h/7d windows arrive as a snapshot per host, not as live numbers, so the
// tests below are mostly about what the page does with an OLD one.

const NOW = 1_786_400_000; // epoch seconds, fixed so countdowns are assertable

test("limitEntries skips a host that reports no limits at all", () => {
  // An agent too old to send the field, a login with no subscription windows,
  // and one whose block carries neither window all mean the same thing: this
  // host can't tell you. None of them is a card with zeroes in it.
  const entries = H.limitEntries([
    { device: "old-host" },
    { device: "api-key-host", limits: null },
    { device: "empty-host", limits: { capturedAt: NOW } },
    // A window with a reset time but no percentage draws nothing, so it is not
    // a card — it would render as a host name with no rows under it.
    { device: "no-pct-host", limits: { capturedAt: NOW, fiveHour: { resetsAt: NOW + 60 } } },
    { device: "real-host", limits: { capturedAt: NOW, fiveHour: { usedPct: 5 } } },
  ], NOW);
  assert.deepEqual(entries.map((e) => e.host), ["real-host"]);
});

test("limitEntries drops a snapshot too old to describe the current windows", () => {
  // The agent refuses to report one this old, but the hub keeps an OFFLINE
  // host's last heartbeat for days — so without this the page shows a dead
  // host's frozen 5-hour window (one that has since reset many times over).
  const entries = H.limitEntries([
    { device: "died-yesterday",
      limits: { capturedAt: NOW - H.LIMIT_MAX_AGE_SEC - 60, fiveHour: { usedPct: 40 } } },
    { device: "stale-but-usable",
      limits: { capturedAt: NOW - H.LIMIT_MAX_AGE_SEC + 60, fiveHour: { usedPct: 40 } } },
  ], NOW);
  assert.deepEqual(entries.map((e) => e.host), ["stale-but-usable"]);
});

test("limitEntries puts the freshest snapshot first", () => {
  const entries = H.limitEntries([
    { device: "stale", limits: { capturedAt: NOW - 9000, sevenDay: { usedPct: 1 } } },
    { device: "fresh", limits: { capturedAt: NOW - 60, sevenDay: { usedPct: 2 } } },
  ], NOW);
  assert.deepEqual(entries.map((e) => e.host), ["fresh", "stale"]);
});

test("limitEntries falls back to the agent key when a host has no device name", () => {
  const entries = H.limitEntries([
    { key: "unnamed-1", limits: { capturedAt: NOW, fiveHour: { usedPct: 5 } } },
  ], NOW);
  assert.equal(entries[0].host, "unnamed-1");
});

test("limitWindowView reports the percentage and the countdown to reset", () => {
  const v = H.limitWindowView({ usedPct: 23.5, resetsAt: NOW + 2 * 3600 + 14 * 60 }, NOW);
  assert.equal(v.pctLabel, "23.5%");
  assert.equal(v.reset, "resets in 2h 14m");
  assert.equal(v.expired, false);
  assert.equal(v.level, "");
});

test("limitWindowView colours the bar by headroom, not by branding", () => {
  assert.equal(H.limitWindowView({ usedPct: 74 }, NOW).level, "");
  assert.equal(H.limitWindowView({ usedPct: 75 }, NOW).level, "warn");
  assert.equal(H.limitWindowView({ usedPct: 90 }, NOW).level, "crit");
});

test("limitWindowView stops believing a window whose reset has already passed", () => {
  // The snapshot describes a window that no longer exists — showing its last
  // percentage would be presenting a stale number as the current balance.
  const v = H.limitWindowView({ usedPct: 88, resetsAt: NOW - 60 }, NOW);
  assert.equal(v.expired, true);
  assert.equal(v.pctLabel, "—");
  assert.equal(v.reset, "window has since reset");
});

test("limitWindowView renders a window that reports no reset time", () => {
  const v = H.limitWindowView({ usedPct: 12 }, NOW);
  assert.equal(v.pctLabel, "12%");
  assert.equal(v.reset, "");
  assert.equal(v.expired, false);
});

test("limitWindowView has nothing to draw without a percentage", () => {
  assert.equal(H.limitWindowView({ resetsAt: NOW + 60 }, NOW), null);
  assert.equal(H.limitWindowView(null, NOW), null);
});

test("fmtDuration reads as an age or a countdown at every scale", () => {
  assert.equal(H.fmtDuration(0), "0s");
  assert.equal(H.fmtDuration(45), "45s");
  assert.equal(H.fmtDuration(6 * 60), "6m");
  assert.equal(H.fmtDuration(2 * 3600 + 14 * 60), "2h 14m");
  assert.equal(H.fmtDuration(50 * 3600), "2d 2h");
  // A clock skew that puts the snapshot in the future must not print "-3m ago".
  assert.equal(H.fmtDuration(-90), "0s");
});

// --- the sub-agent split (XERK-302) ------------------------------------------
// Delegated tokens are a SLICE of every other figure on the page. The two things
// worth guarding are that a host which can't report the split is EXCLUDED from
// the share rather than counted as a zero, and that the card never asserts a
// percentage nobody reported.

const bucketOf = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
// A usage block as an agent reports one: `spent` total, `delegated` of it.
const usage = (spent, delegated) => ({
  totals: bucketOf(spent), today: bucketOf(spent), week: bucketOf(spent),
  days: {}, models: [],
  ...(delegated === undefined ? {} : {
    subagent: {
      totals: bucketOf(delegated), today: bucketOf(delegated), week: bucketOf(delegated),
    },
  }),
});
// The series shape the card consumes: one or more blocks merged together.
function series(...blocks) {
  const u = H.blankUsage();
  for (const b of blocks) H.mergeUsageInto(u, b);
  return { usage: u };
}
// The card renders its table through innerHTML on a shim element.
const cardHtml = (list) => H.subagentCard(list).children.map(c => c._html || c.textContent).join(" ");

test("mergeUsageInto leaves subagent null until something reports one", () => {
  const u = H.blankUsage();
  H.mergeUsageInto(u, usage(1000));
  assert.equal(u.subagent, null, "an older agent means 'can't tell you', not 'delegated nothing'");
});

test("mergeUsageInto tracks the reporting spend separately from the total", () => {
  // One host reports a split, another is too old to. The denominator must be
  // the reporting host's 1000 alone — not the merged 3000.
  const u = H.blankUsage();
  H.mergeUsageInto(u, usage(1000, 250));
  H.mergeUsageInto(u, usage(2000));
  assert.equal(u.totals.input, 3000);
  assert.equal(u.subagent.totals.input, 250);
  assert.equal(u.subagentOf.totals.input, 1000);
});

test("subagentCard takes the share against reporting spend only", () => {
  // 250 of the 1000 that CAN be split is 25%; against the 3000 the fleet spent
  // it would read 8.3% and understate every delegating host.
  const html = cardHtml([series(usage(1000, 250)), series(usage(2000))]);
  assert.match(html, /25\.0%/);
  assert.doesNotMatch(html, /8\.3%/);
});

test("subagentCard says so when only some series can answer", () => {
  const html = cardHtml([series(usage(1000, 250)), series(usage(2000))]);
  assert.match(html, /1 of 2 series report the split/);
});

test("subagentCard stays quiet about coverage when every series answers", () => {
  const html = cardHtml([series(usage(1000, 250)), series(usage(2000, 500))]);
  assert.doesNotMatch(html, /report the split/);
  assert.match(html, /25\.0%/);   // 750 of 3000
});

test("subagentCard shows no percentage at all when nothing reports a split", () => {
  const html = cardHtml([series(usage(1000)), series(usage(2000))]);
  assert.match(html, /older agents don't separate delegated work/);
  assert.doesNotMatch(html, /%/);
});

test("subagentCard distinguishes an empty window from a zero share", () => {
  // A window with no spend has nothing to take a ratio of, so it draws "–";
  // a window with spend and no delegation is a real 0.0%.
  const quiet = { ...usage(0, 0), totals: bucketOf(500), subagent: {
    totals: bucketOf(0), today: bucketOf(0), week: bucketOf(0) } };
  const html = cardHtml([series(quiet)]);
  assert.match(html, /–/);       // today/week: nothing spent
  assert.match(html, /0\.0%/);   // all-time: 500 spent, none delegated
});

test("subagentCard reads as a share of the page, never as an addition to it", () => {
  const html = cardHtml([series(usage(1000, 250))]);
  assert.match(html, /Already counted in every figure above/);
});
