// Unit tests for the Dashboard's summary tiles (the inline script in
// public/index.html), and specifically for the one thing they get wrong when
// nothing pins it: whether a REMOVED host's spend is still counted.
//
// Token usage outlives the host that made it (XERK-338) — the hub serves it as
// `retiredUsage` — and the Usage page has always charted it. The dashboard read
// `data.agents` alone, so removing one busy host erased most of the fleet's
// all-time tokens from the front page while /usage still showed them, which
// reads as lost data rather than as a narrower question being asked.
//
// The tiles are painted from inside `render()` rather than returned, so this
// drives the real render against a DOM shim and reads #tiles back out — the same
// trick usage.test.js uses for that page's render-level tests.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

// Load the page's inline script and hand back { render, els, … }. `orgFilter` is
// the header's org control, stubbed as identity ("All orgs") unless a test
// narrows it; `fetchReply` is what the page's own /api/agents poll resolves to,
// so the SSE tests can watch it re-fetch.
function loadDashboard(orgFilter = (a) => a || [], fetchReply = null) {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
  const sse = [];
  const fetches = [];
  const noop = () => {};
  const document = {
    getElementById(id) { return (els[id] ||= makeEl()); },
    createElement() { return makeEl(); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener: noop, removeEventListener: noop,
    get activeElement() { return null; },
    body: makeEl(), title: "",
  };
  const g = {
    document,
    localStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; },
      setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    location: { pathname: "/", href: "", search: "" },
    navigator: { userAgent: "node" },
    fetch: (u) => {
      fetches.push(String(u));
      return fetchReply
        ? Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(fetchReply()) })
        : new Promise(() => {});
    },
    // Captures the page's SSE handlers so a test can deliver a real `agent` /
    // `removed` event, which is the only way to reach the live-update path — the
    // fallback poll is skipped entirely while the stream is healthy.
    EventSource: class {
      constructor() { sse.push(this); this.handlers = {}; this.readyState = 1; }
      addEventListener(name, fn) { this.handlers[name] = fn; }
      close() {}
    },
    setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    history: { replaceState: noop, pushState: noop },
    TurmaNav: { preserveScroll: (_el, paint) => paint(), toast: noop },
    TurmaOrg: { get: () => "", update: noop, filter: (a) => orgFilter(a), subscribe: noop, sse: noop,
      orgColors: () => ({}) },
    TurmaBoard: { orgName: (k) => k || "", orgColorMap: () => new Map() },
    TurmaNewTicket: { update: noop },
    console, URL: global.URL, URLSearchParams: global.URLSearchParams,
  };
  g.window = g; g.globalThis = g;
  const keys = Object.keys(g);
  const fn = new Function(...keys, src +
    "\n;return { render, fmtTokens, applyAgent, connectSSE," +
    " setCache: (c) => { cache = c; }, getCache: () => cache };");
  return Object.assign(fn(...keys.map((k) => g[k])), { els, sse, fetches });
}

const bucket = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
const usage = (n) => ({
  totals: { input: n, output: 0, cacheWrite: 0, cacheRead: 0 },
  today: { input: n, output: 0, cacheWrite: 0, cacheRead: 0 },
  week: { input: n, output: 0, cacheWrite: 0, cacheRead: 0 },
  models: [],
});
const liveHost = (key, n, siteKey) => ({
  key, device: key, online: true, lastSeen: Date.now(), sessions: [], repos: [],
  usage: usage(n), jira: siteKey ? { siteKey } : null,
});
// What the hub actually serves on `retiredUsage`: agent-SHAPED, but not a host —
// no sessions, no repos, no capacity.
const retiredHost = (key, n, siteKey) => ({
  key, device: key, retired: true, online: false, terminalOnline: false,
  lastSeen: Date.now() - 60_000, usage: usage(n), repoUsage: [],
  jira: siteKey ? { siteKey } : null,
});

// The tiles are one HTML string; read a tile's value/hint back out of it by label.
function tileOf(html, label) {
  const re = new RegExp(
    `<div class="label">${label}</div><div class="value">([^<]*)</div>` +
    `(?:<div class="hint">([^<]*)</div>)?`);
  const m = html.match(re);
  return m ? { value: m[1], hint: m[2] || "" } : null;
}

test("dashboard tiles: a removed host's spend still counts toward the fleet totals", () => {
  const D = loadDashboard();
  D.render({ now: Date.now(), agents: [liveHost("live", 100)], retiredUsage: [retiredHost("gone", 900)] });
  const html = D.els.tiles.innerHTML;
  for (const label of ["Tokens today", "Tokens this week", "Tokens all-time"]) {
    assert.equal(tileOf(html, label).value, D.fmtTokens(1000),
      `${label} must count the removed host, as /usage does`);
  }
});

test("dashboard tiles: the totals say when a removed host is inside them", () => {
  const D = loadDashboard();
  D.render({ now: Date.now(), agents: [liveHost("live", 100)], retiredUsage: [retiredHost("gone", 900)] });
  const html = D.els.tiles.innerHTML;
  assert.match(tileOf(html, "Tokens all-time").hint, /incl\. removed hosts/);
  // ...and does not, when there is nothing retired to count.
  const D2 = loadDashboard();
  D2.render({ now: Date.now(), agents: [liveHost("live", 100)], retiredUsage: [] });
  assert.doesNotMatch(tileOf(D2.els.tiles.innerHTML, "Tokens all-time").hint, /removed hosts/);
});

test("dashboard tiles: a retired entry is spend, never a host", () => {
  // The one rule this must not break (XERK-338): `retiredUsage` entries carry no
  // sessions, repos or capacity, so anything that treats one as a host invents a
  // host that does not exist — an inflated "Hosts online", a card with no
  // controls, a session ceiling counting a box that is gone.
  const D = loadDashboard();
  D.render({ now: Date.now(), agents: [liveHost("live", 100)], retiredUsage: [retiredHost("gone", 900)] });
  const html = D.els.tiles.innerHTML;
  assert.equal(tileOf(html, "Hosts online").value, "1 / 1");
  assert.doesNotMatch(tileOf(html, "Hosts online").hint, /gone/);
  assert.doesNotMatch(D.els.groups.innerHTML, /gone/);
});

test("dashboard tiles: retired spend is scoped by the org filter like a live host", () => {
  // The hub carries `jira.siteKey` on a retired entry for exactly this reason.
  const D = loadDashboard((agents) => (agents || []).filter(
    (a) => (a.jira && a.jira.siteKey) === "ACME"));
  D.render({
    now: Date.now(),
    agents: [liveHost("live", 100, "ACME"), liveHost("other", 5000, "XERK")],
    retiredUsage: [retiredHost("acme-gone", 900, "ACME"), retiredHost("xerk-gone", 7000, "XERK")],
  });
  assert.equal(tileOf(D.els.tiles.innerHTML, "Tokens all-time").value, D.fmtTokens(1000));
});

test("dashboard tiles: a hub with no retiredUsage at all renders exactly as before", () => {
  // An older hub omits the key entirely — indistinguishable from "nothing
  // retired", and neither may throw.
  const D = loadDashboard();
  D.render({ now: Date.now(), agents: [liveHost("live", 100)] });
  assert.equal(tileOf(D.els.tiles.innerHTML, "Tokens all-time").value, D.fmtTokens(100));
});

test("dashboard tiles: a fleet whose only spender was removed still shows its totals", () => {
  const D = loadDashboard();
  D.render({ now: Date.now(), agents: [], retiredUsage: [retiredHost("gone", 900)] });
  assert.equal(tileOf(D.els.tiles.innerHTML, "Tokens all-time").value, D.fmtTokens(900));
  assert.equal(tileOf(D.els.tiles.innerHTML, "Hosts online").value, "0 / 0");
});

test("dashboard tiles: the dominant-model hint counts a removed host's models", () => {
  // The models line is fed from the same list as the totals; a mutant reading
  // only `agents` there passed the whole suite, and the tile then names the
  // wrong model on a fleet whose biggest spender has been removed.
  const D = loadDashboard();
  const live = liveHost("live", 10);
  live.usage.models = [{ model: "claude-haiku-4-5", totals: bucket(10), today: bucket(10), week: bucket(10) }];
  const gone = retiredHost("gone", 900);
  gone.usage.models = [{ model: "claude-opus-4-8-20260101", totals: bucket(900), today: bucket(900), week: bucket(900) }];
  D.render({ now: Date.now(), agents: [live], retiredUsage: [gone] });
  assert.match(tileOf(D.els.tiles.innerHTML, "Tokens all-time").hint, /mostly opus-4-8/);
});

test("dashboard: an empty fleet with retired spend says where the tokens came from", () => {
  // "No hosts have reported yet" directly under a non-zero token tile reads as a
  // bug — and it is the one case where the tiles and the empty state can only be
  // reconciled by saying it out loud.
  const D = loadDashboard();
  D.render({ now: Date.now(), agents: [], retiredUsage: [retiredHost("gone", 900)] });
  assert.match(D.els.groups.innerHTML, /since been removed/);
  assert.doesNotMatch(D.els.groups.innerHTML, /No hosts have reported yet/);

  // A hub nothing has ever beaten to still says so.
  const D2 = loadDashboard();
  D2.render({ now: Date.now(), agents: [], retiredUsage: [] });
  assert.match(D2.els.groups.innerHTML, /No hosts have reported yet/);
});

// ---- live updates: the tiles must not drift on an open page ------------------
// The fallback poll is SKIPPED while SSE is healthy, and SSE carries only the
// per-agent record — so anything the tiles read that is not on that record has
// to be handled where the event lands, or the page is wrong until it reloads.

test("dashboard: removing a host re-fetches, so its spend moves rather than vanishing", () => {
  const D = loadDashboard(undefined, () => ({
    now: Date.now(), agents: [liveHost("stay", 100)], retiredUsage: [retiredHost("gone", 900)],
  }));
  D.setCache({ now: Date.now(), agents: [liveHost("stay", 100), liveHost("gone", 900)], retiredUsage: [] });
  D.connectSSE();
  const es = D.sse[D.sse.length - 1];
  const before = D.fetches.length;
  es.handlers.removed({ data: JSON.stringify({ key: "gone" }) });
  assert.ok(D.fetches.length > before && D.fetches.includes("/api/agents"),
    "a removal is the one event that moves spend between the two lists — it must re-poll");
});

test("dashboard: a retired host that comes back is not counted twice", () => {
  // The hub stops serving it on `retiredUsage` the moment it beats again, but
  // this event does not carry that list — so a stale entry left in the cache
  // charts the same host live AND retired.
  const D = loadDashboard();
  D.setCache({ now: Date.now(), agents: [], retiredUsage: [retiredHost("back", 900)] });
  D.applyAgent(liveHost("back", 900));
  D.render(D.getCache());
  assert.equal(tileOf(D.els.tiles.innerHTML, "Tokens all-time").value, D.fmtTokens(900));
  assert.equal((D.getCache().retiredUsage || []).length, 0);
});
