// Unit tests for the Dashboard's per-repo Prune control (the inline script in
// public/index.html).
//
// A prune used to be a single command that either had finished or hadn't, so
// the button's spinner could hang entirely off the page's local `pending`
// record. Since XERK-256 the agent runs the sweep on a worker thread and reports
// it as queued → running (with progress) → done, precisely because the sweep is
// minutes long — far past PENDING_TTL_MS. So the AGENT's reported status is what
// keeps the button busy, and these tests hold that line.
//
// The code lives inline rather than in a require-able module, so this loads the
// page's <script> body under lightweight browser-global stubs and drives the
// real function — node:test, no npm. Harness shape borrowed from
// dashboard-livestate.test.js / clone.test.js, which do the same.

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
    src + "\n;globalThis.__dash = { repoBlock, pending, pendKey };\n;globalThis.__setRender = (f) => { render = f; };"
  );
  fn(g.localStorage, g.document, g.window, g.EventSource, g.fetch,
     g.setInterval, g.clearInterval, g.setTimeout, g.clearTimeout, g.location, g.matchMedia, g.TurmaOrg, g);
  // The page's boot refresh() resolves after the test ends and would paint into
  // the stub DOM; neuter it, as clone.test.js does.
  g.__setRender(() => {});
  return g.__dash;
}

const REPO = { name: "Tenir", branch: "main", dirtyFiles: 0 };
const host = (prunes) => ({ key: "truenas", online: true, prunes });

function block(prunes) {
  const { repoBlock } = loadDashboard();
  return repoBlock(host(prunes), REPO, [], Date.now());
}

test("prune button is idle when the agent reports no prune", () => {
  const html = block([]);
  assert.match(html, />Prune</);
  assert.doesNotMatch(html, /Pruning…/);
  assert.doesNotMatch(html, /prune-note/);
});

test("a queued prune keeps the button busy and shows what it is waiting on", () => {
  const html = block([{ repo: "Tenir", status: "queued", summary: "queued for pruning", at: "2026-08-12T10:17:00Z" }]);
  assert.match(html, /Pruning…/);
  assert.match(html, /disabled/);
  assert.match(html, /class="prune-note run">queued for pruning</);
});

test("a running prune shows the worker's progress instead of the host going dark", () => {
  const html = block([{ repo: "Tenir", status: "running", summary: "pruning… worktree 4 of 31", at: "2026-08-12T10:19:00Z" }]);
  assert.match(html, /Pruning…/);
  assert.match(html, /class="prune-note run">pruning… worktree 4 of 31</);
});

test("the busy state survives the local pending record expiring", () => {
  // The whole reason the status drives it: `pending` is dropped after
  // PENDING_TTL_MS, minutes before a big repo's sweep is done.
  const { repoBlock, pending } = loadDashboard();
  assert.equal(pending.size, 0);
  const html = repoBlock(host([{ repo: "Tenir", status: "running", summary: "pruning… branch 12 of 42" }]), REPO, [], Date.now());
  assert.match(html, /Pruning…/);
});

test("a finished prune releases the button and shows its summary", () => {
  const html = block([{ repo: "Tenir", status: "done", summary: "removed 31 worktrees · 42 merged branches", at: "2026-08-12T11:07:32Z" }]);
  assert.match(html, />Prune</);
  assert.doesNotMatch(html, /Pruning…/);
  assert.match(html, /class="prune-note ">removed 31 worktrees · 42 merged branches</);
});

test("a failed prune shows the agent's error, not a summary", () => {
  const html = block([{ repo: "Tenir", status: "error", error: "no default branch to compare against", summary: "no default branch — nothing pruned" }]);
  assert.match(html, /class="prune-note err">no default branch to compare against</);
  assert.doesNotMatch(html, /Pruning…/);
});

test("another repo's prune does not touch this one", () => {
  const html = block([{ repo: "DockerOps", status: "running", summary: "pruning… worktree 4 of 31" }]);
  assert.doesNotMatch(html, /Pruning…/);
  assert.doesNotMatch(html, /prune-note/);
});
