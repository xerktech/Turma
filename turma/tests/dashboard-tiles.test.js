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

// Load the page's inline script and hand back { render, els }. `orgFilter` is
// the header's org control, stubbed as identity ("All orgs") unless a test
// narrows it.
function loadDashboard(orgFilter = (a) => a || []) {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
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
    fetch: () => new Promise(() => {}),
    EventSource: class { addEventListener() {} close() {} },
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
  const fn = new Function(...keys, src + "\n;return { render, fmtTokens };");
  return Object.assign(fn(...keys.map((k) => g[k])), { els });
}

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
