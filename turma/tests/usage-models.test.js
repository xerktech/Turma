// Unit tests for the dashboard's per-model usage helpers (the inline script in
// public/index.html): the model names shown on the token tiles and on each
// session card's Activity row.
//
// The bug they pin: those lists are read INSIDE the host-card map, so a single
// entry the helper couldn't read threw and aborted the whole render — the
// dashboard listed NO hosts. It reproduced as "All orgs shows nothing, one org
// shows fine", because filtering to an org excluded the host with the bad list.
//
// Same harness as host-header.test.js: the page's <script> body is evaluated
// under lightweight browser-global stubs (node:test, no npm).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadUsageHelpers() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const g = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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

  const exportTail = `
    ;globalThis.__usage = { shortModels, mergeModels, modelName };
    render = () => {};
  `;
  const fn = new Function(
    "localStorage", "document", "window", "EventSource", "fetch",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "location", "matchMedia", "TurmaOrg", "globalThis",
    src + exportTail
  );
  fn(g.localStorage, g.document, g.window, g.EventSource, g.fetch,
     g.setInterval, g.clearInterval, g.setTimeout, g.clearTimeout, g.location, g.matchMedia, g.TurmaOrg, g);
  return g.__usage;
}

test("shortModels: names the top two consumers, trimmed", () => {
  const { shortModels } = loadUsageHelpers();
  assert.equal(
    shortModels([{ model: "claude-opus-5" }, { model: "claude-haiku-4-5-20251001" }, { model: "claude-fable-5" }]),
    "opus-5, haiku-4-5",
  );
});

test("shortModels: an old agent's bare-string entries read, they don't throw", () => {
  // The hub coerces these on ingest; the renderer stays defensive anyway,
  // because throwing here costs every host card on the page, not just this one.
  const { shortModels } = loadUsageHelpers();
  assert.equal(shortModels(["claude-opus-5", "claude-fable-5"]), "opus-5, fable-5");
});

test("shortModels: a nameless entry is skipped, not rendered and not fatal", () => {
  const { shortModels } = loadUsageHelpers();
  assert.equal(shortModels([{}, { model: "claude-opus-5" }]), "opus-5");
  assert.equal(shortModels([null, undefined, {}, ""]), "–");
  assert.equal(shortModels([]), "–");
  assert.equal(shortModels(null), "–");
});

test("mergeModels: folds by name across hosts, biggest consumer first", () => {
  const { mergeModels } = loadUsageHelpers();
  const bucket = (n) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
  assert.deepEqual(
    mergeModels([
      [{ model: "claude-fable-5", totals: bucket(10) }],
      [{ model: "claude-opus-5", totals: bucket(30) }, { model: "claude-fable-5", totals: bucket(5) }],
    ]),
    [{ model: "claude-opus-5" }, { model: "claude-fable-5" }],
  );
});

test("mergeModels: drops unreadable entries instead of minting a nameless model", () => {
  // A nameless entry used to merge under the key `undefined` and then blow up
  // in shortModels the moment it reached the top two.
  const { mergeModels } = loadUsageHelpers();
  assert.deepEqual(mergeModels([[{}, "claude-opus-5", null]]), [{ model: "claude-opus-5" }]);
});
