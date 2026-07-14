// Unit tests for the Sessions page sidebar render (public/sessions.html): the
// running-session split into Active (waiting/working) vs Idle (auto-demoted),
// the Idle-hidden-when-empty rule, and the Active empty-state messaging.
// node:test, no npm — matches this package's zero-dependency stance. There's no
// jsdom here, so we load the page's real inline <script> into a minimal DOM
// shim and drive its render() with fabricated heartbeat data, asserting on the
// #active / #idle / #stopped innerHTML it produces.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "sessions.html"), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

// --- minimal DOM shim --------------------------------------------------------
function makeEl(id) {
  const el = {
    id, _html: "", textContent: "", value: "", hidden: false,
    style: {}, dataset: {}, children: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { const on = f == null ? !this._s.has(c) : f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); },
    },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, blur() {}, setAttribute() {}, getAttribute() { return null; },
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0 }; },
    scrollIntoView() {}, remove() {},
  };
  Object.defineProperty(el, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); } });
  return el;
}

// Build a fresh sandbox per test so state (cache, section innerHTML) never leaks.
function loadPage() {
  const els = {};
  const document = {
    getElementById(id) { return (els[id] ||= makeEl(id)); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement(tag) { return makeEl("<" + tag + ">"); },
    addEventListener() {}, removeEventListener() {},
    body: makeEl("body"), activeElement: null,
  };
  const noop = () => {};
  const stubs = {
    document,
    localStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    location: { href: "", search: "", pathname: "/sessions" },
    navigator: { userAgent: "node" },
    fetch: () => new Promise(() => {}),             // never resolves -> the boot refresh() is inert
    EventSource: class { addEventListener() {} close() {} static get CLOSED() { return 2; } },
    setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    history: { replaceState: noop, pushState: noop },
    URL: global.URL, URLSearchParams: global.URLSearchParams,
    TurmaChat: { onPoll: noop, close: noop, closeStatic: noop, renderStatic: noop },
    console, Date, Math, JSON, encodeURIComponent, decodeURIComponent, parseInt, parseFloat,
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    scrollTo: noop, innerWidth: 1200, innerHeight: 800,
  };
  const names = Object.keys(stubs);
  const fn = new Function(...names, "window", script + "\n;return { render };");
  const api = fn(...names.map((k) => stubs[k]), stubs);
  return { render: api.render, els };
}

function host(sessions) {
  const now = Date.now();
  return {
    now,
    host: {
      key: "hostA", device: "hostA", online: true, terminalOnline: true,
      lastSeen: now, repos: [{ name: "repoX" }], sessions,
    },
  };
}
const running = (id, summary, session) => ({ id, status: "running", repo: "repoX", summary, session });
const working = (id, summary) => running(id, summary, { paneBusy: true, transcriptAgeSec: 3 });
const waiting = (id, summary) => running(id, summary, { question: "Pick one?", paneBusy: false, transcriptAgeSec: 5 });
const idle = (id, summary) => running(id, summary, { paneBusy: false, transcriptAgeSec: 800 });

test("running sessions split: working/waiting -> Active, idle -> Idle", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([
    working("11111", "Working Task"),
    waiting("22222", "Waiting Task"),
    idle("33333", "Idle Task A"),
    running("44444", "Idle Task B", { paneBusy: null, transcriptAgeSec: 9999 }), // stale transcript, unknown paneBusy -> idle
    { id: "55555", status: "stopped", repo: "repoX", summary: "Dead Task" },
  ]);
  render({ now, agents: [h] });

  const a = els.active.innerHTML;
  const i = els.idle.innerHTML;
  assert.match(a, /Active <span class="count">2<\/span>/);
  assert.ok(a.includes("Working Task") && a.includes("Waiting Task"));
  assert.ok(!a.includes("Idle Task A") && !a.includes("Idle Task B"), "idle sessions must not appear under Active");

  assert.match(i, /Idle <span class="count">2<\/span>/);
  assert.ok(i.includes("Idle Task A") && i.includes("Idle Task B"));
  assert.ok(!i.includes("Working Task"), "working sessions must not appear under Idle");

  assert.ok(els.stopped.innerHTML.includes("Dead Task"), "stopped section still renders");
});

test("all running idle: Active shows empty-state pointing at Idle; Idle lists them", () => {
  const { render, els } = loadPage();
  const { now, host: h } = host([idle("66666", "Only Idle")]);
  render({ now, agents: [h] });

  assert.match(els.active.innerHTML, /Active <span class="count">0<\/span>/);
  assert.ok(els.active.innerHTML.includes("No active sessions"));
  assert.ok(els.active.innerHTML.includes("See Idle below"));
  assert.ok(els.idle.innerHTML.includes("Only Idle"));
});

test("no idle sessions: Idle section renders empty (hidden)", () => {
  const { render, els } = loadPage();
  els.idle.innerHTML = "SENTINEL"; // prove render() clears it, not just leaves stale content
  const { now, host: h } = host([working("77777", "Busy Only")]);
  render({ now, agents: [h] });

  assert.equal(els.idle.innerHTML, "");
  assert.match(els.active.innerHTML, /Active <span class="count">1<\/span>/);
});

test("the Ended-sessions archive browser is gone from the sidebar markup", () => {
  // The archive list + its toggle were removed; only the search box remains as
  // the path to ended-session history. Guards against a regression re-adding it.
  assert.ok(!html.includes("Ended sessions"), "no 'Ended sessions' header");
  assert.ok(!/id="archiveWrap"/.test(html), "no #archiveWrap element");
  assert.ok(!/id="archiveDetails"/.test(html), "no #archiveDetails element");
  assert.ok(/id="idle"/.test(html), "new #idle section present");
});
