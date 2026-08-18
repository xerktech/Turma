// Unit tests for the dashboard's command path (the inline script in
// public/index.html): what happens when the hub REFUSES a command (XERK-264).
//
// The hub answers a refusal with a status and a JSON {error} body — an org
// mismatch, an agent too old to run it, an offline host, a full command queue.
// post() ignored res.status entirely, so all of that landed as a click that
// looked like it worked: the spinner span out its TTL, and a refused resume
// still navigated to a session page with nothing to open. This page's post() is
// the twin of sessions.html's (covered in sessions.test.js), so these pin the
// dashboard's own half rather than trusting the two copies to stay in step.
//
// node:test, no npm — same sandbox pattern as clone.test.js.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The real wording module, so a test can't drift from what ships.
const TurmaNavCore = require("../public/nav.js");

// `reply`/`status` are what every command POST/DELETE answers with.
function loadPage({ reply = { ok: true }, status = 200, throws = false } = {}) {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const els = new Map();
  const store = {};
  const calls = [];   // {url, method}
  const toasts = [];
  const g = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: {
      getElementById: (id) => els.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      get activeElement() { return null; },
      createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
      body: {}, title: "",
    },
    EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
    // The fleet poll (GET) answers empty; a command (POST/DELETE) answers with
    // the status under test.
    fetch: (url, init) => {
      const method = (init && init.method) || "GET";
      if (method === "GET") {
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ agents: [] }), text: () => Promise.resolve("") });
      }
      calls.push({ url, method });
      if (throws) return Promise.reject(new Error("network down"));
      return Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(reply) });
    },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    location: { pathname: "/", href: "" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    TurmaOrg: { get: () => "", filter: (a) => a || [], update() {}, subscribe() {}, sse() {} },
    // The chrome's shared failure toast — the one surface a refusal reaches the
    // operator through. Real wording, recorded here.
    TurmaNav: { toast: (m) => toasts.push(m), refusalText: TurmaNavCore.refusalText, preserveScroll: (_el, paint) => paint() },
  };
  g.window = g; g.globalThis = g;

  const exportTail = `
    ;globalThis.__page = { sessStart, resumeSession, sessKill, pendKey, pending, post, del };
    globalThis.__setRender = (f) => { render = f; };
    globalThis.__setCache = (c) => { cache = c; };
  `;
  const names = ["localStorage", "document", "window", "EventSource", "fetch",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "location", "matchMedia",
    "TurmaOrg", "TurmaNav", "globalThis"];
  const fn = new Function(...names, src + exportTail);
  fn(...names.map((k) => g[k]), g);

  g.__setRender(() => {});   // no DOM to paint in the sandbox
  return { ...g.__page, calls, toasts, location: g.location, setCache: g.__setCache };
}

// post() → fetch → res.json() → the caller's .then is a few microtask turns; the
// sandbox's setTimeout never fires, so drain the queue by hand.
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("a refused start says why, and drops the spinner it painted", async () => {
  const p = loadPage({ reply: { error: "the host's command queue is full", limit: 200 }, status: 429 });
  p.sessStart("hostA", "s1");
  assert.ok(p.pending.has(p.pendKey("start", "hostA", "s1")), "optimistic while in flight");

  await flush();
  // 429 is the worst refusal to swallow: the reason it didn't run is a backlog
  // that won't clear on its own, so an operator who saw nothing would retry and
  // make it worse.
  assert.deepEqual(p.toasts, ["Start failed — the host's command queue is full"]);
  assert.ok(!p.pending.has(p.pendKey("start", "hostA", "s1")),
    "a command that never reached the agent must not keep a 'starting…' row up");
});

test("a refused resume leaves the operator here rather than on an empty session page", async () => {
  const p = loadPage({ reply: { error: "unknown session" }, status: 404 });
  p.resumeSession("hostA", "s1");
  await flush();
  assert.deepEqual(p.toasts, ["Resume failed — unknown session"]);
  assert.equal(p.location.href, "", "no navigation on a resume that didn't happen");
  assert.ok(!p.pending.has(p.pendKey("resume", "hostA", "s1")));
});

test("a resume the hub took still hands off to the sessions page", async () => {
  const p = loadPage({ reply: { ok: true } });
  p.resumeSession("hostA", "s1");
  await flush();
  assert.deepEqual(p.toasts, [], "nothing is toasted on success — a toast means a failure");
  assert.equal(p.location.href, "/sessions?session=s1");
  assert.ok(p.pending.has(p.pendKey("resume", "hostA", "s1")),
    "the spinner stays until the agent reports the session back");
});

test("a refusal with no explanation still names the status", async () => {
  const p = loadPage({ reply: {}, status: 502 });
  p.sessStart("hostA", "s1");
  await flush();
  assert.deepEqual(p.toasts, ["Start failed — the hub answered HTTP 502"]);
});

test("a POST that never lands is reported too, not only one the hub refused", async () => {
  // A dead tunnel and a refusal are different faults with the same visible
  // outcome — nothing happened — so both have to say so.
  const p = loadPage({ throws: true });
  p.sessStart("hostA", "s1");
  await flush();
  assert.deepEqual(p.toasts, ["Start failed — the hub is unreachable"]);
  assert.ok(!p.pending.has(p.pendKey("start", "hostA", "s1")));
});
