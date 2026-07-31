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
    // The header's org filter (org.js) — a real dependency of the page now that
    // every list is scoped by it. Stubbed as the identity scope ("all orgs"), so
    // these tests see the whole fabricated fleet.
    TurmaOrg: { get: () => "", filter: (a) => a || [], update() {}, subscribe() {}, sse() {} },
  };
  g.window = g; g.globalThis = g;

  // Suppress render(): the module body kicks off its own poll on load, whose
  // fetch resolves after the test and would paint into a DOM that isn't there.
  const exportTail = `
    ;globalThis.__hdr = { codingAgent, restartBtn, pending, confirming, pendKey, boardHealthBadge, claudeAuthBadge };
    render = () => {};
  `;
  const fn = new Function(
    "localStorage", "document", "window", "EventSource", "fetch",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "location", "matchMedia", "TurmaOrg", "globalThis",
    src + exportTail
  );
  fn(g.localStorage, g.document, g.window, g.EventSource, g.fetch,
     g.setInterval, g.clearInterval, g.setTimeout, g.clearTimeout, g.location, g.matchMedia, g.TurmaOrg, g);
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

test("restartBtn: offered only on a live host that isn't already restarting", () => {
  // XERK-157: an offline host has no heartbeat to carry the command; an
  // `updating` one is already on its way back. Both suppress the button.
  const { restartBtn } = loadHeaderModule();
  assert.match(restartBtn({ key: "h1", online: true }), /Restart/);
  assert.equal(restartBtn({ key: "h1", online: false }), "");
  assert.equal(restartBtn({ key: "h1", online: true, updating: { at: 1 } }), "");
});

test("restartBtn: arms on the first click, then shows a spinner while in flight", () => {
  const { restartBtn, pending, confirming, pendKey } = loadHeaderModule();
  const a = { key: "h2", online: true };
  // Default: an actionable button wired to restartHost.
  const idle = restartBtn(a);
  assert.match(idle, /onclick="restartHost\('h2'\)"/);
  assert.doesNotMatch(idle, /Confirm restart/);

  // Armed (first click recorded in `confirming`): asks for confirmation.
  confirming.set("ra::h2", 0);
  assert.match(restartBtn(a), /Confirm restart/);
  confirming.delete("ra::h2");

  // Pending (POST fired): disabled spinner, no further clicks.
  pending.set(pendKey("restartAgent", "h2", "_"), { at: Date.now() });
  const busy = restartBtn(a);
  assert.match(busy, /Restarting…/);
  assert.match(busy, /disabled/);
  pending.clear();
});

// --- boardHealthBadge (XERK-156) --------------------------------------------

test("boardHealthBadge: a failed board poll on an online host shows the chip", () => {
  const { boardHealthBadge } = loadHeaderModule();
  const html = boardHealthBadge({
    online: true,
    jira: { configured: true, error: "Azure DevOps temporarily unreachable (HTTP 530)" },
  });
  assert.ok(html.includes("Board unreachable"));
  assert.ok(html.includes("host-auth req"));
  // The friendly poll error rides as the tooltip.
  assert.ok(html.includes("Azure DevOps temporarily unreachable (HTTP 530)"));
});

test("boardHealthBadge: healthy / unconfigured / no-block boards show nothing", () => {
  const { boardHealthBadge } = loadHeaderModule();
  assert.equal(boardHealthBadge({ online: true, jira: { configured: true, error: null } }), "");
  assert.equal(boardHealthBadge({ online: true, jira: { configured: false, error: "x" } }), "");
  assert.equal(boardHealthBadge({ online: true }), "");
});

test("boardHealthBadge: an offline host suppresses it (offline already implies it)", () => {
  const { boardHealthBadge } = loadHeaderModule();
  assert.equal(
    boardHealthBadge({ online: false, jira: { configured: true, error: "unreachable" } }),
    "",
  );
});

test("boardHealthBadge: the tooltip is HTML-escaped", () => {
  const { boardHealthBadge } = loadHeaderModule();
  const html = boardHealthBadge({
    online: true,
    jira: { configured: true, error: '<img src=x onerror="alert(1)">' },
  });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});
