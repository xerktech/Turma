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
  const body = `${script}\n;return { tokenCell, cacheSubLine, cacheLineText, cacheHitRate,
    blankBucket, limitEntries, limitGroups, limitHostLabel, limitCard, limitWindowView,
    fmtDuration, LIMIT_STALE_SEC, LIMIT_MAX_AGE_SEC,
    blankUsage, mergeUsageInto, subagentCard, fleetTotals, renderTotals };`;
  // `els` rides along so the render-level tests can reach the containers the
  // page paints INTO — the strip is written to #totals rather than returned.
  return Object.assign(new Function(...keys, body)(...keys.map((k) => stubs[k])), { els });
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

// --- the headline totals strip ----------------------------------------------
// A port of the Android Usage screen's stat row, so the vectors below are the
// ones `UsageViewModelTest` asserts against `UsageViewModel.compute` — same
// numbers, same answers. A change here that isn't carried there (or the other
// way) shows the operator a different fleet total on the phone than in the
// browser, with nothing to say which is right.

const hostUsage = (today, week, all) => ({
  today: bucket({ input: today }), week: bucket({ input: week }), totals: bucket({ input: all }),
});

test("fleetTotals sums the host-level block across hosts", () => {
  // UsageViewModelTest: "fleet windows sum the host-level block, not the live sessions".
  const t = H.fleetTotals([
    { key: "h1", usage: hostUsage(10, 70, 500) },
    { key: "h2", usage: hostUsage(5, 30, 100) },
  ]);
  assert.equal(t.today.input, 15);
  assert.equal(t.week.input, 100);
  assert.equal(t.totals.input, 600);
});

test("fleetTotals falls back to a host's repos when it reports no aggregate", () => {
  // UsageViewModelTest: "a host with no usage block falls back to summing its
  // repos". An older agent's work must reach the headline rather than read zero.
  const t = H.fleetTotals([
    { key: "old", repoUsage: [
      { repo: "A", usage: hostUsage(1, 7, 10) },
      { repo: "B", usage: hostUsage(2, 14, 20) },
    ] },
  ]);
  assert.equal(t.today.input, 3);
  assert.equal(t.week.input, 21);
  assert.equal(t.totals.input, 30);
});

test("fleetTotals never counts a host's repos ON TOP of its host block", () => {
  // The repo blocks are a partition of the same spend, so a host reporting both
  // must contribute its aggregate ONCE. Adding them doubles every token on the
  // page's headline while every breakdown below it stays right — the kind of
  // disagreement that reads as the breakdown being broken.
  const t = H.fleetTotals([
    { key: "h1", usage: hostUsage(10, 70, 500), repoUsage: [
      { repo: "A", usage: hostUsage(4, 30, 200) },
      { repo: "B", usage: hostUsage(6, 40, 300) },
    ] },
  ]);
  assert.equal(t.today.input, 10);
  assert.equal(t.week.input, 70);
  assert.equal(t.totals.input, 500);
});

test("fleetTotals is empty-safe: no agents, a null agent, a host with neither block", () => {
  for (const agents of [[], null, undefined, [null], [{ key: "bare" }]]) {
    const t = H.fleetTotals(agents);
    assert.equal(t.today.input, 0);
    assert.equal(t.totals.input, 0);
  }
});

test("fleetTotals counts every token field, cache included", () => {
  // UsageViewModelTest: "bucket total sums every token field, cache included" —
  // the strip's figure is dayTokens() over the whole bucket, not just input.
  const t = H.fleetTotals([{ key: "h1", usage: {
    today: bucket({ input: 1, output: 2, cacheWrite: 4, cacheRead: 8 }),
    week: bucket({}), totals: bucket({}),
  } }]);
  assert.equal(t.today.input + t.today.output + t.today.cacheWrite + t.today.cacheRead, 15);
});

test("renderTotals paints the three windows in Android's order and wording", () => {
  H.renderTotals([{ key: "h1", usage: {
    today: bucket({ input: 272_500_000 }),
    week: bucket({ input: 4_800_000_000 }),
    totals: bucket({ input: 11_300_000_000 }),
  } }]);
  const stats = H.els.totals.children.filter((c) => c.className === "stat");
  assert.deepEqual(stats.map((s) => s.children[0].textContent),
    ["Today", "This week", "All-time"]);
  assert.deepEqual(stats.map((s) => s.children[1].textContent), ["272.5M", "4.8B", "11.3B"]);
});

test("renderTotals hangs the all-time cache split under the row", () => {
  H.renderTotals([{ key: "h1", usage: {
    today: bucket({}), week: bucket({}),
    totals: bucket({ input: 1000, cacheRead: 9000, cacheWrite: 0 }),
  } }]);
  const cache = H.els.totals.children.find((c) => c.className === "cache");
  assert.equal(cache.textContent, "9.0k cached · 0 written · 90% hit");
});

test("renderTotals omits the cache line when nothing reports cache traffic", () => {
  // Same rule as cacheSubLine: an older agent reports no cache fields, and
  // "0 cached · 0 written" would read as caching being broken, not unreported.
  H.renderTotals([{ key: "h1", usage: {
    today: bucket({ input: 5 }), week: bucket({ input: 5 }), totals: bucket({ input: 5 }),
  } }]);
  assert.equal(H.els.totals.children.some((c) => c.className === "cache"), false);
});

test("renderTotals REPLACES the strip rather than appending to it", () => {
  // It repaints on every SSE beat, so an append would stack a fresh row of
  // stats under the last one every few seconds.
  const agents = [{ key: "h1", usage: hostUsage(1, 1, 1) }];
  H.renderTotals(agents);
  const first = H.els.totals.children.length;
  H.renderTotals(agents);
  assert.equal(H.els.totals.children.length, first);
});

test("renderTotals shows zeroes for a fleet scoped to nothing, never a stale figure", () => {
  // The org filter can scope the page to no hosts at all; the strip has to say
  // zero rather than keep whatever the previous selection spent.
  H.renderTotals([{ key: "h1", usage: hostUsage(10, 70, 500) }]);
  H.renderTotals([]);
  const stats = H.els.totals.children.filter((c) => c.className === "stat");
  assert.deepEqual(stats.map((s) => s.children[1].textContent), ["0", "0", "0"]);
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

// --- limitGroups: one card per subscription (XERK-301) ----------------------

const sub = (key) => ({ subscription: { key } });

test("limitGroups folds hosts on one subscription into a single card", () => {
  // Both hosts are logged into the same Claude account, so they are reading
  // (and spending) one pool — two sets of bars was the same number twice.
  const groups = H.limitGroups([
    { device: "maxai", ...sub("k1"),
      limits: { capturedAt: NOW - 600, fiveHour: { usedPct: 30 }, sevenDay: { usedPct: 10 } } },
    { device: "truenas", ...sub("k1"),
      limits: { capturedAt: NOW - 60, fiveHour: { usedPct: 42 }, sevenDay: { usedPct: 12 } } },
  ], NOW);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].hosts.map((h) => h.host), ["truenas", "maxai"]);
  assert.equal(groups[0].capturedAt, NOW - 60);
});

test("limitGroups keeps different subscriptions on their own cards", () => {
  const groups = H.limitGroups([
    { device: "work", ...sub("k1"), limits: { capturedAt: NOW, fiveHour: { usedPct: 30 } } },
    { device: "home", ...sub("k2"), limits: { capturedAt: NOW - 30, fiveHour: { usedPct: 5 } } },
  ], NOW);
  assert.deepEqual(groups.map((g) => g.hosts.map((h) => h.host)), [["work"], ["home"]]);
});

test("limitGroups never folds two hosts that merely both report NO subscription", () => {
  // Absent means "this host can't tell you" (the heartbeat's rule), so two
  // silent hosts are not thereby on one plan — an older agent alongside a
  // current one must not have its bars merged into somebody else's.
  const groups = H.limitGroups([
    { device: "old-a", limits: { capturedAt: NOW, fiveHour: { usedPct: 30 } } },
    { device: "old-b", limits: { capturedAt: NOW, fiveHour: { usedPct: 70 } } },
    { device: "old-c", subscription: { key: "" },
      limits: { capturedAt: NOW, fiveHour: { usedPct: 90 } } },
  ], NOW);
  assert.deepEqual(groups.map((g) => g.hosts.map((h) => h.host)),
    [["old-a"], ["old-b"], ["old-c"]]);
});

test("limitGroups takes each window's FRESHEST reading, per window", () => {
  // The newest read of a shared counter is simply the most recent truth — and
  // across a reset it is the only right answer, where a maximum would keep the
  // pre-reset figure alive. Per window, because the freshest snapshot need not
  // carry both.
  const groups = H.limitGroups([
    { device: "a", ...sub("k1"),
      limits: { capturedAt: NOW - 600, fiveHour: { usedPct: 80 }, sevenDay: { usedPct: 44 } } },
    { device: "b", ...sub("k1"),
      limits: { capturedAt: NOW - 60, fiveHour: { usedPct: 3 } } },
  ], NOW);
  assert.equal(groups[0].windows.fiveHour.win.usedPct, 3);      // freshest, not highest
  assert.equal(groups[0].windows.sevenDay.win.usedPct, 44);     // only reading there is
});

test("limitGroups drops an aged-out snapshot before it can join a group", () => {
  const groups = H.limitGroups([
    { device: "dead", ...sub("k1"), limits: {
      capturedAt: NOW - H.LIMIT_MAX_AGE_SEC - 60, fiveHour: { usedPct: 40 } } },
    { device: "live", ...sub("k1"), limits: { capturedAt: NOW, fiveHour: { usedPct: 7 } } },
  ], NOW);
  assert.deepEqual(groups[0].hosts.map((h) => h.host), ["live"]);
});

test("limitGroups leads with the freshest card", () => {
  const groups = H.limitGroups([
    { device: "stale", ...sub("k1"), limits: { capturedAt: NOW - 9000, sevenDay: { usedPct: 1 } } },
    { device: "fresh", ...sub("k2"), limits: { capturedAt: NOW - 60, sevenDay: { usedPct: 2 } } },
  ], NOW);
  assert.deepEqual(groups.map((g) => g.hosts[0].host), ["fresh", "stale"]);
});

test("limitGroups breaks a capturedAt TIE the same way the Android port does", () => {
  // Two hosts whose snapshots tie to the second: fold in a different order, or
  // accept an equal capturedAt as newer, and each client shows a DIFFERENT
  // percentage for one subscription. Both sort freshest-first (stably) and both
  // replace only on a strictly newer read, so a tie keeps fleet order on both.
  const groups = H.limitGroups([
    { device: "first", ...sub("k1"),
      limits: { capturedAt: NOW - 5, fiveHour: { usedPct: 11 }, sevenDay: { usedPct: 21 } } },
    { device: "second", ...sub("k1"),
      limits: { capturedAt: NOW - 5, fiveHour: { usedPct: 99 }, sevenDay: { usedPct: 91 } } },
  ], NOW);
  assert.equal(groups[0].windows.fiveHour.win.usedPct, 11);
  assert.equal(groups[0].windows.sevenDay.win.usedPct, 21);
});

test("a window read earlier than the card's stamp says so on its own row", () => {
  // The head shows the group's FRESHEST capture. A window the freshest host
  // didn't report comes from an older read, and presenting it under that head
  // would be showing somebody else's freshness as its own.
  const card = H.limitCard(H.limitGroups([
    { device: "old", ...sub("k1"),
      limits: { capturedAt: NOW - 900, sevenDay: { usedPct: 44 } } },
    { device: "new", ...sub("k1"),
      limits: { capturedAt: NOW - 30, fiveHour: { usedPct: 3 } } },
  ], NOW)[0], NOW);
  const text = (el) => (el.children || []).map((c) => (c.textContent || "") + text(c)).join("");
  assert.match(text(card), /captured 30s ago/);
  assert.match(text(card), /read 15m ago/);      // the 7d row's own read
  assert.equal(/read .* ago/.test(text(card).replace(/read 15m ago/, "")), false,
    "only the window that is actually behind discloses an age");
});

test("a hostile device name lands as TEXT, never as markup", () => {
  // The label concatenates several agent-supplied device names, and BOTH the
  // heading tooltip and the per-window "read … ago" tooltip repeat them —
  // agents are authenticated, but a host names itself.
  const evil = '<img src=x onerror="window.__xss=1">';
  const card = H.limitCard(H.limitGroups([
    // The hostile host is the OLDER one, so its name reaches the window
    // tooltip as well as the heading.
    { device: evil, ...sub("k1"), limits: { capturedAt: NOW - 600, sevenDay: { usedPct: 44 } } },
    { device: "alpha", ...sub("k1"), limits: { capturedAt: NOW, fiveHour: { usedPct: 5 } } },
  ], NOW)[0], NOW);
  const host = card.children[0].children[0];
  assert.equal(host.textContent, `alpha · ${evil}`);
  assert.match(host.title, /alpha/);
  // No node anywhere in the card may have taken any of it as markup — the
  // heading, the head tooltip and the window's "read … ago" tooltip all carry
  // host names, and only the first of those had a test.
  const walk = (el) => [el, ...(el.children || []).flatMap(walk)];
  for (const el of walk(card)) {
    assert.equal(el.innerHTML, "", "nothing in the card may be assigned as markup");
  }
  assert.ok(walk(card).some((el) => (el.title || "").includes(evil)),
    "the window tooltip must actually name the host its reading came from");
});

test("limitHostLabel names the hosts, counting the tail past a few", () => {
  const named = (...hosts) => H.limitHostLabel({ hosts: hosts.map((host) => ({ host })) });
  assert.equal(named("solo"), "solo");
  assert.equal(named("a", "b"), "a · b");
  assert.equal(named("a", "b", "c", "d", "e"), "a · b · c +2 more");
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

test("subagentCard takes the share against reporting spend WITHIN one series", () => {
  // The case a per-series split misses entirely: ONE series (a repo unified
  // across hosts by remoteKey) fed by a reporting host AND an older one. Every
  // series "reports", so a series-level check sees full coverage — but 3000 of
  // the series' 4000 tokens have no split behind them. Taking the share against
  // the series total reads 6.3%; against the reporting spend it is 25%.
  const html = cardHtml([series(usage(1000, 250), usage(3000))]);
  assert.match(html, /25\.0%/);
  assert.doesNotMatch(html, /6\.3%/);
  assert.match(html, /of 1\.0k/);      // the denominator is disclosed on the row
});

test("subagentCard measures its coverage caveat in SPEND, not in series", () => {
  // Same mixed series: one series, so "N of M series" would say nothing at all.
  const html = cardHtml([series(usage(1000, 250), usage(3000))]);
  assert.match(html, /hosts that can't report one are left out of that row/);
  assert.match(html, /3\.0k not covered/);
});

test("subagentCard states coverage PER ROW, since windows differ", () => {
  // A skewed fleet: the reporting host spent all-time but almost nothing today,
  // the one that can't is the reverse. One card-wide figure would claim ~100%
  // coverage over a Today row that is covered 0.001%.
  const win = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
  const reporting = {
    totals: win(1_000_000), today: win(10), week: win(10), days: {}, models: [],
    subagent: { totals: win(250_000), today: win(5), week: win(5) },
  };
  const blind = { totals: win(1000), today: win(900_000), week: win(900_000), days: {}, models: [] };
  const html = cardHtml([series(reporting), series(blind)]);
  assert.match(html, /1\.0k not covered/);      // all-time: only 1k missing
  assert.match(html, /900\.0k not covered/);    // today: nearly everything is
  // …and the shares themselves stay per-window honest.
  assert.match(html, /50\.0%/);                 // today: 5 of 10
  assert.match(html, /25\.0%/);                 // all-time: 250k of 1M
});

test("subagentCard stays quiet about coverage when every token is covered", () => {
  const html = cardHtml([series(usage(1000, 250)), series(usage(2000, 500))]);
  assert.doesNotMatch(html, /hosts that can't/);
  assert.doesNotMatch(html, /not covered/);
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
