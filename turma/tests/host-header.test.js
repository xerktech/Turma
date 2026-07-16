// Unit tests for the host header's "Agent" row (the inline script in
// public/index.html): which coding agent a host runs, and its version.
//
// That code lives inline (not a require-able module like chat.js), so the
// harness loads the page's <script> body under lightweight browser-global stubs
// and drives the real function — node:test, no npm, matching this package's
// zero-dependency stance and clone.test.js's approach.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Evaluate the page's inline script with just enough of the DOM/timer/network
// surface stubbed that the module body runs to its definitions, and hand back
// the header helpers.
function loadHeaderModule() {
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
  };
  g.window = g; g.globalThis = g;

  // Suppress render(): the module body kicks off its own poll on load, whose
  // fetch resolves after the test and would paint into a DOM that isn't there.
  const exportTail = `
    ;globalThis.__hdr = { codingAgent };
    render = () => {};
  `;
  const fn = new Function(
    "localStorage", "document", "window", "EventSource", "fetch",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "location", "matchMedia", "globalThis",
    src + exportTail
  );
  fn(g.localStorage, g.document, g.window, g.EventSource, g.fetch,
     g.setInterval, g.clearInterval, g.setTimeout, g.clearTimeout, g.location, g.matchMedia, g);
  return g.__hdr;
}

test("codingAgent: names the agent the host reports, with its version", () => {
  const { codingAgent } = loadHeaderModule();
  assert.equal(
    codingAgent({ codingAgent: { name: "Claude Code", version: "2.1.211" } }),
    "Claude Code 2.1.211",
  );
});

test("codingAgent: renders whatever agent a host runs, not a hardcoded one", () => {
  // The point of the field: the image is agent-generic, so the hub must not
  // assume Claude Code when the host says otherwise.
  const { codingAgent } = loadHeaderModule();
  assert.equal(
    codingAgent({ codingAgent: { name: "Copilot CLI", version: "0.9.1" } }),
    "Copilot CLI 0.9.1",
  );
});

test("codingAgent: an older agent's raw version string is parsed, not doubled", () => {
  // The reported bug: agents predating `codingAgent` report only the raw
  // `claude --version` reply, which read "Claude Code 2.1.211 (Claude Code)"
  // under a label that already said Claude Code.
  const { codingAgent } = loadHeaderModule();
  assert.equal(
    codingAgent({ claudeVersion: "2.1.211 (Claude Code)" }),
    "Claude Code 2.1.211",
  );
});

test("codingAgent: an unparseable legacy string is still shown, named", () => {
  const { codingAgent } = loadHeaderModule();
  assert.equal(codingAgent({ claudeVersion: "2.1.211" }), "Claude Code 2.1.211");
});

test("codingAgent: a host reporting no version at all says unknown", () => {
  // Never guess a number — the header says nothing rather than something wrong.
  const { codingAgent } = loadHeaderModule();
  assert.equal(codingAgent({}), "–");
  assert.equal(codingAgent({ claudeVersion: "" }), "–");
});

test("codingAgent: the parsed field wins over the raw string both report", () => {
  const { codingAgent } = loadHeaderModule();
  assert.equal(
    codingAgent({
      codingAgent: { name: "Claude Code", version: "2.1.211" },
      claudeVersion: "2.1.211 (Claude Code)",
    }),
    "Claude Code 2.1.211",
  );
});
