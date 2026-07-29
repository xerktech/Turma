// Unit tests for the Usage page's token cells (public/usage.html): the cache
// read/write split and the hit rate that says whether sessions on a repo are
// re-paying for the same prompt prefix instead of reading it back from cache.
// node:test, no npm — matches this package's zero-dependency stance. There's no
// jsdom here, so the page's real inline <script> is loaded into a minimal DOM
// shim (the same trick sessions.test.js uses) and the pure helpers are returned
// out of the sandbox; only tokenCell/cacheSubLine/cacheHitRate are exercised, so
// the shim only has to be complete enough for the page's boot to not throw.

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
  const body = `${script}\n;return { tokenCell, cacheSubLine, cacheHitRate, blankBucket };`;
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
